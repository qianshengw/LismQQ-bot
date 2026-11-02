// 质检报告修复的回归测试（含测试体系补强四项）：
//   ① B1：GET / 无令牌必须 200 HTML
//   ② console.html 静态扫描：api() 调用路径 ⊆ 桥接路由集合
//   ③ B2：/agent/wait 正常工作（此前 ReferenceError）
//   ④ B3：白名单外消息不进 v2 状态/不触发唤醒
//   ⑤ S1：审批回调按会话绑定（不串号）
//   ⑥ S4：/agent/send 限频（429）
//   ⑦ S3：v1 发送前白名单复核
//   ⑧ M4：busy 为布尔；M7：media 拒绝内网重定向（确定性）
// 全部使用确定性断言（无概率采样）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, loadSystemPrompt } from '../src/bridge.js';
import { OneBotClient } from '../src/onebot.js';
import { fetchImageForModel } from '../src/media.js';
import { isMustReplyText } from '../src/social-v1.js';

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

console.log('qa-fixes.test.mjs');

// 测试期内部 HTTP 绑 127.0.0.1（不暴露局域网）
function makeBridge(configOverrides = {}) {
  const config = {
    qq: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '', accessToken: '' },
    model: { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-test-123456789', baseUrl: 'https://api.deepseek.com' },
    persona: { systemPrompt: 't', name: '小鱼' },
    memory: { enabled: true, maxRecords: 20, maxResults: 3, autoCaptureUtterance: true },
    socialV2: { enabled: true, mode: 'v2', limits: { maxSendPerMinute: 3, maxSendPerHour: 60 } },
    socialV1: { enabled: true, mode: 'v1', limits: { triggerProbability: 0, skipProbability: 0 } },
    allow: { private: ['100'], groups: ['200'], allowAllWhenEmpty: false },
    deny: { private: [], groups: [] },
    tools: { enabled: false },
    sendDelayMs: 0,
    history: { maxMessages: 50 },
    internalPort: 0,
    internalHost: '127.0.0.1',
    ...configOverrides,
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-qa-'));
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

// ── ① B1：GET / 无令牌 200 HTML ──
await test('B1：GET / 无令牌返回 200 HTML（控制台可打开）', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/');
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('content-type').includes('text/html'));
  assert.ok(typeof r.data !== 'object' || r.data.error === undefined, '不应是 JSON 错误');
  const html = await fetch(`http://127.0.0.1:${bridge.internalPort}/console`).then((x) => x.text());
  assert.ok(html.includes('x-data="app()"'), '页面应含 Alpine 应用定义');
  assert.ok(!html.includes('consoleToken'), '免鉴权模式不应再有 token 逻辑');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ② console.html 静态扫描 ──
await test('静态扫描：console.html 的 api() 路径 ⊆ 桥接路由集合', async () => {
  const html = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', 'public', 'console.html'), 'utf8');
  // 抓出所有 api('...') 与 api(`/...`) 的路径
  const usedPaths = new Set();
  for (const m of html.matchAll(/api\(\s*[`'"]([^`'"]+)[`'"]/g)) {
    const p = m[1].split('?')[0].replace(/\$\{[^}]*\}/g, 'X');
    usedPaths.add(p);
  }
  // 桥接路由集合（从 bridge.js 源码抓 url.pathname === '...'）
  const bridgeSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', 'src', 'bridge.js'), 'utf8');
  const routes = new Set();
  for (const m of bridgeSrc.matchAll(/url\.pathname === '([^']+)'/g)) routes.add(m[1]);
  for (const m of bridgeSrc.matchAll(/req\.url \?\? '\/'\.startsWith\('([^']+)'\)|url\.pathname\.startsWith\('([^']+)'\)/g)) {
    if (m[1]) routes.add(m[1]);
    if (m[2]) routes.add(m[2]);
  }
  const known = new Set([...routes, '/console']);
  const unknown = [...usedPaths].filter((p) => !known.has(p) && !p.startsWith('X'));
  assert.deepEqual(unknown, [], `console.html 调用了桥接不存在的路由: ${unknown.join(', ')}`);
});

// ── ③ B2：/agent/wait ──
await test('B2：/agent/wait 正常返回（不再 ReferenceError）', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const r = await call(bridge, '/agent/wait', {
    method: 'POST',
    headers: { 'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': 'p100' },
    body: { timeoutSeconds: 1 },
  });
  assert.equal(r.status, 200, `期望 200，实际 ${r.status}: ${JSON.stringify(r.data)}`);
  assert.deepEqual(r.data.messages, []);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ④ B3：白名单外消息不进 v2 ──
await test('B3：白名单外的私聊不入 v2 状态、不触发唤醒', async () => {
  const { bridge, tmp } = makeBridge(); // 白名单 private:['100']
  bridge.running = true;
  // handleIncoming 依赖 sessionManager（get 延迟建会话用）——测试给个最小 stub
  bridge.sessionManager = { has: () => false, get: async () => ({ listeners: {} }), save: () => {}, saveAll: () => {} };
  let wakeCount = 0;
  bridge.wakeScheduler.onWake = () => { wakeCount++; };
  // 陌生用户 666666 私聊
  await bridge.handleIncoming({ groupId: null, userId: '666666', text: '你好', images: [], raw: {} });
  assert.equal(bridge.socialV2.has('p666666'), false, '陌生人消息不应建 v2 状态');
  assert.equal(wakeCount, 0, '不应触发唤醒');
  assert.equal(bridge._runtimeFor('p666666').unread.length, 0, '不应进未读缓冲');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  await bridge.handleIncoming({ groupId: null, userId: '100', text: '在吗', images: [], raw: {} });
  assert.equal(bridge.socialV2.has('p100'), true);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑤ S1：审批按会话绑定 ──
await test('S1：每个 agent 的审批回调绑定各自会话 key（不串号）', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  // 构建真实 SessionManager（start() 未跑，手动建）——approveToolCallFactory 由 bridge 构造时传入
  const { SessionManager } = await import('../src/pi-host.js');
  bridge.sessionManager = new SessionManager({
    sessionsDir: path.join(tmp, 'sessions'),
    modelConfig: { provider: 'deepseek', model: 'deepseek-flash' },
    systemPrompt: 't',
    maxMessages: 50,
    approveToolCallFactory: bridge.sessionManagerConfig?.approveToolCallFactory
      ?? ((sessionKey) => ({ toolName, args }) => bridge._approveToolCall(sessionKey, toolName, args)),
    streamFn: () => {},
  });
  // 经 SessionManager 取两个会话（tools.enabled=false 无 MCP，但 approve 回调仍绑定）
  const agentA = await bridge.sessionManager.get('g200'); // 白名单内
  const agentB = await bridge.sessionManager.get('g999999'); // 白名单外
  assert.ok(agentA.approveToolCall, 'agentA 应有审批回调');
  assert.ok(agentB.approveToolCall, 'agentB 应有审批回调');
  // 相同的发送工具调用：A 放行、B 拒绝（各自闭包的 key）
  const callA = await agentA.approveToolCall({ toolName: 'mcp_qq_send_message', args: {}, toolCallId: 't1' });
  const callB = await agentB.approveToolCall({ toolName: 'mcp_qq_send_message', args: {}, toolCallId: 't2' });
  assert.equal(callA?.allow, true, '白名单内会话应放行');
  assert.equal(callB?.allow, false, '白名单外会话应拦截（不再借用其它会话的 key）');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑥ S4：/agent/send 限频 ──
await test('S4：/agent/send 连发超限返回 429（单发不可绕过限频）', async () => {
  const { bridge, tmp } = makeBridge(); // maxSendPerMinute: 3
  await bridge._startInternalHttp();
  bridge.bot = { sendGroupMessage: async () => ({}), sendPrivateMessage: async () => ({}) };
  const headers = { 'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200' };
  for (let i = 0; i < 3; i++) {
    const r = await call(bridge, '/agent/send', { method: 'POST', headers, body: { messages: `msg ${i}` } });
    assert.equal(r.status, 200, `第 ${i + 1} 次应放行`);
  }
  const r4 = await call(bridge, '/agent/send', { method: 'POST', headers, body: { messages: 'msg 4' } });
  assert.equal(r4.status, 429, '第 4 次应触发限频');
  assert.equal(bridge.socialV2.get('g200').sendTimes.length, 3);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑦ S3：v1 发送前白名单复核 ──
await test('S3：v1 回合对白名单外会话不发送', async () => {
  const { bridge, tmp } = makeBridge(); // 群白名单只有 200
  await bridge._startInternalHttp();
  const sent = [];
  bridge.bot = { sendGroupMessage: async (gid, msg) => { sent.push({ gid, msg }); }, sendPrivateMessage: async () => ({}) };
  // mock agent（sessionManager.get 返回可控实例）
  bridge.sessionManager = {
    has: () => true,
    get: async () => ({ prompt: async () => ({ text: '回复内容', errorMessage: undefined }), listeners: {} }),
    save: () => {},
  };
  await bridge._runV1Turn('g999999', '【群聊近况】\n（无）\n（回应即可）', []);
  assert.deepEqual(sent, [], '白名单外会话不应发送');
  await bridge._runV1Turn('g200', '【群聊近况】\n（无）\n（回应即可）', []);
  assert.equal(sent.length, 1, '白名单内会话正常发送');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑧ M3：v1 关键词词边界（确定性）──
await test('M3：v1 关键词 "ai" 不命中 wait/rain/chair（词边界）', async () => {
  assert.equal(isMustReplyText('I will wait here', { keywords: ['ai'] }), false);
  assert.equal(isMustReplyText('sitting in a chair', { keywords: ['ai'] }), false);
  assert.equal(isMustReplyText('hey AI robot', { keywords: ['ai'] }), true);
  assert.equal(isMustReplyText('提到人工智能', { keywords: ['人工智能'] }), true);
});

// ── ⑨ M7：media 内网重定向拒绝（确定性，无网络——构造拒绝链）──
await test('M7：图片抓取拒绝解析到内网的域名（确定性）', async () => {
  // isAllowedHost/assertResolvablePublicHost 的判定在 safe-fetch 测试里已覆盖；
  // 这里验证媒体入口对内网 URL 的快速拒绝（无网络往返）
  const r = await fetchImageForModel('http://169.254.169.254/latest/meta-data');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('被拒') || r.error.includes('内网'));
});

// ── ⑩ M4：busy 为布尔 ──
await test('M4：/agent/status 的 busy 是布尔', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const headers = { 'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200' };
  const r = await call(bridge, '/agent/status', { headers });
  assert.equal(typeof r.data.busy, 'boolean', `busy 应为布尔，实际 ${JSON.stringify(r.data.busy)}`);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑪ S2：v1 退场回合结束即回观望 ──
await test('S2：退场 prompt 回合结束后 finishExit（不再静默 60 分钟）', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const sent = [];
  bridge.bot = { sendGroupMessage: async (gid, msg) => { sent.push({ gid, msg }); }, sendPrivateMessage: async () => ({}) };
  bridge.sessionManager = {
    has: () => true,
    get: async () => ({ prompt: async () => ({ text: '那我先去忙啦，回见', errorMessage: undefined }), listeners: {} }),
    save: () => {},
  };
  bridge.socialV1.enterActive('g200');
  bridge.socialV1.startExit('g200');
  assert.equal(bridge.socialV1.state('g200').phase, 'exiting');
  await bridge._runV1Turn('g200', '退场 prompt', []);
  assert.equal(bridge.socialV1.state('g200').phase, 'idle', '退场回合结束后应回观望');
  assert.equal(bridge.socialV1.exitingKeys.has('g200'), false);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑫ A3：出错回合不清未读 ──
await test('A3：唤醒回合出错（timeout/断连）后未读保留、下次可重试', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.running = true; // pushIncoming 需 running
  // 投递两条未读并确认 seq（handleIncoming 用 {groupId, userId, text} 形状）
  await bridge.handleIncoming({ groupId: '200', userId: '100', text: '在吗', images: [], raw: {} });
  await bridge.handleIncoming({ groupId: '200', userId: '100', text: '没人理我吗', images: [], raw: {} });
  const unreadBefore = bridge.socialV2.peekUnread('g200');
  assert.equal(unreadBefore.length, 2, '唤醒前应有 2 条未读');
  // 模拟一个失败的唤醒回合（errorMessage 非空——timeout/connection error）
  bridge.wakeScheduler.setBusy('g200', true);
  const savedReadSeq = bridge.socialV2.get('g200').lastReadThroughSeq;
  const savedUnreadLen = bridge.socialV2.peekUnread('g200').length;
  // 直接调用 _runWakeTurn 的错误路径（prompt 返回 errorMessage）
  bridge.sessionManager = {
    has: () => true,
    get: async () => ({
      prompt: async () => ({ text: '', errorMessage: 'Request timed out.' }),
      listeners: {},
    }),
    save: () => {},
  };
  await bridge._runWakeTurn('g200', 'atMention');
  assert.equal(bridge.socialV2.get('g200').lastReadThroughSeq, savedReadSeq, '出错回合不得推进已读水位');
  assert.ok(bridge.socialV2.peekUnread('g200').length >= savedUnreadLen, '出错回合不得清未读');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑰ 2a/2b：@ 场景禁 SILENT ──
await test('@ 唤醒 prompt 含「@了你」标注与 SILENT 禁令', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.wakeScheduler.stop(); // 纯 prompt 测试：禁止触发真实回合（会撞真实网络）
  // 未读条目带 atMe
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '出来聊天', atMe: true });
  const prompt = bridge._buildWakePrompt('g200', 'probability', bridge.socialV2.peekUnread('g200'));
  assert.ok(prompt.includes('←@了你'), '未读渲染应含 @ 标注');
  assert.ok(prompt.includes('不要输出 [SILENT]'), 'hasAtMe 应注入 SILENT 禁令');
  assert.ok(prompt.includes('必须给出回应'), 'hasAtMe 应注入必须回应指令');
  // 非 @ 场景（巡逻、无 @ 未读）：禁令不出现
  bridge.socialV2.pushIncoming('g200', { sender: '李四', userId: '101', text: '随便聊聊' });
  const prompt2 = bridge._buildWakePrompt('g200', 'proactiveCheck', bridge.socialV2.peekUnread('g200').slice(-1));
  assert.ok(!prompt2.includes('不要输出 [SILENT]'), '非 @ 场景不应注入禁令');
  assert.ok(!prompt2.includes('←@了你'), '非 @ 未读不应有标注');
  // reason=atMention 即使未读暂无标注也命中（immediate 唤醒先于入库显示的场景）
  const prompt3 = bridge._buildWakePrompt('g200', 'atMention', []);
  assert.ok(prompt3.includes('不要输出 [SILENT]'), 'reason=atMention 应命中禁令');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('@ 场景 SILENT 违规：保留未读、不推水位、立即重试唤醒', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.running = true;
  // 一条 @ 未读
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '在吗？', atMe: true });
  const savedReadSeq = bridge.socialV2.get('g200').lastReadThroughSeq;
  const savedUnreadLen = bridge.socialV2.peekUnread('g200').length;
  // stub：模型违规输出 [SILENT]
  bridge.sessionManager = {
    has: () => true,
    get: async () => ({
      prompt: async () => ({ text: '[SILENT]', errorMessage: undefined }),
      listeners: {},
    }),
    save: () => {},
  };
  // 记录重试调度调用
  const scheduled = [];
  const origSchedule = bridge.wakeScheduler.scheduleWake.bind(bridge.wakeScheduler);
  bridge.wakeScheduler.scheduleWake = (k, reason, opts) => { scheduled.push({ k, reason, opts }); return origSchedule(k, reason, opts); };
  bridge.wakeScheduler.setBusy('g200', true); // busy=true 时 immediate 也会暂存，不真跑回合——好，可控
  await bridge._runWakeTurn('g200', 'atMention');
  assert.equal(bridge.socialV2.get('g200').lastReadThroughSeq, savedReadSeq, '违规不得推已读水位');
  assert.equal(bridge.socialV2.peekUnread('g200').length, savedUnreadLen, '违规不得清未读');
  assert.equal(bridge.socialV2.get('g200').lastAtSilentViolationAt > 0, true, '应记录违规时间');
  assert.ok(scheduled.some((s) => s.k === 'g200' && s.reason === 'atMention'), '应立即调度重试唤醒');
  // 等重试的第二轮（异步队列）收敛，避免后续清理时队列还在跑
  await new Promise((r) => setTimeout(r, 1200));
  // 非 @ 场景 SILENT 行为不变：正常沉默 = 看过消息后选择不说话 → 照常推进已读水位（正常消化）
  scheduled.length = 0;
  bridge.socialV2.pushIncoming('g300', { sender: '王五', userId: '102', text: '普通消息' });
  await bridge._runWakeTurn('g300', 'proactiveCheck');
  const st300 = bridge.socialV2.get('g300');
  assert.equal(st300.lastReadThroughSeq, st300.lastUnreadSeq, '非 @ SILENT：水位推进（正常消化未读）');
  assert.ok(!scheduled.some((s) => s.k === 'g300'), '非 @ 场景 SILENT 不触发重试');
  assert.equal(st300.atSilentViolationSeq, 0, '非 @ 场景不记违规');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('私聊唤醒等同 @：prompt 注入禁令', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.wakeScheduler.stop(); // 纯 prompt 测试
  bridge.socialV2.pushIncoming('p100', { sender: '私聊用户', userId: '100', text: '在吗', atMe: false, isPrivate: true });
  const prompt = bridge._buildWakePrompt('p100', 'private', bridge.socialV2.peekUnread('p100'));
  assert.ok(prompt.includes('不要输出 [SILENT]'), '私聊应命中禁令');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('_composePrompt：@/私聊直投注入 SILENT 禁令，普通群消息不注入', async () => {
  const { bridge, tmp } = makeBridge();
  const atRaw = { message: [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: '在吗' } }] };
  const atPrompt = bridge._composePrompt({ groupId: '200', userId: '100', text: '在吗', raw: atRaw });
  assert.ok(atPrompt.includes('不要输出 [SILENT]'), '@ 直投应注入禁令');
  const plainPrompt = bridge._composePrompt({ groupId: '200', userId: '100', text: '普通聊天', raw: { message: [{ type: 'text', data: { text: '普通聊天' } }] } });
  assert.ok(!plainPrompt.includes('不要输出 [SILENT]'), '普通群消息不注入');
  const privPrompt = bridge._composePrompt({ groupId: null, userId: '100', text: '私聊', raw: {} });
  assert.ok(privPrompt.includes('不要输出 [SILENT]'), '私聊应注入禁令');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑬ B6：wake-config 硬钳制 ──
await test('B6：wake-config 钳制——sleepUntil≤4h、mode 归一 diving、atMention 保底', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const headers = { 'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200' };
  // 1) 模型试图关 atMention + 设 active + 超长睡眠
  const farFuture = Date.now() + 24 * 3600 * 1000; // 24h 后——超 4h 上限
  let r = await call(bridge, '/agent/wake-config', {
    method: 'POST', headers,
    body: { mode: 'active', infinite: false, sleepUntil: farFuture, triggers: { atMention: false, nameMention: false, question: false, poke: false } },
  });
  assert.equal(r.status, 200);
  let wc = r.data.wakeConfig;
  assert.equal(wc.mode, 'diving', 'infinite=false 必须归一为 diving');
  assert.equal(wc.triggers.atMention, true, 'atMention 保底不可关');
  assert.ok(wc.sleepUntil <= Date.now() + 4 * 3600 * 1000 + 1000, `sleepUntil 应被钳到 ≤4h，实际 ${new Date(wc.sleepUntil).toISOString()}`);
  // 2) 正常活跃配置不受钳制影响（active 模式下 atMention 可关——活跃由调度器兜底）
  r = await call(bridge, '/agent/wake-config', {
    method: 'POST', headers,
    body: { mode: 'active', infinite: true, sleepUntil: 0, triggers: { atMention: true } },
  });
  assert.equal(r.data.wakeConfig.mode, 'active');
  assert.equal(r.data.wakeConfig.triggers.atMention, true);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑭ C8：states API 含 hasTimer/wakeable/triggers ──
await test('C8：/api/socialv2/states 返回 hasTimer/wakeable/triggers', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.running = true; // pushIncoming 需 running
  // 白名单会话有未读 → 状态存在
  await bridge.handleIncoming({ groupId: '200', userId: '100', text: 'hello', images: [], raw: {} });
  const r = await call(bridge, '/api/socialv2/states');
  assert.equal(r.status, 200);
  const st = r.data.states.find((s) => s.key === 'g200');
  assert.ok(st, 'g200 应在状态列表');
  assert.equal(typeof st.hasTimer, 'boolean');
  assert.equal(typeof st.wakeable, 'boolean');
  assert.equal(st.wakeable, true, '默认触发器开启 → wakeable=true');
  assert.equal(st.triggers.atMention, true);
  assert.equal(typeof st.triggers.probability, 'number');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑮ 1d：triggers 类型校验 400（兑现 AUDIT 第 21 条）──
await test('1d：wake-config 非数组 triggers 返回 400 且状态不被破坏', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const headers = { 'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200' };
  const state = bridge.socialV2.get('g200');
  const before = JSON.stringify(state.wakeConfig);
  // keywords 传字符串（坏类型）
  let r = await call(bridge, '/agent/wake-config', {
    method: 'POST', headers,
    body: { triggers: { keywords: 'abc' } },
  });
  assert.equal(r.status, 400, `坏类型应 400，实际 ${r.status}`);
  // triggers 本身传数组（坏类型）
  r = await call(bridge, '/agent/wake-config', { method: 'POST', headers, body: { triggers: [] } });
  assert.equal(r.status, 400);
  // speakerIds 传字符串
  r = await call(bridge, '/agent/wake-config', { method: 'POST', headers, body: { triggers: { speakerIds: '123' } } });
  assert.equal(r.status, 400);
  assert.equal(JSON.stringify(state.wakeConfig), before, '失败请求不得修改状态');
  // 好类型正常通过
  r = await call(bridge, '/agent/wake-config', { method: 'POST', headers, body: { triggers: { keywords: ['游戏'] } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.wakeConfig.triggers.keywords, ['游戏']);
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑯ SILENT 闸：变体与散落标记不得外发 ──
await test('SILENT 闸：整条变体不外发、正文标记被剥除', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const sent = [];
  bridge.bot = { sendGroupMessage: async (gid, msg) => { sent.push({ gid, msg }); }, sendPrivateMessage: async () => ({}) };
  // 出口 1：sendToQQ 整条变体
  await bridge.sendToQQ({ groupId: '200', userId: '1' }, '[SILENT]。');
  assert.equal(sent.length, 0, '[SILENT]。 不得外发');
  // 出口 2：sendToQQ 散落标记剥除
  await bridge.sendToQQ({ groupId: '200', userId: '1' }, '我先看看 [SILENT] 好的');
  assert.equal(sent.length, 1, '剥完有正文应发送');
  assert.ok(!String(sent[0].msg).includes('[SILENT]'), '正文不得含标记');
  assert.ok(String(sent[0].msg).includes('我先看看'));
  // 出口 3：/agent/send 显式发 [SILENT] → 200 且不发
  sent.length = 0;
  const headers = { 'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200' };
  const r = await call(bridge, '/agent/send', { method: 'POST', headers, body: { messages: ['[SILENT]'] } });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 0, '显式 [SILENT] 不外发');
  // 出口 4：/agent/reply 引用回复 [SILENT]
  const r2 = await call(bridge, '/agent/reply', { method: 'POST', headers, body: { text: '[SILENT]', messageId: 1 } });
  assert.equal(r2.status, 200);
  assert.equal(sent.length, 0, '引用 [SILENT] 不外发');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ⑰ E+D：睡前观察 + 退场话闸 ──
await test('E：固定观察规则只在 system，唤醒仅含收尾提醒', async () => {
  const { bridge, tmp } = makeBridge();
  const prompt = bridge._buildWakePrompt('g200', 'proactiveCheck', []);
  const system = loadSystemPrompt(bridge.config, tmp);
  assert.ok(prompt.includes('【收尾流程】'));
  assert.ok(!prompt.includes('【群聊不是客服队列】'));
  assert.ok(system.includes('qq_wait_for_messages(timeoutSeconds=300)'));
  assert.ok(system.includes('每回合观察预算约12分钟'));
  assert.ok(system.includes('不要用[SILENT]代替给明确请求的回答'));
  assert.ok(system.includes('话没说完，继续等'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('F1/F4：未读渲染含相对时间与旧消息指引', async () => {
  const { bridge, tmp } = makeBridge();
  bridge.wakeScheduler.stop(); // 纯 prompt 构建测试：禁止概率触发真实回合（会撞真实网络）
  const now = Date.now();
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '旧话题', time: now - 45 * 60000 });
  bridge.socialV2.pushIncoming('g200', { sender: '李四', userId: '101', text: '新话题', time: now - 3 * 60000, atMe: true });
  const prompt = bridge._buildWakePrompt('g200', 'proactiveCheck', bridge.socialV2.peekUnread('g200'));
  assert.ok(prompt.includes('45 分钟前'), '旧消息应带相对时间');
  assert.ok(prompt.includes('3 分钟前'), '新消息应带相对时间');
  assert.ok(prompt.includes('超过 30 分钟的旧消息'), '应含 30 分钟旧消息指引');
  assert.ok(prompt.includes('刷到旧聊天记录'), '应含旧消息心态引导');
  assert.ok(prompt.includes('←@了你'), '指向标注保留');
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('E：/agent/wait 观察预算——按实际等待扣减、用完立即返回、单次截断', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.running = true; // handleIncoming 入库需要 running
  const headers = { 'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200' };
  const rt = bridge._runtimeFor('g200');
  rt.waitBudgetMs = 12 * 60 * 1000; // 回合开始语义
  // 轮数不限：做 3 轮 1 秒短观察（原 2 轮制下会被掐），预算足够
  for (let i = 1; i <= 3; i++) {
    const r = await call(bridge, '/agent/wait', { method: 'POST', headers, body: { timeoutSeconds: 1 } });
    assert.equal(r.status, 200);
    assert.ok(r.data.waitBudgetLeftMs > 11 * 60 * 1000, `第 ${i} 轮后预算应只扣约 1s（实际 ${r.data.waitBudgetLeftMs}ms）`);
  }
  // 预算见底：设为 500ms → wait 600s 被截断为 ≤1s 且快速返回空
  rt.waitBudgetMs = 500;
  const t0 = Date.now();
  const r3 = await call(bridge, '/agent/wait', { method: 'POST', headers, body: { timeoutSeconds: 600 } });
  assert.equal(r3.status, 200);
  assert.ok(Date.now() - t0 < 3000, `预算见底应快速返回（实际 ${Date.now() - t0}ms）`);
  // 预算用完：立即返回空 + 提示（不真等）
  rt.waitBudgetMs = 0;
  const t1 = Date.now();
  const r4 = await call(bridge, '/agent/wait', { method: 'POST', headers, body: { timeoutSeconds: 600 } });
  assert.equal(r4.status, 200);
  assert.deepEqual(r4.data.messages, [], '预算用完返回空');
  assert.ok(r4.data.note.includes('预算'), '应带预算提示');
  assert.ok(Date.now() - t1 < 2000, '预算用完不得真等');
  // 等到消息的轮次也按实际时长扣（不等满 timeout）；F2：返回消息带时间+指向渲染
  rt.waitBudgetMs = 60000;
  // OneBot 群消息事件自带 sender（昵称/群名片）——桥接据此渲染「发送者显示名」，
  // 否则模型只能看到裸 QQ 号（旧实现丢了这层昵称解析）。
  const atRaw = {
    sender: { user_id: 100, nickname: '张三' },
    message: [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: 'arrive' } }],
  };
  setTimeout(() => {
    void bridge.handleIncoming({ groupId: '200', userId: '100', text: 'arrive', images: [], raw: atRaw });
  }, 300);
  const r5 = await call(bridge, '/agent/wait', { method: 'POST', headers, body: { timeoutSeconds: 60, quietMs: 0 } });
  assert.equal(r5.data.messages.length, 1, '消息到达应返回');
  assert.ok(r5.data.messages[0].text.includes('刚刚'), 'F2：观察结果应带相对时间');
  assert.ok(r5.data.messages[0].text.includes('张三'), 'F2：应含发送者');
  assert.ok(r5.data.messages[0].text.includes('←@了你'), 'F2：@ 消息应带指向标注');
  assert.ok(r5.data.waitBudgetLeftMs > 50000 && r5.data.waitBudgetLeftMs < 60000, '按实际等待（~300ms+）扣减');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('D2：退场话闸——整句不外发、带正文放行、分条过滤', async () => {
  const { bridge, tmp } = makeBridge({ socialV2: { enabled: true, mode: 'v2', limits: { maxSendPerMinute: 60, maxSendPerHour: 600 } } });
  await bridge._startInternalHttp();
  const sent = [];
  bridge.bot = { sendGroupMessage: async (gid, msg) => { sent.push({ gid, msg }); }, sendPrivateMessage: async () => ({}) };
  // 整句退场话不外发
  await bridge.sendToQQ({ groupId: '200', userId: '1' }, '那我先撤了');
  await bridge.sendToQQ({ groupId: '200', userId: '1' }, '我去忙了。');
  await bridge.sendToQQ({ groupId: '200', userId: '1' }, '告辞~');
  assert.equal(sent.length, 0, '整句退场话不得外发');
  // 沉默旁白变体也不外发（解释+收尾短句）
  await bridge.sendToQQ({ groupId: '200', userId: '1' }, '那我先撤了，你们聊');
  await bridge.sendToQQ({ groupId: '200', userId: '1' }, '群里没聊关于我的，收');
  assert.equal(sent.length, 0, '沉默旁白变体不得外发');
  // 带实质正文放行
  await bridge.sendToQQ({ groupId: '200', userId: '1' }, '我查了一下，这个活动周五截止，你们记得报名');
  assert.equal(sent.length, 1, '带正文应放行');
  assert.ok(String(sent[0].msg).includes('周五截止'));
  // 分条过滤：正常条发送、退场条被滤
  sent.length = 0;
  const r = await call(bridge, '/agent/send', {
    method: 'POST',
    headers: { 'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200' },
    body: { messages: ['火锅走起', '我先撤了', '回聊'] },
  });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 2, '退场条被过滤，其余发送');
  assert.ok(!sent.some((s) => String(s.msg).includes('我先撤了')));
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('D3：v1 farewell prompt 不再要求告别语、允许 [SILENT] 安静退', async () => {
  const { bridge, tmp } = makeBridge();
  const prompt = bridge._buildFarewellPrompt('g200');
  assert.ok(!prompt.includes('说一句简短的收尾话'), '不应再要求收尾话');
  assert.ok(!prompt.includes('这句必须说'), '不应强制必须说');
  assert.ok(!prompt.includes('比如告辞'), '不应示例告辞话术');
  assert.ok(prompt.includes('不要说「我先撤了」'), '应禁口头禅');
  assert.ok(prompt.includes('[SILENT] 安静退场'), '应允许安静退场');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── 1：唤醒 prompt 上下文注入族 + 初始提示词 + 原因定制 ──
await test('1a/1c：唤醒 prompt 含时间观念/身份/参与度/原因引导', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.myQQId = '99999';
  const st = bridge.socialV2.get('g200');
  st.lastIncomingAt = Date.now() - 3 * 60000;
  st.lastAiReplyAt = Date.now() - 30 * 60000;
  st.lastWakeAt = Date.now() - 40 * 60000;
  st.wakeCount = 5;
  bridge.socialV2.pushIncoming('g200', { sender: '张三', userId: '100', text: '在吗' });
  st.bootstrapSent = true; // 非 bootstrap 回合才显示【唤醒原因】行
  const prompt = bridge._buildWakePrompt('g200', 'atMention', bridge.socialV2.peekUnread('g200'));
  assert.ok(prompt.includes('【现在】'), '应含时间观念段');
  assert.ok(prompt.includes('30 分钟前'), '上次发言应带相对时间（lastAiReplyAt 不被 pushIncoming 刷新）');
  assert.ok(prompt.includes('【你是谁】'), '应含身份段');
  assert.ok(prompt.includes('小鱼'), '应含 persona 昵称');
  assert.ok(prompt.includes('99999'), '应含机器人 QQ');
  assert.ok(prompt.includes('【节奏】'), '应含参与度段');
  assert.ok(prompt.includes('【唤醒原因】atMention'), '应含原因');
  // 巡逻定制引导
  const p2 = bridge._buildWakePrompt('g200', 'proactiveCheck', []);
  assert.ok(p2.includes('主动巡逻'), '巡逻应有专属引导');
  assert.ok(!p2.includes('必须给出回应'), '巡逻不应强制回应');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('1b：initialPrompt 首次唤醒注入、bootstrap 后不再出现、控制台可改', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  const st = bridge.socialV2.get('g200');
  st.initialPrompt = '这是一个游戏开黑群，忌讳讨论政治';
  // 首次（bootstrapSent=false）→ 注入
  const p1 = bridge._buildWakePrompt('g200', 'proactiveCheck', []);
  assert.ok(p1.includes('关于这个会话'), '首次应注入初始提示词');
  assert.ok(p1.includes('忌讳讨论政治'));
  assert.equal(st.bootstrapSent, true, '注入后标记 bootstrap');
  // 二次 → 不再注入
  const p2 = bridge._buildWakePrompt('g200', 'proactiveCheck', []);
  assert.ok(!p2.includes('关于这个会话'), 'bootstrap 后不再注入');
  // 控制台改写 → 重置 bootstrap
  const headers = { 'content-type': 'application/json' };
  const r = await call(bridge, '/api/socialv2/initial-prompt', { method: 'POST', headers, body: { sessionKey: 'g200', initialPrompt: '新背景' } });
  assert.equal(r.status, 200);
  assert.equal(st.bootstrapSent, false, '改写应重置 bootstrap');
  const p3 = bridge._buildWakePrompt('g200', 'proactiveCheck', []);
  assert.ok(p3.includes('新背景'), '新背景下次唤醒注入');
  const g = await call(bridge, '/api/socialv2/initial-prompt?key=g200');
  assert.equal(g.data.initialPrompt, '新背景');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── 2a：wait 静默窗 ──
await test('2a：wait 静默窗——连发多条等 quiet 后一起返回', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.running = true;
  // 1.5 秒后连发 2 条（间隔 300ms）
  setTimeout(() => {
    void bridge.handleIncoming({ groupId: '200', userId: '100', text: '第一条', images: [], raw: {} });
    setTimeout(() => {
      void bridge.handleIncoming({ groupId: '200', userId: '100', text: '第二条', images: [], raw: {} });
    }, 300);
  }, 1500);
  const t0 = Date.now();
  // quietMs=1000：第一条到达后应再等 1s（期间第二条到达刷新等待）→ 总耗时 ≥ 1.5s + 1s
  const messages = await bridge._waitForMessages('g200', 30, 1000);
  const elapsed = Date.now() - t0;
  assert.equal(messages.length, 2, '静默窗内到达的消息应一起返回');
  assert.ok(elapsed >= 2400, `应等满静默窗（elapsed=${elapsed}ms）`);
  assert.ok(messages.some((m) => m.text === '第二条'), '第二条应包含');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('2a：wait 静默窗 0 = 收到立即返回', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.running = true;
  setTimeout(() => {
    void bridge.handleIncoming({ groupId: '200', userId: '100', text: 'quick', images: [], raw: {} });
  }, 300);
  const t0 = Date.now();
  const messages = await bridge._waitForMessages('g200', 10, 0);
  assert.equal(messages.length, 1);
  assert.ok(Date.now() - t0 < 2000, 'quietMs=0 应立即返回');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── 2b：睡前观察硬闸 ──
await test('2b：观察硬闸——投喂未读后未观察就 mark_read/wake_config 返回 409', async () => {
  const { bridge, tmp } = makeBridge();
  await bridge._startInternalHttp();
  bridge.running = true;
  await bridge.handleIncoming({ groupId: '200', userId: '100', text: '在吗', images: [], raw: {} });
  const headers = { 'x-console-token': bridge.internalToken, 'x-agent-call': '1', 'x-qq-session': 'g200' };
  // 模拟：回合开始（hadUnreadThisTurn=true，预算满额=未观察）
  const rt = bridge._runtimeFor('g200');
  rt.hadUnreadThisTurn = true;
  rt.waitBudgetMs = 12 * 60 * 1000;
  // mark_read 被闸
  const r1 = await call(bridge, '/agent/mark-read', { method: 'POST', headers, body: { seq: 1 } });
  assert.equal(r1.status, 409, '未观察就 mark_read 应 409');
  assert.ok(r1.data.error.includes('观察'), '409 应带观察指引');
  // wake-config 被闸
  const r2 = await call(bridge, '/agent/wake-config', { method: 'POST', headers, body: { mode: 'diving' } });
  assert.equal(r2.status, 409, '未观察就 wake_config 应 409');
  // 观察一场后（预算被扣减）放行
  rt.waitBudgetMs = 12 * 60 * 1000 - 5000;
  const r3 = await call(bridge, '/agent/mark-read', { method: 'POST', headers, body: { seq: 1 } });
  assert.equal(r3.status, 200, '观察后 mark_read 放行');
  rt.hadUnreadThisTurn = true;
  rt.waitBudgetMs = 0; // 预算用尽（观察额度用完）也放行
  // active 不是「要睡了」→ 不受硬闸
  const r4 = await call(bridge, '/agent/wake-config', { method: 'POST', headers, body: { mode: 'active', infinite: true } });
  assert.equal(r4.status, 200, '设 active 不受硬闸');
  // 预算用尽后设 diving 也放行（prompt 已提示可直接收尾）
  const r4b = await call(bridge, '/agent/wake-config', { method: 'POST', headers, body: { mode: 'diving' } });
  assert.equal(r4b.status, 200, '预算用尽后 diving 放行');
  // 无未读回合（巡逻空醒）不设 hadUnreadThisTurn → 不闸
  bridge._runtimeFor('g200').hadUnreadThisTurn = false;
  const r5 = await call(bridge, '/agent/mark-read', { method: 'POST', headers, body: { seq: 1 } });
  assert.equal(r5.status, 200, '无未读回合不受闸');
  if (bridge.internalServer) await new Promise((resolve) => bridge.internalServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

for (const [name, promise] of asyncs) {
  await promise;
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
