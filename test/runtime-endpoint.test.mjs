// /api/runtime 端点回归：GET 形状 / POST 即时生效 + 传播到已有会话 / 白名单字段
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';

let passed = 0;
let failed = 0;
const asyncs = [];

function test(name, fn) {
  const wrapper = async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error?.message ?? error}`);
    }
  };
  asyncs.push([name, wrapper()]);
}

console.log('runtime-endpoint.test.mjs');

function makeBridge() {
  const config = {
    qq: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '', accessToken: '' },
    model: { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com' },
    persona: { systemPrompt: '', systemPromptFile: 'roles/default.md' },
    memory: { enabled: false },
    socialV2: { enabled: false },
    socialV1: { enabled: false },
    allow: { private: [], groups: [] },
    deny: { private: [], groups: [] },
    tools: { enabled: false },
    sendDelayMs: 800,
    maxTurnSeconds: 300,
    history: { maxMessages: 120, summarize: true },
    internalPort: 0,
    internalHost: '127.0.0.1',
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-rt-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config), 'utf8');
  return { bridge: new Bridge({ config, rootDir: tmp }), tmp };
}

async function call(bridge, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${bridge.internalPort}${pathname}`, {
    method,
    headers: { 'x-console-token': bridge.internalToken, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

await test('GET /api/runtime：形状完整', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/api/runtime');
  assert.equal(r.status, 200);
  assert.equal(r.data.runtime.ackMessage, '');
  assert.equal(r.data.runtime.sendDelayMs, 800);
  assert.equal(r.data.runtime.maxTurnSeconds, 300);
  assert.equal(r.data.runtime.historySummarize, true);
  await new Promise((res) => bridge.internalServer.close(res));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('POST /api/runtime：即时生效 + 写回 config', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/api/runtime', {
    method: 'POST',
    body: { ackMessage: '收到～', sendDelayMs: 1200, maxTurnSeconds: 600, historyMaxMessages: 200, historySummarize: false },
  });
  assert.equal(r.status, 200);
  // 运行态
  assert.equal(bridge.config.ackMessage, '收到～');
  assert.equal(bridge.config.sendDelayMs, 1200);
  assert.equal(bridge.config.maxTurnSeconds, 600);
  assert.equal(bridge.config.history.maxMessages, 200);
  assert.equal(bridge.config.history.summarize, false);
  // config 落盘
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.equal(raw.sendDelayMs, 1200);
  assert.equal(raw.maxTurnSeconds, 600);
  await new Promise((res) => bridge.internalServer.close(res));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('POST /api/runtime：历史参数传播到已有会话', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  // 模拟一个已存在的会话 agent
  const fakeAgent = { maxMessages: 120, summarizeEnabled: true };
  const { SessionManager } = await import('../src/pi-host.js');
  const fakeMgr = new SessionManager({
    sessionsDir: path.join(tmp, 'sessions'),
    modelConfig: { provider: 'deepseek', model: 'deepseek-flash' },
    systemPrompt: 't',
    maxMessages: 120,
    summarize: true,
  });
  fakeMgr.agents.set('g1', fakeAgent);
  bridge.sessionManager = fakeMgr;

  await call(bridge, '/api/runtime', { method: 'POST', body: { historyMaxMessages: 300, historySummarize: false } });
  assert.equal(fakeAgent.maxMessages, 300, '已有会话的 maxMessages 应更新');
  assert.equal(fakeAgent.summarizeEnabled, false, '已有会话的 summarize 应更新');
  assert.equal(fakeMgr.maxMessages, 300);
  assert.equal(fakeMgr.summarize, false);
  await new Promise((res) => bridge.internalServer.close(res));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('POST /api/runtime：非法值被钳制', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  await call(bridge, '/api/runtime', { method: 'POST', body: { sendDelayMs: 999999, maxTurnSeconds: 5, historyMaxMessages: 1 } });
  assert.equal(bridge.config.sendDelayMs, 60000);
  assert.equal(bridge.config.maxTurnSeconds, 30);
  assert.equal(bridge.config.history.maxMessages, 20);
  await new Promise((res) => bridge.internalServer.close(res));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('POST /sessions/abort：空闲会话返回 aborted=false', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const fakeAgent = { isBusy: () => false, abort: () => {} };
  const { SessionManager } = await import('../src/pi-host.js');
  const mgr = new SessionManager({ sessionsDir: path.join(tmp, 's'), modelConfig: { provider: 'deepseek', model: 'deepseek-flash' }, systemPrompt: 't' });
  mgr.agents.set('g1', fakeAgent);
  bridge.sessionManager = mgr;
  const r = await call(bridge, '/sessions/abort', { method: 'POST', body: { sessionKey: 'g1' } });
  assert.equal(r.data.aborted, false);
  const r2 = await call(bridge, '/sessions/abort', { method: 'POST', body: { sessionKey: 'g404' } });
  assert.equal(r2.status, 404);
  await new Promise((res) => bridge.internalServer.close(res));
  fs.rmSync(tmp, { recursive: true, force: true });
});

for (const [name, promise] of asyncs) {
  await promise;
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
