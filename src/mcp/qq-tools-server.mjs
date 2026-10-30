// MCP stdio server：QQ 动作安全子集。由 pi-mcp 的 StdioTransport 作为子进程拉起，
// 通过桥接的内部 HTTP API（internalPort + internalToken）回调桥接本体——与 agent 后端无关。
// 协议：@modelcontextprotocol JSON-RPC over stdio（换行分帧）。
import readline from 'node:readline';
import { AsyncLocalStorage } from 'node:async_hooks';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'qq-tools', version: '0.1.0' };

/** 桥接内部 API 基址与环境（启动时由桥接注入 env）。 */
const BRIDGE_BASE = process.env.QQ_BRIDGE_BASE ?? 'http://127.0.0.1:3210';
const BRIDGE_TOKEN = process.env.QQ_BRIDGE_TOKEN ?? '';
/** 长轮询等待工具（qq_wait_for_messages）的超时；须大于桥接侧长轮询时长。 */
const WAIT_TIMEOUT_MS = Number(process.env.QQ_WAIT_TIMEOUT_MS ?? 600000);
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 当前请求所属的 QQ 会话 key（桥接以隐藏参数 __qqSession 注入）。
 *
 * 会话上下文是"这次工具调用属于哪个 QQ 会话"的唯一凭据：桥接据此决定
 * 往哪发消息、读谁的未读、写哪份 v2 状态。缺了它，所有会话相关工具都会
 * 失败（发送 403 / 读取恒空 / v2 状态接口空指针）。
 *
 * 取值来源：MCP server 是所有会话共享的独立子进程，会话 key 只能随每次
 * 调用传递，不能写进进程 env。tools/call 分支通过 AsyncLocalStorage 绑定请求上下文；同会话调用串行，不同会话调用并行，异步上下文隔离避免并发串号。
 */
const sessionContext = new AsyncLocalStorage();

/** 桥接注入的隐藏参数名（模型看不到，也不参与 body）。 */
const SESSION_PARAM = '__qqSession';

async function bridgeApi(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('桥接回调超时')), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', 'x-agent-call': '1' };
    if (BRIDGE_TOKEN) headers['x-console-token'] = BRIDGE_TOKEN;
    const session = sessionContext.getStore();
    if (session) headers['x-qq-session'] = session;
    const response = await fetch(`${BRIDGE_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: data?.error ?? `HTTP ${response.status}` };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }], isError: false };
}

// ── 工具定义（MCP tools/list 的 inputSchema 是 JSON Schema）───────────────────

const TOOLS = [
  {
    name: 'qq_get_unread_messages',
    description: '读取当前 QQ 会话未读消息（自上次读取以来的新消息），返回 [{sender, text, time, relativeTime}]。每条都带相对时间与「是否在叫你」的标注。可传 afterSeq 只取该 seq 之后的消息（读到的最大 seq 在返回的 throughSeq 里）。',
    inputSchema: {
      type: 'object',
      properties: {
        afterSeq: { type: 'integer', description: '只取该 seq 之后的消息；不传则取上次投喂之后的新消息' },
        limit: { type: 'integer', description: '最多取几条（默认全部，最新优先截断）' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (Number.isFinite(Number(args?.afterSeq))) params.set('afterSeq', String(Math.max(0, Math.floor(Number(args.afterSeq)))));
      if (Number.isFinite(Number(args?.limit))) params.set('limit', String(Math.max(0, Math.min(200, Math.floor(Number(args.limit))))));
      const qs = params.toString();
      const r = await bridgeApi(`/agent/unread${qs ? `?${qs}` : ''}`);
      return r.ok ? jsonResult(r.data) : textResult(`读取失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_get_group_history',
    description: '获取当前群最近的消息历史，返回 [{sender, text, time}]（最多 count 条）。',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'integer', description: '条数，默认 20，最大 50' } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const count = Math.min(Math.max(Number(args?.count ?? 20), 1), 50);
      const r = await bridgeApi(`/agent/history?count=${count}`);
      return r.ok ? jsonResult(r.data) : textResult(`读取失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_send_message',
    description: '向当前 QQ 会话发送文本消息。支持字符串或字符串数组（数组=拆成多条发送）。',
    inputSchema: {
      type: 'object',
      properties: {
        messages: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '文本或文本数组',
        },
      },
      required: ['messages'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const r = await bridgeApi('/agent/send', { method: 'POST', body: { messages: args?.messages } });
      return r.ok ? textResult('已发送') : textResult(`发送失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_reply',
    description: '引用回复某条消息。使用当前消息、未读工具或群历史返回的真实messageId；不要把seq水位当messageId。',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'integer', description: '被引用的消息 id' },
        text: { type: 'string', description: '回复文本' },
      },
      required: ['messageId', 'text'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const r = await bridgeApi('/agent/reply', {
        method: 'POST',
        body: { messageId: Number(args?.messageId), text: String(args?.text ?? '') },
      });
      return r.ok ? textResult('已回复') : textResult(`回复失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_list_groups',
    description: '列出机器人所在的群（groupId / groupName / memberCount）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await bridgeApi('/agent/groups');
      return r.ok ? jsonResult(r.data) : textResult(`查询失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_get_group_members',
    description: '获取当前群的成员列表（userId / nickname / card / role）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await bridgeApi('/agent/members');
      return r.ok ? jsonResult(r.data) : textResult(`查询失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_get_message_images',
    description: '获取当前会话未读消息里的图片 URL 列表（配合 qq_get_unread_messages 使用）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await bridgeApi('/agent/unread');
      if (!r.ok) return textResult(`读取失败: ${r.error}`, true);
      const urls = (r.data?.messages ?? []).flatMap((m) => m.images ?? []);
      return jsonResult({ images: urls });
    },
  },
  {
    name: 'qq_get_forward_msg',
    description: '展开一条合并转发消息（需要 forward id，来自会话里的 [转发消息 id=...]）。',
    inputSchema: {
      type: 'object',
      properties: { forwardId: { type: 'string', description: '转发消息 id' } },
      required: ['forwardId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const r = await bridgeApi(`/agent/forward?id=${encodeURIComponent(String(args?.forwardId ?? ''))}`);
      return r.ok ? jsonResult(r.data) : textResult(`展开失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_set_wake_config',
    description: '设置唤醒配置（二代仿真的核心交互）：决定你下次什么时候醒。需要改变下次唤醒条件时设置；不调用会保留现有配置，无有效触发条件时桥接才恢复默认值。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['active', 'diving'], description: 'active=活跃状态，diving=潜水状态；两者均按triggers判断消息唤醒，要每条消息唤醒需开启anyMessage' },
        infinite: { type: 'boolean', description: 'true=无限期（按触发器醒），false=sleepUntil 定时醒' },
        sleepUntil: { type: 'integer', description: 'infinite=false 时的唤醒时间戳（毫秒）' },
        triggers: {
          type: 'object',
          properties: {
            atMention: { type: 'boolean', description: '有人 @ 我时醒' },
            nameMention: { type: 'boolean', description: '提到我的名字时醒' },
            question: { type: 'boolean', description: '有人向我提问时醒' },
            poke: { type: 'boolean', description: '有人戳我时醒' },
            anyMessage: { type: 'boolean', description: '任何消息都醒（慎用，刷屏环境会频繁醒）' },
            keywords: { type: 'array', items: { type: 'string' }, description: '关键词列表，命中即醒' },
            speakerIds: { type: 'array', items: { type: 'string' }, description: '指定 QQ 号发言时醒' },
            probability: { type: 'number', description: '0~1，每条消息随机醒的概率' },
          },
          additionalProperties: false,
        },
        batchWindowMs: { type: 'integer', description: '唤醒合并窗口毫秒（多条消息一起醒）' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const r = await bridgeApi('/agent/wake-config', { method: 'POST', body: args ?? {} });
      return r.ok ? textResult('唤醒配置已更新') : textResult(`设置失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_mark_read',
    description: '确认已读到某条消息（seq 水位回执）。读完未读消息后调用，避免下次重复看到同一条。传你**实际读到**的最大 seq（不要凭空猜测或加大）。',
    inputSchema: {
      type: 'object',
      properties: { seq: { type: 'integer', description: '已读到的最大 seq' } },
      required: ['seq'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const r = await bridgeApi('/agent/mark-read', { method: 'POST', body: { seq: Number(args?.seq ?? 0) } });
      return r.ok ? textResult(`已确认已读（水位 ${r.data?.lastReadThroughSeq ?? args?.seq ?? 0}）`) : textResult(`失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_memory',
    description: '你的会话记忆（话题/想法/群友印象）。append 记录、remove 删除、clear 清空、不传 action 则查看当前记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['append', 'remove', 'clear'], description: '缺省=查看' },
        category: { type: 'string', enum: ['topic', 'thought', 'impression'], description: 'topic=近期话题, thought=想做的事（2h 过期）, impression=群友印象' },
        text: { type: 'string', description: 'append：内容一句话；impression 分类时可用「名字:标签」格式' },
        who: { type: 'string', description: 'append impression：群友名字' },
        trait: { type: 'string', description: 'append impression：印象标签' },
        motivation: { type: 'string', description: 'append thought 时：为什么想做' },
        index: { type: 'integer', description: 'remove：条目下标（查看时可见顺序）' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!args?.action) {
        const r = await bridgeApi('/agent/memory');
        return r.ok ? jsonResult(r.data) : textResult(`查询失败: ${r.error}`, true);
      }
      const r = await bridgeApi('/agent/memory', { method: 'POST', body: args });
      return r.ok ? textResult('已更新') : textResult(`失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_send_burst',
    description: '连发多条消息（模拟真人节奏，条间自动加间隔）。默认最多8条、单条500字，实际受会话连发限额约束。',
    inputSchema: {
      type: 'object',
      properties: {
        messages: { type: 'array', items: { type: 'string' }, description: '要连发的文本数组' },
        gapMode: { type: 'string', enum: ['auto', 'fixed', 'byLength'], description: '间隔模式，默认 auto' },
      },
      required: ['messages'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const r = await bridgeApi('/agent/burst', { method: 'POST', body: { messages: args?.messages, gapMode: args?.gapMode } });
      return r.ok ? textResult(`已连发 ${r.data?.sent?.length ?? 0} 条`) : textResult(`发送失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_wait_for_messages',
    description: '睡前观察：等待当前会话的新消息（默认 5 分钟），收到消息后按quietMs静默合并再返回（quietMs=0立即返回）、超时返回空。说完话/处理完未读后用它观察有没有人接话——短观察可以多轮（每回合总时长预算 12 分钟，用完立即返回），确认没人说了再用 qq_set_wake_config 收尾。',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutSeconds: { type: 'integer', description: '最长等待秒数，默认 300，最大 600' },
        quietMs: { type: 'integer', description: '静默窗毫秒：收到消息后再静默观察这么久才返回（对方连发时不抢答），默认 8000，0 = 收到立即返回' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const seconds = Math.min(Math.max(Number(args?.timeoutSeconds ?? 300), 1), 600);
      const quietMs = Math.min(Math.max(Number(args?.quietMs ?? 8000), 0), 60000);
      // 观察总时长预算（每回合 12 分钟）由桥接 /agent/wait 端点强制扣减，预算用完立即返回空数组
      const r = await bridgeApi('/agent/wait', { method: 'POST', body: { timeoutSeconds: seconds, quietMs }, timeoutMs: (seconds + 30) * 1000 });
      return r.ok ? jsonResult(r.data) : textResult(`等待失败: ${r.error}`, true);
    },
  },
  {
    name: 'qq_session_status',
    description: '查询当前QQ会话的sessionKey、type、unread和busy；此工具不返回唤醒配置或白名单。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await bridgeApi('/agent/status');
      return r.ok ? jsonResult(r.data) : textResult(`查询失败: ${r.error}`, true);
    },
  },
];

// ── JSON-RPC stdio 循环 ───────────────────────────────────────────────────────

function writeFrame(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

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
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'notifications/initialized':
      return; // 通知，无需响应
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;
    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        sendError(id, -32602, `未知工具: ${name}`);
        return;
      }
      try {
        // 会话 key 由桥接以隐藏参数注入：取出来放进请求上下文，并从工具参数里
        // 摘掉（不让它进入 body，也不让模型看见）。
        const rawArgs = (params?.arguments && typeof params.arguments === 'object') ? params.arguments : {};
        const session = String(rawArgs[SESSION_PARAM] ?? '');
        const cleanArgs = { ...rawArgs };
        delete cleanArgs[SESSION_PARAM];
        const result = await sessionContext.run(session, () => tool.handler(cleanArgs));
        sendResult(id, result);
      } catch (error) {
        sendResult(id, textResult(`工具执行异常: ${error?.message ?? error}`, true));
      }
      return;
    }
    default:
      if (id !== undefined && id !== null) sendError(id, -32601, `方法不存在: ${method}`);
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // 同会话保持顺序，不同会话独立执行；上下文由 AsyncLocalStorage 隔离。
  const queues = new Map();
  const dispatch = (message) => {
    const key = message.method === 'tools/call'
      ? String(message.params?.arguments?.[SESSION_PARAM] ?? '') : 'protocol';
    const previous = queues.get(key) ?? Promise.resolve();
    const task = previous.then(() => handleRequest(message)).catch(error => {
      console.error('[qq-tools] 处理异常:', error?.message ?? error);
      if (message.id != null) sendError(message.id, -32603, 'internal error');
    });
    queues.set(key, task);
    void task.finally(() => { if (queues.get(key) === task) queues.delete(key); });
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      console.error('[qq-tools] 无法解析的帧（忽略）');
      return;
    }
    dispatch(message);
  });

  rl.on('close', () => process.exit(0));
}

main().catch((error) => {
  console.error('[qq-tools] 致命错误:', error);
  process.exit(1);
});
