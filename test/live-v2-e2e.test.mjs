// Real LongCat -> production Bridge -> real MCP -> mock QQ. No real contacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
if (!process.env.LIVE_API_KEY) { console.log('[skip] LIVE_API_KEY not set'); process.exit(0); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-v2-production-'));
const sent = [];
const config = {
  qq: { wsUrl: 'ws://127.0.0.1:1' },
  model: { provider: 'longcat', model: process.env.LIVE_MODEL ?? 'LongCat-2.5-Preview',
    baseUrl: process.env.LIVE_BASE_URL ?? 'https://api.longcat.chat/openai/v1',
    apiKey: process.env.LIVE_API_KEY, maxTokens: 1024, thinkingLevel: 'off' },
  persona: { name: '小鱼', systemPrompt: '你是群友小鱼，简短自然地说中文。按用户要求使用QQ工具。不需要联网搜索。' },
  memory: { enabled: true, maxRecords: 50, maxResults: 3 },
  socialV1: { enabled: false }, socialV2: { enabled: true, mode: 'v2' },
  allow: { groups: ['200'], private: [] }, deny: { groups: [], private: [] },
  tools: { enabled: true }, history: { maxMessages: 60, summarize: false },
  maxTurnSeconds: 60, sendDelayMs: 0, internalPort: 0,
};
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
const bot = { on() { return this; }, connect() {}, close() {}, getLoginInfo: async () => ({ user_id: 999 }),
  sendGroupMessage: async (id, text) => sent.push({ id, text }),
  sendPrivateMessage: async () => { throw new Error('unexpected private send'); } };
const bridge = new Bridge({ config, rootDir: root, deps: { bot } });
try {
  await bridge.start();
  const start = Date.now();
  await bridge.handleIncoming({ groupId: '200', userId: '100', images: [],
    text: '今晚一起玩游戏吗？请用 qq_send_message 回一句，再用 qq_memory 的 topic 分类记录“今晚约游戏”，并用 qq_set_wake_config 开启 atMention=true。三项都要执行。',
    raw: { message: [{ type: 'at', data: { qq: '999' } }] } });
  await bridge._runtimeFor('g200').queue;
  assert.ok(sent.length > 0, 'actual QQ output');
  assert.ok(bridge.toolSentInTurn.has('g200'), 'real send tool invoked');
  assert.ok(bridge.socialV2.formatMemory('g200').includes('今晚约游戏'), 'production memory accepts topic');
  assert.equal(bridge.socialV2.get('g200').wakeConfig.triggers.atMention, true);
  assert.equal(bridge.socialV2.peekUnread('g200').length, 0);
  console.log('PASS production V2: send, memory, wake configuration, unread', JSON.stringify({ elapsedMs: Date.now() - start, sent }));
} finally {
  await bridge.stop();
  process.removeListener('SIGINT', bridge.shutdownHandler);
  process.removeListener('SIGTERM', bridge.shutdownHandler);
  fs.rmSync(root, { recursive: true, force: true });
}
