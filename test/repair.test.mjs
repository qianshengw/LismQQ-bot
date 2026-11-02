import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Bridge } from '../src/bridge.js';
import { SessionManager, createSessionAgent } from '../src/pi-host.js';
import { OneBotClient } from '../src/onebot.js';
import { WebSocketServer } from 'ws';
import { fetchImageForModel } from '../src/media.js';
import { SocialV2Store } from '../src/social-v2.js';
import vm from 'node:vm';
import { SocialV1Store } from '../src/social-v1.js';


// Exercise the real Pi provider and HTTP serialization, without external services.
async function fixture(t, { v2 = false, live = false, tools = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-repair-'));
  const requests = [], sent = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, auth: req.headers.authorization, url: req.url });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const data = { id: 'mock', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    res.end(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const model = live ? { provider: 'longcat', model: process.env.LIVE_MODEL ?? 'LongCat-2.5-Preview',
    baseUrl: process.env.LIVE_BASE_URL ?? 'https://api.longcat.chat/openai/v1', apiKey: process.env.LIVE_API_KEY }
    : { provider: 'deepseek', model: 'deepseek-flash', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'audit-placeholder' };
  const config = { qq: { wsUrl: 'ws://127.0.0.1:1' }, model: { ...model, maxTokens: 256, thinkingLevel: 'off' },
    persona: { systemPrompt: '你是测试助手。简短回答。' }, memory: { enabled: true, maxRecords: 50, maxResults: 5 },
    allow: { private: ['100', '101'], groups: ['200'] }, deny: { private: [], groups: [] },
    socialV1: { enabled: false }, socialV2: { enabled: v2, mode: 'v2' }, tools: { enabled: tools },
    history: { maxMessages: 50, summarize: false }, maxTurnSeconds: 30, sendDelayMs: 0,
    internalHost: '127.0.0.1', internalPort: 0 };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const bot = { on() { return this; }, connect() {}, close() {}, getLoginInfo: async () => ({ user_id: 999 }),
    sendPrivateMessage: async (id, text) => sent.push({ id, text }),
    sendGroupMessage: async (id, text) => sent.push({ id, text }) };
  const bridge = new Bridge({ config, rootDir: root, deps: { bot } });
  bridge.bot = bot;
  await bridge.start();
  t.after(async () => {
    bridge.running = false; clearInterval(bridge.flushTimer); clearInterval(bridge.v1LoopTimer);
    bridge.wakeScheduler?.stop();
    for (const h of bridge.mcpHandles) await h.close();
    for (const signal of ['SIGINT', 'SIGTERM']) {
      // start registers one shutdown handler per bridge; avoid fixture handler accumulation.
      process.removeListener(signal, bridge.shutdownHandler);
    }
    await new Promise(r => bridge.internalServer.close(r));
    await new Promise(r => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { bridge, requests, sent, root, model };
}

const privateMessage = (text, id = '100') => ({ userId: id, groupId: null, text, images: [], raw: {} });
async function drain(b, key) { await b._runtimeFor(key).queue; }

async function agentApi(b, route, body, key = 'g200') {
  const r = await fetch(`http://127.0.0.1:${b.internalPort}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': b.internalToken,
      'x-agent-call': '1', 'x-qq-session': key }, body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

test('management tools do not suppress final text replies', async t => {
  const { bridge: b, sent } = await fixture(t, { v2: true });
  const agent = await b.sessionManager.get('g200');
  agent.prompt = async () => {
    assert.equal((await agentApi(b, '/agent/wake-config', {})).status, 200);
    assert.equal((await agentApi(b, '/agent/memory', { category: 'topic', text: '游戏' })).status, 200);
    return { text: '今晚见' };
  };
  b.socialV2.pushIncoming('g200', { sender: '100', text: '今晚来吗' });
  await b._runWakeTurn('g200', 'manual');
  assert.deepEqual(sent.map(m => m.text), ['今晚见']);
});

test('V2 batches the newest unread first, keeps old backlog as background and never drops it', async t => {
  const { bridge: b } = await fixture(t, { v2: true });
  const agent = await b.sessionManager.get('g200');
  const prompts = [];
  agent.prompt = async text => { prompts.push(text); return { text: '[SILENT]' }; };
  for (let i = 1; i <= 25; i++) b.socialV2.pushIncoming('g200', { sender: '100', text: '字'.repeat(250) + 'TAIL-' + i });
  await b._runWakeTurn('g200', 'manual');
  // QUALITY-REPORT P1-03：唤醒后不该先回**最老**的消息——最新 20 条才是当下上下文
  assert.ok(prompts[0].includes('TAIL-25'), '首批应包含最新一条');
  assert.ok(prompts[0].includes('TAIL-6'), '首批应包含最新的 20 条');
  assert.ok(!prompts[0].includes('[seq=1]'), '最老的 5 条不应进首批');
  assert.ok(prompts[0].includes('另有 5 条更早的未读'), '老积压应作为背景说明');
  // 老积压不能被静默抹掉：仍在队列里，等过期归档
  assert.equal(b.socialV2.peekUnread('g200').length, 5, '老积压应保留在队列（不丢消息）');
  // 下一轮不再展示这些老消息（它们是背景，不是待办）
  await b._runWakeTurn('g200', 'manual');
  assert.ok(!prompts[1].includes('TAIL-1]'), '下一轮不应再展示老积压');
});

test('V1 direct input is consumed once without discarding intervening ordinary messages', async t => {
  const { bridge: b, root } = await fixture(t);
  b.config.socialV1 = { enabled: true, mode: 'v1' };
  b.socialV1 = new SocialV1Store(root, { limits: { skipProbability: 0 } });
  const st = b.socialV1.enterActive('g200'); st.lastCheckAt = Date.now() - 1000;
  const queued = []; b._enqueueV1Turn = (_, text) => queued.push(text);
  b._v1Incoming('g200', { userId: '100', text: '普通消息' });
  b._v1Incoming('g200', { userId: '100', text: '机器人能不能回答' });
  assert.equal(queued.length, 1);
  st.nextCheckAt = 0; b._v1Tick();
  assert.equal(queued.length, 2);
  assert.ok(queued[1].includes('普通消息'));
  assert.ok(!queued[1].split('【刚刚发生的】')[1].includes('机器人能不能回答'));
});

test('V1 probe response immediately reaches agent once', async t => {
  const { bridge: b, root } = await fixture(t);
  b.config.socialV1 = { enabled: true, mode: 'v1' };
  b.socialV1 = new SocialV1Store(root);
  b.socialV1.enterProbing('g200');
  const queued = []; b._enqueueV1Turn = (_, text) => queued.push(text);
  b._v1Incoming('g200', { userId: '100', text: '接你刚才的话' });
  assert.equal(queued.length, 1); assert.ok(queued[0].includes('接你刚才的话'));
  b.socialV1.state('g200').nextCheckAt = 0; b._v1Tick();
  assert.equal(queued.length, 1);
});

test('manual wake validates key and whitelist at HTTP boundary', async t => {
  const { bridge: b } = await fixture(t, { v2: true });
  assert.equal((await agentApi(b, '/api/socialv2/wake', { sessionKey: 'bad' })).status, 400);
  assert.equal((await agentApi(b, '/api/socialv2/wake', { sessionKey: 'g999' })).status, 403);
});

test('fallback, ordinary and reply sends share the same send budget', async t => {
  const { bridge: b, sent } = await fixture(t, { v2: true });
  b.socialV2.limits.maxSendPerMinute = 1;
  await b._sendToSession('g200', '第一条');
  assert.equal((await agentApi(b, '/agent/reply', { text: '第二条' })).status, 429);
  await assert.rejects(b._sendToSession('g200', '第三条'), /限频/);
  assert.equal(sent.length, 1);
});

test('send failure refunds budget and partial burst keeps only successful slots', async t => {
  const { bridge: b } = await fixture(t, { v2: true });
  let count = 0;
  b.bot.sendGroupMessage = async () => { if (++count > 1) throw new Error('disconnected'); };
  const result = await agentApi(b, '/agent/burst', { messages: ['一', '二'], gapMode: 'fixed' });
  assert.equal(result.status, 502);
  assert.equal(b.socialV2.get('g200').sendTimes.length, 1);
  assert.equal(b.toolSentInTurn.has('g200'), true);
});

test('V2 passes enriched image and quote context into the agent', async t => {
  const { bridge: b } = await fixture(t, { v2: true });
  const agent = await b.sessionManager.get('g200');
  let input;
  b._enrichMessage = async m => {
    assert.equal(m.images[0].url, 'image-reference');
    assert.equal(m.raw.message[0].type, 'reply');
    return { message: { ...m, text: m.text + '\n[引用 张三：原文]' }, images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }] };
  };
  agent.prompt = async (text, images) => { input = { text, images }; return { text: '[SILENT]' }; };
  b.socialV2.pushIncoming('g200', { sender: '100', text: '看图', images: [{ url: 'image-reference' }], raw: { message: [{ type: 'reply' }] } });
  await b._runWakeTurn('g200', 'manual');
  assert.ok(input.text.includes('[引用 张三：原文]'));
  assert.equal(input.images[0].mimeType, 'image/png');
});

test('V2 ignores non-triggering chatter even when ordinary group reply is enabled', async t => {
  const { bridge: b, requests } = await fixture(t, { v2: true });
  b.config.group = { respondToAll: true };
  b._shouldRespondInGroup = () => true;
  b.socialV2.get('g200').wakeConfig.triggers = { probability: 0 };
  await b.handleIncoming({ groupId: '200', userId: '100', text: '群友闲聊', images: [], raw: {} });
  await drain(b, 'g200');
  assert.equal(requests.length, 0);
  assert.equal(b.socialV2.peekUnread('g200').length, 1);
});

test('V2 fallback send failure preserves unread and does not claim a successful action', async t => {
  const { bridge: b } = await fixture(t, { v2: true });
  b.socialV2.pushIncoming('g200', { text: '请回复', sender: '100' });
  b.bot.sendGroupMessage = async () => { throw new Error('NapCat disconnected'); };
  await b._runWakeTurn('g200', 'manual');
  assert.equal(b.socialV2.peekUnread('g200').length, 1);
  assert.equal(b.toolSentInTurn.has('g200'), false);
});

test('Web rejects malformed trigger lists without corrupting the conversation', async t => {
  const { bridge: b } = await fixture(t, { v2: true });
  b.socialV2.get('g200');
  const response = await fetch(`http://127.0.0.1:${b.internalPort}/api/socialv2/config`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': b.internalToken },
    body: JSON.stringify({ sessionKey: 'g200', wakeConfig: { triggers: { speakerIds: '123' } } }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(b.socialV2.get('g200').wakeConfig.triggers.speakerIds, []);
});

test('V1 bridge heartbeat advances cold-room state instead of resetting its check deadline', async t => {
  const { bridge: b, root } = await fixture(t);
  b.config.socialV1 = { enabled: true, mode: 'v1' };
  b.socialV1 = new SocialV1Store(root, { limits: { idleWindowMs: 1, idleRetryProbability: 0 } });
  const st = b.socialV1.enterActive('g200');
  st.nextCheckAt = 0; st.lastActiveMessageAt = 1;
  b._v1Tick();
  assert.equal(st.phase, 'idle');
});

test('impression deletion supports names, prototype-like names are safe, read cursor is bounded', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-social-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SocialV2Store(root);
  for (const who of ['小明', '__proto__', 'constructor']) {
    assert.equal(store.appendMemory('g200', { category: 'impression', who, trait: '友好' }).ok, true);
    assert.equal(store.removeMemory('g200', { category: 'impression', text: who }).ok, true);
    assert.equal(Object.hasOwn(store.get('g200').memberImpressions, who), false);
  }
  store.pushIncoming('g200', { text: '第一条' });
  store.markSeen('g200', 999999);
  assert.equal(store.get('g200').lastReadThroughSeq, 1);
  store.pushIncoming('g200', { text: '第二条' });
  assert.equal(store.markSeen('g200', Infinity), false);
  assert.equal(store.peekUnread('g200').length, 1);
});

test('real provider: private input → model → QQ; key, endpoint and token limit reach HTTP', async t => {
  const { bridge: b, requests, sent } = await fixture(t);
  await b.handleIncoming(privateMessage('你好')); await drain(b, 'p100');
  assert.equal(sent.length, 1); assert.equal(sent[0].text, '收到');
  assert.equal(requests[0].auth, 'Bearer audit-placeholder');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].body.max_tokens ?? requests[0].body.max_completion_tokens, 256);
  assert.ok(JSON.stringify(requests[0].body.messages).includes('你好'));
});

test('messages keep full text and order; conversations remain isolated', async t => {
  const { bridge: b, requests, sent } = await fixture(t);
  await Promise.all(['第一条', '第二条', '第三条'].map(text => b.handleIncoming(privateMessage(text))));
  await drain(b, 'p100');
  assert.equal(requests.length, 3); assert.equal(sent.length, 3);
  for (const [i, text] of ['第一条', '第二条', '第三条'].entries())
    assert.ok(JSON.stringify(requests[i].body.messages).includes(text));
  await b.handleIncoming(privateMessage('另一用户', '101')); await drain(b, 'p101');
  assert.ok(!JSON.stringify(requests.at(-1).body.messages).includes('第一条'));
});

test('group @ has one immediate V2 route; self echoes are ignored', async t => {
  const { bridge: b, sent } = await fixture(t, { v2: true });
  const message = { groupId: '200', userId: '100', text: '你好', images: [],
    raw: { message: [{ type: 'at', data: { qq: '999' } }] } };
  await b.handleIncoming(message); await drain(b, 'g200');
  assert.equal(sent.length, 1); assert.equal(b.socialV2.peekUnread('g200').length, 0);
  assert.equal(b.wakeScheduler._runtime('g200').batchHandle, null);
  await b.handleIncoming({ ...message, userId: '999', raw: { post_type: 'message_sent' } });
  await drain(b, 'g200'); assert.equal(sent.length, 1);
});

test('live memory injection and persisted transcript survive manager restart', async t => {
  const { bridge: b, requests, root } = await fixture(t);
  b.memoryPool.store('喜欢喝乌龙茶', { namespace: 'p100', scope: 'user' });
  await b.handleIncoming(privateMessage('乌龙茶')); await drain(b, 'p100');
  assert.ok(JSON.stringify(requests[0].body.messages).includes('喜欢喝乌龙茶'));
  const manager = new SessionManager({ sessionsDir: path.join(root, 'state/sessions'), modelConfig: b.config.model });
  const a = await manager.get('p100');
  assert.ok(JSON.stringify(a.exportSession()).includes('乌龙茶'));
  assert.equal(manager.has('p101'), false);
});

test('session status works after creation; runtime timeout reaches existing and future agents', async t => {
  const { bridge: b } = await fixture(t);
  const a = await b.sessionManager.get('p100');
  const base = `http://127.0.0.1:${b.internalPort}`;
  const status = await fetch(base + '/agent/status', { headers: {
    'x-console-token': b.internalToken, 'x-agent-call': '1', 'x-qq-session': 'p100' } });
  assert.equal(status.status, 200); assert.equal((await status.json()).busy, false);
  const update = await fetch(base + '/api/runtime', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxTurnSeconds: 45 }) });
  assert.equal(update.status, 200); assert.equal(a.maxTurnSeconds, 45);
  assert.equal((await b.sessionManager.get('p101')).maxTurnSeconds, 45);
});

test('concurrent session creation produces one agent', async t => {
  const { bridge: b } = await fixture(t);
  const [a, c] = await Promise.all([b.sessionManager.get('p100'), b.sessionManager.get('p100')]);
  assert.equal(a, c);
});

test('persona hot reload serializes recreation and preserves dialogue', async t => {
  const { bridge: b } = await fixture(t);
  await b.handleIncoming(privateMessage('历史保留验收')); await drain(b, 'p100');
  const change = b.sessionManager.reconfigure({ systemPrompt: '新人设' });
  const next = b.sessionManager.get('p100');
  await change;
  const agent = await next;
  assert.equal(agent.agent.state.systemPrompt, '新人设');
  assert.ok(JSON.stringify(agent.exportSession()).includes('历史保留验收'));
});

test('graceful shutdown persists dialogue and releases listening sockets', async t => {
  const { bridge: b, root } = await fixture(t);
  await b.handleIncoming(privateMessage('停机验收')); await drain(b, 'p100');
  await b.stop();
  assert.equal(b.internalServer.listening, false);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'state/sessions/p100.json'), 'utf8'));
  assert.ok(JSON.stringify(saved).includes('停机验收'));
});

test('compaction retains messages appended during summary and prompt waits for it', async () => {
  const a = await createSessionAgent({ modelConfig: { provider: 'deepseek', model: 'deepseek-flash' }, maxMessages: 6 });
  a.agent.state.messages = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `old-${i}` }));
  let release; a.summarizeMessages = () => new Promise(r => { release = r; });
  const trim = a._trimHistory(); a.agent.state.messages.push({ role: 'user', content: 'new' });
  release('summary'); await trim;
  assert.ok(a.agent.state.messages.some(m => m.content === 'new'));
});

test('console plane is token-free with origin check; /agent/ still requires dual headers', async t => {
  const { bridge: b } = await fixture(t);
  // 控制面免鉴权：远程无 token 也放行
  const req = { url: '/api/model', headers: { host: 'example:3210' }, socket: { remoteAddress: '192.168.1.2' } };
  assert.equal(b._authed(req), true);
  // 跨站 Origin 仍拒绝
  req.headers.origin = 'http://foreign.example'; assert.equal(b._authed(req), false);
  req.headers.origin = 'http://example:3210'; assert.equal(b._authed(req), true);
  // /agent/ 工具回调：双头缺一不可
  const agentReq = { url: '/agent/status', headers: { host: 'example:3210' }, socket: { remoteAddress: '192.168.1.2' } };
  assert.equal(b._authed(agentReq), false);
  agentReq.headers['x-console-token'] = b.internalToken; assert.equal(b._authed(agentReq), false);
  agentReq.headers['x-agent-call'] = '1'; assert.equal(b._authed(agentReq), true);
});

test('Web controls persist cancellation, update real timers and hot-toggle simulation', async t => {
  const { bridge: b, root } = await fixture(t, { v2: true });
  const base = `http://127.0.0.1:${b.internalPort}`;
  const api = async (path, body) => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(res.status, 200, await res.clone().text()); return res.json();
  };
  b.socialV2.get('p100');
  await api('/api/socialv2/config', { sessionKey: 'p100', wakeConfig: { infinite: false, sleepUntil: Date.now() + 600000 } });
  assert.ok(b.wakeScheduler._runtime('p100').timers.has('sleep'));
  await api('/api/socialv2/config', { sessionKey: 'p100', wakeConfig: { mode: 'active', infinite: true, sleepUntil: 0 } });
  assert.equal(b.wakeScheduler._runtime('p100').timers.has('sleep'), false);
  const state = await api('/api/socialv2/state?key=p100');
  assert.equal(state.wakeConfig.sleepUntil, 0); assert.ok(state.lastConsoleAction.at);
  const restored = new SocialV2Store(path.join(root, 'state'));
  assert.equal(restored.get('p100').wakeConfig.sleepUntil, 0);
  await api('/api/socialv2/schedule', { batchWindowMs: 5000, proactiveMinMs: 300000, proactiveMaxMs: 600000, burstMaxMessages: 3 });
  assert.equal(b.socialV2.get('p100').wakeConfig.batchWindowMs, 5000);
  assert.equal(b.socialV2.limits.burstMaxMessages, 3);
  assert.ok(b.wakeScheduler._runtime('p100').timers.has('proactive'));
  await api('/api/simulation', { v1: { enabled: true, mode: 'v1' }, v2: { enabled: false, mode: 'off' } });
  assert.equal(b.socialV2, null); assert.ok(b.socialV1); assert.ok(b.v1LoopTimer);
  await api('/api/simulation', { v1: { enabled: false, mode: 'off' }, v2: { enabled: true, mode: 'v2' } });
  assert.equal(b.socialV1, null); assert.ok(b.socialV2);
  assert.equal(b.socialV2.get('p100').wakeConfig.sleepUntil, 0);
});

test('actual page JavaScript reads cancellation state and submits model limits', async () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m => m[1].includes('function app()'))[1];
  const sandbox = { localStorage: { getItem: () => '', setItem() {} }, console };
  vm.createContext(sandbox); vm.runInContext(script, sandbox);
  const app = sandbox.app();
  app.api = async () => ({ wakeConfig: { infinite: true, sleepUntil: 0, triggers: {} }, lastConsoleAction: { text: '已取消' } });
  app.v2SleepAt = '2027-01-01T00:00'; await app.v2Detail('p100');
  assert.equal(app.v2SleepAt, ''); assert.equal(app.v2DetailData.lastConsoleAction.text, '已取消');
  assert.ok(html.includes('x-model.number="modelForm.maxTokens"'));
  assert.ok(html.includes('x-model.number="v2Schedule.batchWindowMs"'));
});

test('simulation polling refreshes states without replacing unsaved form edits', async () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m => m[1].includes('function app()'))[1];
  let poll;
  const sandbox = { localStorage: { getItem: () => '', setItem() {} }, console,
    document: { body: { classList: { add() {} } } }, setInterval: fn => { poll = fn; return 1; },
    clearInterval() {}, setTimeout, clearTimeout };
  vm.createContext(sandbox); vm.runInContext(script, sandbox);
  const app = sandbox.app();
  app.refreshShell = async () => {}; app.loadView = () => {};
  app.api = async route => route.endsWith('/states') ? { enabled: true, states: [{ key: 'g200' }] } : { activity: ['new event'] };
  app.init(); app.view = 'socialv2'; app.v2Triggers.keywordsStr = 'unsaved'; app.v2SleepAt = '2027-01-01T12:00';
  await poll();
  assert.equal(app.v2.states[0].key, 'g200'); assert.equal(app.v2.activity[0], 'new event');
  assert.equal(app.v2Triggers.keywordsStr, 'unsaved'); assert.equal(app.v2SleepAt, '2027-01-01T12:00');
});

test('slow message enrichment cannot reorder a later text message', async t => {
  const { bridge: b, requests } = await fixture(t);
  const enrich = b._enrichMessage.bind(b);
  b._enrichMessage = async message => {
    if (message.text === '慢消息') await new Promise(r => setTimeout(r, 30));
    return enrich(message);
  };
  await Promise.all(['慢消息', '快消息'].map(text => b.handleIncoming(privateMessage(text))));
  await drain(b, 'p100');
  const first = JSON.stringify(requests[0].body.messages);
  assert.ok(first.includes('慢消息')); assert.ok(!first.includes('快消息'));
});

test('revoking whitelist during a turn blocks final QQ output', async t => {
  const { bridge: b, sent } = await fixture(t);
  b.config.deny.private = ['100'];
  await b.sendToQQ(privateMessage('test'), 'must not send');
  await assert.rejects(b._sendToSession('p100', 'must not send'), /不允许/);
  assert.equal(sent.length, 0);
});

test('OneBot real WebSocket handshake, inbound event and echoed action response', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(r => server.once('listening', r));
  const client = new OneBotClient({ wsUrl: `ws://127.0.0.1:${server.address().port}`, accessToken: 'test-token' });
  t.after(async () => { client.close(); for (const ws of server.clients) ws.terminate(); await new Promise(r => server.close(r)); });
  let authorization;
  server.on('connection', (ws, req) => {
    authorization = req.headers.authorization;
    ws.on('message', data => {
      const frame = JSON.parse(String(data));
      ws.send(JSON.stringify({ echo: frame.echo, status: 'ok', retcode: 0, data: { message_id: 7 } }));
    });
    ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 100,
      message: [{ type: 'text', data: { text: '协议消息' } }] }));
  });
  const inbound = new Promise(r => client.on('onPrivateMessage', r));
  const opened = new Promise(r => client.on('onOpen', r));
  client.connect(); await opened;
  assert.equal(authorization, 'Bearer test-token');
  assert.equal((await inbound).text, '协议消息');
  assert.equal((await client.sendPrivateMessage('100', 'reply')).message_id, 7);
});

test('image reader cancels oversized bodies before consuming the full stream', async () => {
  const original = globalThis.fetch;
  let reads = 0, cancelled = false;
  globalThis.fetch = async () => ({ status: 200, ok: true, headers: new Headers(), body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: new Uint8Array(600 * 1024) }; },
    cancel: async () => { cancelled = true; },
  }) } });
  try {
    const result = await fetchImageForModel('https://8.8.8.8/image');
    assert.equal(result.ok, false); assert.equal(reads, 2); assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});

test('LongCat: real model → MCP → bridge → mock QQ, with session binding', { skip: !process.env.LIVE_API_KEY }, async t => {
  const { bridge: b, sent } = await fixture(t, { live: true, tools: true });
  await b.handleIncoming(privateMessage('这是工具链路验收。必须调用 qq_send_message 工具发送且只发送 LC_REPAIR_OK，不要用普通文字代替工具。'));
  await drain(b, 'p100');
  assert.ok(sent.some(m => m.id === '100' && JSON.stringify(m.text).includes('LC_REPAIR_OK')));
  assert.equal(b.toolSentInTurn.has('p100'), true, 'must exercise actual MCP send');
});
