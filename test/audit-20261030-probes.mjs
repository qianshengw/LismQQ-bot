// QUALITY-REPORT-2026-10-30 的原始缺陷探针（**已按修复后的正确行为改写**）。
//
// 原始版本断言的是「缺陷成立」（两次立即 @ 只唤醒一次 / 最老 20 条看不到新 @ /
// 空回复照样清已读 / wait 读的是另一份队列 / reply 与 burst 能把退场话发出去）。
// 那些缺陷已在本轮修复，因此这里改为断言**修复后的行为**——
// 同一组探针，从「复现缺陷」变成「防止回归」。
//
// 更完整的回归覆盖见 test/quality-fixes.test.mjs（已注册进 npm test）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { SocialV2Store } from '../src/social-v2.js';
import { WakeScheduler } from '../src/wake-scheduler.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-'));
const config = {
  qq: { wsUrl: 'ws://127.0.0.1:1' },
  model: { provider: 'deepseek', model: 'deepseek-flash' },
  persona: { name: '小鱼' },
  memory: { enabled: false },
  socialV2: { enabled: true, mode: 'v2' },
  socialV1: { enabled: false },
  tools: { enabled: false },
  allow: { groups: ['200'] },
  deny: {},
  internalHost: '127.0.0.1',
  internalPort: 0,
};
const b = new Bridge({ config, rootDir: root });
try {
  b.running = true;
  let now = 100000;
  const store = new SocialV2Store(path.join(root, 'probe'), { now: () => now });
  let wakes = 0;
  const scheduler = new WakeScheduler({ store, onWake: () => wakes++, now: () => now });

  // ① P1-01：连续两次显式 @ 都应唤醒（direct 档独立额度）
  scheduler.scheduleWake('g200', 'atMention', { immediate: true });
  scheduler.scheduleWake('g200', 'atMention', { immediate: true });
  assert.equal(wakes, 2, '连续两次显式 @ 应各自唤醒（direct 档不被常规额度卡住）');
  console.log('FIXED: immediate @ is no longer rate limited by the normal quota');
  scheduler.stop();

  // ② P1-03：21 条未读、最后一条是新 @ → 首批必须带新 @
  for (let i = 0; i < 21; i++) b.socialV2.pushIncoming('g200', { text: i === 20 ? 'fresh @' : 'old ' + i, sender: '100', atMe: i === 20 });
  const { batch } = b._selectWakeBatch('g200');
  assert.ok(batch.some((m) => m.atMe), '首批必须包含最新的 @');
  console.log('FIXED: newest @ is included in the first batch');

  // ③ P1-04：空回复不得清已读
  let sent = 0;
  b.bot = { sendGroupMessage: async () => { sent++; } };
  b.sessionManager = { get: async () => ({ listeners: {}, prompt: async () => ({ text: '' }) }), save() {} };
  const beforeSeq = b.socialV2.get('g200').lastReadThroughSeq;
  await b._runWakeTurn('g200', 'atMention');
  assert.equal(sent, 0);
  assert.equal(b.socialV2.get('g200').lastReadThroughSeq, beforeSeq, '未回应时不得推进已读水位');
  console.log('FIXED: an empty response no longer acknowledges the @ obligation');

  // ④ P1-02：wait 只等游标之后的新消息（不读另一份队列）
  b.socialV2.pushIncoming('g200', { text: 'after wake', sender: '100' });
  const again = await b._waitForMessages('g200', 1, 0);
  assert.ok(again.length >= 1 && again.some((m) => m.text === 'after wake'), 'wait 应读到新消息');
  const twice = await b._waitForMessages('g200', 1, 0);
  assert.equal(twice.length, 0, '同一条消息不得被 wait 再读一遍');
  console.log('FIXED: wait consumes the same cursor-based queue as the wake prompt');

  // ⑤ P2-08：reply / burst 的退场话必须被拦
  await b._startInternalHttp();
  const url = `http://127.0.0.1:${b.internalPort}`;
  for (const route of ['reply', 'burst']) {
    const body = route === 'reply' ? { text: '我先撤了', messageId: 123 } : { messages: ['我先撤了'] };
    const r = await fetch(url + '/agent/' + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': b.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200' },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
  }
  assert.equal(sent, 0, '退场话不得进入 QQ');
  console.log('FIXED: reply and burst both enforce the farewell filter');
} finally {
  b.running = false;
  b.wakeScheduler?.stop();
  if (b.internalServer) await new Promise((r) => b.internalServer.close(r));
  fs.rmSync(root, { recursive: true, force: true });
}
