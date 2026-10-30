// memory-pool 单测：CJK bigram / 停用词 / 标点 / FIFO / 分区隔离 / 序列化。
import assert from 'node:assert/strict';
import { SharedMemoryPool, tokenize, cjkBigrams, renderPreferenceBlock } from '../src/memory-pool.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
  }
}

console.log('memory-pool.test.mjs');

// ── tokenize ─────────────────────────────────────────────────────────────────

test('英文小写化 + 停用词过滤', () => {
  const tokens = tokenize('Food to avoid!');
  assert.ok(tokens.includes('food'));
  assert.ok(tokens.includes('avoid'));
  assert.ok(!tokens.includes('to'));
  assert.ok(!tokens.includes('food!'));
});

test('CJK bigram：乌龙茶 → 乌龙/龙茶', () => {
  const bigrams = cjkBigrams('乌龙茶');
  assert.deepEqual(bigrams, ['乌龙', '龙茶']);
});

test('单字 CJK 保留自身', () => {
  assert.deepEqual(cjkBigrams('茶'), ['茶']);
});

test('英文 token 不产生 bigram', () => {
  assert.deepEqual(cjkBigrams('peanuts'), []);
});

test('中文子串查询可命中长记忆', () => {
  const pool = new SharedMemoryPool();
  pool.store('用户喜欢喝乌龙茶', { namespace: 'p1' });
  const results = pool.retrieve('乌龙茶', { namespace: 'p1' });
  assert.equal(results.length, 1);
  assert.equal(results[0].memory, '用户喜欢喝乌龙茶');
});

test('中文停用词 bigram 被过滤', () => {
  const tokens = tokenize('我们喜欢乌龙茶');
  assert.ok(!tokens.includes('我们'));
  assert.ok(tokens.includes('乌龙'));
});

// ── retrieve 排序与空查询 ────────────────────────────────────────────────────

test('纯停用词查询返回空（M-28）', () => {
  const pool = new SharedMemoryPool();
  pool.store('some memory', { namespace: 'n' });
  assert.deepEqual(pool.retrieve('to the', { namespace: 'n' }), []);
});

test('空查询返回空', () => {
  const pool = new SharedMemoryPool();
  pool.store('memory', { namespace: 'n' });
  assert.deepEqual(pool.retrieve('', { namespace: 'n' }), []);
});

test('重叠越多得分越高（排序）', () => {
  const pool = new SharedMemoryPool({ maxResults: 5 });
  pool.store('用户喜欢乌龙茶', { namespace: 'n' });
  pool.store('用户养了一只猫', { namespace: 'n' });
  const results = pool.retrieve('用户喜欢乌龙茶吗', { namespace: 'n' });
  assert.equal(results[0].memory, '用户喜欢乌龙茶');
});

test('maxResults 限制', () => {
  const pool = new SharedMemoryPool({ maxResults: 5 });
  for (let i = 0; i < 10; i++) pool.store(`memory about tea ${i}`, { namespace: 'n' });
  const results = pool.retrieve('tea', { namespace: 'n' });
  assert.equal(results.length, 5);
});

// ── 分区隔离 ────────────────────────────────────────────────────────────────

test('utterance 分区对偏好召回不可见', () => {
  const pool = new SharedMemoryPool();
  pool.store('用户问今天天气', { namespace: 'n', scope: 'utterance' });
  pool.store('用户喜欢乌龙茶', { namespace: 'n', scope: 'user' });
  const prefs = pool.retrieve('用户', { namespace: 'n', scope: 'user' });
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0].memory, '用户喜欢乌龙茶');
});

test('namespace 隔离', () => {
  const pool = new SharedMemoryPool();
  pool.store('alice 的记忆', { namespace: 'p100' });
  const other = pool.retrieve('记忆', { namespace: 'p200' });
  assert.deepEqual(other, []);
});

// ── FIFO ────────────────────────────────────────────────────────────────────

test('容量淘汰最旧记录', () => {
  const pool = new SharedMemoryPool({ maxRecords: 3 });
  pool.store('a', { namespace: 'n' });
  pool.store('b', { namespace: 'n' });
  pool.store('c', { namespace: 'n' });
  pool.store('d', { namespace: 'n' });
  assert.equal(pool.count(), 3);
  const memories = pool.listRecords({ namespace: 'n' }).map((r) => r.memory);
  assert.deepEqual(memories, ['b', 'c', 'd']);
});

// ── 序列化 ──────────────────────────────────────────────────────────────────

test('toJSON / fromJSON 往返', () => {
  const pool = new SharedMemoryPool();
  pool.store('记忆甲', { namespace: 'n', source: 'user', scope: 'user' });
  pool.store('记忆乙', { namespace: 'n', scope: 'utterance' });
  const restored = SharedMemoryPool.fromJSON(pool.toJSON(), { maxRecords: 10 });
  assert.equal(restored.count(), 2);
  const results = restored.retrieve('记忆甲', { namespace: 'n', scope: 'user' });
  assert.equal(results.length, 1);
  assert.equal(results[0].memory, '记忆甲');
});

// ── 偏好块渲染 ──────────────────────────────────────────────────────────────

test('renderPreferenceBlock 空结果返回空串', () => {
  assert.equal(renderPreferenceBlock([]), '');
  assert.equal(renderPreferenceBlock(null), '');
});

test('renderPreferenceBlock 拼接记忆行', () => {
  const block = renderPreferenceBlock([{ memory: '喜欢乌龙茶' }, { memory: '养了猫' }]);
  assert.ok(block.includes('##用户偏好'));
  assert.ok(block.includes('喜欢乌龙茶'));
  assert.ok(block.includes('养了猫'));
});

// ── clear ───────────────────────────────────────────────────────────────────

test('clear 按 namespace 清空', () => {
  const pool = new SharedMemoryPool();
  pool.store('a', { namespace: 'n1' });
  pool.store('b', { namespace: 'n2' });
  const removed = pool.clear('n1');
  assert.equal(removed, 1);
  assert.equal(pool.count(), 1);
});

process.exitCode = failed > 0 ? 1 : 0;
