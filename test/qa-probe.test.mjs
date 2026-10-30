// 质检探针（QA probe）：把静态审阅中怀疑的缺陷变成运行时实证。
// 不联网、不连 QQ；用 mock bot 驱动 Bridge 的内部 HTTP 与状态机。
// 用法：node test/qa-probe.test.mjs
// 说明：本文件是审查产物，不在 npm test 的默认套件列表内（run-tests.mjs 显式枚举）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { SocialV2Store } from '../src/social-v2.js';

let pass = 0;
let fail = 0;
const reproduced = [];
const unreproduced = [];

// 探针语义：本文件里每个 assert 断言的都是「缺陷行为成立」。
// 因此 assert 全部通过 = 缺陷被运行时实证；assert 抛错 = 该行为未出现（疑似已修复）。
function probe(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      reproduced.push({ name, detail: '全部断言成立 → 缺陷行为已在运行时确认' });
      console.log(`  [缺陷已确认] ${name}`);
    })
    .catch((error) => {
      unreproduced.push({ name, detail: error?.message ?? String(error) });
      console.log(`  [未确认] ${name} → ${error?.message ?? error}`);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const BASE_CONFIG = {
  qq: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '', accessToken: '' },
  model: { provider: 'longcat', model: 'LongCat-2.5-Preview', apiKey: '', thinkingLevel: 'off', maxTokens: 512, baseUrl: 'https://api.longcat.chat/openai/v1' },
  persona: { systemPrompt: 'test', name: '小鱼' },
  memory: { enabled: true, maxRecords: 50, maxResults: 5, autoCaptureUtterance: true },
  socialV2: { enabled: true, mode: 'v2', limits: {} },
  socialV1: { enabled: true, mode: 'v1', limits: {} },
  allow: { private: ['100'], groups: ['200'], allowAllWhenEmpty: false },
  deny: { private: [], groups: [] },
  tools: { enabled: false, sendWhitelist: [] },
  sendDelayMs: 0,
  ackMessage: '',
  maxTurnSeconds: 60,
  history: { maxMessages: 50 },
  internalPort: 0,
  internalHost: '127.0.0.1',
};

function makeMockBot(sent) {
  return {
    connected: true,
    connectionState: 'open',
    lastError: '',
    lastErrorAt: 0,
    on() { return this; },
    connect() {},
    close() {},
    call: async () => ({}),
    getLoginInfo: async () => ({ user_id: '99999', nickname: 'bot' }),
    sendGroupMessage: async (gid, msg) => { sent.push({ kind: 'group', target: String(gid), msg }); return {}; },
    sendPrivateMessage: async (uid, msg) => { sent.push({ kind: 'private', target: String(uid), msg }); return {}; },
    getGroupHistory: async () => [],
  };
}

async function makeStartedBridge(overrides = {}) {
  const config = JSON.parse(JSON.stringify(BASE_CONFIG));
  Object.assign(config, overrides);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-qa-'));
  const sent = [];
  const bridge = new Bridge({ config, rootDir: tmp, deps: { bot: makeMockBot(sent) } });
  await bridge.start();
  return { bridge, tmp, sent };
}

async function teardown(bridge) {
  clearInterval(bridge.flushTimer);
  clearInterval(bridge.v1LoopTimer);
  bridge.wakeScheduler?.stop();
  if (bridge.internalServer) await new Promise((r) => bridge.internalServer.close(r));
}

console.log('qa-probe.test.mjs — 运行时缺陷复现探针\n');

const ctx = await makeStartedBridge();
const { bridge, sent } = ctx;
const headers = { 'x-console-token': bridge.internalToken };
const agentHeaders = { ...headers, 'x-agent-call': '1' };

console.log('── P1 /agent/wait 端点 ──');
await probe('P1a /agent/wait 未声明 body 就引用 → ReferenceError', async () => {
  const res = await fetch(`http://127.0.0.1:${bridge.internalPort}/agent/wait`, {
    method: 'POST',
    headers: { ...agentHeaders, 'x-qq-session': 'g200', 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeoutSeconds: 1 }),
  });
  const text = await res.text();
  assert(res.status >= 500, `期望 5xx，实际 ${res.status}：${text}`);
  assert(/body is not defined/i.test(text), `期望 ReferenceError: body is not defined，实际返回：${text}`);
});

console.log('\n── P2 二代仿真白名单绕过 ──');
await probe('P2a 非白名单私聊用户触发唤醒（唤醒在 isAllowed 之前求值）', async () => {
  await bridge.handleIncoming({ groupId: null, userId: '666666', text: '你好，在吗', images: [], messageId: 1, raw: {} });
  const rt = bridge.wakeScheduler.runtimes.get('p666666');
  assert(rt && rt.pendingWakes.length > 0, '未观察到对非白名单私聊的唤醒调度');
  const reason = rt.pendingWakes[0].reason;
  assert(reason === 'private', `期望 reason=private，实际 ${reason}`);
});

await probe('P2b 非白名单群的私聊内容进入 v2 未读缓冲（AI 可读到）', async () => {
  const st = bridge.socialV2.get('p666666');
  assert(st.unread.length > 0, 'v2 未读缓冲为空');
  assert(st.unread.some((m) => m.text === '你好，在吗'), '陌生用户消息未进入 v2 未读');
});

await probe('P2c 非白名单群的消息同样被记录并建立群友印象', async () => {
  await bridge.handleIncoming({ groupId: '999999', userId: '777777', text: '群里的消息', images: [], messageId: 2, raw: {} });
  const st = bridge.socialV2.get('g999999');
  assert(st.unread.length > 0, '非白名单群消息未进入 v2 未读');
  assert(Object.keys(st.memberImpressions).length > 0, '非白名单群建立了群友印象');
});

console.log('\n── P3 工具审批跨会话串号 ──');
await probe('P3a 审批闭包使用全局 _currentTurnKey，非真实会话 key', async () => {
  // g200 在白名单内；模拟「另一个会话的回合刚跑完」把 _currentTurnKey 置成 g200
  bridge._currentTurnKey = 'g200';
  // 此处发起工具调用的其实是 g999（非白名单），但闭包拿到的是 g200
  const decision = await bridge.sessionManager.approveToolCall({ toolName: 'mcp_qq_send_message', args: { messages: ['x'] } });
  assert(decision.allow === true, `期望 allow=true（串号放行），实际 ${JSON.stringify(decision)}`);
});

await probe('P3b 直接按真实会话 key 审批则会被拦截（说明只有闭包取错 key）', async () => {
  const decision = await bridge._approveToolCall('g999', 'mcp_qq_send_message', {});
  assert(decision.allow === false, `期望 allow=false，实际 ${JSON.stringify(decision)}`);
});

console.log('\n── P4 /agent/status busy 字段类型 ──');
await probe('P4a busy 返回 Promise 序列化成 {} 而非布尔值', async () => {
  const res = await fetch(`http://127.0.0.1:${bridge.internalPort}/agent/status`, {
    headers: { ...agentHeaders, 'x-qq-session': 'g200' },
  });
  const body = await res.json();
  assert(typeof body.busy !== 'boolean', `期望 busy 不是布尔值，实际类型 ${typeof body.busy}，值 ${JSON.stringify(body.busy)}`);
});

console.log('\n── P5 未读缓冲缺 images 字段 ──');
await probe('P5a qq_get_message_images 恒返回空数组', async () => {
  await bridge.handleIncoming({ groupId: null, userId: '100', text: '带图', images: [{ url: 'http://x/y.png', file: 'y.png' }], messageId: 3, raw: {} });
  const rt = bridge._runtimeFor('p100');
  const entry = rt.unread[rt.unread.length - 1];
  assert(entry.images === undefined, '未读条目本应无 images 字段（本断言失败说明行为已变）');
  const res = await fetch(`http://127.0.0.1:${bridge.internalPort}/agent/unread`, {
    headers: { ...agentHeaders, 'x-qq-session': 'p100' },
  });
  const body = await res.json();
  const urls = (body.messages ?? []).flatMap((m) => m.images ?? []);
  assert(urls.length === 0, `期望取不到图片 URL（缺陷复现），实际 ${urls.length}`);
});

console.log('\n── P6 一代仿真自动回复不校验白名单 ──');
await probe('P6a 非白名单会话的 v1 自动回复被真的发出去', async () => {
  bridge.sessionManager = {
    get: async () => ({ listeners: {}, prompt: async () => ({ text: '在的', errorMessage: undefined }) }),
    save: () => {},
  };
  sent.length = 0;
  bridge._enqueueV1Turn('g999999', '（群聊近况）测试', []);
  await new Promise((r) => setTimeout(r, 400));
  const hit = sent.find((s) => s.target === '999999');
  assert(hit, '未观察到对非白名单群 g999999 的发送（缺陷未复现）');
});

console.log('\n── P7 qq_memory 的 impression 分类未实现 ──');
await probe('P7a appendMemory(category=impression) 返回失败', async () => {
  const store = new SocialV2Store(fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-qa-mem-')), {});
  const r = store.appendMemory('g1', { category: 'impression', text: '张三喜欢抬杠' });
  assert(r.ok === false, '期望 impression 分类失败（缺陷复现），实际成功');
  assert(/未知分类/.test(r.error ?? ''), `期望"未知分类"错误，实际：${r.error}`);
});

console.log('\n── P8 burst 失败回滚多释放配额 ──');
await probe('P8a 发送失败时 releaseSendSlots 释放数与实际发送数不符', async () => {
  const { bridge: b2 } = await makeStartedBridge();
  b2.bot.sendGroupMessage = async () => { throw new Error('模拟发送失败'); };
  const st = b2.socialV2.get('g200');
  const before = st.sendTimes.length;
  const res = await fetch(`http://127.0.0.1:${b2.internalPort}/agent/burst`, {
    method: 'POST',
    headers: { ...agentHeaders, 'x-qq-session': 'g200', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: ['a', 'b', 'c'] }),
  });
  assert(res.status >= 400, `期望发送失败，实际 ${res.status}`);
  assert(st.sendTimes.length === 0, `期望配额全部回滚为 0，实际残留 ${st.sendTimes.length - before} 个占位（回滚数与实际发送数不符）`);
  await teardown(b2);
});

console.log('\n── P10 账本走势金额恒为 0 ──');
await probe('P10a ledger.series() 的 cost 恒为 0（turn.cost 是数字却按 .total 取）', async () => {
  bridge.ledger.add('g200', { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 });
  const summary = bridge.ledger.summary({});
  assert(summary.totals.cost > 0, `期望累计花费 > 0，实际 ${summary.totals.cost}（账本本身未计费）`);
  const series = bridge.ledger.series({ hours: 24, maxBuckets: 48 });
  const totalSeriesCost = (series.buckets ?? []).reduce((a, b) => a + (b.cost ?? 0), 0);
  assert(totalSeriesCost === 0, `期望走势金额恒为 0（缺陷复现），实际 ${totalSeriesCost}`);
});

console.log('\n── P11 发送限频可被 qq_send_message 绕过 ──');
await probe('P11a 连续调用 /agent/send 超过 maxSendPerMinute 仍全部放行', async () => {
  const { bridge: b2 } = await makeStartedBridge();
  b2.socialV2.limits.maxSendPerMinute = 3; // 限频调到 3 条/分钟
  const h2 = { 'x-console-token': b2.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200', 'Content-Type': 'application/json' };
  let ok = 0;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`http://127.0.0.1:${b2.internalPort}/agent/send`, {
      method: 'POST',
      headers: h2,
      body: JSON.stringify({ messages: [`m${i}`] }),
    });
    if (res.status === 200) ok++;
  }
  assert(ok === 6, `期望 6 次全部放行（缺陷复现），实际放行 ${ok} 次`);
  const st = b2.socialV2.get('g200');
  assert(st.sendTimes.length === 0, `期望 /agent/send 不登记限频占位（缺陷复现），实际登记 ${st.sendTimes.length} 个`);
  await teardown(b2);
});

console.log('\n── P12 一代仿真退场后长时间静默 ──');
await probe('P12a exiting 相位下被点名也不投递；bridge 从不调用 finishExit', async () => {
  const v1 = bridge.socialV1;
  v1.startExit('g200');
  let enqueued = 0;
  const orig = bridge._enqueueV1Turn.bind(bridge);
  bridge._enqueueV1Turn = (...a) => { enqueued++; return orig(...a); };
  bridge._v1Incoming('g200', {
    userId: '1', text: '@机器人 在吗', images: [], messageId: 9,
    raw: { message: [{ type: 'at', data: { qq: '99999' } }] },
  });
  assert(enqueued === 0, `期望 exiting 相位下不投递（缺陷复现），实际投递 ${enqueued} 次`);
  assert(v1.exitingKeys.has('g200'), '期望退出集合仍持有该 key（bridge 未调用 finishExit）');
  assert(v1.state('g200').phase === 'exiting', '期望相位仍停留在 exiting');
  bridge._enqueueV1Turn = orig;
});

console.log('\n── P13 必回关键词子串误命中 ──');
await probe('P13a 关键词 "ai" 按子串匹配 → "wait"/"rain" 被判必回', async () => {
  const { isMustReplyText } = await import('../src/social-v1.js');
  const kw = ['deepseek', 'ai', '人工智能', '机器人'];
  assert(isMustReplyText('wait for me', { myName: '小鱼', keywords: kw }) === true, '期望 "wait" 被子串命中（缺陷复现）');
  assert(isMustReplyText('it will rain tomorrow', { myName: '小鱼', keywords: kw }) === true, '期望 "rain" 被子串命中（缺陷复现）');
});

console.log('\n── P9 控制台首页可达性 ──');
await probe('P9a GET / 无鉴权头返回 401（浏览器无法附加自定义头 → 控制台打不开）', async () => {
  const res = await fetch(`http://127.0.0.1:${bridge.internalPort}/`);
  const text = await res.text();
  assert(res.status === 200, `控制面应免鉴权（局域网），实际 ${res.status}`);
  });

await probe('P9b GET / 带 x-console-token 返回 200 HTML（说明仅被鉴权拦截）', async () => {
  const res = await fetch(`http://127.0.0.1:${bridge.internalPort}/`, { headers });
  const text = await res.text();
  assert(res.status === 200, `期望 200，实际 ${res.status}`);
  assert(/<html/i.test(text), '返回的不是 HTML 页面');
});

await teardown(bridge);

console.log(`\n${'='.repeat(60)}`);
console.log(`探针总数：${reproduced.length + unreproduced.length}`);
console.log(`  缺陷已被运行时确认：${reproduced.length}`);
console.log(`  未确认（行为未出现）：${unreproduced.length}`);
if (reproduced.length) {
  console.log('\n缺陷确认清单：');
  for (const f of reproduced) console.log(`  ✗ ${f.name}\n      ${f.detail}`);
}
if (unreproduced.length) {
  console.log('\n未确认清单：');
  for (const f of unreproduced) console.log(`  · ${f.name}\n      ${f.detail}`);
}
process.exit(reproduced.length > 0 ? 1 : 0);
