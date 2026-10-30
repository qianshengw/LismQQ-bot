// 批次 C 单测：控制台玩法页的后端端点形状（v1 states/config/activity/flush、v2 memory/reset）。
// 不连 QQ、不跑模型：Bridge 构造 + 内部 HTTP + 直接调 _handleInternal 的 fetch 面。
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

console.log('console-pages.test.mjs');

function makeBridge(configOverrides = {}) {
  const config = {
    qq: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '', accessToken: '' },
    model: { provider: 'deepseek', model: 'deepseek-flash', apiKey: '', baseUrl: 'https://api.deepseek.com' },
    persona: { systemPrompt: 't', name: '小鱼' },
    memory: { enabled: true, maxRecords: 20, maxResults: 3, autoCaptureUtterance: true },
    socialV2: { enabled: true, mode: 'v2', limits: {} },
    socialV1: { enabled: true, mode: 'v1', limits: {} },
    allow: { private: [], groups: [], allowAllWhenEmpty: false },
    deny: { private: [], groups: [] },
    tools: { enabled: false },
    sendDelayMs: 0,
    history: { maxMessages: 50 },
    internalPort: 0,
    ...configOverrides,
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-console-'));
  // config.json 落盘（whitelist/v1 config 写回测试用）
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config), 'utf8');
  return { bridge: new Bridge({ config, rootDir: tmp }), tmp };
}

async function call(bridge, pathname, { method = 'GET', body } = {}) {
  // 直接走 HTTP（bridge._startInternalHttp 已起）
  const headers = { 'x-console-token': bridge.internalToken, 'content-type': 'application/json' };
  const response = await fetch(`http://127.0.0.1:${bridge.internalPort}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

await test('v1 states：初始为空但 enabled', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/api/socialv1/states');
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, true);
  assert.deepEqual(r.data.states, []);
  assert.ok(r.data.config.triggerProbability !== undefined);
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('v1 states：enterActive 后相位可见', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.socialV1.enterActive('g100');
  const r = await call(bridge, '/api/socialv1/states');
  const st = r.data.states.find((s) => s.key === 'g100');
  assert.ok(st, 'g100 应在列表中');
  assert.equal(st.phase, 'active');
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('v1 config：参数写回 config.json 且运行态生效', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/api/socialv1/config', { method: 'POST', body: { triggerProbability: 0.33, mustReplyKeywords: ['小鲸', 'ds'] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.config.triggerProbability, 0.33);
  // 运行态
  assert.equal(bridge.socialV1.limits.triggerProbability, 0.33);
  assert.deepEqual(bridge.socialV1.limits.mustReplyKeywords, ['小鲸', 'ds']);
  // config.json 落盘
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.equal(raw.socialV1.limits.triggerProbability, 0.33);
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('v1 state 手动设相位：active / idle', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r1 = await call(bridge, '/api/socialv1/state', { method: 'POST', body: { sessionKey: 'g200', phase: 'active' } });
  assert.equal(r1.data.phase, 'active');
  assert.equal(bridge.socialV1.state('g200').phase, 'active');
  const r2 = await call(bridge, '/api/socialv1/state', { method: 'POST', body: { sessionKey: 'g200', phase: 'idle' } });
  assert.equal(r2.data.phase, 'idle');
  // 非法 phase 拒绝
  const r3 = await call(bridge, '/api/socialv1/state', { method: 'POST', body: { sessionKey: 'g200', phase: 'probing' } });
  assert.equal(r3.status, 400);
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('v1 flush：无摘要时报错、有摘要时投喂', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r0 = await call(bridge, '/api/socialv1/flush', { method: 'POST', body: { sessionKey: 'g300' } });
  assert.equal(r0.data.ok, false, '无摘要应报错');
  bridge.socialV1.appendSummary('g300', { sender: '甲', text: '一' });
  bridge.socialV1.appendSummary('g300', { sender: '乙', text: '二' });
  let enqueued = null;
  bridge._enqueueV1Turn = (key, promptText) => { enqueued = { key, promptText }; };
  const r = await call(bridge, '/api/socialv1/flush', { method: 'POST', body: { sessionKey: 'g300' } });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.fed, 2);
  assert.ok(enqueued.promptText.includes('甲'), '投递 prompt 应含摘要');
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('v1 activity：日志有界返回', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  for (let i = 0; i < 120; i++) bridge._v1Log('g400', `日志 ${i}`);
  const r = await call(bridge, '/api/socialv1/activity');
  assert.equal(r.data.activity.length, 100);
  assert.equal(r.data.activity[0].line, '日志 119', '最新在前');
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('v2 memory 编辑：append / clear', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.socialV2.get('g500');
  const r1 = await call(bridge, '/api/socialv2/memory', { method: 'POST', body: { sessionKey: 'g500', action: 'append', category: 'topic', text: '测试话题' } });
  assert.equal(r1.data.ok, true);
  assert.ok(r1.data.memory.includes('测试话题'));
  const r2 = await call(bridge, '/api/socialv2/memory', { method: 'POST', body: { sessionKey: 'g500', action: 'clear', category: 'topic' } });
  assert.equal(r2.data.ok, true);
  assert.ok(r2.data.memory.includes('暂无记忆'));
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('v2 reset：删除会话状态', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.socialV2.get('g600');
  bridge.socialV2.appendMemory('g600', { category: 'topic', text: '要被清掉的' });
  const r = await call(bridge, '/api/socialv2/reset', { method: 'POST', body: { sessionKey: 'g600' } });
  assert.equal(r.data.ok, true);
  assert.equal(bridge.socialV2.has('g600'), false);
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('/status 含 simulation 指示', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/status');
  assert.equal(r.data.simulation.v2.enabled, true);
  assert.equal(r.data.simulation.v2.mode, 'v2');
  assert.equal(r.data.simulation.v1.enabled, true);
  assert.equal(r.data.simulation.v1.mode, 'v1');
  bridge.internalServer.closeAllConnections?.();
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

for (const [name, promise] of asyncs) {
  await promise;
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
