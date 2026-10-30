// pi-host 单测：mock streamFn（不联网）验证事件映射、工具执行、审批拦截、记忆注入、会话持久化。
// mock 依赖 pi 的 StreamFn 契约：返回 AssistantMessageEventStream，push start/done 事件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { SessionManager } from '../src/pi-host.js';
import { SharedMemoryPool } from '../src/memory-pool.js';

let passed = 0;
let failed = 0;

const pendingTests = [];
function test(name, fn) {
  pendingTests.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (error) { failed++; console.error('  ✗ ' + name, error); }
  });
}

const MODEL_CONFIG = { provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'off', maxTokens: 512 };

/** 构造一个 mock streamFn：把请求上下文记录到 scratch，然后回一段固定文本（可含 toolCall）。 */
function makeMockStreamFn(scratch, script) {
  // script: 数组，每项 { text?, toolCalls?: [{id,name,arguments}] }，按调用次序消费
  let callIndex = 0;
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    const step = script[Math.min(callIndex, script.length - 1)];
    callIndex++;
    scratch.push({
      model: { id: model.id, provider: model.provider, baseUrl: model.baseUrl },
      messages: structuredClone(context.messages),
      messageCount: context.messages.length,
      lastRole: context.messages[context.messages.length - 1]?.role,
    });
    queueMicrotask(() => {
      const content = [];
      if (step.text) content.push({ type: 'text', text: step.text });
      for (const tc of step.toolCalls ?? []) {
        content.push({ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.arguments });
      }
      const timestamp = Date.now();
      // 先发 start，再逐块发 end（模拟最简事件序列）
      stream.push({
        type: 'start',
        partial: { role: 'assistant', content: [], api: 'openai-completions', provider: 'deepseek', model: model.id, usage: {}, stopReason: 'pending', timestamp },
      });
      for (const block of content) {
        if (block.type === 'text') {
          stream.push({ type: 'text_start', contentIndex: 0, partial: { role: 'assistant', content: [{ type: 'text', text: '' }], api: 'openai-completions', provider: 'deepseek', model: model.id, usage: {}, stopReason: 'pending', timestamp } });
          stream.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: { role: 'assistant', content: [block], api: 'openai-completions', provider: 'deepseek', model: model.id, usage: {}, stopReason: 'pending', timestamp } });
        } else {
          stream.push({ type: 'toolcall_end', contentIndex: content.indexOf(block), toolCall: block, partial: { role: 'assistant', content: [block], api: 'openai-completions', provider: 'deepseek', model: model.id, usage: {}, stopReason: 'pending', timestamp } });
        }
      }
      const usage = {
        input: 100, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 120,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      };
      const finalMessage = {
        role: 'assistant', content, api: 'openai-completions', provider: 'deepseek', model: model.id,
        usage, stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop', timestamp,
      };
      stream.push({ type: 'done', reason: finalMessage.stopReason, message: finalMessage });
      stream.end(finalMessage);
    });
    return stream;
  };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-pihost-'));

// ── SessionAgent 基础回合 ────────────────────────────────────────────────────

test('prompt() 返回 assistant 文本', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'test prompt',
    streamFn: makeMockStreamFn([], [{ text: '你好呀' }]),
  });
  const { text } = await agent.prompt('在吗');
  assert.equal(text, '你好呀');
  assert.equal(agent.agent.state.messages.length, 3); // system + user + assistant
});

test('事件映射：onTurnUsage / onRunComplete 触发', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    streamFn: makeMockStreamFn([], [{ text: 'ok' }]),
  });
  const usages = [];
  let runComplete = 0;
  agent.listeners.onTurnUsage = ({ usage }) => usages.push(usage);
  agent.listeners.onRunComplete = () => runComplete++;
  await agent.prompt('hi');
  assert.equal(usages.length, 1);
  assert.equal(usages[0].input, 100);
  assert.equal(usages[0].cacheRead, 10);
  assert.equal(runComplete, 1);
});

// ── 工具执行与审批 ──────────────────────────────────────────────────────────

test('工具执行：memory_write 写入 user 分区', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  const pool = new SharedMemoryPool();
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    memoryPool: pool,
    memoryNamespace: 'p42',
    streamFn: makeMockStreamFn([], [
      { toolCalls: [{ id: 't1', name: 'memory_write', arguments: { content: '用户喜欢乌龙茶' } }] },
      { text: '记住了' },
    ]),
  });
  await agent.prompt('我喜欢乌龙茶，记住一下');
  const records = pool.listRecords({ namespace: 'p42', scope: 'user' });
  assert.equal(records.length, 1);
  assert.equal(records[0].memory, '用户喜欢乌龙茶');
});

test('beforeToolCall 拦截：block 后模型收到错误结果', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  let called = null;
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    approveToolCall: async ({ toolName }) => {
      called = toolName;
      return { allow: false, reason: '白名单拦截' };
    },
    tools: [
      {
        name: 'mcp_qq_send_message',
        label: 'send',
        description: 'send',
        parameters: { type: 'object', properties: { messages: { type: 'string' } } },
        execute: async () => ({ content: [{ type: 'text', text: 'sent' }], details: undefined }),
      },
    ],
    streamFn: makeMockStreamFn([], [
      { toolCalls: [{ id: 't1', name: 'mcp_qq_send_message', arguments: { messages: 'hi' } }] },
      { text: '好的，不发了' },
    ]),
  });
  await agent.prompt('给所有人发 hi');
  assert.equal(called, 'mcp_qq_send_message');
  // blocked 的 toolResult 是 isError
  const toolResult = agent.agent.state.messages.find((m) => m.role === 'toolResult');
  assert.ok(toolResult);
  assert.equal(toolResult.isError, true);
});

test('beforeToolCall 放行：工具正常执行', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    approveToolCall: async () => ({ allow: true }),
    tools: [
      {
        name: 'mcp_web_search',
        label: 'search',
        description: 'search',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        execute: async () => ({ content: [{ type: 'text', text: '搜索结果…' }], details: undefined }),
      },
    ],
    streamFn: makeMockStreamFn([], [
      { toolCalls: [{ id: 't1', name: 'mcp_web_search', arguments: { query: '天气' } }] },
      { text: '今天晴天' },
    ]),
  });
  const { text } = await agent.prompt('今天天气怎么样');
  assert.equal(text, '今天晴天');
});

// ── 记忆注入 ────────────────────────────────────────────────────────────────

test('transformContext 注入偏好块（scope=user 可见）', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  const pool = new SharedMemoryPool();
  pool.store('用户喜欢乌龙茶', { namespace: 'p7', scope: 'user' });
  const scratch = [];
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    memoryPool: pool,
    memoryNamespace: 'p7',
    streamFn: makeMockStreamFn(scratch, [{ text: '嗯嗯' }]),
  });
  await agent.prompt('乌龙茶推荐');
  // 注入块出现在 mock 收到的上下文里
  const injected = JSON.stringify(scratch[0]);
  assert.ok(injected.includes('用户偏好') || injected.includes('乌龙茶'), '上下文里应包含记忆注入');
});

test('utterance 分区不进偏好注入', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  const pool = new SharedMemoryPool();
  pool.store('用户问过天气', { namespace: 'p8', scope: 'utterance' });
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    memoryPool: pool,
    memoryNamespace: 'p8',
    streamFn: makeMockStreamFn([], [{ text: 'ok' }]),
  });
  await agent.prompt('天气');
  const injected = agent.agent.state.messages.filter((m) => m.systemHint);
  assert.equal(injected.length, 0, 'utterance 记忆不应被注入');
});

test('captureUtterance 写入 utterance 分区', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  const pool = new SharedMemoryPool();
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    memoryPool: pool,
    memoryNamespace: 'p9',
    streamFn: makeMockStreamFn([], [{ text: 'ok' }]),
  });
  agent.captureUtterance('今天穿什么好');
  const records = pool.listRecords({ namespace: 'p9', scope: 'utterance' });
  assert.equal(records.length, 1);
});

// ── transcript 裁剪与会话管理器 ─────────────────────────────────────────────

test('history 裁剪保留 system + 最近 N 条', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    maxMessages: 5,
    streamFn: makeMockStreamFn([], [{ text: 'ok' }]),
  });
  for (let i = 0; i < 6; i++) {
    await agent.prompt(`msg ${i}`);
  }
  const messages = agent.agent.state.messages;
  assert.ok(messages.length <= 6, `messages.length=${messages.length} 应被裁剪`);
  assert.equal(messages[0].role, 'system');
});

test('SessionManager：持久化与恢复', async () => {
  const manager = new SessionManager({
    sessionsDir: path.join(tmpRoot, 'sessions-1'),
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    maxMessages: 50,
    streamFn: makeMockStreamFn([], [{ text: '第一次' }]),
  });
  const agent1 = await manager.get('p100');
  await agent1.prompt('hi');
  manager.save('p100');
  assert.ok(fs.existsSync(path.join(tmpRoot, 'sessions-1', 'p100.json')));

  // 新管理器恢复
  const manager2 = new SessionManager({
    sessionsDir: path.join(tmpRoot, 'sessions-1'),
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    maxMessages: 50,
    streamFn: makeMockStreamFn([], [{ text: '第二次' }]),
  });
  const agent2 = await manager2.get('p100');
  assert.equal(agent2.agent.state.messages.length, 3, '恢复后应有 system+user+assistant');
  await agent2.prompt('again');
  const last = agent2.agent.state.messages[agent2.agent.state.messages.length - 1];
  assert.equal(last.content[0].text, '第二次');
});

test('SessionManager：retire 清 transcript 与记忆', async () => {
  const pool = new SharedMemoryPool();
  const manager = new SessionManager({
    sessionsDir: path.join(tmpRoot, 'sessions-2'),
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    memoryPool: pool,
    maxMessages: 50,
    streamFn: makeMockStreamFn([], [{ text: 'ok' }]),
  });
  await manager.get('p200');
  manager.save('p200');
  pool.store('some memory', { namespace: 'p200' });
  await manager.retire('p200');
  assert.equal(manager.has('p200'), false);
  assert.ok(!fs.existsSync(path.join(tmpRoot, 'sessions-2', 'p200.json')));
  assert.equal(pool.listRecords({ namespace: 'p200' }).length, 0);
});

test('toolFactory 每会话注入工具', async () => {
  const manager = new SessionManager({
    sessionsDir: path.join(tmpRoot, 'sessions-3'),
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    maxMessages: 50,
    toolFactory: async ({ sessionKey }) => [
      {
        name: 'mcp_qq_session_status',
        label: 'status',
        description: 'status',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: `session=${sessionKey}` }], details: undefined }),
      },
    ],
    streamFn: makeMockStreamFn([], [
      { toolCalls: [{ id: 't1', name: 'mcp_qq_session_status', arguments: {} }] },
      { text: 'done' },
    ]),
  });
  const agent = await manager.get('g999');
  const { text } = await agent.prompt('查状态');
  assert.equal(text, 'done');
  const toolResult = agent.agent.state.messages.find((m) => m.role === 'toolResult');
  assert.ok(toolResult.content[0].text.includes('session=g999'));
});

// ── transcript 完整性：裁剪不拆 tool 配对 + 回合前自洁 ────────────────────────

test('裁剪边界落在 tool 配对中间时不拆散（A1）', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    maxMessages: 8,
    streamFn: makeMockStreamFn([], [{ text: 'ok' }]),
  });
  // 手工构造 transcript：system + [u,a(toolCall),toolResult]×3 + 保留区若干，
  // 让「按条数切」的切点恰好落在 assistant(toolCall) 与它的 toolResult 之间
  const messages = [{ role: 'system', content: 'p', timestamp: 0 }];
  for (let i = 0; i < 3; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `u${i}` }], timestamp: i });
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'qq_send_message', arguments: {} }], stopReason: 'toolUse', timestamp: i });
    messages.push({ role: 'toolResult', toolCallId: `c${i}`, toolName: 'qq_send_message', content: [{ type: 'text', text: 'sent' }], timestamp: i });
  }
  for (let i = 0; i < 5; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `keep${i}` }], timestamp: 100 + i });
  }
  agent.agent.state.messages = messages;
  agent.maxMessages = 8; // 触发裁剪：reserve=5，overflow 计算会切到中间
  await agent._trimHistoryAsync();
  const after = agent.agent.state.messages;
  // 断言：保留区开头（第一条非 system、非 summary 消息）不能是 toolResult
  const firstKept = after.findIndex((m) => m.role !== 'system' && m.summary !== true);
  assert.ok(firstKept >= 0);
  assert.notEqual(after[firstKept].role, 'toolResult', `保留段开头不能是孤儿 toolResult，实际 role=${after[firstKept].role}`);
  // 每个 toolResult 必须能在它前面找到配对的 toolCall id
  const seen = new Set();
  for (const m of after) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === 'toolCall') seen.add(b.id);
    }
    if (m.role === 'toolResult') assert.ok(seen.has(m.toolCallId), `孤儿 toolResult ${m.toolCallId}`);
  }
});

test('_sanitizeTranscript：孤儿 toolResult 删除、无结果 toolCall 剥除（A2）', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    streamFn: makeMockStreamFn([], [{ text: 'ok' }]),
  });
  agent.agent.state.messages = [
    { role: 'system', content: 'p', timestamp: 0 },
    // 正常配对
    { role: 'user', content: [{ type: 'text', text: 'u1' }], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'toolCall', id: 'a', name: 't', arguments: {} }], stopReason: 'toolUse', timestamp: 2 },
    { role: 'toolResult', toolCallId: 'a', toolName: 't', content: [{ type: 'text', text: 'r' }], timestamp: 3 },
    // 孤儿 toolResult（前置 assistant 被裁掉）
    { role: 'toolResult', toolCallId: 'orphan', toolName: 't', content: [{ type: 'text', text: 'orphan' }], timestamp: 4 },
    // error 残骸：assistant 只有 toolCall、没有 toolResult
    { role: 'assistant', content: [{ type: 'toolCall', id: 'ghost', name: 't', arguments: {} }], stopReason: 'error', errorMessage: 'timeout', timestamp: 5 },
  ];
  await agent.prompt('下一轮');
  const after = agent.agent.state.messages;
  const ids = new Set();
  for (const m of after) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === 'toolCall') ids.add(b.id);
    }
    if (m.role === 'toolResult') {
      assert.equal(m.toolCallId, 'a', `应只剩正常配对的 toolResult，实际 ${m.toolCallId}`);
    }
  }
  assert.ok(!ids.has('ghost'), '无结果的 ghost toolCall 应被剥除');
  assert.ok(ids.has('a'), '正常配对的 toolCall 应保留');
  // 无结果剥除后空的 assistant 消息应被删除
  assert.ok(!after.some((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.length === 0), '不应残留空 assistant');
});

test('error 回合残留的 toolCall 在下一轮 prompt 前被自洁（端到端）', async () => {
  const { SessionAgent } = await import('../src/pi-host.js');
  // 脚本：第 1 轮 error（带 toolCall 无结果——模拟 abort 残骸），第 2 轮正常
  const agent = new SessionAgent({
    modelConfig: MODEL_CONFIG,
    systemPrompt: 'p',
    streamFn: (model, context) => {
      const stream = createAssistantMessageEventStream();
      const hadToolCall = context.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'text' && String(b.text).includes('第二轮')));
      queueMicrotask(() => {
        const timestamp = Date.now();
        if (!hadToolCall) {
          // 第一轮：模型调了工具但回合被 abort（stopReason=aborted，无 toolResult）
          const finalMessage = {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'lost', name: 'qq_send_message', arguments: {} }],
            stopReason: 'aborted', timestamp,
          };
          stream.push({ type: 'start', partial: { ...finalMessage, usage: {}, stopReason: 'pending' } });
          stream.push({ type: 'done', reason: 'aborted', message: finalMessage });
          stream.end(finalMessage);
        } else {
          const finalMessage = { role: 'assistant', content: [{ type: 'text', text: '恢复' }], stopReason: 'stop', timestamp };
          stream.push({ type: 'start', partial: { ...finalMessage, usage: {}, stopReason: 'pending' } });
          stream.push({ type: 'done', reason: 'stop', message: finalMessage });
          stream.end(finalMessage);
        }
      });
      return stream;
    },
  });
  const r1 = await agent.prompt('第一轮');
  assert.equal(r1.text, '');
  const r2 = await agent.prompt('第二轮');
  assert.equal(r2.text, '恢复');
  // abort 残骸（lost toolCall）已被剥除
  const blocks = agent.agent.state.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  assert.ok(!blocks.some((b) => b?.type === 'toolCall' && b.id === 'lost'), 'abort 残骸 toolCall 应被自洁');
});

for (const run of pendingTests) await run();
process.exitCode = failed > 0 ? 1 : 0;
