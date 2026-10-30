import { stripLegacyWakeRules } from './qq-chat-rules.js';
// pi-host：把 @earendil-works/pi-agent-core 的 Agent 封装成「QQ 会话 ↔ Agent 实例」的管理器。
//
// 职责（对照原 qq-bridge 的 dsh-client.js + ensureSession + pumpMux）：
//   1. 模型注册：pi-ai 的 deepseek provider（或任意 OpenAI 兼容 base_url）
//   2. 会话生命周期：创建 / 恢复（transcript JSON 持久化）/ 退役
//   3. 事件映射：agent.subscribe() 事件 → 桥接回调（onTextDelta/onTurnComplete/onToolCall/...）
//   4. 审批钩子：beforeToolCall → 桥接的 approveToolCall 回调（转 QQ 问答）
//   5. 记忆注入：transformContext 钩子 → memory-pool 检索块
//   6. token 账本：turn_end 的 message.usage 归一化累计
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, createProvider, Type } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { renderPreferenceBlock } from './memory-pool.js';

/** pi-ai 内部 openai-completions 实现（自定义 OpenAI 兼容端点用；按需动态加载）。 */
let _openAiApiImpl = null;
async function openAICompletionsApi() {
  if (!_openAiApiImpl) {
    const impl = await import('@earendil-works/pi-ai/api/openai-completions');
    _openAiApiImpl = { stream: impl.stream, streamSimple: impl.streamSimple };
  }
  return _openAiApiImpl;
}

/**
 * 解析模型：内置 deepseek 目录优先；否则（配置了 baseUrl）注册自定义 OpenAI 兼容 provider。
 * @returns {Promise<{models: MutableModels, model: Model}>}
 */
async function resolveModel(modelConfig) {
  const providerId = modelConfig.provider ?? 'deepseek';
  const models = createModels();
  if (providerId === 'deepseek') {
    models.setProvider(deepseekProvider());
  }
  let model = models.getModel(providerId, modelConfig.model);
  if (model && modelConfig.baseUrl) model = { ...model, baseUrl: modelConfig.baseUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '') };
  if (!model && modelConfig.baseUrl) {
    const modelShape = {
      id: modelConfig.model,
      name: modelConfig.model,
      api: 'openai-completions',
      provider: providerId,
      baseUrl: modelConfig.baseUrl,
      reasoning: modelConfig.reasoning === true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: modelConfig.contextWindow ?? 128000,
      maxTokens: modelConfig.maxTokens ?? 2048,
    };
    models.setProvider(createProvider({
      id: providerId,
      name: providerId,
      baseUrl: modelConfig.baseUrl.replace(/\/chat\/completions$/, '').replace(/\/v1$/, ''),
      auth: {
        apiKey: {
          name: `${providerId} API key`,
          resolve: async ({ credential }) => {
            const key = credential?.key ?? modelConfig.apiKey;
            if (!key) return undefined;
            return { auth: { apiKey: key }, source: 'config' };
          },
        },
      },
      models: [modelShape],
      api: await openAICompletionsApi(),
    }));
    model = models.getModel(providerId, modelConfig.model);
  }
  if (!model) throw new Error(`模型不存在: ${providerId}/${modelConfig.model}`);
  return { models, model };
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function normalizeUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw : {};
  return {
    input: Number(usage.input ?? 0),
    output: Number(usage.output ?? 0),
    cacheRead: Number(usage.cacheRead ?? 0),
    cacheWrite: Number(usage.cacheWrite ?? 0),
    totalTokens: Number(usage.totalTokens ?? (Number(usage.input ?? 0) + Number(usage.output ?? 0))),
    cost: usage.cost && typeof usage.cost === 'object' ? usage.cost : { ...EMPTY_USAGE.cost },
  };
}

/** 从消息数组提取 assistant 文本（toolCall/thinking 块跳过）。 */
export function assistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

/** assistant 消息里请求的工具名列表（用于判断「这条消息是不是在走发送工具」）。 */
export function assistantToolNames(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content
    .filter((block) => block && block.type === 'toolCall')
    .map((block) => String(block.name ?? ''))
    .filter(Boolean);
}

/** memory_write 工具的参数 schema（typebox）。 */
const memoryWriteSchema = Type.Object({
  content: Type.String({ description: '要记住的内容，一句话，例如「用户喜欢喝乌龙茶」' }),
});

/**
 * 恢复 transcript 时，把首条 system 消息替换为当前 systemPrompt。
 *
 * 为什么必须替换：pi 的 Agent 构造规则是「transcript 首条为 system 时不再注入
 * initialState.systemPrompt」——直接恢复会让**旧人设**永久盖住新人设（Web 上
 * 改了人设、删了会话也没用的根因之一）。统一在此处替换，三条恢复路径共用。
 *
 * @param {Array|undefined} messages - 恢复的 transcript（可为空）
 * @param {string} systemPrompt - 当前生效的人设
 * @returns {Array} 处理后的 messages（非 system 开头时不动，由 Agent 自行注入）
 */
export function applyCurrentSystemMessage(messages, systemPrompt) {
  const list = Array.isArray(messages) ? messages.map(m => {
    if (m?.role !== 'user') return m;
    if (typeof m.content === 'string') return { ...m, content: stripLegacyWakeRules(m.content) };
    if (!Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map(b => b?.type === 'text' ? { ...b, text: stripLegacyWakeRules(b.text) } : b) };
  }) : [];
  const prompt = String(systemPrompt ?? '').trim();
  if (!prompt || list.length === 0) return list; // 空 transcript 交给 Agent 自行注入
  if (list[0]?.role === 'system') {
    // 保留原 system 消息的 sections/toolsAdded 等字段（若有），只替换文本
    const old = list[0];
    list[0] = {
      ...old,
      content: prompt,
    };
    return list;
  }
  // 无 system 开头：前置一条（与 Agent 的 createInitialSystemMessage 等价，避免重复注入）
  return [{ role: 'system', content: prompt, timestamp: Date.now() }, ...list];
}

/**
 * @param {object} options
 * @param {object} options.modelConfig - { baseUrl, provider, model, apiKey, thinkingLevel, maxTokens }
 * @param {string} options.systemPrompt
 * @param {object} [options.memoryPool] - SharedMemoryPool 实例（可空）
 * @param {string} options.memoryNamespace
 * @param {object} [options.memoryOptions] - { autoCaptureUtterance, maxResults }
 * @param {(context: {toolName: string, args: unknown, toolCallId: string}) => Promise<{allow: boolean, reason?: string}>} [options.approveToolCall]
 * @param {Array} [options.tools] - 额外 AgentTool 列表（MCP 包装后的工具）
 * @param {object} [options.session] - { sessionId, messages } 恢复的 transcript
 * @param {number} [options.maxMessages] - transcript 裁剪阈值
 * @param {object} [options.streamFn] - 覆盖默认 streamFn（测试 mock 用）
 */
export async function createSessionAgent(options) {
  const { models, model } = await resolveModel(options.modelConfig);
  return new SessionAgent(options, { models, model });
}

export class SessionAgent {
  constructor(options, resolved = null) {
    this.modelConfig = options.modelConfig;
    this.memoryPool = options.memoryPool ?? null;
    this.memoryNamespace = options.memoryNamespace ?? '';
    this.memoryOptions = options.memoryOptions ?? {};
    // 审批回调绑定本 agent 的会话 key（memoryNamespace），跨会话不串号
    const boundKey = options.memoryNamespace ?? '';
    const rawApprove = options.approveToolCall ?? null;
    this.approveToolCall = rawApprove
      ? async (context) => rawApprove({ ...context, sessionKey: boundKey })
      : null;
    this.maxMessages = options.maxMessages ?? 120;
    this.maxTurnSeconds = options.maxTurnSeconds ?? 300;
    // 裁剪摘要压缩开关（config.history.summarize；false = 回退硬丢）
    this.summarizeEnabled = options.summarize !== false;
    this.listeners = {}; // 桥接回调：onTextDelta/onTurnComplete/onToolCall/onToolResult/onError

    let models;
    let model;
    if (resolved) {
      ({ models, model } = resolved);
    } else {
      // 同步路径：仅内置目录（deepseek）；自定义端点请走 createSessionAgent()
      models = createModels();
      if ((options.modelConfig.provider ?? 'deepseek') === 'deepseek') {
        models.setProvider(deepseekProvider());
      }
      model = models.getModel(options.modelConfig.provider ?? 'deepseek', options.modelConfig.model);
      if (!model) throw new Error(`模型不存在: ${options.modelConfig.provider ?? 'deepseek'}/${options.modelConfig.model}（自定义 baseUrl 请用 createSessionAgent）`);
    }

    const tools = [...(options.tools ?? [])];
    if (this.memoryPool) {
      tools.push({
        name: 'memory_write',
        label: '记录偏好',
        description: '把用户的长期偏好/事实写进记忆，下次对话可召回。只用于稳定的偏好，不要记闲聊。',
        parameters: memoryWriteSchema,
        execute: async (_id, params) => {
          this.memoryPool.store(String(params.content ?? ''), {
            namespace: this.memoryNamespace,
            source: 'user',
            scope: 'user',
          });
          return { content: [{ type: 'text', text: '已记录' }], details: undefined };
        },
      });
    }

    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt ?? '',
        model,
        thinkingLevel: options.modelConfig.thinkingLevel ?? 'off',
        tools,
        // 恢复的 transcript 首条 system 强制替换为当前 systemPrompt（防旧人设盖住新人设）
        messages: applyCurrentSystemMessage(options.session?.messages, options.systemPrompt ?? ''),
      },
      streamFn: (requestModel, context, requestOptions = {}) => {
        const stream = options.streamFn ?? models.streamSimple.bind(models);
        return stream(requestModel, context, {
          ...requestOptions,
          apiKey: requestOptions.apiKey || this.modelConfig.apiKey || undefined,
          maxTokens: requestOptions.maxTokens ?? this.modelConfig.maxTokens,
          // Bound each HTTP request below Node fetch's default headers deadline.
          // Separate from the full dialogue/observation turn budget.
          timeoutMs: requestOptions.timeoutMs ?? Math.min(120000, this.maxTurnSeconds * 1000),
        });
      },
      transformContext: this.memoryPool ? (messages) => this._injectMemory(messages) : undefined,
      beforeToolCall: this.approveToolCall
        ? async (context) => {
            const decision = await this.approveToolCall({
              toolName: context.toolCall.name,
              args: context.args,
              toolCallId: context.toolCall.id,
            });
            if (!decision.allow) {
              return { block: true, reason: decision.reason ?? '该工具调用被 QQ 侧安全策略拦截' };
            }
            return undefined;
          }
        : undefined,
      sessionId: options.session?.sessionId,
    });

    this.agent.subscribe((event) => this._dispatch(event));
  }

  _dispatch(event) {
    const fire = (name, payload) => {
      const fn = this.listeners[name];
      if (fn) {
        try {
          fn(payload);
        } catch (error) {
          console.error(`[pi-host] ${name} 回调异常:`, error?.message ?? error);
        }
      }
    };
    switch (event.type) {
      case 'message_update': {
        // 只关心 assistant 的流式文本增量
        const partial = event.message;
        if (partial?.role === 'assistant' && event.assistantMessageEvent?.type === 'text_delta') {
          fire('onTextDelta', { delta: event.assistantMessageEvent.delta });
        }
        break;
      }
      case 'tool_execution_start':
        fire('onToolCall', { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        break;
      case 'tool_execution_end':
        fire('onToolResult', { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
        break;
      case 'message_end': {
        // assistant 消息**完成**（不是流式碎片）——首答即时外发的钩子（QUALITY-REPORT P1-05）
        const completed = event.message;
        if (completed?.role === 'assistant') {
          fire('onAssistantMessage', {
            text: assistantText(completed),
            toolNames: assistantToolNames(completed),
            message: completed,
          });
        }
        break;
      }
      case 'turn_end': {
        const message = event.message;
        if (message?.role === 'assistant') {
          fire('onTurnUsage', { usage: normalizeUsage(message.usage), stopReason: message.stopReason, errorMessage: message.errorMessage });
        }
        break;
      }
      case 'agent_end':
        fire('onRunComplete', { messages: event.messages });
        break;
      default:
        break;
    }
  }

  /** 记忆注入：只读 scope='user' 分区，utterance 分区对偏好不可见。 */
  _injectMemory(messages) {
    try {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const query = typeof lastUser?.content === 'string' ? lastUser.content
        : (lastUser?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join(' ');
      if (!query) return messages;
      const results = this.memoryPool.retrieve(query, {
        namespace: this.memoryNamespace,
        scope: 'user',
        limit: this.memoryOptions.maxResults ?? 5,
      });
      const block = renderPreferenceBlock(results);
      if (!block) return messages;
      return [...messages, { role: 'user', content: block, timestamp: Date.now(), systemHint: true }];
    } catch (error) {
      console.error('[pi-host] 记忆注入失败（忽略）:', error?.message ?? error);
      return messages;
    }
  }

  _trimHistory() {
    // Share one compaction promise; prompt and lifecycle operations await its completion.
    if (this._trimPromise) return this._trimPromise;
    this._trimPromise = this._trimHistoryAsync().catch((error) => {
      console.error('[pi-host] 历史裁剪失败（忽略，保留原样）:', error?.message ?? error);
    }).finally(() => {
      this._trimPromise = null;
    });
    return this._trimPromise;
  }

  /**
   * 历史裁剪：超过 maxMessages 时把最旧的非 system 区段压缩成一条摘要消息，
   * 而不是硬丢（对齐 pi coding-agent compaction 的语义，QQ 场景简化版）。
   *
   * 结构：[system, ...摘要/保留区]；摘要消息 role=user 且带 summary:true 标记，
   * 下次裁剪跳过已有摘要（滚动合并：旧摘要文本并入新摘要）。
   * 摘要失败（网络/额度）降级为硬丢并打日志——不阻塞对话。
   */
  async _trimHistoryAsync() {
    const messages = this.agent.state.messages;
    if (messages.length <= this.maxMessages) return;

    const systemCount = messages[0]?.role === 'system' ? 1 : 0;
    // 待裁剪区：最旧的非 system、非既有摘要消息，裁到剩余 maxMessages - reserve
    const reserve = Math.floor(this.maxMessages * 2 / 3); // 保留区目标（默认 80）
    const bodyStart = systemCount;
    // 找到第一个「非摘要」消息的起点——已有摘要消息保持原位不动，只压它之后的内容
    let firstCompressible = bodyStart;
    while (firstCompressible < messages.length && messages[firstCompressible]?.summary === true) {
      firstCompressible++;
    }
    const compressibleCount = messages.length - firstCompressible;
    const overflow = compressibleCount - reserve;
    if (overflow <= 0) return;

    // 切点前移：保留段开头不能是 toolResult（否则其配对的 assistant toolCall 被裁掉，
    // 下次请求 API 报 "Cannot resolve tool name for tool_call_id" 且为持久错误）。
    let cut = firstCompressible + overflow;
    while (cut < messages.length && messages[cut]?.role === 'toolResult') {
      cut++;
    }
    if (cut >= messages.length) return; // 全是 toolResult 尾巴（异常），本轮不动

    // 待压缩段（含旧摘要消息的**文本**——滚动合并进新摘要）
    const oldSummaries = messages.slice(bodyStart, firstCompressible);
    const toCompress = [...oldSummaries, ...messages.slice(firstCompressible, cut)];
    // Retain additions made while an external caller awaits compaction.
    const kept = () => this.agent.state.messages.slice(cut);

    // 合成摘要
    const summarizeEnabled = this.summarizeEnabled !== false;
    let summaryText = null;
    if (summarizeEnabled) {
      summaryText = await this.summarizeMessages(toCompress);
    }
    if (!summaryText) {
      // 降级：硬丢（原行为），打日志
      console.warn(`[pi-host] ${this.memoryNamespace} 历史裁剪：摘要不可用，硬丢 ${toCompress.length} 条`);
      this.agent.state.messages = [...messages.slice(0, bodyStart), ...kept()];
      return;
    }

    const summaryMessage = {
      role: 'user',
      content: [{ type: 'text', text: `【此前对话摘要】\n${summaryText}\n（以上为此前对话的压缩记录，非本轮消息）` }],
      timestamp: Date.now(),
      summary: true, // 标记：下次裁剪跳过
    };
    this.agent.state.messages = [...messages.slice(0, bodyStart), summaryMessage, ...kept()];
  }

  /**
   * 调当前会话模型把一批消息压成结构化摘要。
   * @param {Array} messages - 待压缩消息（非 system）
   * @returns {Promise<string|null>} 摘要文本；失败返回 null（调用方降级硬丢）
   */
  async summarizeMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    // 拼成纯文本对话稿（assistant/toolResult 也保留，截断防超长）
    const lines = [];
    for (const m of messages) {
      const text = typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content)
          ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
          : '');
      if (!text) continue;
      const who = m.summary === true ? '[早期摘要]' : (m.role === 'assistant' ? 'AI' : (m.role === 'toolResult' ? `[工具结果 ${m.toolName ?? ''}]` : '用户'));
      lines.push(`${who}: ${String(text).slice(0, 300)}`);
    }
    if (lines.length === 0) return null;

    const summaryPrompt = [
      '以下是一段 QQ 聊天的历史记录。请把它压缩成一份结构化摘要，供后续对话接续上下文使用。',
      '按此格式输出（每节一行或几行，简洁，总长不超过 400 字）：',
      '【聊过的事】主要话题与结论',
      '【用户的偏好与约定】用户表达过的喜好/要求/承诺（没有就写"无"）',
      '【未完的话题】提到但没聊完的事（没有就写"无"）',
      '只输出摘要本身，不要客套。',
      '',
      '--- 历史记录开始 ---',
      ...lines,
      '--- 历史记录结束 ---',
    ].join('\n');

    try {
      const model = this.agent.state.model;
      const streamFn = this.agent.streamFunction;
      if (typeof streamFn !== 'function' || !model) return null;
      const stream = streamFn(model, {
        messages: [{ role: 'user', content: summaryPrompt, timestamp: Date.now() }],
      }, { maxTokens: 600, apiKey: this.modelConfig?.apiKey || undefined, signal: AbortSignal.timeout(Math.min(this.maxTurnSeconds, 60) * 1000) });
      const final = await stream.result();
      if (final?.stopReason === 'error' || final?.stopReason === 'aborted') {
        console.warn('[pi-host] 摘要调用失败:', final?.errorMessage);
        return null;
      }
      const text = (final?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return text || null;
    } catch (error) {
      console.warn('[pi-host] 摘要异常（降级硬丢）:', error?.message ?? error);
      return null;
    }
  }

  /**
   * transcript 自洁：清理 error/abort 回合留下的残骸（持久 400 错误的根源）。
   * 1) 孤儿 toolResult：toolCallId 找不到前置 assistant toolCall → 整条删除
   * 2) 无结果的 toolCall 块：剥块（剥完 assistant 空了则删整条）
   * 每次回合开始前调用；顺带兜底清除残缺的末尾 assistant。
   */
  _sanitizeTranscript() {
    const messages = this.agent.state.messages;
    if (messages.length === 0) return;
    const pending = new Set(); // 已见未消费的 toolCall id
    const cleaned = [];
    let dirty = false;
    for (const m of messages) {
      if (m?.role === 'assistant' && Array.isArray(m.content)) {
        const calls = m.content.filter((b) => b?.type === 'toolCall');
        for (const c of calls) pending.add(c.id);
      } else if (m?.role === 'toolResult') {
        if (!pending.has(m.toolCallId)) {
          dirty = true; // 孤儿：前置 toolCall 已丢（被裁剪/error 清掉）
          continue;
        }
        pending.delete(m.toolCallId);
      }
      cleaned.push(m);
    }
    // pending 里剩下的 = 有 toolCall 但没有对应 toolResult（error/abort 残骸）
    if (pending.size > 0) {
      for (const m of cleaned) {
        if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
        const before = m.content.length;
        m.content = m.content.filter((b) => !(b?.type === 'toolCall' && pending.has(b.id)));
        if (m.content.length !== before) dirty = true;
      }
      // toolCall 剥完后 assistant 可能空了（无文本无 thinking 无块）——API 不收空 assistant
      for (let i = cleaned.length - 1; i >= 0; i--) {
        const m = cleaned[i];
        if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
        if (m.content.length === 0) {
          cleaned.splice(i, 1);
          dirty = true;
        }
      }
    }
    if (dirty) {
      console.warn(`[pi-host] ${this.memoryNamespace} transcript 自洁：清理 error/abort 残骸（孤儿 toolResult / 无结果 toolCall）`);
      this.agent.state.messages = cleaned;
    }
  }

  /**
   * 投递一轮对话；解析为最终 assistant 文本。
   * @param {string} text
   * @param {Array<{data: string, mimeType: string}>} [images]
   * @returns {Promise<{text: string, errorMessage?: string}>}
   */
  async prompt(text, images) {
    if (this._trimPromise) await this._trimPromise;
    this._sanitizeTranscript();
    const content = [{ type: 'text', text }];
    for (const image of images ?? []) {
      if (image?.data && image?.mimeType) content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    }
    // 回合超时：maxTurnSeconds 到点 abort（防止一个回合永久占住串行队列）
    const turnTimeoutMs = (this.maxTurnSeconds ?? 300) * 1000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.agent.abort(); }, turnTimeoutMs);
    try {
      await this.agent.prompt([{ role: 'user', content, timestamp: Date.now() }]);
    } finally {
      clearTimeout(timer);
      await this._trimHistory();
    }
    if (timedOut) {
      console.warn(`[pi-host] ${this.memoryNamespace} 回合超时（${this.maxTurnSeconds}s），已中断`);
    }
    const last = this.agent.state.messages[this.agent.state.messages.length - 1];
    const text2 = assistantText(last);
    return { text: text2, errorMessage: last?.errorMessage };
  }

  /** 运行中追加消息（steer）。 */
  steer(text) {
    this.agent.steer({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
  }

  isBusy() {
    return this.agent.state.isStreaming;
  }

  async waitForIdle() {
    await this.agent.waitForIdle();
    if (this._trimPromise) await this._trimPromise;
  }

  abort() {
    this.agent.abort();
  }

  /** 自动捕获：把用户提问写进 utterance 分区（对偏好召回不可见）。 */
  captureUtterance(text) {
    if (!this.memoryPool) return;
    if (this.memoryOptions.autoCaptureUtterance === false) return;
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return;
    this.memoryPool.store(trimmed, {
      namespace: this.memoryNamespace,
      source: 'user',
      scope: 'utterance',
    });
  }

  /** 导出 transcript（持久化用）。 */
  exportSession() {
    return { sessionId: this.memoryNamespace, messages: this.agent.state.messages };
  }

  reset() {
    this.agent.reset();
  }
}

/**
 * 会话管理器：qqKey → SessionAgent，transcript JSON 持久化。
 */
export class SessionManager {
  constructor({
    sessionsDir,
    modelConfig,
    systemPrompt,
    memoryPool,
    memoryOptions = {},
    maxMessages = 120,
    maxTurnSeconds = 300,
    summarize = true, // 裁剪摘要压缩开关（config.history.summarize）
    toolFactory = null, // async (ctx) => AgentTool[]  每会话构建工具（MCP 包装）
    approveToolCall = null,
    approveToolCallFactory = null,
    streamFn = null, // 测试 mock
  }) {
    this.sessionsDir = sessionsDir;
    this.modelConfig = modelConfig;
    this.systemPrompt = systemPrompt;
    this.memoryPool = memoryPool;
    this.memoryOptions = memoryOptions;
    this.maxMessages = maxMessages;
    this.maxTurnSeconds = maxTurnSeconds;
    this.summarize = summarize;
    this.toolFactory = toolFactory;
    this.approveToolCall = approveToolCall;
    this.approveToolCallFactory = approveToolCallFactory;
    this.streamFn = streamFn;
    /** @type {Map<string, SessionAgent>} */
    this.agents = new Map();
    this.creating = new Map();
    /** 待重建（等回合边界）的会话 key —— P1-06：忙碌会话不阻塞配置保存 */
    this.pendingRebuild = new Set();
    this.rebuilding = new Map();
    /** 配置版本号（每次热切换 +1）—— P1-06 */
    this.configVersion = 0;
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  _sessionPath(key) {
    const safe = String(key).replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.sessionsDir, `${safe}.json`);
  }

  listSessions() {
    try {
      return fs
        .readdirSync(this.sessionsDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -5));
    } catch {
      return [];
    }
  }

  has(key) {
    return this.agents.has(key);
  }

  async get(key) {
    // 等当前这次热切换结束（重建很快——忙碌会话不会被它阻塞，见 _reconfigure）。
    // 旧实现同样等待，但旧实现的 reconfigure 会等所有会话 idle，
    // 于是形成「更新等 idle / 回合内工具等更新」的等待环（P1-06）。
    // 现在 reconfigure 不再等 idle，这里的等待不会再与回合互相咬合。
    if (this.reconfiguring) await this.reconfiguring.catch(() => {});
    if (this.rebuilding.has(key)) await this.rebuilding.get(key);
    if (this.agents.has(key)) {
      const agent = this.agents.get(key);
      if (this.pendingRebuild.has(key) && !agent.isBusy()) {
        await this._rebuildAgent(key);
        return this.agents.get(key);
      }
      return agent;
    }

    if (this.creating.has(key)) return this.creating.get(key);
    const creation = this._create(key);
    this.creating.set(key, creation);
    try { return await creation; } finally { this.creating.delete(key); }
  }

  async _create(key) {
    const filePath = this._sessionPath(key);
    let restored = undefined;
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(parsed?.messages)) restored = { sessionId: key, messages: parsed.messages };
      } catch (error) {
        console.warn(`[pi-host] 恢复会话 ${key} 失败（忽略，从头开始）:`, error?.message ?? error);
      }
    }

    const tools = this.toolFactory ? await this.toolFactory({ sessionKey: key }) : [];
    const agent = await createSessionAgent({
      modelConfig: this.modelConfig,
      systemPrompt: this.systemPrompt,
      memoryPool: this.memoryPool,
      memoryNamespace: key,
      memoryOptions: this.memoryOptions,
      approveToolCall: this.approveToolCallFactory ? this.approveToolCallFactory(key) : this.approveToolCall,
      tools,
      session: restored,
      maxMessages: this.maxMessages,
      summarize: this.summarize,
      maxTurnSeconds: this.maxTurnSeconds ?? 300,
      streamFn: this.streamFn ?? undefined,
    });
    this.agents.set(key, agent);
    return agent;
  }

  /**
   * 运行参数热更新传播：把 maxMessages/summarize 同步到所有已存在的会话 agent。
   * （/api/runtime 修改后调用——否则只有新会话生效，旧会话仍是旧值）
   */
  applyRuntimeLimits({ maxMessages, summarize, maxTurnSeconds } = {}) {
    if (Number.isFinite(Number(maxMessages))) this.maxMessages = Number(maxMessages);
    if (typeof summarize === 'boolean') this.summarize = summarize;
    if (Number.isFinite(maxTurnSeconds)) this.maxTurnSeconds = maxTurnSeconds;
    for (const agent of this.agents.values()) {
      if (Number.isFinite(maxTurnSeconds)) agent.maxTurnSeconds = maxTurnSeconds;
      if (Number.isFinite(Number(maxMessages))) agent.maxMessages = Number(maxMessages);
      if (typeof summarize === 'boolean') agent.summarizeEnabled = summarize;
    }
  }

  /** 持久化一个会话的 transcript。 */
  save(key) {
    const agent = this.agents.get(key);
    if (!agent) return;
    const session = agent.exportSession();
    const filePath = this._sessionPath(key);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session), 'utf8');
    fs.renameSync(tmp, filePath);
    // 回合边界：把「等回合结束才生效」的待重建会话应用掉（P1-06）
    this.maybeRebuildPending(key);
  }

  saveAll() {
    for (const key of this.agents.keys()) this.save(key);
  }

  /**
   * 热切换模型/人设：更新运行态配置，重建会话 Agent（transcript 保留）。
   *
   * 【P1-06 修复】旧实现会 `await old.waitForIdle()` 逐个等所有会话跑完当前回合，
   * 一个忙群能把保存请求拖到几分钟；而且期间所有 get() 都排队等重建完成。
   * 现在：
   *   - 配置立即生效（version++），新会话直接用新配置；
   *   - 空闲会话立刻重建（很快，不阻塞请求）；
   *   - 忙碌会话标记为 pending，在回合边界（save/回合结束）重建，不阻塞全局。
   *
   * @param {object} next - { modelConfig, systemPrompt }
   * @returns {Promise<{ok: boolean, version: number, applied: number, pending: number}>}
   */
  async reconfigure(next = {}) {
    const pending = this.reconfiguring ?? Promise.resolve();
    const update = pending.catch(() => {}).then(() => this._reconfigure(next));
    this.reconfiguring = update;
    try { return await update; } finally { if (this.reconfiguring === update) this.reconfiguring = null; }
  }

  async _reconfigure({ modelConfig, systemPrompt } = {}) {
    await Promise.all(this.creating.values());
    if (modelConfig) {
      // 语义明确（QUALITY-REPORT P2-10）：
      //   - 传入的字段一律采用新值（baseUrl 传空串 = 显式清空）；
      //   - apiKey 传空串 = 「保留旧 key」（控制台脱敏提交场景），用 keepApiKey 标记。
      const patch = { ...modelConfig };
      if (modelConfig.keepApiKey) {
        delete patch.keepApiKey;
        delete patch.apiKey;
      }
      this.modelConfig = { ...this.modelConfig, ...patch };
      delete this.modelConfig.keepApiKey;
    }
    if (systemPrompt !== undefined) {
      const prompt = String(systemPrompt ?? '');
      // 空人设是**合法**的（用户可能想清空）——但不能落成「保存成功却仍是旧人设」。
      // 调用方负责传入**解析后**的最终人设（loadSystemPrompt 有默认兜底，不会是空串）。
      this.systemPrompt = prompt;
    }
    this.configVersion = (this.configVersion ?? 0) + 1;

    const keys = [...this.agents.keys()];
    let applied = 0;
    const pendingKeys = [];
    for (const key of keys) {
      const old = this.agents.get(key);
      if (!old) continue;
      if (old.isBusy()) {
        // 忙碌会话：推迟到回合边界重建，不阻塞保存请求
        this.pendingRebuild.add(key);
        pendingKeys.push(key);
        continue;
      }
      await this._rebuildAgent(key);
      applied++;
    }
    console.log(`[pi-host] 已热切换配置（v${this.configVersion}）：${applied} 个会话即时重建，${pendingKeys.length} 个待回合结束生效`);
    return { ok: true, version: this.configVersion, applied, pending: pendingKeys.length, pendingKeys };
  }

  /**
   * 重建单个会话的 Agent（transcript 保留，配置用当前版本）。
   * @param {string} key
   */
  async _rebuildAgent(key) {
    if (this.rebuilding.has(key)) return this.rebuilding.get(key);
    const pending = this._doRebuildAgent(key);
    this.rebuilding.set(key, pending);
    try { return await pending; } finally { this.rebuilding.delete(key); }
  }

  async _doRebuildAgent(key) {
    const old = this.agents.get(key);
    if (!old) return null;
    const session = old.exportSession();
    const tools = this.toolFactory ? await this.toolFactory({ sessionKey: key }) : [];
    const agent = await createSessionAgent({
      modelConfig: this.modelConfig,
      systemPrompt: this.systemPrompt,
      memoryPool: this.memoryPool,
      memoryNamespace: key,
      memoryOptions: this.memoryOptions,
      approveToolCall: this.approveToolCallFactory ? this.approveToolCallFactory(key) : this.approveToolCall,
      tools,
      session: { sessionId: key, messages: session.messages },
      maxMessages: this.maxMessages,
      summarize: this.summarize,
      maxTurnSeconds: this.maxTurnSeconds ?? 300,
      streamFn: this.streamFn ?? undefined,
    });
    old.listeners = {}; // 断开旧实例回调
    this.agents.set(key, agent);
    this.pendingRebuild.delete(key);
    return agent;
  }

  /**
   * 回合边界应用待重建会话（忙碌会话跑完当前回合后调用）。
   * 由 SessionAgent 回合结束时触发，不阻塞任何请求。
   */
  maybeRebuildPending(key) {
    if (!this.pendingRebuild.has(key)) return;
    const agent = this.agents.get(key);
    if (!agent || agent.isBusy()) return;
    void this._rebuildAgent(key).catch((error) => {
      console.error(`[pi-host] 会话 ${key} 待生效重建失败:`, error?.message ?? error);
    });
  }

  /** 退役会话：清内存 + 删 transcript。 */
  async retire(key) {
    if (this.rebuilding.has(key)) await this.rebuilding.get(key);
    this.pendingRebuild.delete(key);
    if (this.creating.has(key)) await this.creating.get(key);
    const agent = this.agents.get(key);
    if (agent) {
      try {
        agent.abort();
        await agent.waitForIdle();
      } catch {
        // 中断即可
      }
      this.agents.delete(key);
    }
    try {
      fs.rmSync(this._sessionPath(key), { force: true });
    } catch {
      // 文件不存在
    }
    if (this.memoryPool) this.memoryPool.clear(key);
  }
}
