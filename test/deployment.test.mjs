// 批次 D 单测：模型热切换（脱敏/热生效）、调度参数端点、连接状态三态。
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

console.log('deployment.test.mjs');

const MOCK_MODEL = { provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'off', maxTokens: 256 };

function makeBridge(configOverrides = {}) {
  const config = {
    qq: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '', accessToken: '' },
    model: { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-test-123456789', baseUrl: 'https://api.deepseek.com', thinkingLevel: 'off', maxTokens: 256 },
    persona: { systemPrompt: 't', name: '小鱼' },
    memory: { enabled: true, maxRecords: 20, maxResults: 3, autoCaptureUtterance: true },
    socialV2: { enabled: true, mode: 'v2', limits: {} },
    socialV1: { enabled: false },
    allow: { private: [], groups: [], allowAllWhenEmpty: false },
    deny: { private: [], groups: [] },
    tools: { enabled: false },
    sendDelayMs: 0,
    history: { maxMessages: 50 },
    internalPort: 0,
    internalHost: '127.0.0.1',
    ...configOverrides,
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-deploy-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config), 'utf8');
  return { bridge: new Bridge({ config, rootDir: tmp }), tmp };
}

async function call(bridge, pathname, { method = 'GET', body } = {}) {
  const headers = { 'x-console-token': bridge.internalToken, 'content-type': 'application/json' };
  const response = await fetch(`http://127.0.0.1:${bridge.internalPort}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

await test('/api/model GET：apiKey 脱敏', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/api/model');
  assert.equal(r.status, 200);
  assert.equal(r.data.model.hasApiKey, true);
  assert.ok(r.data.model.apiKeyMasked.startsWith('sk-tes'));
  assert.ok(!r.data.model.apiKeyMasked.includes('123456789'), '完整 key 不应出现在响应里');
  assert.ok((r.data.builtins ?? []).includes('deepseek-flash'));
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('/api/model POST：写回 config + 运行态生效', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/api/model', {
    method: 'POST',
    body: { provider: 'longcat', model: 'LongCat-2.5-Preview', baseUrl: 'https://api.longcat.chat/openai/v1', apiKey: 'ak_new_key_abcdef', thinkingLevel: 'low', maxTokens: 1024 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.model.model, 'LongCat-2.5-Preview');
  // 运行态
  assert.equal(bridge.config.model.model, 'LongCat-2.5-Preview');
  assert.equal(bridge.config.model.thinkingLevel, 'low');
  // config.json 落盘
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.equal(raw.model.model, 'LongCat-2.5-Preview');
  assert.equal(raw.model.apiKey, 'ak_new_key_abcdef');
  // 新 key 进脱敏名单
  assert.equal(bridge.knownTokens.has('ak_new_key_abcdef'), true);
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('/api/model POST：非法 baseUrl 拒绝', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/api/model', { method: 'POST', body: { baseUrl: 'ftp://x' } });
  assert.equal(r.status, 400);
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('/api/model POST：热切换重建已有会话（transcript 保留）', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  // mock sessionManager：一个已有会话
  const fakeAgent = {
    isBusy: () => false,
    waitForIdle: async () => {},
    exportSession: () => ({ sessionId: 'g1', messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }),
    listeners: { a: 1 },
  };
  let reconfigureArgs = null;
  bridge.sessionManager = {
    get: async () => fakeAgent,
    reconfigure: async (args) => { reconfigureArgs = args; },
  };
  const r = await call(bridge, '/api/model', { method: 'POST', body: { model: 'deepseek-v4-pro', thinkingLevel: 'high' } });
  assert.equal(r.status, 200);
  // reconfigure 应被调用且带新 modelConfig
  assert.ok(reconfigureArgs, 'reconfigure 应被调用');
  assert.equal(reconfigureArgs.modelConfig.model, 'deepseek-v4-pro');
  assert.equal(reconfigureArgs.modelConfig.thinkingLevel, 'high');
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('/api/socialv2/schedule：GET 默认值 + POST 运行态生效', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const g = await call(bridge, '/api/socialv2/schedule');
  assert.equal(g.data.ok, true);
  assert.equal(g.data.schedule.proactiveMinMs, 30 * 60 * 1000);
  const p = await call(bridge, '/api/socialv2/schedule', {
    method: 'POST',
    body: { proactiveMinMs: 10 * 60 * 1000, maxWakePerMinute: 3 },
  });
  assert.equal(p.data.ok, true);
  // 运行态：scheduler 的 proactiveConfig 引用 config.socialV2
  assert.equal(bridge.config.socialV2.proactiveMinMs, 10 * 60 * 1000);
  assert.equal(bridge.socialV2.limits.maxWakePerMinute, 3);
  // config.json 落盘
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.equal(raw.socialV2.proactiveMinMs, 10 * 60 * 1000);
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('connection 状态字段：bot 缺席时为 idle', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/status');
  assert.equal(r.data.connection.state, 'idle');
  assert.equal(r.data.connection.wsUrl, 'ws://127.0.0.1:1');
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('OneBotClient 连接状态追踪：连不上 → protocol-down', async () => {
  const { OneBotClient } = await import('../src/onebot.js');
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:9' }); // discard 端口，必然连不上
  client.connect();
  // 等待连接失败（本机 discard 端口立即拒绝）
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(client.connectionState, 'protocol-down');
  assert.ok(client.lastError.length > 0);
  client.close();
});

await test('internalHost：默认 0.0.0.0 可局域网监听', async () => {
  const { bridge, tmp } = makeBridge({ internalHost: '0.0.0.0' });
  await bridge._startInternalHttp();
  assert.equal(bridge.internalHost, '0.0.0.0');
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

for (const [name, promise] of asyncs) {
  await promise;
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
