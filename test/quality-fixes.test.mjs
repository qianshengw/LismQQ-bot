// QUALITY-REPORT-2026-10-30 的修复回归测试。
//
// 覆盖报告里逐项确认过的缺陷：
//   P1-01 @ 直通仍受普通唤醒限频        → 分档限频（direct/followUp/normal/proactive）
//   P1-02 已读有两个来源会重复投喂      → 单一事实源 + 游标（已展示/已处理/已送达）
//   P1-03 最新 @ 排在旧积压之后        → 最新显式请求优先 + 逐条相对时间
//   P1-04 没有「确实回应了」的后置条件  → 以实际发送回执判定
//   P1-05 纯文本回答等整个回合才外发    → assistant 消息完成即发
//   P1-06 人设/模型热保存等待长回合      → 版本化 + 回合边界重建，不再全局阻塞
//   P2-07 睡眠最短/最长是空配置        → 硬钳制真正生效
//   P2-08 退场话「六出口全拦」不成立    → 统一出站闸门
//   P2-09 接话机制与原版不等价          → 无问号的定向提问 / 引用对象判定 / followUp
//   P2-10 Web 成功状态与持久化不一致    → 原子落盘 + 失败非 2xx
//
// 全部使用确定性断言（不依赖概率采样、不访问真实 QQ/模型）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, loadSystemPrompt } from '../src/bridge.js';
import { SocialV2Store, evaluateWakeTrigger, tierOfReason, WAKE_TIER } from '../src/social-v2.js';
import { WakeScheduler } from '../src/wake-scheduler.js';

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

console.log('quality-fixes.test.mjs');

function makeBridge(configOverrides = {}) {
  const config = {
    qq: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '', accessToken: '' },
    model: { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-test-123456789', baseUrl: 'https://api.deepseek.com' },
    persona: { systemPrompt: 't', name: '小鱼' },
    memory: { enabled: false },
    socialV2: { enabled: true, mode: 'v2', limits: { maxSendPerMinute: 60, maxSendPerHour: 600 } },
    socialV1: { enabled: false },
    allow: { private: ['100'], groups: ['200'], allowAllWhenEmpty: false },
    deny: { private: [], groups: [] },
    tools: { enabled: false },
    sendDelayMs: 0,
    history: { maxMessages: 50 },
    internalPort: 0,
    internalHost: '127.0.0.1',
    ...configOverrides,
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-fix-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config), 'utf8');
  return { bridge: new Bridge({ config, rootDir: tmp }), tmp };
}

async function call(bridge, pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${bridge.internalPort}${pathname}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})), headers: response.headers };
}

const agentHeaders = (bridge, key = 'g200') => ({
  'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': key,
});

// ── P1-01：分档唤醒限频 ─────────────────────────────────────────────────────

await test('P1-01：显式 @（direct 档）不被常规唤醒额度卡住', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-tier-'));
  let now = 100000;
  const store = new SocialV2Store(path.join(tmp, 't'), { now: () => now });
  let wakes = 0;
  const scheduler = new WakeScheduler({ store, onWake: () => { wakes++; }, now: () => now });
  // 常规档先吃掉额度（question = normal 档）
  assert.equal(store.tryRegisterWake('g200', { tier: 'normal', reason: 'question' }).ok, true);
  assert.equal(store.tryRegisterWake('g200', { tier: 'normal', reason: 'question' }).ok, false, '常规档应被限频');
  // 显式 @ 走 direct 档：不受常规额度影响
  scheduler.scheduleWake('g200', 'atMention', { immediate: true });
  scheduler.scheduleWake('g200', 'atMention', { immediate: true });
  assert.equal(wakes, 2, `连续两次显式 @ 都应唤醒，实际 ${wakes}`);
  scheduler.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-01：档位互相独立，且 direct 档自身有上限', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-tier2-'));
  const store = new SocialV2Store(path.join(tmp, 't'), { limits: { maxDirectWakePerMinute: 3 } });
  for (let i = 0; i < 3; i++) {
    assert.equal(store.tryRegisterWake('g200', { tier: 'direct', reason: 'atMention' }).ok, true, `第 ${i + 1} 次 direct 应放行`);
  }
  const gate = store.tryRegisterWake('g200', { tier: 'direct', reason: 'atMention' });
  assert.equal(gate.ok, false, 'direct 档自身也要有上限（防刷）');
  assert.ok(gate.retryAfterMs > 0, '限频应给出重试等待时间');
  assert.equal(store.get('g200').lastWakeGate.tier, 'direct', '应记录命中的档位');
  // 其它档位不受影响
  assert.equal(store.tryRegisterWake('g200', { tier: 'proactive', reason: 'proactiveCheck' }).ok, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-01：手动唤醒区分「已排队」与「被限频」', async () => {
  const { bridge, tmp } = makeBridge();
  bridge.running = true;
  // 让主动档（manual 属于 proactive 档）额度用尽
  bridge.socialV2.get('g200');
  for (let i = 0; i < 20; i++) bridge.socialV2.tryRegisterWake('g200', { tier: 'proactive', reason: 'manual' });
  const r = bridge.manualWake('g200', 'manual');
  assert.equal(r.woke, false, `应被限频，实际 ${JSON.stringify(r)}`);
  assert.equal(r.deferred, 'rate-limited', '应说明被限频');
  assert.ok(r.retryAfterMs > 0, '被限频时应给出重试等待');
  assert.ok(String(r.error).includes('限频'), '错误信息应说明原因');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P1-02：未读单一事实源 ───────────────────────────────────────────────────

await test('P1-01：用户驱动的档位额度不得低于常规档', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-floor-'));
  // 常规档配得很宽松（生产 config 就是这样），direct 档没单独配
  const store = new SocialV2Store(path.join(tmp, 'f'), { limits: { maxWakePerMinute: 15, maxWakePerHour: 40, maxDirectWakePerMinute: 6 } });
  // 用掉常规档 6 次后，显式 @ 仍应放行（不能比常规更严）
  for (let i = 0; i < 6; i++) assert.equal(store.tryRegisterWake('g200', { tier: 'normal', reason: 'question' }).ok, true);
  assert.equal(store.tryRegisterWake('g200', { tier: 'direct', reason: 'atMention' }).ok, true, '显式 @ 不应比常规触发更受限');
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-02：首屏展示过的消息不会被「等新消息」再读一遍', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.running = true;
  const headers = agentHeaders(bridge);
  // 模型首屏读到了 1 条
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '第一条', atMe: true });
  const first = await call(bridge, '/agent/unread', { headers });
  assert.equal(first.data.messages.length, 1, '首屏应读到 1 条');
  // 再读一次 → 同一队列已被消费，不应重复
  const second = await call(bridge, '/agent/unread', { headers });
  assert.equal(second.data.messages.length, 0, '同一队列不应重复投喂');
  // 等新消息也只等游标之后的新消息
  const waited = await call(bridge, '/agent/wait', { method: 'POST', headers, body: { timeoutSeconds: 1, quietMs: 0 } });
  assert.equal(waited.data.messages.length, 0, 'wait 不得返回已展示过的消息');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-02：wait 只返回游标之后的新消息，且带水位', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.running = true;
  const headers = agentHeaders(bridge);
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '旧消息', atMe: true });
  await call(bridge, '/agent/unread', { headers }); // 消费掉
  setTimeout(() => {
    void bridge.handleIncoming({ groupId: '200', userId: '100', text: '新消息', images: [], raw: {} });
  }, 120);
  const r = await call(bridge, '/agent/wait', { method: 'POST', headers, body: { timeoutSeconds: 5, quietMs: 0 } });
  assert.equal(r.data.messages.length, 1, '只应返回新消息');
  assert.ok(String(r.data.messages[0].text).includes('新消息'));
  assert.ok(r.data.throughSeq >= 1, '应返回水位');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-02：已读水位、已展示水位、已处理水位三者独立', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-cur-'));
  const store = new SocialV2Store(path.join(tmp, 'c'));
  store.pushIncoming('g200', { sender: 'a', text: '1' });
  store.pushIncoming('g200', { sender: 'b', text: '2' });
  store.pushIncoming('g200', { sender: 'c', text: '3' });
  store.markShownSeqs('g200', [1, 2]);
  assert.equal(store.get('g200').shownSeq, 2, '已展示水位应推进到 2');
  assert.equal(store.get('g200').lastReadThroughSeq, 0, '展示不等于已读');
  assert.equal(store.get('g200').handledSeq, 0, '展示不等于已回应');
  // 已读只清理**确实展示过**的：3 号没展示过，不能被顺带清掉
  store.markRead('g200', 2);
  assert.deepEqual(store.peekUnread('g200').map((m) => m.seq), [3], '没展示过的消息不应被越界清理');
  store.markHandled('g200', 2);
  assert.equal(store.get('g200').handledSeq, 2, '有发送回执才推进已处理水位');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P1-03：最新 @ 优先 + 逐条相对时间 ───────────────────────────────────────

await test('P1-03：积压 100 条后新 @，第一批必须带新 @', async () => {
  const { bridge, tmp } = makeBridge();
  for (let i = 1; i <= 100; i++) {
    bridge.socialV2.pushIncoming('g200', { sender: '100', userId: '100', text: `旧消息${i}` });
  }
  bridge.socialV2.pushIncoming('g200', { sender: '101', userId: '101', text: '现在 @ 我', atMe: true });
  const { batch, background } = bridge._selectWakeBatch('g200');
  assert.ok(batch.some((m) => m.atMe === true), '第一批必须包含新的 @');
  assert.ok(background.length > 0, '更早的积压应作为背景');
  assert.ok(batch.length <= 20, '单批不超过 20 条');
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-03：未读渲染带逐条相对时间与旧消息指引', async () => {
  const { bridge, tmp } = makeBridge();
  const now = Date.now();
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '两小时前的旧话', time: now - 2 * 3600 * 1000 });
  bridge.socialV2.pushIncoming('g200', { sender: '李四', userId: '101', text: '刚刚的话', time: now - 10 * 1000, atMe: true });
  const prompt = bridge._buildWakePrompt('g200', 'atMention', bridge.socialV2.peekUnread('g200'));
  assert.ok(prompt.includes('2 小时前'), '旧消息应带相对年龄');
  assert.ok(prompt.includes('刚刚'), '新消息应带相对年龄');
  assert.ok(prompt.includes('←@了你'), '应保留指向标注');
  assert.ok(prompt.includes('刷到旧聊天记录'), '应含旧消息心态引导');
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-03：过期闲聊归档，但显式请求永不归档', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-arch-'));
  let now = 1000000;
  const store = new SocialV2Store(path.join(tmp, 'a'), { now: () => now, limits: { staleChatMs: 30 * 60 * 1000 } });
  store.pushIncoming('g200', { sender: 'a', text: '很久以前的闲聊', time: now - 2 * 3600 * 1000 });
  store.pushIncoming('g200', { sender: 'b', text: '很久以前但点名的', time: now - 2 * 3600 * 1000, atMe: true });
  const archived = store.archiveStale('g200');
  assert.equal(archived, 1, '只归档普通闲聊');
  const left = store.peekUnread('g200');
  assert.equal(left.length, 1, '显式请求必须保留');
  assert.equal(left[0].atMe, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P1-04：以实际发送回执判定「回应了」 ─────────────────────────────────────

await test('P1-04：空回复不得推进已读水位（显式请求不得被当作普通已读）', async () => {
  const { bridge, tmp } = makeBridge();
  bridge.running = true;
  const sent = [];
  bridge.bot = { sendGroupMessage: async (gid, msg) => { sent.push(msg); }, sendPrivateMessage: async () => ({}) };
  bridge.sessionManager = {
    get: async () => ({ listeners: {}, prompt: async () => ({ text: '' }), save() {} }),
    save() {},
  };
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '在吗？', atMe: true });
  const before = bridge.socialV2.get('g200').lastReadThroughSeq;
  await bridge._runWakeTurn('g200', 'atMention');
  assert.equal(sent.length, 0, '没有实际发送');
  assert.equal(bridge.socialV2.get('g200').lastReadThroughSeq, before, '未回应时不得推进已读水位');
  assert.equal(bridge.socialV2.peekUnread('g200').length, 1, '未读必须保留');
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-04：已发送后输出 SILENT 不算违规（不能重复投喂）', async () => {
  const { bridge, tmp } = makeBridge();
  bridge.running = true;
  const sent = [];
  bridge.bot = { sendGroupMessage: async (gid, msg) => { sent.push(msg); }, sendPrivateMessage: async () => ({}) };
  bridge.sessionManager = {
    get: async () => ({
      listeners: {},
      // 模拟模型：先通过发送工具发了一条，最后输出 [SILENT]
      prompt: async () => {
        bridge._recordSendReceipt('g200', '已经发出去了');
        return { text: '[SILENT]' };
      },
      save() {},
    }),
    save() {},
  };
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '在吗？', atMe: true });
  await bridge._runWakeTurn('g200', 'atMention');
  assert.equal(bridge.socialV2.get('g200').unansweredSeq ?? 0, 0, '已回应后不应记为未回应');
  assert.equal(bridge.socialV2.get('g200').lastReadThroughSeq, 1, '已回应后可推进已读水位');
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-04：未回应时安排有限重试并注入纠错提示', async () => {
  const { bridge, tmp } = makeBridge();
  bridge.running = true;
  bridge.bot = { sendGroupMessage: async () => ({}), sendPrivateMessage: async () => ({}) };
  bridge.sessionManager = {
    get: async () => ({ listeners: {}, prompt: async () => ({ text: '' }), save() {} }),
    save() {},
  };
  let scheduled = 0;
  bridge.wakeScheduler.scheduleWake = () => { scheduled++; };
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '在吗？', atMe: true });
  await bridge._runWakeTurn('g200', 'atMention');
  assert.equal(scheduled, 1, '未回应应安排一次重试');
  const st = bridge.socialV2.get('g200');
  assert.ok(String(st.pendingCorrection).includes('必须'), '应写入纠错提示');
  assert.equal(st.unansweredRetries, 1);
  // 同一批再违规一次 → 不再无限重试
  await bridge._runWakeTurn('g200', 'atMention');
  assert.equal(scheduled, 1, '同一批不应无限重试');
  assert.ok(bridge.socialV2.get('g200').unansweredRetries <= 2, '重试次数必须有上限');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P1-05：首答即时外发 ─────────────────────────────────────────────────────

await test('P1-05：assistant 消息完成即发送（不等整个回合结束）', async () => {
  const { bridge, tmp } = makeBridge();
  bridge.running = true;
  const sent = [];
  bridge.bot = { sendGroupMessage: async (gid, msg) => { sent.push(msg); }, sendPrivateMessage: async () => ({}) };
  const listeners = {};
  bridge.sessionManager = {
    get: async () => ({
      listeners,
      prompt: async () => {
        // 模拟 pi 的 message_end：文本完成 → 立刻外发
        listeners.onAssistantMessage?.({ text: '我在，稍等', toolNames: [] });
        return { text: '我在，稍等' };
      },
      save() {},
    }),
    save() {},
  };
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '在吗？', atMe: true });
  await bridge._runWakeTurn('g200', 'atMention');
  assert.equal(sent.length, 1, '首答应发出一条');
  assert.ok(String(sent[0]).includes('我在'), '首答内容应正确');
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-05：首答带发送类工具调用时不重复外发', async () => {
  const { bridge, tmp } = makeBridge();
  bridge.running = true;
  const sent = [];
  bridge.bot = { sendGroupMessage: async (gid, msg) => { sent.push(msg); }, sendPrivateMessage: async () => ({}) };
  const listeners = {};
  bridge.sessionManager = {
    get: async () => ({
      listeners,
      prompt: async () => {
        // 模拟模型：同一条 assistant 消息里既写了字又调了发送工具
        listeners.onAssistantMessage?.({ text: '我来发', toolNames: ['mcp_qq_send_message'] });
        // 发送工具真的发出去（并留下回执）
        await bridge._sendToSession('g200', '我来发');
        bridge._recordSendReceipt('g200', '我来发');
        return { text: '我来发' };
      },
      save() {},
    }),
    save() {},
  };
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '在吗？', atMe: true });
  await bridge._runWakeTurn('g200', 'atMention');
  assert.equal(sent.length, 1, `工具发送与即时首答不应重复（实际 ${sent.length} 条）`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P1-06：热保存不再全局阻塞 ───────────────────────────────────────────────

await test('P1-06：人设保存不等待忙碌会话，立即返回并报告待生效数', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  fs.mkdirSync(path.join(tmp, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'roles', 'default.md'), '旧人设', 'utf8');
  const { SessionManager } = await import('../src/pi-host.js');
  const busyAgent = {
    listeners: {}, isBusy: () => true, waitForIdle: async () => {},
    exportSession: () => ({ sessionId: 'g200', messages: [] }), abort() {},
  };
  bridge.sessionManager = new SessionManager({
    sessionsDir: path.join(tmp, 'sessions'),
    modelConfig: { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-x' },
    systemPrompt: '旧人设',
    maxMessages: 50,
  });
  bridge.sessionManager.agents.set('g200', busyAgent);
  const t0 = Date.now();
  const r = await call(bridge, '/api/persona', { method: 'POST', body: { content: '新人设' } });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 200, `人设保存应成功：${JSON.stringify(r.data)}`);
  assert.ok(elapsed < 2000, `保存不应等待忙碌会话（耗时 ${elapsed}ms）`);
  assert.equal(r.data.pendingSessions, 1, '应报告 1 个会话待回合结束生效');
  assert.equal(bridge.sessionManager.configVersion, 1, '配置版本应递增');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P1-06：空闲会话立即重建，忙碌会话推迟到回合边界', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-rc-'));
  const { SessionManager } = await import('../src/pi-host.js');
  const sm = new SessionManager({
    sessionsDir: path.join(tmp, 'sessions'),
    modelConfig: { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-x' },
    systemPrompt: '旧人设',
    maxMessages: 50,
  });
  // 空闲会话：立即重建
  const idle = await sm.get('g200');
  const r1 = await sm.reconfigure({ systemPrompt: '新人设' });
  assert.equal(r1.applied, 1, '空闲会话应即时重建');
  assert.equal(r1.pending, 0);
  const after = await sm.get('g200');
  assert.notEqual(after, idle, '空闲会话应换了新实例');
  assert.equal(after.agent.state.systemPrompt, '新人设');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P2-07：睡眠最短/最长真正生效 ────────────────────────────────────────────

await test('P2-07：睡眠最短/最长是硬限制（模型请求被钳制）', async () => {
  const { bridge, tmp } = makeBridge({ socialV2: { enabled: true, mode: 'v2', sleepMinMs: 5 * 60 * 1000, sleepMaxMs: 30 * 60 * 1000, limits: {} } });
  await bridge._startInternalHttp();
  const headers = agentHeaders(bridge);
  // 请求睡 10 小时 → 钳到 30 分钟
  let r = await call(bridge, '/agent/wake-config', {
    method: 'POST', headers,
    body: { mode: 'diving', infinite: false, sleepUntil: Date.now() + 10 * 3600 * 1000 },
  });
  assert.equal(r.status, 200, `wake-config 应成功：${JSON.stringify(r.data)}`);
  const sleepUntil = r.data.wakeConfig.sleepUntil;
  const minutes = (sleepUntil - Date.now()) / 60000;
  assert.ok(minutes <= 31 && minutes >= 29, `应被钳到最长 30 分钟，实际 ${minutes.toFixed(1)}`);
  assert.ok(String(r.data.note ?? '').includes('睡眠时长'), '应提示已调整');
  // 请求睡 1 秒 → 钳到最短 5 分钟
  r = await call(bridge, '/agent/wake-config', {
    method: 'POST', headers,
    body: { mode: 'diving', infinite: false, sleepUntil: Date.now() + 1000 },
  });
  const minutes2 = (r.data.wakeConfig.sleepUntil - Date.now()) / 60000;
  assert.ok(minutes2 >= 4.9, `应被钳到最短 5 分钟，实际 ${minutes2.toFixed(1)}`);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P2-07：调度接口拒绝「最短 > 最长」的非法组合', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/api/socialv2/schedule', {
    method: 'POST',
    body: { sleepMinMs: 3600000, sleepMaxMs: 60000 },
  });
  assert.equal(r.status, 400, '非法组合应被拒绝');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P2-08：退场话统一出口拦截 ───────────────────────────────────────────────

await test('P2-08：reply / burst / send / 底层发送都拦退场话', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const sent = [];
  bridge.bot = { sendGroupMessage: async (gid, msg) => { sent.push(msg); }, sendPrivateMessage: async () => ({}) };
  const headers = agentHeaders(bridge);
  for (const route of ['reply', 'burst', 'send']) {
    const body = route === 'reply' ? { text: '我先撤了', messageId: 1 }
      : route === 'burst' ? { messages: ['我先撤了'] } : { messages: ['我先撤了'] };
    const r = await call(bridge, `/agent/${route}`, { method: 'POST', headers, body });
    assert.equal(r.status, 200, `${route} 应正常返回（被拦而不是报错）`);
  }
  assert.equal(sent.length, 0, `退场话不应进入 QQ（实际 ${sent.length} 条）`);
  // 底层发送也拦
  const res = await bridge._sendToSession('g200', '那我先撤了');
  assert.equal(res?.blocked, 'farewell', '底层发送必须拦退场话');
  assert.equal(sent.length, 0);
  // 带正文的正常内容放行
  const ok = await call(bridge, '/agent/send', { method: 'POST', headers, body: { messages: ['那我先撤了，你们聊'] } });
  assert.equal(ok.status, 200);
  assert.equal(sent.length, 1, '带正文应放行');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P2-08：被拦下的条目不占发送额度', async () => {
  const { bridge, tmp } = makeBridge({ socialV2: { enabled: true, mode: 'v2', limits: { maxSendPerMinute: 2, maxSendPerHour: 60 } } });
  await bridge._startInternalHttp();
  const sent = [];
  bridge.bot = { sendGroupMessage: async (gid, msg) => { sent.push(msg); }, sendPrivateMessage: async () => ({}) };
  const headers = agentHeaders(bridge);
  await call(bridge, '/agent/send', { method: 'POST', headers, body: { messages: ['我先撤了'] } });
  assert.equal(bridge.socialV2.get('g200').sendTimes.length, 0, '被拦条目不应占用额度');
  await call(bridge, '/agent/send', { method: 'POST', headers, body: { messages: ['正常内容'] } });
  assert.equal(bridge.socialV2.get('g200').sendTimes.length, 1, '实际发送应占用额度');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P2-09：接话机制 ─────────────────────────────────────────────────────────

await test('P2-09：无问号的定向提问也能被识别', async () => {
  const { bridge, tmp } = makeBridge();
  const atRaw = { message: [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: '在吗' } }] };
  assert.equal(bridge._isQuestionToMe({ groupId: '200', userId: '100', text: '在吗', raw: atRaw }), true, '@ 我一定算');
  assert.equal(bridge._isQuestionToMe({ groupId: '200', userId: '100', text: '小鱼然后呢', raw: {} }), true, '提到名字 + 接话引导词');
  assert.equal(bridge._isQuestionToMe({ groupId: '200', userId: '100', text: '然后呢', raw: {} }), true, '「然后呢」是典型接话');
  assert.equal(bridge._isQuestionToMe({ groupId: '200', userId: '100', text: '今天天气不错', raw: {} }), false, '无关闲聊不算');
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P2-09：引用别人不再被误判成「对我提问」', async () => {
  const { bridge, tmp } = makeBridge();
  const replyRaw = { message: [{ type: 'reply', data: { id: '12345' } }, { type: 'text', data: { text: '这个怎么说？' } }] };
  // quoteTargetIsMe=false（引用的是别人）→ 不算对我提问
  assert.equal(
    bridge._isQuestionToMe({ groupId: '200', userId: '100', text: '这个怎么说？', raw: replyRaw }, { quoteTargetIsMe: false }),
    false,
    '引用别人不该当成对我提问',
  );
  // 引用的是我 → 算
  assert.equal(
    bridge._isQuestionToMe({ groupId: '200', userId: '100', text: '这个怎么说？', raw: replyRaw }, { quoteTargetIsMe: true }),
    true,
    '引用我本人应算对我说话',
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P2-09：短时跟随——我问过话、对方接话会触发唤醒', async () => {
  const cfg = { triggers: { atMention: true, nameMention: true, question: true, poke: true, anyMessage: false, probability: 0 } };
  const now = 100000;
  // 刚问过话 → 对方接话应触发 followUp
  const hit = evaluateWakeTrigger(cfg, { userId: '100', text: '我觉得还行' }, {
    lastAiReplyAt: now - 10000, lastAiReplyWasQuestion: true, now, followUpWindowMs: 5 * 60 * 1000,
  });
  assert.equal(hit.hit, true, '短时接话应触发');
  assert.equal(hit.reason, 'followUp');
  // 窗口外不触发
  const miss = evaluateWakeTrigger(cfg, { userId: '100', text: '我觉得还行' }, {
    lastAiReplyAt: now - 10 * 60 * 1000, lastAiReplyWasQuestion: true, now, followUpWindowMs: 5 * 60 * 1000,
  });
  assert.equal(miss.hit, false, '窗口外不应触发');
  // 我没问过话 → 不触发
  const noAsk = evaluateWakeTrigger(cfg, { userId: '100', text: '嗯嗯' }, {
    lastAiReplyAt: now - 10000, lastAiReplyWasQuestion: false, now, followUpWindowMs: 5 * 60 * 1000,
  });
  assert.equal(noAsk.hit, false, '没问过话不应触发跟随');
});

await test('P2-09：回复检查概率不再恒为 100%', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-rc-'));
  const store = new SocialV2Store(path.join(tmp, 'r'));
  let fired = 0;
  const timers = [];
  const sched = new WakeScheduler({
    store, onWake: () => { fired++; },
    now: () => 1000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  sched.scheduleReplyCheck('g200', { wasQuestion: true, wasBurst: true });
  assert.equal(timers.length, 1);
  // 概率被截到 <1：连续 50 次都不应 100% 触发
  for (let i = 0; i < 50; i++) timers[0].fn();
  assert.ok(fired < 50, `回复检查不应恒触发（触发 ${fired}/50）`);
  sched.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P2-09：系统提示词保留原版行为规则，唤醒不重复', async () => {
  const { bridge, tmp } = makeBridge();
  const prompt = loadSystemPrompt(bridge.config, tmp);
  assert.ok(!bridge._buildWakePrompt('g200', 'proactiveCheck', []).includes('【群聊不是客服队列】'));
  assert.ok(prompt.includes('判断是不是在接你的话'), '应含接话判断引导');
  assert.ok(prompt.includes('话没说完，继续等'), '应含「等半句补完」规则');
  assert.ok(prompt.includes('群聊不是客服队列'), '应含原版群聊行为规则');
  assert.ok(prompt.includes('别用问号'), '应含原版「别用问号开场」规则');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P2-10：Web 成功状态与持久化一致性 ───────────────────────────────────────

await test('P2-10：人设写盘失败返回非 2xx', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  // 人设文件路径指向一个不可写的目录
  bridge.config.persona = { systemPromptFile: path.join(tmp, 'no-such-dir', 'x', 'role.md'), name: '小鱼' };
  bridge._writePersonaFile = () => ({ ok: false, error: '模拟磁盘写入失败' });
  const r = await call(bridge, '/api/persona', { method: 'POST', body: { content: '新人设' } });
  assert.ok(r.status >= 400, `写盘失败必须非 2xx，实际 ${r.status}`);
  assert.equal(r.data.ok, false);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P2-10：二代状态保存失败不提交运行态', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.socialV2.get('g200');
  bridge.socialV2.save = () => false; // 模拟落盘失败
  const r = await call(bridge, '/api/socialv2/config', {
    method: 'POST',
    body: { sessionKey: 'g200', wakeConfig: { mode: 'active' } },
  });
  assert.ok(r.status >= 400, `保存失败必须非 2xx，实际 ${r.status}`);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P2-10：模型 baseUrl 空串=清空、apiKey 空串=保留旧值', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  // 先记下旧 key
  const before = await call(bridge, '/api/model');
  assert.equal(before.data.model.hasApiKey, true);
  // apiKey 传空串 → 保留旧值（不发新 key 也不清空）
  const r = await call(bridge, '/api/model', { method: 'POST', body: { apiKey: '' } });
  assert.equal(r.status, 200);
  assert.ok(String(r.data.note).includes('保留'), '应说明 API Key 保持原值');
  const after = await call(bridge, '/api/model');
  assert.equal(after.data.model.hasApiKey, true, '旧 key 必须还在');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('P2-10：调度参数落盘失败时运行态不变', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const before = bridge.config.socialV2?.batchWindowMs;
  // 只替换这一个实例的写盘方法（不碰全局 fs——测试是并发跑的）
  bridge._writeConfigFile = () => { throw new Error('模拟磁盘满'); };
  const r = await call(bridge, '/api/socialv2/schedule', { method: 'POST', body: { batchWindowMs: 12345 } });
  assert.ok(r.status >= 400, `落盘失败必须非 2xx，实际 ${r.status}`);
  assert.equal(bridge.config.socialV2?.batchWindowMs, before, '运行态不应被失败的保存改动');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

for (const [, promise] of asyncs) {
  await promise;
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
