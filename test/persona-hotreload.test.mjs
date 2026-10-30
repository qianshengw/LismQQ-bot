// 人设热生效回归测试（三层 bug 修复验证）：
//   F1：POST /api/persona 保存后热生效（reconfigure 重建所有 agent，transcript 保留）
//   F2：恢复的 transcript 首条 system 消息被替换为当前人设（pi 会忽略非首条注入）
//   F3：config inline 值被清空（文件为唯一来源）
// 全部确定性断言；模型走 mock streamFn。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { applyCurrentSystemMessage } from '../src/pi-host.js';

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

console.log('persona-hotreload.test.mjs');

const MOCK_MODEL = { provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'off', maxTokens: 256 };

/** mock streamFn：回显 system prompt 的前 12 字，便于断言模型看到的人设 */
function makeMockStreamFn(scratch) {
  return (model, context) => {
    const systemMsg = context.messages.find((m) => m.role === 'system');
    const systemText = typeof systemMsg?.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg?.content ?? '');
    scratch.push(systemText);
    const stream = {
      async *[Symbol.asyncIterator]() {
        const timestamp = Date.now();
        yield { type: 'start', partial: { role: 'assistant', content: [], api: 'openai-completions', provider: 'deepseek', model: model.id, usage: {}, stopReason: 'pending', timestamp } };
        const finalMessage = {
          role: 'assistant', content: [{ type: 'text', text: '好的' }], api: 'openai-completions', provider: 'deepseek', model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp,
        };
        yield { type: 'done', reason: 'stop', message: finalMessage };
      },
      result: async () => ({
        role: 'assistant', content: [{ type: 'text', text: '好的' }], api: 'openai-completions', provider: 'deepseek', model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now(),
      }),
    };
    return stream;
  };
}

function makeBridge(configOverrides = {}) {
  const config = {
    qq: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '', accessToken: '' },
    model: { ...MOCK_MODEL, apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com' },
    persona: { systemPrompt: '', systemPromptFile: 'roles/default.md' },
    memory: { enabled: false },
    socialV2: { enabled: false },
    socialV1: { enabled: false },
    allow: { private: [], groups: [] },
    deny: { private: [], groups: [] },
    tools: { enabled: false },
    sendDelayMs: 0,
    history: { maxMessages: 50 },
    internalPort: 0,
    internalHost: '127.0.0.1',
    ...configOverrides,
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-persona-'));
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

// ── F2 单元：applyCurrentSystemMessage ──
await test('F2 单元：恢复 transcript 的旧 system 被替换为新 prompt', () => {
  const restored = [
    { role: 'system', content: '旧人设', timestamp: 1 },
    { role: 'user', content: 'hi', timestamp: 2 },
  ];
  const out = applyCurrentSystemMessage(restored, '新海洋风格人设');
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, '新海洋风格人设');
  assert.equal(out[1].role, 'user');
  assert.equal(out.length, 2);
});

await test('F2 单元：无 system 开头的 transcript 前置新 system', () => {
  const out = applyCurrentSystemMessage([{ role: 'user', content: 'hi', timestamp: 1 }], '人设B');
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, '人设B');
});

await test('F2 单元：空 transcript 直接空数组（Agent 自行注入）', () => {
  assert.deepEqual(applyCurrentSystemMessage([], '人设C'), []);
  assert.deepEqual(applyCurrentSystemMessage(undefined, '人设C'), []);
});

await test('F1 端到端：Web 保存人设 → 已存在会话的下一回合用新 system', async () => {
  const { bridge, tmp } = makeBridge();
  fs.mkdirSync(path.join(tmp, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'roles', 'default.md'), '你是 QQ 里的中文聊天助手，口语化、简短。', 'utf8');
  await bridge._startInternalHttp();
  const scratch = [];
  const { SessionManager } = await import('../src/pi-host.js');
  bridge.sessionManager = new SessionManager({
    sessionsDir: path.join(tmp, 'sessions'),
    modelConfig: { ...MOCK_MODEL, apiKey: 'sk-x' },
    systemPrompt: loadSystemPromptOf(bridge),
    maxMessages: 50,
    streamFn: makeMockStreamFn(scratch),
  });
  const agentA = await bridge.sessionManager.get('g200');
  await agentA.prompt('第一轮');
  const oldSystemSeen = scratch[scratch.length - 1];
  assert.ok(oldSystemSeen.includes('口语化'), '初始人设应来自 roles/default.md');

  const r = await call(bridge, '/api/persona', { method: 'POST', body: { content: '你是海洋馆的鲸鱼讲解员，说话带水泡音。' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);

  const agentA2 = await bridge.sessionManager.get('g200'); // reconfigure 重建了实例，重新取
  await agentA2.prompt('第二轮');
  const newSystemSeen = scratch[scratch.length - 1];
  assert.ok(newSystemSeen.includes('鲸鱼讲解员'), `模型应看到新人设，实际: ${newSystemSeen.slice(0, 60)}`);

  const saved = fs.readFileSync(path.join(tmp, 'roles', 'default.md'), 'utf8');
  assert.ok(saved.includes('鲸鱼讲解员'));

  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('F1 端到端：保存后 retire → 重建会话也用新人设', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const { SessionManager } = await import('../src/pi-host.js');
  bridge.sessionManager = new SessionManager({
    sessionsDir: path.join(tmp, 'sessions'),
    modelConfig: { ...MOCK_MODEL, apiKey: 'sk-x' },
    systemPrompt: loadSystemPromptOf(bridge),
    maxMessages: 50,
    streamFn: makeMockStreamFn([]),
  });
  await bridge.sessionManager.get('g300'); // 建立旧会话
  await call(bridge, '/api/persona', { method: 'POST', body: { content: '新人设：沙漠旅人。' } });
  await bridge.sessionManager.retire('g300');
  const agent = await bridge.sessionManager.get('g300');
  const systemMsg = agent.agent.state.messages[0];
  assert.equal(systemMsg.role, 'system');
  assert.ok(String(systemMsg.content).includes('沙漠旅人'), `重建会话的人设应更新，实际: ${String(systemMsg.content).slice(0, 50)}`);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});


await test('F3：保存人设时 config.json 的 inline systemPrompt 被清空', async () => {
  const { bridge, tmp } = makeBridge({
    persona: { systemPrompt: '旧的内联人设（优先级陷阱）', systemPromptFile: 'roles/default.md' },
  });
  await bridge._startInternalHttp();
  // inline 非空时 loadSystemPrompt 优先用它——保存前旧内联生效
  assert.ok(loadSystemPromptOf(bridge).includes('内联'));
  const r = await call(bridge, '/api/persona', { method: 'POST', body: { content: '文件版新人设。' } });
  assert.equal(r.data.ok, true);
  // inline 已清空 → 文件成为来源
  assert.equal(bridge.config.persona.systemPrompt, '');
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.equal(raw.persona.systemPrompt, '');
  assert.equal(loadSystemPromptOf(bridge).includes('文件版新人设'), true);
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function loadSystemPromptOf(bridge) {
  const config = bridge.config;
  const inline = String(config.persona?.systemPrompt ?? '').trim();
  if (inline) return inline;
  const file = String(config.persona?.systemPromptFile ?? '').trim();
  if (file) {
    const filePath = path.isAbsolute(file) ? file : path.join(bridge.rootDir, file);
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch { /* fallthrough */ }
  }
  return '';
}

for (const [name, promise] of asyncs) {
  await promise;
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
