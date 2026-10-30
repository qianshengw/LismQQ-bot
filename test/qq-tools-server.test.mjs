// qq-tools-server 单测：真实子进程（stdio MCP 协议）+ 桥接内部 API 的 mock HTTP server。
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '../src/mcp/qq-tools-server.mjs');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error?.message ?? error}`);
    }
  })();
}

/** 一个最小 JSON-RPC-over-stdio MCP 客户端。 */
class TinyMcpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    child.stdout.on('data', (chunk) => this._onData(chunk));
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message));
          else entry.resolve(message.result);
        }
      } catch {
        // 忽略坏帧
      }
    }
  }

  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text) console.error(`    [server stderr] ${text}`);
  });
  return new TinyMcpClient(child);
}

/** mock 桥接内部 API。 */
function startMockBridge(handlers) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const handler = handlers[`${req.method} ${url.pathname}`];
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const result = handler({ url, body: body ? JSON.parse(body) : {} });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const run = async () => {
  console.log('qq-tools-server.test.mjs');

  const unreadCalls = [];
  const { server: mockBridge, port: mockPort } = await startMockBridge({
    'GET /agent/unread': () => {
      unreadCalls.push(1);
      return { messages: [{ sender: 'alice', text: '在吗', time: Date.now() }] };
    },
    'POST /agent/send': ({ body }) => ({ sent: Array.isArray(body.messages) ? body.messages : [body.messages] }),
    'GET /agent/status': () => ({ sessionKey: 'g1', type: 'group', unread: 3 }),
    'POST /agent/wait': () => ({ messages: [{ sender: 'bob', text: '来玩', time: Date.now() }] }),
  });

  const client = startServer({ QQ_BRIDGE_BASE: `http://127.0.0.1:${mockPort}`, QQ_BRIDGE_TOKEN: 'tok' });

  await test('initialize 握手', async () => {
    const result = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(result.serverInfo.name, 'qq-tools');
    assert.ok(result.capabilities.tools);
  });

  await test('tools/list 含全部 QQ 工具', async () => {
    const result = await client.request('tools/list', {});
    const names = result.tools.map((t) => t.name);
    for (const expected of ['qq_get_unread_messages', 'qq_get_group_history', 'qq_send_message', 'qq_reply', 'qq_wait_for_messages', 'qq_session_status']) {
      assert.ok(names.includes(expected), `缺少 ${expected}`);
    }
  });

  await test('qq_get_unread_messages 调桥接 /agent/unread', async () => {
    const result = await client.request('tools/call', { name: 'qq_get_unread_messages', arguments: {} });
    assert.equal(result.isError, undefined ?? false);
    assert.ok(result.content[0].text.includes('alice'));
    assert.equal(unreadCalls.length, 1);
  });

  await test('qq_send_message POST /agent/send', async () => {
    const result = await client.request('tools/call', { name: 'qq_send_message', arguments: { messages: ['hi', 'yo'] } });
    assert.equal(result.content[0].text, '已发送');
  });

  await test('qq_session_status 返回桥接状态', async () => {
    const result = await client.request('tools/call', { name: 'qq_session_status', arguments: {} });
    assert.ok(result.content[0].text.includes('"type": "group"') || result.content[0].text.includes('group'));
  });

  await test('未知工具返回 -32602', async () => {
    await assert.rejects(
      client.request('tools/call', { name: 'nope', arguments: {} }),
      /未知工具/,
    );
  });

  await test('不同会话并发隔离，同会话保持顺序', async () => {
    let releaseWait;
    const sessions = [];
    const slowBridge = http.createServer(async (req, res) => {
      for await (const chunk of req) {} // consume body
      const key = req.headers['x-qq-session'];
      sessions.push([req.url, key]);
      if (req.url === '/agent/wait') await new Promise(resolve => { releaseWait = resolve; });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/agent/wait' ? { messages: [] } : { sent: ['ok'] }));
    });
    await new Promise(r => slowBridge.listen(0, '127.0.0.1', r));
    const parallel = startServer({ QQ_BRIDGE_BASE: `http://127.0.0.1:${slowBridge.address().port}` });
    try {
      const waiting = parallel.request('tools/call', { name: 'qq_wait_for_messages', arguments: { timeoutSeconds: 5, __qqSession: 'g1' } });
      const deadline = Date.now() + 5000;
      while (!releaseWait && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      assert.ok(releaseWait, 'wait must reach bridge');
      const same = parallel.request('tools/call', { name: 'qq_send_message', arguments: { messages: 'same', __qqSession: 'g1' } });
      const other = parallel.request('tools/call', { name: 'qq_send_message', arguments: { messages: 'other', __qqSession: 'g2' } });
      await Promise.race([other, new Promise((_, reject) => { const h = setTimeout(() => reject(new Error('other session blocked')), 3000); h.unref(); })]);
      assert.deepEqual(sessions, [['/agent/wait', 'g1'], ['/agent/send', 'g2']]);
      releaseWait(); await Promise.all([waiting, same]);
      assert.deepEqual(sessions.at(-1), ['/agent/send', 'g1']);
    } finally {
      releaseWait?.(); parallel.child.kill();
      await new Promise(r => slowBridge.close(r));
    }
  });

  client.child.kill();
  mockBridge.close();
  process.exitCode = failed > 0 ? 1 : 0;
};

run();
