// onebot 单测：帧解析 / 消息段归一化 / action 响应匹配（不连真实 WS）。
import assert from 'node:assert/strict';
import { parseMessageSegments, OneBotClient } from '../src/onebot.js';

let passed = 0;
let failed = 0;

const pendingTests = [];
function test(name, fn) {
  pendingTests.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (error) { failed++; console.error('  ✗ ' + name, error); }
  });
}

console.log('onebot.test.mjs');

test('文本段归一化', () => {
  const parsed = parseMessageSegments([{ type: 'text', data: { text: '你好' } }]);
  assert.equal(parsed.text, '你好');
  assert.equal(parsed.images.length, 0);
});

test('多段拼接 + 图片提取', () => {
  const parsed = parseMessageSegments([
    { type: 'text', data: { text: '看这张 ' } },
    { type: 'image', data: { url: 'https://example.com/a.jpg', file: 'a.jpg', summary: '图' } },
  ]);
  assert.equal(parsed.text, '看这张 ');
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].url, 'https://example.com/a.jpg');
  assert.equal(parsed.images[0].summary, '图');
});

test('at/face/reply 段转占位文本', () => {
  const parsed = parseMessageSegments([
    { type: 'reply', data: { id: 12345 } },
    { type: 'at', data: { qq: 10086 } },
    { type: 'face', data: { id: 13 } },
    { type: 'text', data: { text: '哈哈' } },
  ]);
  assert.equal(parsed.text, '[回复:12345][@10086][表情:13]哈哈');
});

test('字符串 message 兜底', () => {
  const parsed = parseMessageSegments('纯字符串');
  assert.equal(parsed.text, '纯字符串');
});

test('非数组/空输入安全', () => {
  assert.equal(parseMessageSegments(undefined).text, '');
  assert.equal(parseMessageSegments(null).images.length, 0);
});

test('_handleFrame：action 响应按 echo 匹配', () => {
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1' });
  client.ws = { readyState: 1, send() {} };
  const promise = client._callWs('get_login_info', {}, 5000);
  // 模拟 WS 响应
  client._handleFrame({ echo: [...client.pendingCalls.keys()][0], status: 'ok', retcode: 0, data: { user_id: 42 } });
  return promise.then((data) => {
    assert.equal(data.user_id, 42);
  });
});

test('_handleFrame：群消息分发', () => {
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1' });
  let received = null;
  client.on('onGroupMessage', (m) => {
    received = m;
  });
  client._handleFrame({
    post_type: 'message',
    message_type: 'group',
    group_id: 111,
    user_id: 222,
    message_id: 333,
    message: [{ type: 'text', data: { text: '在吗' } }],
  });
  assert.equal(received.groupId, '111');
  assert.equal(received.userId, '222');
  assert.equal(received.text, '在吗');
});

test('_handleFrame：私聊分发', () => {
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1' });
  let received = null;
  client.on('onPrivateMessage', (m) => {
    received = m;
  });
  client._handleFrame({
    post_type: 'message',
    message_type: 'private',
    user_id: 555,
    message: 'hi',
  });
  assert.equal(received.userId, '555');
  assert.equal(received.text, 'hi');
});

test('_handleFrame：心跳静默', () => {
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1' });
  let notices = 0;
  client.on('onNotice', () => notices++);
  client._handleFrame({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: {} });
  assert.equal(notices, 0);
});

test('_handleFrame：action 错误码 reject', async () => {
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1' });
  client.ws = { readyState: 1, send() {} };
  const promise = client._callWs('send_msg', {}, 5000);
  const echo = [...client.pendingCalls.keys()][0];
  client._handleFrame({ echo, status: 'failed', retcode: 1200, wording: 'no permission' });
  await assert.rejects(promise, /retcode=1200/);
});

// 小提示：_callWs 依赖 this.ws.readyState —— 未连接时应直接 reject
test('未连接时 action 直接失败', async () => {
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1' });
  await assert.rejects(client._callWs('ping', {}, 1000), /未连接/);
});

for (const run of pendingTests) await run();
process.exitCode = failed > 0 ? 1 : 0;
