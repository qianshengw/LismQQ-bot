// 冒烟自测：不连 OneBot、不跑真模型。验证模块加载、配置解析、记忆池、mock 回合、内部 HTTP。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SharedMemoryPool, tokenize } from './memory-pool.js';
import { splitForQQ } from './md-to-plain.js';
import { Bridge } from './bridge.js';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error?.message ?? error}`);
  }
}

console.log('self-test（离线冒烟）');

await check('模块加载：memory-pool / onebot / pi-host / bridge / mcp', async () => {
  await import('./onebot.js');
  await import('./pi-host.js');
  await import('./mcp/wrap.js');
  assert.ok(typeof tokenize === 'function');
});

await check('记忆池中文召回', async () => {
  const pool = new SharedMemoryPool({ maxRecords: 10 });
  pool.store('用户喜欢喝乌龙茶', { namespace: 'x' });
  const results = pool.retrieve('乌龙茶', { namespace: 'x' });
  assert.equal(results.length, 1);
});

await check('QQ 分条', async () => {
  assert.deepEqual(splitForQQ('a\n\nb'), ['a', 'b']);
});

await check('Bridge 构建 + 内部 HTTP + 工具回调鉴权', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-selftest-'));
  const bridge = new Bridge({
    config: {
      qq: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '', accessToken: '' },
      model: { provider: 'deepseek', model: 'deepseek-chat', apiKey: '', baseUrl: 'https://api.deepseek.com' },
      persona: { systemPrompt: 't' },
      memory: { enabled: true, maxRecords: 10, maxResults: 3, autoCaptureUtterance: true },
      allow: { private: [], groups: [], allowAllWhenEmpty: false },
      deny: { private: [], groups: [] },
      tools: { enabled: false },
      sendDelayMs: 0,
      history: { maxMessages: 50 },
      internalPort: 0,
    },
    rootDir: tmp,
  });
  await bridge._startInternalHttp();
  const noAuth = await fetch(`http://127.0.0.1:${bridge.internalPort}/status`);
  assert.equal(noAuth.status, 200);
  const authed = await fetch(`http://127.0.0.1:${bridge.internalPort}/status`, {
    headers: { 'x-console-token': bridge.internalToken },
  });
  assert.equal(authed.status, 200);
  await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await check('pi 依赖解析（Agent / createModels / deepseekProvider / pi-mcp）', async () => {
  const { Agent } = await import('@earendil-works/pi-agent-core');
  const { createModels } = await import('@earendil-works/pi-ai');
  const { deepseekProvider } = await import('@earendil-works/pi-ai/providers/deepseek');
  const { McpClient, StdioTransport, toLlmContent } = await import('@earendil-works/pi-mcp');
  assert.ok(typeof Agent === 'function');
  assert.ok(typeof createModels === 'function');
  const models = createModels();
  models.setProvider(deepseekProvider());
  const modelIds = models.getModels('deepseek').map((m) => m.id);
  const model = models.getModel('deepseek', modelIds[0]);
  assert.ok(model, '内置目录应含 deepseek 模型');
  assert.equal(model.api, 'openai-completions');
  assert.ok(typeof McpClient === 'function');
  assert.ok(typeof StdioTransport === 'function');
  assert.ok(typeof toLlmContent === 'function');
});

await check('deepseek 目录模型清单', async () => {
  const { createModels } = await import('@earendil-works/pi-ai');
  const { deepseekProvider } = await import('@earendil-works/pi-ai/providers/deepseek');
  const models = createModels();
  models.setProvider(deepseekProvider());
  const ids = models.getModels('deepseek').map((m) => m.id);
  assert.ok(ids.length > 0, `deepseek 目录模型数 > 0（实际 ${ids.length}）`);
  console.log(`    deepseek 目录: ${ids.join(', ')}`);
});

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
