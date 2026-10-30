// 真机联调：LongCat 端点真实对话（不用 QQ、不用 WS——直接驱动 SessionAgent）。
// 用法：node test/live-longcat.test.mjs
// 失败只影响本文件退出码，不进 run-tests.mjs（网络测试不进 CI）。
import { createSessionAgent } from '../src/pi-host.js';

const BASE_URL = process.env.LIVE_BASE_URL ?? 'https://api.longcat.chat/openai/v1';
const API_KEY = process.env.LIVE_API_KEY ?? '';
const MODEL_ID = process.env.LIVE_MODEL ?? 'LongCat-2.5-Preview';

if (!API_KEY) {
  console.log('[skip] LIVE_API_KEY not set; skipping live test (key never committed)');
  process.exit(0);
}
console.log(`真机联调 → ${BASE_URL} / ${MODEL_ID}`);

const agent = await createSessionAgent({
  modelConfig: {
    provider: 'longcat',
    model: MODEL_ID,
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    thinkingLevel: 'off',
    maxTokens: 256,
  },
  systemPrompt: '你是测试机器人。只输出一句话。',
});

console.log('发送: 用一个词回答，天空是什么颜色？');
try {
  await agent.prompt('用一个词回答，天空是什么颜色？');
  const last = agent.agent.state.messages[agent.agent.state.messages.length - 1];
  const text = (last?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  console.log('回复:', text);
  console.log('usage:', JSON.stringify(last?.usage));
  console.log('stopReason:', last?.stopReason);
  if (last?.stopReason === 'error') {
    console.error('端点返回错误:', last?.errorMessage);
    process.exit(1);
  }
  if (!text.trim()) {
    console.error('回复为空');
    process.exit(1);
  }
  console.log('\n[OK] 真机联调通过');
  process.exit(0);
} catch (error) {
  console.error('联调失败:', error?.message ?? error);
  process.exit(1);
}
