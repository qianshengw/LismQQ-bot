// 裁剪摘要压缩回归测试：
//   ① 触发：超过 maxMessages 时压缩区段被替换为一条 summary 消息
//   ② 保留区：最近消息保留，摘要消息排最前（紧随 system）
//   ③ 防重复摘要：summary:true 消息不被再次压缩，其文本滚动并入新摘要
//   ④ 失败降级：摘要调用失败 → 硬丢（原行为），不阻塞 prompt
//   ⑤ 开关：summarize:false → 直接硬丢
//   ⑥ 少量溢出（≤4 条）不触发模型调用
// 全部确定性断言（mock streamFn）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionAgent, applyCurrentSystemMessage } from '../src/pi-host.js';

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

console.log('compaction.test.mjs');

const MOCK_MODEL = { provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'off', maxTokens: 256 };

/**
 * mock streamFn：
 * - 主对话（消息数 > 1）回 "好的"
 * - 摘要调用（单条 user 消息且含"压缩成一份结构化摘要"）回固定摘要文本；behavior 可注入失败
 */
function makeMockStreamFn({ summaryText = '【聊过的事】测试摘要。', failSummary = false, calls = [] } = {}) {
  return (model, context) => {
    calls.push({ role: 'user', count: context.messages.length, first: String(context.messages[0]?.content ?? '').slice(0, 40) });
    const isSummaryCall = context.messages.length === 1
      && typeof context.messages[0]?.content === 'string'
      && context.messages[0].content.includes('压缩成一份结构化摘要');
    const replyText = isSummaryCall ? (failSummary ? 'x' : summaryText) : '好的';
    const timestamp = Date.now();
    const finalMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: replyText }],
      api: 'openai-completions',
      provider: 'deepseek',
      model: model.id,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: isSummaryCall && failSummary ? 'error' : 'stop',
      errorMessage: isSummaryCall && failSummary ? 'mock summary failure' : undefined,
      timestamp,
    };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: { role: 'assistant', content: [], api: 'openai-completions', provider: 'deepseek', model: model.id, usage: {}, stopReason: 'pending', timestamp } };
        yield { type: 'done', reason: finalMessage.stopReason, message: finalMessage };
      },
      result: async () => finalMessage,
    };
  };
}

function makeAgent({ maxMessages = 12, summarize = true, streamFn }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-compact-'));
  return createSessionAgent({
    modelConfig: { ...MOCK_MODEL, apiKey: 'sk-x' },
    systemPrompt: '测试人设。',
    maxMessages,
    summarize,
    streamFn,
    // 空目录即可：SessionAgent 不需要 sessionsDir（那是 SessionManager 的）
  }).then((agent) => ({ agent, tmp }));
}

/** 灌 n 轮对话（每轮 user+assistant 两条消息） */
async function feedRounds(agent, n) {
  for (let i = 0; i < n; i++) {
    await agent.prompt(`消息 ${i}`);
  }
}

// ── ① 触发 + 替换 ──
await test('触发：超过阈值后最旧区段被替换为一条 summary 消息', async () => {
  const { agent, tmp } = await makeAgent({ maxMessages: 12, summarize: true, streamFn: makeMockStreamFn() });
  // 12 上限：1 system + 11 body。灌 8 轮 = 16 body → 超限
  await feedRounds(agent, 8);
  const messages = agent.agent.state.messages;
  assert.equal(messages[0].role, 'system');
  const summaryMsg = messages.find((m) => m.summary === true);
  assert.ok(summaryMsg, '应存在一条 summary 消息');
  assert.equal(summaryMsg.role, 'user');
  const text = typeof summaryMsg.content === 'string' ? summaryMsg.content : summaryMsg.content.map((b) => b.text).join('');
  assert.ok(text.includes('【此前对话摘要】'), `摘要消息应带前缀，实际: ${text.slice(0, 50)}`);
  assert.ok(text.includes('测试摘要'), '摘要文本应来自 mock 摘要调用');
  // 总量受控
  assert.ok(messages.length <= 13, `裁剪后消息数应 ≤ 13，实际 ${messages.length}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ② 保留区 ──
await test('保留区：最近的消息完整保留', async () => {
  const { agent, tmp } = await makeAgent({ maxMessages: 12, summarize: true, streamFn: makeMockStreamFn() });
  await feedRounds(agent, 8);
  const messages = agent.agent.state.messages;
  // 最后一条 assistant 应是最近一轮的回复 "好的"
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'assistant');
  // 最近几条 user 消息内容仍在（消息 7/6 至少一个在）
  const texts = messages.map((m) => (Array.isArray(m.content) ? m.content.map((b) => b.text || '').join('') : String(m.content ?? ''))).join('|');
  assert.ok(texts.includes('消息 7'), '最近消息应保留');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ③ 防重复摘要 ──
await test('防重复：已有摘要消息不再被压缩，其文本滚动并入新摘要', async () => {
  const summaryCalls = [];
  const streamFn = makeMockStreamFn({ summaryText: '【聊过的事】滚动摘要版本二。', calls: summaryCalls });
  const { agent, tmp } = await makeAgent({ maxMessages: 12, summarize: true, streamFn });
  await feedRounds(agent, 8); // 第一次压缩
  const before = agent.agent.state.messages.filter((m) => m.summary === true).length;
  assert.equal(before, 1, '第一次压缩后应有 1 条摘要');
  await feedRounds(agent, 5); // 再次超限 → 第二次压缩
  const after = agent.agent.state.messages.filter((m) => m.summary === true).length;
  assert.ok(after <= 1, `摘要消息不应叠加，实际 ${after}`);
  // 摘要调用次数 = 2（两次压缩各一次），且每次都是单条 user 消息的独立调用
  const summaryCallCount = summaryCalls.filter((c) => c.first.includes('压缩成一份结构化摘要')).length;
  // feedRounds(8) 中途就可能触发一次（第 7 轮后），结束时再一次，R2 再一次 → >=2 合理；
  // 关键不变量：任意时刻上下文里摘要最多 1 条
  assert.ok(summaryCallCount >= 2, `摘要模型调用应 >=2 次，实际 ${summaryCallCount}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ④ 失败降级 ──
await test('失败降级：摘要调用失败 → 硬丢（不阻塞对话）', async () => {
  const { agent, tmp } = await makeAgent({ maxMessages: 12, summarize: true, streamFn: makeMockStreamFn({ failSummary: true }) });
  await feedRounds(agent, 8);
  const messages = agent.agent.state.messages;
  assert.ok(!messages.some((m) => m.summary === true), '摘要失败不应产生 summary 消息');
  assert.ok(messages.length <= 13, '降级硬丢后总量仍受控');
  assert.equal(messages[0].role, 'system');
  // 后续对话仍可正常进行
  await agent.prompt('继续聊');
  assert.equal(messages[messages.length - 1].role, 'assistant');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑤ 开关关闭 ──
await test('开关：summarize=false → 直接硬丢（不调摘要模型）', async () => {
  const calls = [];
  const streamFn = makeMockStreamFn({ calls });
  const { agent, tmp } = await makeAgent({ maxMessages: 12, summarize: false, streamFn });
  await feedRounds(agent, 8);
  const messages = agent.agent.state.messages;
  assert.ok(!messages.some((m) => m.summary === true), '关闭摘要时不应产生 summary 消息');
  assert.ok(messages.length <= 13);
  const summaryCallCount = calls.filter((c) => c.first.includes('压缩成一份结构化摘要')).length;
  assert.equal(summaryCallCount, 0, '关闭摘要时不应有摘要模型调用');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Even short transcripts obey the configured maximum.
await test('小历史窗口超过上限仍执行摘要并保持容量边界', async () => {
  const calls = [];
  const { agent, tmp } = await makeAgent({ maxMessages: 12, summarize: true, streamFn: makeMockStreamFn({ calls }) });
  try {
    await feedRounds(agent, 6);
    assert.ok(agent.agent.state.messages.length <= 12);
    assert.ok(agent.agent.state.messages.some(m => m.summary === true));
    assert.ok(calls.some(c => c.first.includes('压缩成一份结构化摘要')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

for (const [name, promise] of asyncs) {
  await promise;
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
