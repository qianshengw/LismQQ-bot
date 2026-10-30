// MCP 工具的「会话绑定」回归测试（端到端，不 mock 内部 HTTP）。
//
// 为什么需要这个测试：
//   MCP server 是独立子进程，它回调桥接内部 HTTP 时必须带上 x-qq-session 头，
//   桥接才知道这次调用属于哪个 QQ 会话（否则发送被 403、读取返回空、v2 状态接口崩）。
//   之前 qq-tools-server.mjs 从不发这个头 → 整个 QQ 工具面失效，
//   而 mock 内部 HTTP 的 e2e 测试看不出来（mock 不做校验）。
//
// 本测试用真实的 MCP 子进程 + 真实的 Bridge 内部 HTTP，跑通「工具 → 桥接 → 发送」全链路。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
  }
}

console.log('mcp-session-binding.test.mjs\n');

const CONFIG = {
  qq: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '', accessToken: '' },
  model: { provider: 'longcat', model: 'LongCat-2.5-Preview', apiKey: '', thinkingLevel: 'off', maxTokens: 64, baseUrl: 'https://api.longcat.chat/openai/v1' },
  persona: { systemPrompt: 'test' },
  memory: { enabled: false, maxRecords: 10, maxResults: 3, autoCaptureUtterance: false },
  socialV2: { enabled: true, mode: 'v2', limits: {} },
  socialV1: { enabled: false },
  allow: { private: [], groups: ['200'], allowAllWhenEmpty: false },
  deny: { private: [], groups: [] },
  tools: { enabled: true, sendWhitelist: [] },
  sendDelayMs: 0,
  ackMessage: '',
  maxTurnSeconds: 60,
  history: { maxMessages: 20 },
  internalPort: 0,
  internalHost: '127.0.0.1',
};

async function makeBridge() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-mcpsess-'));
  const sent = [];
  const bridge = new Bridge({
    config: JSON.parse(JSON.stringify(CONFIG)),
    rootDir: tmp,
    deps: {
      bot: {
        connected: true,
        connectionState: 'open',
        on() { return this; },
        connect() {},
        close() {},
        call: async () => ({}),
        getLoginInfo: async () => ({ user_id: '99999', nickname: 'bot' }),
        sendGroupMessage: async (gid, msg) => { sent.push({ target: String(gid), msg }); return {}; },
        sendPrivateMessage: async (uid, msg) => { sent.push({ target: String(uid), msg }); return {}; },
        getGroupHistory: async () => [],
      },
    },
  });
  await bridge.start();
  return { bridge, tmp, sent };
}

async function teardown(bridge) {
  clearInterval(bridge.flushTimer);
  clearInterval(bridge.v1LoopTimer);
  bridge.wakeScheduler?.stop();
  for (const h of bridge.mcpHandles) await h.close().catch(() => {});
  if (bridge.internalServer) await new Promise((r) => bridge.internalServer.close(r));
}

function textOf(result) {
  return (result?.content ?? []).map((c) => c?.text ?? '').join('\n');
}

const { bridge, sent } = await makeBridge();

await test('MCP 工具发送：白名单内的群能真正收到消息', async () => {
  const tools = await bridge._buildTools('g200');
  const send = tools.find((t) => t.name === 'mcp_qq_send_message');
  assert.ok(send, '未找到 mcp_qq_send_message 工具');
  const res = await send.execute('t1', { messages: ['来自工具的测试消息'] });
  const text = textOf(res);
  assert.ok(!res.isError, `工具返回错误：${text}`);
  assert.ok(!/白名单/.test(text), `工具被白名单拦截：${text}`);
  assert.equal(sent.length, 1, `期望发出 1 条，实际 ${sent.length} 条（${text}）`);
  assert.equal(sent[0].target, '200');
});

await test('MCP 工具发送：白名单外的群被拒绝', async () => {
  const tools = await bridge._buildTools('g999');
  const send = tools.find((t) => t.name === 'mcp_qq_send_message');
  const res = await send.execute('t2', { messages: ['越权消息'] });
  const text = textOf(res);
  assert.ok(/白名单/.test(text), `期望被白名单拒绝，实际返回：${text}`);
  assert.equal(sent.length, 1, '越权调用不应产生任何发送');
});

await test('MCP 工具读取：未读缓冲按会话隔离', async () => {
  const rt = bridge._runtimeFor('g200');
  rt.unread.push({ sender: '张三', text: '给 200 群的消息' });
  const rt2 = bridge._runtimeFor('g300');
  rt2.unread.push({ sender: '李四', text: '给 300 群的消息' });

  const tools = await bridge._buildTools('g200');
  const unread = tools.find((t) => t.name === 'mcp_qq_get_unread_messages');
  const res = await unread.execute('t3', {});
  const text = textOf(res);
  assert.ok(text.includes('给 200 群的消息'), `未读到本会话消息：${text}`);
  assert.ok(!text.includes('给 300 群的消息'), `读到了别的会话的消息（会话绑定失效）：${text}`);
});

await test('MCP 工具：v2 唤醒配置能按会话写入', async () => {
  const tools = await bridge._buildTools('g200');
  const cfg = tools.find((t) => t.name === 'mcp_qq_set_wake_config');
  const res = await cfg.execute('t4', { mode: 'active' });
  const text = textOf(res);
  assert.ok(!res.isError, `设置唤醒配置失败：${text}`);
  const state = bridge.socialV2.get('g200');
  assert.equal(state.wakeConfig.mode, 'active', '唤醒配置未落到正确会话');
});

await teardown(bridge);

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
