// 批次 B 单测：v1 状态机转移表 / 选择性参与 / [SILENT] / CJK 空格分句 / 摘要池（假时钟）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SocialV1Store,
  isCjkChar,
  splitByCjkSpaces,
  splitLongSegment,
  planSocialTimeline,
  isSilentMarker,
  isDirectedAtAi,
  isMustReplyText,
} from '../src/social-v1.js';

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

console.log('social-v1.test.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-v1-'));

// ── CJK 判定与分句 ──────────────────────────────────────────────────────────

test('isCjkChar：汉字是、全角标点不是', () => {
  assert.ok(isCjkChar('鱼'));
  assert.ok(isCjkChar('龘'));
  assert.ok(!isCjkChar('，'));
  assert.ok(!isCjkChar('a'));
  assert.ok(!isCjkChar(''));
});

test('splitByCjkSpaces：中文空格分条', () => {
  assert.deepEqual(splitByCjkSpaces('在的在的 今晚可以 几点开'), ['在的在的', '今晚可以', '几点开']);
});

test('splitByCjkSpaces：英文间空格保留', () => {
  assert.deepEqual(splitByCjkSpaces('play 2 games 就来'), ['play 2 games', '就来']);
});

test('splitByCjkSpaces：混合边界', () => {
  // "2 games 就来"：s 与 就 之间分；play 2 games 是英文连体
  const parts = splitByCjkSpaces('play 2 games 就来');
  assert.equal(parts.length, 2);
});

test('splitLongSegment：代理对保护', () => {
  const parts = splitLongSegment('😀'.repeat(100), 50);
  for (const p of parts) {
    const last = p.charCodeAt(p.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff));
  }
});

test('planSocialTimeline：空格分条 + 超长硬拆', () => {
  const long = '甲'.repeat(600);
  const timeline = planSocialTimeline(`开头 ${long}`, { maxReplyChars: 500 });
  assert.ok(timeline.length >= 2);
  assert.equal(timeline[0], '开头');
});

test('planSocialTimeline：burst 关闭时不分条', () => {
  const timeline = planSocialTimeline('一句 另一句', { burstEnabled: false });
  assert.equal(timeline.length, 1);
});

// ── [SILENT] ────────────────────────────────────────────────────────────────

test('isSilentMarker：精确匹配', () => {
  assert.ok(isSilentMarker('[SILENT]'));
  assert.ok(isSilentMarker(' [silent] '));
  assert.ok(!isSilentMarker('[SILENT] 前面有话'));
  assert.ok(!isSilentMarker(''));
});

// ── 指向性判定 ──────────────────────────────────────────────────────────────

test('isDirectedAtAi：AI 提问/挑战/追问', () => {
  assert.ok(isDirectedAtAi('deepseek 你是不是机器人？'));
  assert.ok(isDirectedAtAi('你和 gpt 谁强'));
  assert.ok(isDirectedAtAi('你说怎么办'));
  assert.ok(isDirectedAtAi('怎么不说话'));
});

test('isDirectedAtAi：普通聊天不误伤', () => {
  assert.ok(!isDirectedAtAi('今天天气不错'));
  assert.ok(!isDirectedAtAi('刚才那个游戏真好玩'));
});

test('isMustReplyText：昵称/关键词/指向性', () => {
  assert.ok(isMustReplyText('小鱼在吗', { myName: '小鱼' }));
  assert.ok(isMustReplyText('deepseek 好用吗', { keywords: ['deepseek'] }));
  assert.ok(isMustReplyText('你会不会这个', {}));
  assert.ok(!isMustReplyText('没事了', { myName: '小鱼' }));
});

// ── 状态机（假时钟）────────────────────────────────────────────────────────

class FakeClock {
  constructor() { this.nowMs = 1000; this.tasks = []; this.seq = 0; }
  now() { return this.nowMs; }
  setTimeout(fn, ms) { const id = ++this.seq; this.tasks.push({ id, at: this.nowMs + ms, fn }); return id; }
  clearTimeout(id) { this.tasks = this.tasks.filter((t) => t.id !== id); }
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

async function stateMachineTest() {
  // idle → (direct) → active
  {
    let now = 1000;
    const v1 = new SocialV1Store(null, { now: () => now, limits: { triggerProbability: 0 } });
    assert.equal(v1.state('g1').phase, 'idle');
    assert.equal(v1.shouldTriggerFromIdle('g1', { direct: true }), true);
    v1.enterActive('g1');
    assert.equal(v1.state('g1').phase, 'active');
    assert.ok(v1.state('g1').activeDeadlineAt > now);
  }

  // active → 活跃超时 → exiting →（finishExit）→ idle
  {
    let now = 1000;
    const v1 = new SocialV1Store(null, {
      now: () => now,
      limits: { activeDurationEnabled: true, activeDurationMinMs: 1000, activeDurationMaxMs: 1000, activeCheckMinMs: 100, activeCheckMaxMs: 100 },
    });
    v1.enterActive('g2');
    const events = [];
    now += 1500;
    v1.tick((key, kind) => events.push(kind));
    assert.equal(v1.state('g2').phase, 'exiting');
    assert.deepEqual(events, ['exit']);
    v1.finishExit('g2');
    assert.equal(v1.state('g2').phase, 'idle');
  }

  // active → 冷场 → probing →（超时无回应）→ idle
  {
    let now = 1000;
    const v1 = new SocialV1Store(null, {
      now: () => now,
      limits: {
        activeDurationEnabled: false,
        idleWindowMs: 1000,
        idleRetryProbability: 1, // 必中试探
        idleRetryWaitMs: 500,
        activeCheckMinMs: 100, activeCheckMaxMs: 100,
      },
    });
    v1.enterActive('g3');
    const events = [];
    now += 1500; // 冷场超阈值 → 试探
    v1.tick((key, kind) => events.push(kind));
    assert.equal(v1.state('g3').phase, 'probing');
    assert.deepEqual(events, ['probe']);
    now += 600; // 试探窗口过 → 回 idle
    v1.tick();
    assert.equal(v1.state('g3').phase, 'idle');
  }

  // probing 窗口内有人说话 → 回 active
  {
    let now = 1000;
    const v1 = new SocialV1Store(null, {
      now: () => now,
      limits: { activeDurationEnabled: false, idleWindowMs: 1000, idleRetryProbability: 1, idleRetryWaitMs: 5000, activeCheckMinMs: 100, activeCheckMaxMs: 100 },
    });
    v1.enterActive('g4');
    now += 1500;
    v1.tick();
    assert.equal(v1.state('g4').phase, 'probing');
    assert.equal(v1.noteActivity('g4'), true);
    assert.equal(v1.state('g4').phase, 'active');
  }

  // 活跃期批量检测：skip 概率（必回不 skip；刚回复 60s 内不 skip）
  {
    let now = 10 * 60 * 60 * 1000; // 用真实量级的时钟（lastAiReplyAt=0 时 since 巨大，不受保护窗影响）
    const v1 = new SocialV1Store(null, { now: () => now, limits: { skipProbability: 0.9 } });
    // 刚回复过 → skip 概率 0
    v1.enterActive('g5');
    v1.noteAiReply('g5');
    assert.equal(v1.shouldSkipInActive('g5', 1), false, '刚回复 60s 内不沉默');
    // mustReply → 不 skip
    assert.equal(v1.shouldSkipInActive('g5', 5, { mustReply: true }), false);
    // 压力大（5 条）→ skip 概率 0.9-0.5=0.4，多次采样必有沉默与不沉默
    let skipped = 0;
    for (let i = 0; i < 200; i++) {
      if (v1.shouldSkipInActive('g5', 5)) skipped++;
      v1.state('g5').lastAiReplyAt = 0; // 清掉刚回复保护
    }
    assert.ok(skipped > 20 && skipped < 180, `skip 比例异常: ${skipped}/200`);
  }

  // 摘要池：drain 清空
  {
    let now = 1000;
    const v1 = new SocialV1Store(null, { now: () => now });
    v1.appendSummary('g6', { sender: '甲', text: '一' });
    v1.appendSummary('g6', { sender: '乙', text: '二' });
    assert.ok(v1.hasSummaries('g6'));
    const items = v1.drainSummaries('g6');
    assert.equal(items.length, 2);
    assert.ok(!v1.hasSummaries('g6'));
  }

  // 持久化往返
  {
    const dir = path.join(tmp, 'persist');
    let now = 1000;
    const v1a = new SocialV1Store(dir, { now: () => now });
    v1a.enterActive('g7');
    v1a.save();
    const v1b = new SocialV1Store(dir, { now: () => now });
    assert.equal(v1b.state('g7').phase, 'active');
  }
}

asyncs.push(['v1 状态机七场景（假时钟）', stateMachineTest()]);

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
