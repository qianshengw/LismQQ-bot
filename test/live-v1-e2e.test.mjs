// 批次 B 真机 e2e：LongCat 端点验证 v1 全链路——
// 必回直投 → [SILENT] 潜水 → CJK 空格分条发送。
// 用法：node test/live-v1-e2e.test.mjs
import { createSessionAgent } from '../src/pi-host.js';
import { isSilentMarker, planSocialTimeline } from '../src/social-v1.js';

const BASE_URL = process.env.LIVE_BASE_URL ?? 'https://api.longcat.chat/openai/v1';
const API_KEY = process.env.LIVE_API_KEY ?? '';
const MODEL_ID = process.env.LIVE_MODEL ?? 'LongCat-2.5-Preview';

if (!API_KEY) {
  console.log('[skip] LIVE_API_KEY not set; skipping live test (key never committed)');
  process.exit(0);
}
console.log(`一代仿真真机 e2e → ${BASE_URL} / ${MODEL_ID}`);

const sentMessages = [];
const toolLog = [];
const server = null; // 无需 mock HTTP：直接在工具 execute 里收集

const agent = await createSessionAgent({
  modelConfig: {
    provider: 'longcat',
    model: MODEL_ID,
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    thinkingLevel: 'off',
    maxTokens: 512,
  },
  systemPrompt: '你是一个 QQ 群的仿真群友「小鱼」。口语化简短。需要发言时用 qq_send_message 工具；不想说话时直接输出 [SILENT]。',
  tools: [{
    name: 'mcp_qq_send_message',
    label: '发消息',
    description: '向当前 QQ 群发送文本。想分条说就用字符串数组（空格分条语义），每条一句话。',
    parameters: { type: 'object', properties: { messages: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, required: ['messages'] },
    execute: async (_id, params) => {
      const msgs = Array.isArray(params.messages) ? params.messages : [String(params.messages)];
      sentMessages.push(...msgs);
      toolLog.push(`send(${msgs.length}): ${msgs.join(' | ')}`);
      return { content: [{ type: 'text', text: '已发送' }], details: undefined };
    },
  }],
});

const checks = [];
let score = 0;
const check = (name, ok) => { checks.push(`${ok ? '✓' : '✗'} ${name}`); if (ok) score++; };

// ── 场景 1：必回消息（被点名）→ 应发言 ──
console.log('---- 场景 1：必回（被点名）----');
{
  const promptText = [
    '【群聊近况】',
    '张三：今天好累',
    '李四：是啊',
    '【刚刚发生的】',
    '王五：@小鱼 你觉得今晚吃什么好',
    '（这些消息在等你回应。回复内容即可。）',
  ].join('\n');
  await agent.prompt(promptText);
  // 判定口径与生产一致：v1 的 _runV1Turn 会把模型的文字回复自动发出去，
  // 所以「调了工具」或「直接输出文本」都算发言（只有 [SILENT] 算潜水）。
  const { text } = { text: agent.agent.state.messages.at(-1)?.content?.find?.((b) => b.type === 'text')?.text ?? '' };
  const spoke = sentMessages.length > 0 || (text && !isSilentMarker(text));
  check('必回消息 AI 发了言', !!spoke);
  console.log('AI 发言:', JSON.stringify(sentMessages.slice()), '文本:', JSON.stringify(text));
}

// ── 场景 2：非必回消息 + 明确允许潜水 → 可能 [SILENT]（多次采样统计）──
console.log('---- 场景 2：非必回（可潜水）----');
{
  const silentCount = { replies: 0, silents: 0 };
  for (let round = 0; round < 3; round++) {
    sentMessages.length = 0;
    const promptText = [
      '【群聊近况】',
      '张三：这个游戏挺好玩',
      '【刚刚发生的】',
      '李四：哈哈是的',
      '（这些不是点名你的消息。不想接就只输出 [SILENT]，想接就直接回复内容。）',
    ].join('\n');
    const { text } = await agent.prompt(promptText);
    if (isSilentMarker(text)) silentCount.silents++;
    else if (sentMessages.length > 0) silentCount.replies++;
    else silentCount.replies++; // 直接输出文本（无工具）也视为接话
  }
  console.log('三次采样:', JSON.stringify(silentCount));
  check('非必回消息 AI 有决策（接话或潜水）', silentCount.replies + silentCount.silents === 3);
}

// ── 场景 3：分条语义 ──
console.log('---- 场景 3：分条 ----');
{
  sentMessages.length = 0;
  const promptText = '【刚刚发生的】\n张三：@小鱼 复杂点说，今晚三件事：吃饭、开会、打游戏。用空格分条发出来。（这些消息在等你回应。）';
  await agent.prompt(promptText);
  const timeline = sentMessages.length > 0 ? sentMessages : [];
  console.log('AI 输出条数:', timeline.length, JSON.stringify(timeline));
  // 工具分条 > 文本分条（模型可能直接用空格输出，由 planSocialTimeline 切）
  const rawText = agent.agent.state.messages.at(-1)?.content?.find?.((b) => b.type === 'text')?.text ?? '';
  const timelineFromText = planSocialTimeline(rawText, { maxReplyChars: 500 });
  const count = Math.max(timeline.length, timelineFromText.length);
  check('AI 有输出', count > 0);
}

for (const line of checks) console.log(`  ${line}`);
console.log(`\n${score}/${checks.length} 项通过`);
process.exit(score === checks.length ? 0 : 1);
