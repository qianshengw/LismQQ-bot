// MCP stdio server：只读 web_search / web_fetch（SSRF 防护走 ../safe-fetch.js 的严密实现）。
// 与 agent 后端无关；凭据按 config 注入的 env（WEB_SEARCH_API_KEY / WEB_SEARCH_BASE_URL / WEB_SEARCH_MODEL）解析。
import readline from 'node:readline';
import { safeFetch, isAllowedHost } from '../safe-fetch.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'web-search-safe', version: '0.1.0' };

const API_KEY = process.env.WEB_SEARCH_API_KEY ?? '';
const BASE_URL = (process.env.WEB_SEARCH_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.WEB_SEARCH_MODEL ?? 'deepseek-chat';
const MAX_FETCH_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const SEARCH_TIMEOUT_MS = 60000;

/** HTML → 纯文本（极简版：去 script/style/标签）。 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 搜索后端 ─────────────────────────────────────────────────────────────────

async function searchViaOpenAICompatible(query) {
  if (!API_KEY) throw new Error('WEB_SEARCH_API_KEY 未配置');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('搜索超时')), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: 'You are a web search assistant. Answer with search results only.' },
          { role: 'user', content: `Search the web and summarize findings for: ${query}` },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`搜索端点 HTTP ${response.status}`);
    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content ?? '';
    return String(text).slice(0, 4000);
  } finally {
    clearTimeout(timer);
  }
}

/** Bing RSS 兜底（无凭据可用）。 */
async function searchViaBingRss(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
  const { text } = await safeFetch(url, { timeoutMs: SEARCH_TIMEOUT_MS, maxBytes: MAX_FETCH_BYTES });
  const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5);
  if (items.length === 0) return '（Bing RSS 无结果）';
  return items
    .map(([, item]) => {
      const title = (item.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '';
      const link = (item.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? '';
      const desc = (item.match(/<description>([\s\S]*?)<\/description>/) ?? [])[1] ?? '';
      return `- ${title}\n  ${link}\n  ${desc.slice(0, 200)}`;
    })
    .join('\n');
}

async function webSearch(query) {
  try {
    return await searchViaOpenAICompatible(query);
  } catch (error) {
    console.error('[web-search] OpenAI 兼容搜索失败，回退 Bing RSS:', error?.message ?? error);
    return await searchViaBingRss(query);
  }
}

// ── JSON-RPC stdio 循环 ───────────────────────────────────────────────────────

function writeFrame(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const TOOLS = [
  {
    name: 'web_search',
    description: '联网搜索。返回摘要文本（含来源）。优先 DeepSeek 联网端点，失败回退 Bing RSS。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = String(args?.query ?? '').trim();
      if (!query) return { content: [{ type: 'text', text: 'query 为空' }], isError: true };
      try {
        const result = await webSearch(query);
        return { content: [{ type: 'text', text: result }], isError: false };
      } catch (error) {
        return { content: [{ type: 'text', text: `搜索失败: ${error?.message ?? error}` }], isError: true };
      }
    },
  },
  {
    name: 'web_fetch',
    description: '抓取一个公网 URL 的正文（纯文本，最大 512KB）。拒绝内网/本地地址与解析到内网的域名（SSRF 防护，含 DNS rebinding 防护）。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL' } },
      required: ['url'],
      additionalProperties: false,
    },
    handler: async (args) => {
      let parsed;
      try {
        parsed = new URL(String(args?.url ?? ''));
      } catch {
        return { content: [{ type: 'text', text: 'URL 非法' }], isError: true };
      }
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !isAllowedHost(parsed.hostname)) {
        return { content: [{ type: 'text', text: 'URL 非法或指向内网/本地地址，已拒绝' }], isError: true };
      }
      try {
        const { status, text } = await safeFetch(parsed, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_FETCH_BYTES });
        const isHtml = /<html[\s>]/i.test(text);
        const body = isHtml ? htmlToText(text) : text;
        return { content: [{ type: 'text', text: `[HTTP ${status}] ${body.slice(0, 6000)}` }], isError: false };
      } catch (error) {
        return { content: [{ type: 'text', text: `抓取失败: ${error?.message ?? error}` }], isError: true };
      }
    },
  },
];

function sendResult(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  writeFrame({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      sendResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      return;
    case 'notifications/initialized':
      return;
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) {
        sendError(id, -32602, `未知工具: ${params?.name}`);
        return;
      }
      sendResult(id, await tool.handler(params?.arguments ?? {}));
      return;
    }
    default:
      if (id !== undefined && id !== null) sendError(id, -32601, `方法不存在: ${method}`);
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    void handleRequest(message).catch((error) => {
      console.error('[web-search] 处理异常:', error?.message ?? error);
      if (message.id !== undefined && message.id !== null) sendError(message.id, -32603, 'internal error');
    });
  });
  rl.on('close', () => process.exit(0));
}

main().catch((error) => {
  console.error('[web-search] 致命错误:', error);
  process.exit(1);
});
