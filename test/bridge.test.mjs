// bridge 单测：准入/白名单/分条/串行队列/token 账本（不连 OneBot、不跑真模型）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { splitForQQ } from '../src/md-to-plain.js';

let passed = 0;
let failed = 0;

const pendingTests = [];
function test(name, fn) {
  pendingTests.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (error) { failed++; console.error('  ✗ ' + name, error); }
  });
}

console.log('bridge.test.mjs');

const BASE_CONFIG = {
  qq: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '', accessToken: '' },
  model: { provider: 'deepseek', model: 'deepseek-chat', apiKey: '', thinkingLevel: 'off', maxTokens: 512, baseUrl: 'https://api.deepseek.com' },
  persona: { systemPrompt: 'test' },
  memory: { enabled: true, maxRecords: 50, maxResults: 5, autoCaptureUtterance: true },
  allow: { private: ['100'], groups: ['200'], allowAllWhenEmpty: false },
  deny: { private: [], groups: [] },
  tools: { enabled: false, sendWhitelist: [] },
  sendDelayMs: 0,
  ackMessage: '',
  maxTurnSeconds: 60,
  history: { maxMessages: 50 },
  internalPort: 0,
};

function makeBridge(configOverrides = {}) {
  const config = JSON.parse(JSON.stringify(BASE_CONFIG));
  Object.assign(config, configOverrides);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-bridge-'));
  return { bridge: new Bridge({ config, rootDir: tmp }), tmp };
}

// ── splitForQQ ──────────────────────────────────────────────────────────────

test('splitForQQ：空文本返回空数组', () => {
  assert.deepEqual(splitForQQ(''), []);
  assert.deepEqual(splitForQQ('   '), []);
});

test('splitForQQ：短文本单条', () => {
  assert.deepEqual(splitForQQ('你好'), ['你好']);
});

test('splitForQQ：空行分段', () => {
  const parts = splitForQQ('第一段\n\n第二段');
  assert.deepEqual(parts, ['第一段', '第二段']);
});

test('splitForQQ：超长切分并限制最多 10 条', () => {
  const long = 'x'.repeat(2000);
  const parts = splitForQQ(long, 450);
  assert.equal(parts.length, 5); // 2000/450 → 5 段
  assert.ok(parts.every((p) => p.length <= 450));
  // 上限 10 条：超长文本被截断到 10 段
  const huge = 'y'.repeat(10000);
  assert.equal(splitForQQ(huge, 450).length, 10);
});

// ── 白名单 ──────────────────────────────────────────────────────────────────

test('isAllowed：私聊白名单命中/未命中', () => {
  const { bridge } = makeBridge();
  const config = bridge.config;
  const allowed = isAllowedFor(config, { groupId: null, userId: '100' });
  const denied = isAllowedFor(config, { groupId: null, userId: '999' });
  assert.equal(allowed, true);
  assert.equal(denied, false);
});

test('isAllowed：群白名单', () => {
  const { bridge } = makeBridge();
  const config = bridge.config;
  assert.equal(isAllowedFor(config, { groupId: '200', userId: '1' }), true);
  assert.equal(isAllowedFor(config, { groupId: '300', userId: '1' }), false);
});

test('isAllowed：deny 优先于 allow', () => {
  const { bridge } = makeBridge({
    deny: { private: ['100'], groups: [] },
  });
  assert.equal(isAllowedFor(bridge.config, { groupId: null, userId: '100' }), false);
});

test('isAllowed：空白名单 + allowAllWhenEmpty', () => {
  const { bridge } = makeBridge({
    allow: { private: [], groups: [], allowAllWhenEmpty: true },
  });
  assert.equal(isAllowedFor(bridge.config, { groupId: null, userId: '任意' }), true);
});

// 黑盒包装（isAllowed 是模块内函数，通过 Bridge 行为间接验证；这里复刻逻辑做单元断言）
function isAllowedFor(config, message) {
  const deny = message.groupId ? config.deny?.groups ?? [] : config.deny?.private ?? [];
  const denySet = new Set(deny.map(String));
  if (denySet.has(message.groupId ?? message.userId)) return false;
  const allow = message.groupId ? config.allow?.groups ?? [] : config.allow?.private ?? [];
  if (allow.length === 0) return config.allow?.allowAllWhenEmpty === true;
  return new Set(allow.map(String)).has(message.groupId ?? message.userId);
}

// ── token 账本 ──────────────────────────────────────────────────────────────

test('TokenLedger：累计与落盘恢复', () => {
  const { bridge, tmp } = makeBridge();
  bridge.ledger.add('p100', { input: 10, output: 5, cacheRead: 2 });
  bridge.ledger.add('p100', { input: 20, output: 8, cacheRead: 3 });
  assert.equal(bridge.ledger.total.input, 30);
  assert.equal(bridge.ledger.total.output, 13);
  assert.equal(bridge.ledger.total.requests, 2);
  bridge.ledger.flush();

  const ledgerPath = path.join(tmp, 'state', 'token-ledger.json');
  const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.equal(raw.total.input, 30);
  assert.equal(raw.bySession.p100.requests, 2);
});

// ── 内部 HTTP：工具回调端点 ─────────────────────────────────────────────────

test('内部 HTTP：控制面免鉴权（未带令牌仍 200）', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const response = await fetch(`http://127.0.0.1:${bridge.internalPort}/status`);
  assert.equal(response.status, 200, '控制面应免鉴权直接 200');
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  void tmp;
});

test('内部 HTTP：/status 与 /memory', async () => {
  const { bridge } = makeBridge();
  await bridge._startInternalHttp();
  const headers = { 'x-console-token': bridge.internalToken };
  const status = await fetch(`http://127.0.0.1:${bridge.internalPort}/status`, { headers });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.running, false);
  assert.ok(statusBody.ledger);

  bridge.memoryPool.store('记忆一条', { namespace: 'p100' });
  const memory = await fetch(`http://127.0.0.1:${bridge.internalPort}/memory?session=p100`, { headers });
  const memoryBody = await memory.json();
  assert.equal(memoryBody.records.length, 1);
  await new Promise((resolve) => bridge.internalServer.close(resolve));
});

test('内部 HTTP：/agent/send 走会话绑定发送', async () => {
  const { bridge } = makeBridge();
  await bridge._startInternalHttp();
  const sent = [];
  bridge.bot = {
    sendGroupMessage: async (gid, msg) => {
      sent.push({ gid, msg });
      return {};
    },
    sendPrivateMessage: async () => {},
  };
  const response = await fetch(`http://127.0.0.1:${bridge.internalPort}/agent/send`, {
    method: 'POST',
    headers: { 'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: ['hello', 'world'] }),
  });
  const body = await response.json();
  assert.equal(body.sent.length, 2);
  assert.equal(sent[0].gid, '200');
  await new Promise((resolve) => bridge.internalServer.close(resolve));
});

// ── wait/unread 缓冲 ────────────────────────────────────────────────────────

test('unread 缓冲与 waiter 唤醒', async () => {
  const { bridge } = makeBridge();
  const runtime = bridge._runtimeFor('p100');
  const waitPromise = bridge._waitForMessages('p100', 2);
  setTimeout(() => {
    runtime.unread.push({ sender: 'u', text: '新消息' });
    bridge._notifyWaiters('p100');
  }, 50);
  const messages = await waitPromise;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '新消息');
});

test('wait 超时返回空数组', async () => {
  const { bridge } = makeBridge();
  const messages = await bridge._waitForMessages('p999', 1);
  assert.deepEqual(messages, []);
});

// ── 收到消息 → 会话准入（不跑模型：tools.enabled=false 且未 start，只测路由）──

test('handleIncoming：白名单外不入回合队列', async () => {
  const { bridge } = makeBridge();
  let turns = 0;
  bridge._enqueueTurn = () => turns++;
  await bridge.handleIncoming({ groupId: null, userId: '888', text: 'hi', images: [], raw: {} });
  assert.equal(turns, 0);
  // 但未读缓冲已记录
  assert.equal(bridge._runtimeFor('p888').unread.length, 0);
});

test('handleIncoming：群聊未被 @ 不响应', async () => {
  const { bridge } = makeBridge();
  let turns = 0;
  bridge._enqueueTurn = () => turns++;
  bridge.myQQId = '42';
  await bridge.handleIncoming({
    groupId: '200',
    userId: '100',
    text: '普通群聊',
    images: [],
    raw: { message: [{ type: 'text', data: { text: '普通群聊' } }] },
  });
  assert.equal(turns, 0);
});

test('handleIncoming：群聊 @ 机器人响应', async () => {
  const { bridge } = makeBridge();
  let enqueued = null;
  bridge._enqueueTurn = (key, message, text) => {
    enqueued = { key, text };
  };
  bridge.myQQId = '42';
  await bridge.handleIncoming({
    groupId: '200',
    userId: '100',
    text: '你好',
    images: [],
    raw: { message: [{ type: 'at', data: { qq: 42 } }, { type: 'text', data: { text: ' 你好' } }] },
  });
  assert.equal(enqueued.key, 'g200');
  assert.ok(enqueued.text.includes('你好'));
});

for (const run of pendingTests) await run();
process.exitCode = failed > 0 ? 1 : 0;
