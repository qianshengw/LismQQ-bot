// 批次 A 单测：social-v2 状态（key 规范化/记忆/水位/限频）、唤醒调度（优先级/忙暂存/防呆，假时钟）、burst 规划。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SocialV2Store, canonicalKey, keyOf, evaluateWakeTrigger, WAKE_PRIORITY, DEFAULT_WAKE_CONFIG } from '../src/social-v2.js';
import { WakeScheduler } from '../src/wake-scheduler.js';
import { planBurst, computeGaps } from '../src/burst.js';

let passed = 0;
let failed = 0;
const asyncs = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      asyncs.push([name, r]);
      return;
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
  }
}

console.log('social-v2.test.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-v2-'));

// ── key 规范化 ──────────────────────────────────────────────────────────────

test('canonicalKey：新格式直通', () => {
  assert.equal(canonicalKey('g123'), 'g123');
  assert.equal(canonicalKey('p456'), 'p456');
});

test('canonicalKey：旧格式兼容', () => {
  assert.equal(canonicalKey('group:123'), 'g123');
  assert.equal(canonicalKey('private:456'), 'p456');
  assert.equal(canonicalKey('GROUP:789'), 'g789');
});

test('canonicalKey：纯数字拒绝（不猜类型）', () => {
  assert.equal(canonicalKey('123'), '');
  assert.equal(canonicalKey(''), '');
});

test('keyOf 构造', () => {
  assert.equal(keyOf('group', 123), 'g123');
  assert.equal(keyOf('private', '456'), 'p456');
});

// ── 触发器评估 ──────────────────────────────────────────────────────────────

test('触发器：private 最高优先', () => {
  const r = evaluateWakeTrigger(DEFAULT_WAKE_CONFIG, { isPrivate: true });
  assert.equal(r.hit, true);
  assert.equal(r.reason, 'private');
});

test('触发器：@ > 名字 > 提问 优先级', () => {
  const cfg = { triggers: { atMention: true, nameMention: true, question: true, probability: 0 } };
  const ctx = { myName: '小鱼' };
  assert.equal(evaluateWakeTrigger(cfg, { atMe: true, text: '在吗?' }, ctx).reason, 'atMention');
  assert.equal(evaluateWakeTrigger(cfg, { atMe: false, text: '小鱼在吗?' }, ctx).reason, 'nameMention');
  // question 用预计算的 questionToMe 字段（bridge 侧由 _isQuestionToMe 判定）
  assert.equal(evaluateWakeTrigger(cfg, { atMe: false, text: '今天天气?', questionToMe: true }, ctx).reason, 'question');
});

test('触发器：短英文关键词词边界', () => {
  const cfg = { triggers: { keywords: ['ds'], probability: 0 } };
  assert.equal(evaluateWakeTrigger(cfg, { text: 'this is words' }).hit, false);
  assert.equal(evaluateWakeTrigger(cfg, { text: '叫 ds 来看' }).hit, true);
});

test('触发器：中文关键词包含匹配', () => {
  const cfg = { triggers: { keywords: ['小鲸'] } };
  assert.equal(evaluateWakeTrigger(cfg, { text: '小鲸快来' }).hit, true);
});

test('触发器：全关 + 概率 0 = 不醒', () => {
  const cfg = { triggers: { atMention: false, nameMention: false, question: false, poke: false, anyMessage: false, probability: 0 } };
  assert.equal(evaluateWakeTrigger(cfg, { atMe: true, text: 'x?' }).hit, false);
});

// ── 状态仓库 ────────────────────────────────────────────────────────────────

test('store：get 创建 + pushIncoming 分配递增 seq', () => {
  const store = new SocialV2Store(path.join(tmp, 's1'), { now: () => 1000 });
  const s1 = store.pushIncoming('g1', { sender: '甲', text: '一' });
  const s2 = store.pushIncoming('g1', { sender: '乙', text: '二' });
  assert.equal(s1, 1);
  assert.equal(s2, 2);
  assert.equal(store.peekUnread('g1').length, 2);
});

test('store：markSeen 水位推进并清 unread', () => {
  const store = new SocialV2Store(path.join(tmp, 's2'), { now: () => 1000 });
  store.pushIncoming('g2', { sender: '甲', text: '一' });
  store.pushIncoming('g2', { sender: '乙', text: '二' });
  store.pushIncoming('g2', { sender: '丙', text: '三' });
  store.markSeen('g2', 2);
  assert.equal(store.get('g2').lastReadThroughSeq, 2);
  assert.deepEqual(store.peekUnread('g2').map((m) => m.seq), [3]);
});

test('store：记忆 append/remove/clear + 过期', () => {
  let now = 1000;
  const store = new SocialV2Store(path.join(tmp, 's3'), { now: () => now });
  store.appendMemory('g3', { category: 'topic', text: '聊到了猫' });
  store.appendMemory('g3', { category: 'thought', text: '想发一首诗', motivation: '气氛好' });
  assert.ok(store.formatMemory('g3').includes('聊到了猫'));
  assert.ok(store.formatMemory('g3').includes('想发一首诗'));
  // thought 2h 过期
  now += 3 * 3600 * 1000;
  store.expireMemory('g3');
  assert.ok(!store.formatMemory('g3').includes('想发一首诗'));
  // topic 24h 过期
  now += 30 * 3600 * 1000;
  store.expireMemory('g3');
  assert.ok(store.formatMemory('g3').includes('暂无记忆'));
});

test('store：印象累计与淘汰', () => {
  const store = new SocialV2Store(path.join(tmp, 's4'), { now: () => 1000, limits: { maxImpressions: 2 } });
  store.touchImpression('g4', '甲');
  store.touchImpression('g4', '乙', { trait: '话痨' });
  store.touchImpression('g4', '丙');
  const impressions = store.get('g4').memberImpressions;
  assert.equal(Object.keys(impressions).length, 2);
  assert.equal(impressions['乙'].traits[0], '话痨');
});

test('store：持久化往返 + 旧 key 兼容', () => {
  const dir = path.join(tmp, 's5');
  const store1 = new SocialV2Store(dir, { now: () => 1000 });
  store1.pushIncoming('group:42', { sender: '甲', text: '旧 key 数据' });
  store1.appendMemory('group:42', { category: 'topic', text: '旧话题' });
  store1.save();
  const store2 = new SocialV2Store(dir, { now: () => 1000 });
  assert.ok(store2.has('g42'), '旧 key group:42 应映射为 g42');
  assert.ok(store2.formatMemory('g42').includes('旧话题'));
  assert.equal(store2.get('g42').lastUnreadSeq, 1);
});

test('store：唤醒限频 1/min', () => {
  const store = new SocialV2Store(path.join(tmp, 's6'), { now: () => 1000 });
  assert.equal(store.tryRegisterWake('g6').ok, true);
  const second = store.tryRegisterWake('g6');
  assert.equal(second.ok, false);
  assert.ok(second.retryAfterMs > 0);
});

test('store：发送限频预占与回滚', () => {
  const store = new SocialV2Store(path.join(tmp, 's7'), { now: () => 1000, limits: { maxSendPerMinute: 3, maxSendPerHour: 60 } });
  assert.equal(store.reserveSendSlots('g7', 2).ok, true);
  assert.equal(store.reserveSendSlots('g7', 2).ok, false); // 2+2 > 3/min
  store.releaseSendSlots('g7', 2);
  assert.equal(store.reserveSendSlots('g7', 3).ok, true);
});

// ── 唤醒调度（假时钟）───────────────────────────────────────────────────────

class FakeClock {
  constructor() {
    this.nowMs = 1000;
    this.tasks = [];
    this.seq = 0;
  }
  now() { return this.nowMs; }
  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.tasks.push({ id, at: this.nowMs + ms, fn });
    return id;
  }
  clearTimeout(id) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
  }
  /** 推进时间，执行到期任务（含任务执行中产生的新任务） */
  async advance(ms) {
    const target = this.nowMs + ms;
    while (true) {
      this.tasks.sort((a, b) => a.at - b.at);
      const next = this.tasks.find((t) => t.at <= target);
      if (!next) break;
      this.nowMs = Math.max(this.nowMs, next.at);
      this.tasks = this.tasks.filter((t) => t.id !== next.id);
      await next.fn();
    }
    this.nowMs = target;
  }
}

async function schedulerTest() {
  // 合并窗口 + 优先级升级
  {
    const clock = new FakeClock();
    const store = new SocialV2Store(path.join(tmp, 'w1'), { now: () => clock.now() });
    const wakes = [];
    const sched = new WakeScheduler({
      store, onWake: (key, reason) => wakes.push({ key, reason, at: clock.now() }),
      now: () => clock.now(), setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h),
    });
    // 8s 窗口内先进低优先级，再进高优先级 → 合并为一次，取最高
    sched.scheduleWake('g1', 'probability');
    sched.scheduleWake('g1', 'atMention');
    await clock.advance(10000);
    assert.equal(wakes.length, 1, `应合并为一次唤醒，实际 ${wakes.length}`);
    assert.equal(wakes[0].reason, 'atMention');
    sched.stop();
  }

  // 忙时暂存 + turn 结束补发
  {
    const clock = new FakeClock();
    const store = new SocialV2Store(path.join(tmp, 'w2'), { now: () => clock.now() });
    const wakes = [];
    const sched = new WakeScheduler({
      store, onWake: (key, reason) => wakes.push(reason),
      now: () => clock.now(), setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h),
    });
    sched.setBusy('g2', true);
    sched.tryWake('g2', 'atMention');
    assert.equal(wakes.length, 0, '忙时不唤醒');
    sched.setBusy('g2', false);
    assert.equal(wakes.length, 1, '解除忙后补发');
    sched.stop();
  }

  // 限频延后重试不丢弃
  // 注意（QUALITY-REPORT P1-01）：显式 @ 走 **direct 档**独立额度，
  // 不再被「常规唤醒 1/min」的额度卡住——所以这里用常规档的触发器来验证限频重试。
  {
    const clock = new FakeClock();
    const store = new SocialV2Store(path.join(tmp, 'w3'), { now: () => clock.now() });
    const wakes = [];
    const sched = new WakeScheduler({
      store, onWake: (key, reason) => wakes.push(reason),
      now: () => clock.now(), setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h),
    });
    sched.tryWake('g3', 'question'); // 第 1 次 OK
    sched.tryWake('g3', 'question'); // 1/min 限制 → 60s 后重试
    assert.equal(wakes.length, 1);
    await clock.advance(61000);
    assert.equal(wakes.length, 2, '限频后应延后重试');
    sched.stop();
  }

  // P1-01：显式 @（direct 档）有自己的额度——连发两次 @ 都应立刻唤醒
  {
    const clock = new FakeClock();
    const store = new SocialV2Store(path.join(tmp, 'w3d'), { now: () => clock.now() });
    const wakes = [];
    const sched = new WakeScheduler({
      store, onWake: (key, reason) => wakes.push(reason),
      now: () => clock.now(), setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h),
    });
    sched.scheduleWake('g32', 'atMention', { immediate: true });
    sched.scheduleWake('g32', 'atMention', { immediate: true });
    assert.equal(wakes.length, 2, `连续两次显式 @ 都应唤醒，实际 ${wakes.length}`);
    // 常规档额度独立：@ 不会占用常规额度
    assert.equal(store.get('g32').wakeTimes.length, 0, 'direct 档不应占用常规额度');
    // 但 direct 档本身有上限（防刷）
    const gate = store.tryRegisterWake('g32', { tier: 'direct', reason: 'atMention' });
    assert.equal(gate.ok, true);
    sched.stop();
  }

  // A4：连续限频不丢唤醒（旧实现第二个被限频的唤醒会顶掉重试定时器）
  {
    const clock = new FakeClock();
    const store = new SocialV2Store(path.join(tmp, 'w31'), { now: () => clock.now() });
    const wakes = [];
    const sched = new WakeScheduler({
      store, onWake: (key, reason) => wakes.push(reason),
      now: () => clock.now(), setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h),
    });
    sched.tryWake('g31', 'question');   // 第 1 次 OK
    sched.tryWake('g31', 'question');   // 限频 → 进 pendingWakes 等 wakeRetry
    sched.tryWake('g31', 'probability'); // 限频 → 也进 pendingWakes（旧实现会顶掉第一个的重试）
    assert.equal(wakes.length, 1);
    await clock.advance(61000);
    assert.equal(wakes.length, 2, '两个被限频的唤醒重试后至少补发一个（不丢失）');
    assert.equal(wakes[1], 'question', '重试取最高优先级（question > probability）');
    sched.stop();
  }

  // 防永眠：无触发条件重置
  {
    const store = new SocialV2Store(path.join(tmp, 'w4'), { now: () => 1000 });
    const sched = new WakeScheduler({ store, onWake: () => {}, now: () => 1000 });
    store.get('g4').wakeConfig.triggers = { atMention: false, nameMention: false, question: false, poke: false, anyMessage: false, probability: 0 };
    assert.equal(sched.ensureWakeable('g4'), true, '无触发条件应重置');
    assert.equal(store.get('g4').wakeConfig.triggers.atMention, true);
  }

  // 空醒计数：≥3 次重置
  {
    const store = new SocialV2Store(path.join(tmp, 'w5'), { now: () => 1000, limits: { noActionResetThreshold: 3 } });
    const sched = new WakeScheduler({ store, onWake: () => {}, now: () => 1000 });
    assert.equal(sched.noteNoAction('g5'), false);
    assert.equal(sched.noteNoAction('g5'), false);
    assert.equal(sched.noteNoAction('g5'), true, '第 3 次应触发重置');
    assert.equal(store.get('g5').wakeConfig.mode, 'active');
    sched.noteAction('g5');
    assert.equal(store.get('g5').noActionCount, 0);
  }

  // 睡眠定时器：infinite=false 到点唤醒并恢复无限潜水
  {
    const clock = new FakeClock();
    const store = new SocialV2Store(path.join(tmp, 'w6'), { now: () => clock.now() });
    const wakes = [];
    const sched = new WakeScheduler({
      store, onWake: (k, r) => wakes.push(r),
      now: () => clock.now(), setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h),
    });
    const state = store.get('g6');
    state.wakeConfig = { ...state.wakeConfig, mode: 'diving', infinite: false, sleepUntil: clock.now() + 300000 };
    sched.setupSleepTimer('g6');
    await clock.advance(100000);
    assert.equal(wakes.length, 0, '未到点不醒');
    await clock.advance(210000);
    assert.deepEqual(wakes, ['timeout']);
    assert.equal(store.get('g6').wakeConfig.infinite, true, '到点后恢复无限潜水');
    sched.stop();
  }

  // 入站触发：@ 命中 → 合并窗口后唤醒
  {
    const clock = new FakeClock();
    const store = new SocialV2Store(path.join(tmp, 'w7'), { now: () => clock.now() });
    const wakes = [];
    const sched = new WakeScheduler({
      store, onWake: (k, r) => wakes.push(r), myName: '小鱼',
      now: () => clock.now(), setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h),
    });
    sched.onIncomingMessage('g7', { atMe: true, text: '在吗' });
    await clock.advance(9000);
    assert.deepEqual(wakes, ['atMention']);
    sched.stop();
  }
}

asyncs.push(['唤醒调度：七场景（假时钟）', schedulerTest()]);

// ── burst ──────────────────────────────────────────────────────────────────

test('burst：条数上限与单条字数', () => {
  const tooMany = planBurst(Array.from({ length: 9 }, (_, i) => `条${i}`));
  assert.equal(tooMany.ok, false);
  const tooLong = planBurst(['x'.repeat(501)]);
  assert.equal(tooLong.ok, false);
  const ok = planBurst(['a', 'b', 'c']);
  assert.equal(ok.ok, true);
  assert.equal(ok.gaps.length, 2);
});

test('burst：间隔三模式', () => {
  const msgs = ['短', '中中等长度内容', '更更长更更长更更长的内容'];
  const fixed = computeGaps(msgs, { gapMode: 'fixed', fixedGapMs: 1500 });
  assert.deepEqual(fixed, [1500, 1500]);
  const byLength = computeGaps(msgs, { gapMode: 'byLength', gapBaseMs: 800, gapPerCharMs: 20 });
  assert.equal(byLength[0], 800 + 1 * 20);
  assert.ok(byLength[1] > byLength[0]);
  const auto = computeGaps(msgs, { gapMode: 'auto' });
  assert.ok(auto[0] >= 1000 && auto[0] <= 5000);
});

// 等待异步测试
for (const [name, promise] of asyncs) {
  try {
    await promise;
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
  }
}

process.exitCode = failed > 0 ? 1 : 0;
