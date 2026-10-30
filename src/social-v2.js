// 二代仿真（socialV2）状态模块：wake 配置 / 群友记忆 / seq 水位 / 限频窗口。
// 移植自 qq-bridge bridge.js 的 socialV2 状态域（状态结构与防呆语义保持一致），
// 全部是桥接本地状态，与 agent 后端无关。
//
// 关键差异（pi 架构适配）：
//   - 会话 key 规范化：旧版 'group:123' / 'private:456'，新桥 'g123' / 'p456'；
//     canonicalKey() 双向兼容，旧数据可直接继承。
//   - preSleep 观察窗按决策简化掉（AI 声明潜水直接生效，唤醒条件照常触发）。
//   - agentToken 体系不移植（新桥用 x-qq-session 头绑定，安全性更好）。
import fs from 'node:fs';
import path from 'node:path';

// ── key 规范化 ───────────────────────────────────────────────────────────────

/**
 * 会话 key 统一为新桥格式（g123 / p456）。
 * 兼容旧版 social-v2.json 里的 'group:123' / 'private:456' 与各种变体。
 */
export function canonicalKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^[gp]\d+$/.test(s)) return s; // 已是新格式
  const m = s.match(/^(?:group|private)[:_](\d+)$/i);
  if (m) return (m[0].toLowerCase().startsWith('group') ? 'g' : 'p') + m[1];
  // 纯数字：无法区分群/私聊，交给调用方补类型（这里返回空串拒绝猜测）
  return /^\d+$/.test(s) ? '' : '';
}

/** 纯数字 id + 会话类型 → key。 */
export function keyOf(type, id) {
  return (type === 'group' ? 'g' : 'p') + String(id).replace(/\D/g, '');
}

// ── 默认配置（对齐旧版语义）───────────────────────────────────────────────

export const DEFAULT_WAKE_CONFIG = Object.freeze({
  mode: 'diving', // active | diving
  infinite: true, // true = 无限期潜水（直到触发器叫醒）
  sleepUntil: 0, // 有限潜水的时间戳（ms）
  triggers: {
    atMention: true,
    nameMention: true,
    speakerIds: [],
    keywords: [],
    question: true,
    poke: true,
    anyMessage: false,
    probability: 0.05,
  },
  batchWindowMs: 3000,
});

export const DEFAULT_V2_LIMITS = Object.freeze({
  maxSendPerMinute: 8,
  maxSendPerHour: 60,
  // ── 唤醒限频按「档位」拆分（QUALITY-REPORT P1-01）──
  // direct：显式请求（@我 / 私聊 / 戳一戳）——用户点名，不应被普通巡逻额度卡住
  maxDirectWakePerMinute: 6,
  maxDirectWakePerHour: 120,
  // followUp：短时跟随（我刚问过话，对方接了）——用户驱动但非显式
  maxFollowUpWakePerMinute: 3,
  maxFollowUpWakePerHour: 60,
  // normal：常规触发器（提到名字 / 向我提问 / 关键词 / 指定人 / 任意消息 / 概率）
  maxWakePerMinute: 1,
  maxWakePerHour: 30,
  // proactive：AI 自己的定时器（巡逻 / 回复检查 / 睡眠到点 / 手动）
  maxProactiveWakePerMinute: 1,
  maxProactiveWakePerHour: 20,
  // followUp 触发窗口：我上次发言后多久内算「接我的话」
  followUpWindowMs: 5 * 60 * 1000,
  // 过期闲聊归档阈值：超过这个时间的普通闲聊不再投喂（显式请求不归档）
  staleChatMs: 30 * 60 * 1000,
  burstMaxMessages: 8,
  burstMaxChars: 500,
  maxUnread: 100,
  maxRecentMessages: 200,
  maxTopics: 20,
  maxThoughts: 20,
  maxImpressions: 50,
  topicExpireMs: 24 * 3600 * 1000,
  thoughtExpireMs: 2 * 3600 * 1000,
  proactiveBaseProbability: 0.3,
  proactiveIdeaBoost: 1.4,
  proactiveRecentPenalty: 0.5,
  proactiveNightPenalty: 0.3,
  proactiveChattyPenalty: 0.3,
  noActionResetThreshold: 3,
  recentSendWindowMs: 3600 * 1000,
  recentSendChattyCount: 5,
  // 回复检查基础概率（原实现从 1 起步再截到 1 → 恒 100% 触发）
  replyCheckBaseProbability: 0.5,
});

/** 触发器优先级（唤醒原因合并时，高级原因覆盖低级）。 */
export const WAKE_PRIORITY = Object.freeze({
  private: 100,
  anyMessage: 15,
  atMention: 70,
  followUp: 65,
  nameMention: 60,
  question: 50,
  poke: 40,
  keyword: 30,
  speaker: 20,
  probability: 10,
});

/**
 * 唤醒档位（QUALITY-REPORT P1-01：显式请求 / 跟随 / 常规 / 主动 四级限频）。
 * 每档有独立额度，互不挤占——显式 @ 不再被「每分钟 1 次」的巡逻额度卡住。
 */
export const WAKE_TIER = Object.freeze({
  direct: 'direct',
  followUp: 'followUp',
  normal: 'normal',
  proactive: 'proactive',
});

/** 唤醒原因 → 档位映射。 */
export const WAKE_REASON_TIER = Object.freeze({
  private: WAKE_TIER.direct,
  atMention: WAKE_TIER.direct,
  poke: WAKE_TIER.direct,
  followUp: WAKE_TIER.followUp,
  nameMention: WAKE_TIER.normal,
  question: WAKE_TIER.normal,
  anyMessage: WAKE_TIER.normal,
  keyword: WAKE_TIER.normal,
  speaker: WAKE_TIER.normal,
  probability: WAKE_TIER.normal,
  proactiveCheck: WAKE_TIER.proactive,
  replyCheck: WAKE_TIER.proactive,
  timeout: WAKE_TIER.proactive,
  manual: WAKE_TIER.proactive,
  unreadContinuation: WAKE_TIER.proactive,
});

/** 某档位的限频字段名（limits 上的 maxXxxWakePerMinute / PerHour）。 */
export const WAKE_TIER_LIMIT_FIELDS = Object.freeze({
  direct: ['maxDirectWakePerMinute', 'maxDirectWakePerHour'],
  followUp: ['maxFollowUpWakePerMinute', 'maxFollowUpWakePerHour'],
  normal: ['maxWakePerMinute', 'maxWakePerHour'],
  proactive: ['maxProactiveWakePerMinute', 'maxProactiveWakePerHour'],
});

/** 档位 → 状态里存时间戳的字段名。 */
const WAKE_TIER_TIME_FIELD = Object.freeze({
  direct: 'directWakeTimes',
  followUp: 'followUpWakeTimes',
  normal: 'wakeTimes',
  proactive: 'proactiveWakeTimes',
});

/** 取某档位；未知原因归入 proactive（最保守，不挤占用户额度）。 */
export function tierOfReason(reason) {
  return WAKE_REASON_TIER[String(reason ?? '')] ?? WAKE_TIER.proactive;
}

/**
 * 评估一条消息是否命中唤醒触发器（优先级从高到低）。
 *
 * 与原版的差异（QUALITY-REPORT P2-09）：
 *   - 新增 followUp：我上一句是提问、对方在窗口内接话 → 唤醒（原来的实现完全接不上话）
 *   - question 的判定由调用方决定（questionToMe 已包含「引用对象是我 / 提到我名字 / 指向我的措辞」），
 *     这里不再要求必须以问号结尾（那是 bridge 层的老限制）
 * @returns {{hit: boolean, reason: string}} reason ∈ WAKE_PRIORITY 键
 */
export function evaluateWakeTrigger(config, message, {
  myQQId = '', myName = '', lastAiReplyAt = 0, lastAiReplyWasQuestion = false, now = Date.now(), followUpWindowMs = 0,
} = {}) {
  const cfg = config?.triggers ?? {};
  if (message.isPrivate) return { hit: true, reason: 'private' };
  if (cfg.atMention === true && message.atMe) return { hit: true, reason: 'atMention' };
  if (cfg.nameMention === true && myName && message.text && message.text.includes(myName)) {
    return { hit: true, reason: 'nameMention' };
  }
  if (cfg.question === true && message.questionToMe) return { hit: true, reason: 'question' };
  if (cfg.poke === true && message.isPoke) return { hit: true, reason: 'poke' };
  if (Array.isArray(cfg.keywords) && cfg.keywords.length > 0 && message.text) {
    const lower = message.text.toLowerCase();
    for (const kw of cfg.keywords) {
      const k = String(kw).toLowerCase();
      if (!k) continue;
      // 短英文词按词边界匹配，避免 "ds" 命中 "words"
      const pattern = /^[a-z0-9]+$/i.test(k) ? new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
      if (pattern ? pattern.test(lower) : lower.includes(k)) return { hit: true, reason: 'keyword' };
    }
  }
  if (Array.isArray(cfg.speakerIds) && cfg.speakerIds.map(String).includes(String(message.userId))) {
    return { hit: true, reason: 'speaker' };
  }
  // 短时跟随：我刚问过话，对方在窗口内接话 → 当成一次「正在对话中的定向接话」（QUALITY-REPORT P2-09）
  if (
    followUpWindowMs > 0
    && lastAiReplyWasQuestion
    && lastAiReplyAt > 0
    && now - lastAiReplyAt <= followUpWindowMs
    && message.text
    && String(message.text).trim().length > 0
  ) {
    return { hit: true, reason: 'followUp' };
  }
  if (cfg.anyMessage === true) return { hit: true, reason: 'anyMessage' };
  const p = Number(cfg.probability ?? 0);
  if (p > 0 && Math.random() < p) return { hit: true, reason: 'probability' };
  return { hit: false, reason: '' };
}

// ── 会话状态 ────────────────────────────────────────────────────────────────

export function newConversationState(key, now = Date.now()) {
  return {
    key,
    wakeConfig: { ...DEFAULT_WAKE_CONFIG, triggers: { ...DEFAULT_WAKE_CONFIG.triggers } },
    // 未读队列 = **唯一事实源**（QUALITY-REPORT P1-02）。
    // 运行时另有一份 runtime.unread（桥接层），两套队列各自消费会重复投喂——已废弃，见 bridge.js。
    unread: [], // {seq, sender, userId, text, hasImage, time, messageId, atMe, questionToMe, ...}
    recentMessages: [],
    lastUnreadSeq: 0,
    // 三个独立游标（不要用一次读取等价完成回应）：
    //   shownSeq       —— 已经投喂给模型看过的最大 seq
    //   lastReadThroughSeq —— 模型自己确认已读的最大 seq
    //   handledSeq     —— 桥接判定「已回应」（有实际发送回执）的最大 seq
    shownSeq: 0,
    shownSeqs: [], // 实际展示过的 seq 集合（精确清理用，避免越界清掉没展示过的消息）
    lastReadThroughSeq: 0,
    handledSeq: 0,
    modelSeenSeqs: {}, // 模型游标回执（工具名 -> seq）
    pendingExplicit: [], // 已展示但未回应的显式请求（@/提问）——不能被归档吞掉
    archivedCount: 0, // 被归档的过期闲聊条数
    activeTopics: [], // {text, lastMentionAt, participants, pendingQuestion}
    pendingThoughts: [], // {text, motivation, expiresAt}
    memberImpressions: {}, // 名字 -> {traits[], interactionCount, lastSeenAt}
    // 限频窗口（按档位分开记账）
    wakeTimes: [], // normal 档
    directWakeTimes: [], // direct 档（显式 @/私聊/戳）
    followUpWakeTimes: [], // followUp 档
    proactiveWakeTimes: [], // proactive 档
    sendTimes: [], // 出站发送限频窗口
    lastWakeAt: 0,
    wakeCount: 0,
    noActionCount: 0,
    wakeConfigMissCount: 0,
    lastIncomingAt: 0,
    lastAiReplyAt: 0,
    lastAiReplyWasQuestion: false, // 我上一句是不是问句（followUp 触发用）
    lastActionAt: 0,
    lastAtSilentViolationAt: 0, // @ 场景输出 [SILENT] 违规的最后时间（观测用）
    atSilentViolationSeq: 0, // 违规时未读最老 seq（同批只重试一次，防唤醒死循环）
    pendingCorrection: '', // 上次没回应的纠错提示（下一轮唤醒注入）
    unansweredSeq: 0, // 已展示但未回应的显式请求 seq
    unansweredRetries: 0, // 该请求已重试次数（有限重试）
    lastWakeGate: null, // 最近一次限频判定：{reason, tier, at, retryAt, queuedMs}
    bootstrapSent: false,
    initialPrompt: '', // 会话初始提示词（控制台预写的圈子背景，首次唤醒注入一次）
    createdAt: now,
  };
}

// ── 状态仓库 ────────────────────────────────────────────────────────────────

export class SocialV2Store {
  constructor(stateDir, { limits = {}, now = Date.now } = {}) {
    this.filePath = path.join(stateDir, 'social-v2.json');
    this.limits = { ...DEFAULT_V2_LIMITS, ...limits };
    this.now = now;
    /** @type {Map<string, object>} */
    this.conversations = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const conversations = raw?.conversations ?? {};
      for (const [rawKey, value] of Object.entries(conversations)) {
        const key = canonicalKey(rawKey);
        if (!key) continue;
        // 旧数据兼容：唤醒配置缺字段补默认
        const state = {
          ...newConversationState(key),
          ...value,
          key,
          wakeConfig: {
            ...DEFAULT_WAKE_CONFIG,
            ...(value.wakeConfig ?? {}),
            triggers: { ...DEFAULT_WAKE_CONFIG.triggers, ...(value.wakeConfig?.triggers ?? {}) },
          },
        };
        // 运行时句柄不落盘；历史窗口重整
        state.unread = (state.unread ?? []).slice(-this.limits.maxUnread);
        state.recentMessages = (state.recentMessages ?? []).slice(-this.limits.maxRecentMessages);
        // 旧数据迁移：补齐新游标与分档限频数组（老文件只有 wakeTimes）
        state.shownSeq = Number(state.shownSeq ?? 0) || 0;
        state.shownSeqs = Array.isArray(state.shownSeqs) ? state.shownSeqs : [];
        state.handledSeq = Number(state.handledSeq ?? 0) || 0;
        state.lastReadThroughSeq = Number(state.lastReadThroughSeq ?? 0) || 0;
        state.pendingExplicit = Array.isArray(state.pendingExplicit) ? state.pendingExplicit : [];
        state.archivedCount = Number(state.archivedCount ?? 0) || 0;
        state.directWakeTimes = Array.isArray(state.directWakeTimes) ? state.directWakeTimes : [];
        state.followUpWakeTimes = Array.isArray(state.followUpWakeTimes) ? state.followUpWakeTimes : [];
        state.proactiveWakeTimes = Array.isArray(state.proactiveWakeTimes) ? state.proactiveWakeTimes : [];
        state.sendTimes = Array.isArray(state.sendTimes) ? state.sendTimes : [];
        state.wakeTimes = Array.isArray(state.wakeTimes) ? state.wakeTimes : [];
        this.conversations.set(key, state);
      }
      if (Object.keys(conversations).length > 0) {
        console.log(`[social-v2] 已恢复 ${this.conversations.size} 个会话状态`);
      }
    } catch {
      // 首次运行
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const conversations = {};
      for (const [key, state] of this.conversations) {
        // 只存可序列化字段（记忆/配置/水位），不存运行时对象
        conversations[key] = state;
      }
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, conversations }, null, 1), 'utf8');
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (error) {
      console.warn('[social-v2] 保存失败:', error?.message ?? error);
      return false;
    }
  }

  /** 取会话状态（不存在则创建）。 */
  get(key) {
    const k = canonicalKey(key);
    if (!k) return null;
    let state = this.conversations.get(k);
    if (!state) {
      state = newConversationState(k, this.now());
      this.conversations.set(k, state);
    }
    return state;
  }

  has(key) {
    return this.conversations.has(canonicalKey(key));
  }

  keys() {
    return [...this.conversations.keys()];
  }

  delete(key) {
    return this.conversations.delete(canonicalKey(key));
  }

  // ── 消息入库与水位 ────────────────────────────────────────────────────────

  /**
   * 消息进未读缓冲（分配递增 seq），同时入 recentMessages。
   * 这是**唯一**的未读事实源：桥接层不再维护第二份 runtime.unread。
   * @returns {number} 分配的 seq
   */
  pushIncoming(key, message) {
    const state = this.get(key);
    const seq = ++state.lastUnreadSeq;
    // eventTime：OneBot 事件自带的时间戳（服务器补发的旧消息不能显示成「刚刚」）
    const eventTime = Number(message?.eventTime ?? message?.raw?.time ?? 0);
    const receivedAt = this.now();
    const entry = {
      seq,
      ...message,
      // time 用「消息真实发生时间」判断年龄；没有就用本机接收时间
      time: Number.isFinite(eventTime) && eventTime > 0 ? (eventTime < 1e12 ? eventTime * 1000 : eventTime) : (message.time ?? receivedAt),
      receivedAt,
    };
    state.unread.push(entry);
    if (state.unread.length > this.limits.maxUnread) {
      const dropped = state.unread.splice(0, state.unread.length - this.limits.maxUnread);
      // 被容量上限挤掉的显式请求不能静默丢失——转存 pendingExplicit
      for (const m of dropped) if (this.isExplicitMessage(m)) state.pendingExplicit.push(m);
    }
    state.recentMessages.push(entry);
    if (state.recentMessages.length > this.limits.maxRecentMessages) {
      state.recentMessages = state.recentMessages.slice(-this.limits.maxRecentMessages);
    }
    state.lastIncomingAt = entry.time;
    return seq;
  }

  /** 是否是「必须回应」的显式请求（@我 / 向我提问 / 私聊）。 */
  isExplicitMessage(message) {
    return message?.atMe === true || message?.questionToMe === true || message?.isPrivate === true;
  }

  /**
   * 取未读（不动水位）。
   * @param {string} key
   * @param {object} [opts]
   * @param {number} [opts.afterSeq] - 只取 seq 大于它的（游标语义）
   * @param {number} [opts.limit] - 最多取几条（从**最新**往回取）
   * @returns {Array<object>}
   */
  peekUnread(key, { afterSeq = 0, limit = 0 } = {}) {
    const state = this.get(key);
    const list = state.unread.filter((m) => m.seq > afterSeq);
    if (limit > 0 && list.length > limit) return list.slice(-limit);
    return list;
  }

  /**
   * 取出「已展示」的一段消息：**只推进 shownSeq 水位，不移除队列**。
   *
   * 为什么不移除：回合失败（超时/断连/400）时这批消息必须能原样重投，
   * 「无丢消息」比「不重复展示」更重要。消息真正离开队列靠
   * markRead（模型确认已读）/ markHandled（有实际发送回执）/ archiveStale（过期归档）。
   *
   * 关键：不能用 markSeen(maxSeq) 把中间**没展示过**的消息一起抹掉——
   * 只推进水位，队列里的消息由各自的 seq 精确处理。
   *
   * @param {string} key
   * @param {Array<number>} seqs
   * @param {object} [opts] - { tool } 模型游标回执来源
   */
  markShownSeqs(key, seqs, { tool = 'auto-after-turn' } = {}) {
    const state = this.get(key);
    const list = (Array.isArray(seqs) ? seqs : [seqs]).map((n) => Number(n)).filter((n) => Number.isFinite(n));
    if (list.length === 0) return 0;
    const max = Math.max(...list);
    state.shownSeq = Math.max(state.shownSeq ?? 0, max);
    state.modelSeenSeqs[tool] = Math.max(state.modelSeenSeqs[tool] ?? 0, max);
    // 记录真正展示过的 seq（精确清理用——不能越界清掉没展示过的老消息）
    const shown = new Set(state.shownSeqs ?? []);
    for (const s of list) shown.add(s);
    state.shownSeqs = [...shown].sort((a, b) => a - b).slice(-1000);
    return list.length;
  }

  /** 模型游标回执：模型声称已看到 seq N（兼容旧调用；按水位推进）。 */
  markSeen(key, seq, { tool = 'qq_get_unread_messages' } = {}) {
    const state = this.get(key);
    const parsed = Number(seq);
    if (!Number.isFinite(parsed)) return false;
    const n = Math.min(state.lastUnreadSeq, Math.max(0, Math.floor(parsed)));
    state.modelSeenSeqs[tool] = Math.max(state.modelSeenSeqs[tool] ?? 0, n);
    if (n > state.lastReadThroughSeq) state.lastReadThroughSeq = n;
    // 从 unread 里清掉已确认看到的
    state.unread = state.unread.filter((m) => m.seq > n);
    return true;
  }

  /**
   * 模型确认已读（qq_mark_read）：推进已读水位，**只清理确实展示过**的那几条。
   * 跨过没展示过的老消息会造成「老消息水位被错误跨越」——这里刻意不做。
   * @returns {number} 新的已读水位
   */
  markRead(key, seq, { tool = 'qq_mark_read' } = {}) {
    const state = this.get(key);
    const parsed = Number(seq);
    if (!Number.isFinite(parsed)) return state.lastReadThroughSeq;
    const n = Math.min(state.lastUnreadSeq, Math.max(0, Math.floor(parsed)));
    state.modelSeenSeqs[tool] = Math.max(state.modelSeenSeqs[tool] ?? 0, n);
    if (n > state.lastReadThroughSeq) state.lastReadThroughSeq = n;
    const shown = new Set(state.shownSeqs ?? []);
    state.unread = state.unread.filter((m) => !(m.seq <= n && shown.has(m.seq)));
    state.pendingExplicit = (state.pendingExplicit ?? []).filter((m) => m.seq > n || !shown.has(m.seq));
    return state.lastReadThroughSeq;
  }

  /**
   * 按**明确 seq 集合**确认已读（桥接自动确认用）：只清理给定的那些消息。
   * @param {string} key
   * @param {Array<number>} seqs
   */
  markReadSeqs(key, seqs) {
    const state = this.get(key);
    const list = (Array.isArray(seqs) ? seqs : [seqs]).map((n) => Number(n)).filter((n) => Number.isFinite(n));
    if (list.length === 0) return state.lastReadThroughSeq;
    const set = new Set(list);
    state.unread = state.unread.filter((m) => !set.has(m.seq));
    if (Math.max(...list) > state.lastReadThroughSeq) state.lastReadThroughSeq = Math.max(...list);
    state.pendingExplicit = (state.pendingExplicit ?? []).filter((m) => !set.has(m.seq));
    return state.lastReadThroughSeq;
  }

  /**
   * 标记「已回应」（有实际 QQ 发送回执时调用）：推进 handledSeq，
   * 并把对应的显式请求从 pendingExplicit 移除。
   */
  markHandled(key, seq) {
    const state = this.get(key);
    const seqs = new Set((Array.isArray(seq) ? seq : [seq]).map(Number));
    const parsed = Math.max(...seqs);
    if (!Number.isFinite(parsed)) return state.handledSeq ?? 0;
    const n = Math.min(state.lastUnreadSeq, Math.max(0, Math.floor(parsed)));
    if (n > (state.handledSeq ?? 0)) state.handledSeq = n;
    state.pendingExplicit = (state.pendingExplicit ?? []).filter((m) => !seqs.has(m.seq));
    if (state.unansweredSeq && state.unansweredSeq <= n) {
      state.unansweredSeq = 0;
      state.unansweredRetries = 0;
    }
    return state.handledSeq;
  }

  /**
   * 记录「已展示但未回应的显式请求」。
   * @param {Array<object>} messages
   */
  trackExplicitPending(key, messages) {
    const state = this.get(key);
    const list = (Array.isArray(messages) ? messages : [messages]).filter((m) => m && this.isExplicitMessage(m));
    if (list.length === 0) return;
    const known = new Set((state.pendingExplicit ?? []).map((m) => m.seq));
    for (const m of list) {
      if (known.has(m.seq)) continue;
      known.add(m.seq);
      state.pendingExplicit.push({ seq: m.seq, sender: m.sender, text: m.text, time: m.time, atMe: m.atMe === true, questionToMe: m.questionToMe === true });
    }
    if (state.pendingExplicit.length > 50) state.pendingExplicit = state.pendingExplicit.slice(-50);
    const newest = list[list.length - 1];
    if (newest) {
      state.unansweredSeq = Math.max(state.unansweredSeq ?? 0, newest.seq);
      state.unansweredRetries = state.unansweredRetries ?? 0;
    }
  }

  /**
   * 归档过期闲聊：超过 staleChatMs 的**普通**消息不再投喂（显式请求永不归档，
   * 它们要么留在未读队列，要么进 pendingExplicit）。
   * @returns {number} 归档条数
   */
  archiveStale(key) {
    const state = this.get(key);
    const cutoff = this.now() - (this.limits.staleChatMs ?? 30 * 60 * 1000);
    const keep = [];
    let archived = 0;
    for (const m of state.unread) {
      const explicit = this.isExplicitMessage(m);
      const age = this.now() - (m.time ?? m.receivedAt ?? this.now());
      if (!explicit && age > (this.limits.staleChatMs ?? 30 * 60 * 1000)) {
        archived++;
        continue;
      }
      keep.push(m);
    }
    state.unread = keep;
    state.archivedCount = (state.archivedCount ?? 0) + archived;
    void cutoff;
    return archived;
  }

  // ── 记忆 ─────────────────────────────────────────────────────────────────

  appendMemory(key, { category, text, motivation = '', who = '', trait = '' } = {}) {
    const state = this.get(key);
    const now = this.now();
    // impression：群友印象（who=名字，trait=印象标签；text 兜底拆「名字:标签」）
    if (category === 'impression') {
      let name = String(who ?? '').trim();
      let t = String(trait ?? '').trim();
      if (!name && text) {
        const m = String(text).match(/^([^:：]{1,60})[:：]\s*(.+)$/);
        if (m) { name = m[1].trim(); t = m[2].trim(); }
      }
      if (!name) return { ok: false, error: 'impression 需要 who（名字）或「名字:标签」格式的 text' };
      if (!t) return { ok: false, error: 'impression 需要 trait（印象标签）' };
      this.touchImpression(key, name, { trait: t });
      return { ok: true, memory: this.formatMemory(key) };
    }
    const clean = String(text ?? '').trim().slice(0, 300);
    if (!clean) return { ok: false, error: 'text 为空' };
    if (category === 'topic') {
      const existing = state.activeTopics.find((t) => t.text === clean);
      if (existing) {
        existing.lastMentionAt = now;
      } else {
        state.activeTopics.push({ text: clean, lastMentionAt: now, participants: [], pendingQuestion: '' });
        if (state.activeTopics.length > this.limits.maxTopics) state.activeTopics.shift();
      }
      return { ok: true, memory: this.formatMemory(key) };
    }
    if (category === 'thought') {
      state.pendingThoughts.push({ text: clean, motivation: String(motivation).slice(0, 200), expiresAt: now + this.limits.thoughtExpireMs });
      if (state.pendingThoughts.length > this.limits.maxThoughts) state.pendingThoughts.shift();
      return { ok: true, memory: this.formatMemory(key) };
    }
    return { ok: false, error: `未知分类: ${category}（topic | thought | impression）` };
  }

  /** 群友印象（按发言自动累计 + AI 可补充 traits）。 */
  touchImpression(key, name, { trait = '' } = {}) {
    const state = this.get(key);
    const n = String(name ?? '').trim().slice(0, 60);
    if (!n) return;
    if (!Object.hasOwn(state.memberImpressions, n)) {
      Object.defineProperty(state.memberImpressions, n, { value: { traits: [], interactionCount: 0, lastSeenAt: 0 }, enumerable: true, writable: true, configurable: true });
    }
    const entry = state.memberImpressions[n];
    entry.interactionCount += 1;
    entry.lastSeenAt = this.now();
    if (trait) {
      const t = String(trait).trim().slice(0, 60);
      if (t && !entry.traits.includes(t)) {
        entry.traits.push(t);
        if (entry.traits.length > 8) entry.traits.shift();
      }
    }
    if (Object.keys(state.memberImpressions).length > this.limits.maxImpressions) {
      // 淘汰最久未见的
      const oldest = Object.entries(state.memberImpressions).sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (oldest) delete state.memberImpressions[oldest[0]];
    }
  }

  removeMemory(key, { category, index, text, who } = {}) {
    const state = this.get(key);
    const i = Math.floor(Number(index));
    if (category === 'impression' && String(who ?? text ?? '').trim()) {
      delete state.memberImpressions[String(who ?? text).trim().slice(0, 60)];
      return { ok: true };
    }
    if (category === 'topic' && i >= 0 && i < state.activeTopics.length) {
      state.activeTopics.splice(i, 1);
      return { ok: true };
    }
    if (category === 'thought' && i >= 0 && i < state.pendingThoughts.length) {
      state.pendingThoughts.splice(i, 1);
      return { ok: true };
    }
    return { ok: false, error: 'index 越界或分类未知' };
  }

  clearMemory(key, { category } = {}) {
    const state = this.get(key);
    if (category === 'topic') state.activeTopics = [];
    else if (category === 'thought') state.pendingThoughts = [];
    else if (category === 'impression') state.memberImpressions = {};
    else if (!category) {
      state.activeTopics = [];
      state.pendingThoughts = [];
      state.memberImpressions = {};
    } else return { ok: false, error: `未知分类: ${category}` };
    return { ok: true };
  }

  /** 过期清理（topic 24h / thought 2h），返回清理数。 */
  expireMemory(key) {
    const state = this.get(key);
    const now = this.now();
    const before = state.activeTopics.length + state.pendingThoughts.length;
    state.activeTopics = state.activeTopics.filter((t) => now - t.lastMentionAt < this.limits.topicExpireMs);
    state.pendingThoughts = state.pendingThoughts.filter((t) => t.expiresAt > now);
    return before - (state.activeTopics.length + state.pendingThoughts.length);
  }

  /** 渲染成注入 prompt 的记忆块（对齐旧版 formatMemoryV2 的分区结构）。 */
  formatMemory(key) {
    const state = this.get(key);
    const lines = [];
    if (state.activeTopics.length > 0) {
      lines.push('【近期话题】');
      for (const t of state.activeTopics.slice(-8)) {
        lines.push(`- ${t.text}${t.pendingQuestion ? `（有未回的问题：${t.pendingQuestion}）` : ''}`);
      }
    }
    if (state.pendingThoughts.length > 0) {
      lines.push('【想做的事】');
      for (const t of state.pendingThoughts.slice(-5)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = Object.entries(state.memberImpressions);
    if (impressions.length > 0) {
      lines.push('【群友印象】');
      for (const [name, imp] of impressions.slice(0, 10)) {
        lines.push(`- ${name}：互动 ${imp.interactionCount} 次${imp.traits.length ? `，${imp.traits.join('、')}` : ''}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : '（暂无记忆）';
  }

  // ── 限频 ─────────────────────────────────────────────────────────────────

  /**
   * 唤醒限频检查与登记（**按档位**记账，QUALITY-REPORT P1-01）。
   *
   * 档位与额度：
   *   direct    —— 显式请求（@我 / 私聊 / 戳一戳）：独立额度，不被普通巡逻卡住
   *   followUp  —— 短时跟随（我刚问过话，对方接了）
   *   normal    —— 常规触发器
   *   proactive —— AI 自己的定时器（巡逻 / 回复检查 / 睡眠到点 / 手动）
   *
   * @param {string} key
   * @param {object} [opts]
   * @param {string} [opts.tier] - 档位（缺省按 reason 推断）
   * @param {string} [opts.reason] - 唤醒原因（记进 lastWakeGate）
   * @returns {{ok: boolean, retryAfterMs?: number, tier?: string, reason?: string}}
   */
  tryRegisterWake(key, { tier = null, reason = '' } = {}) {
    const state = this.get(key);
    const now = this.now();
    const t = tier ?? tierOfReason(reason);
    const [minuteField, hourField] = WAKE_TIER_LIMIT_FIELDS[t] ?? WAKE_TIER_LIMIT_FIELDS.normal;
    const timeField = WAKE_TIER_TIME_FIELD[t] ?? 'wakeTimes';
    const maxPerMinute = Number(this.limits[minuteField] ?? 1);
    const maxPerHour = Number(this.limits[hourField] ?? 30);

    // 用户驱动的档位（direct/followUp）额度**不得低于常规档**——
    // 否则「显式 @ 走独立额度」会变成「显式 @ 反而更严」，与修复意图相反。
    const normalMinute = Number(this.limits.maxWakePerMinute ?? 1);
    const normalHour = Number(this.limits.maxWakePerHour ?? 30);
    const floorMinute = t === WAKE_TIER.direct || t === WAKE_TIER.followUp ? normalMinute : 0;
    const floorHour = t === WAKE_TIER.direct || t === WAKE_TIER.followUp ? normalHour : 0;
    const limitPerMinute = Math.max(maxPerMinute, floorMinute);
    const limitPerHour = Math.max(maxPerHour, floorHour);

    const times = (state[timeField] ?? []).filter((ts) => now - ts < 3600 * 1000);
    state[timeField] = times;
    const lastMinute = times.filter((ts) => now - ts < 60 * 1000);
    if (lastMinute.length >= limitPerMinute) {
      const oldest = Math.min(...lastMinute);
      const retryAfterMs = Math.max(1000, 60 * 1000 - (now - oldest));
      state.lastWakeGate = { reason, tier: t, at: now, retryAt: now + retryAfterMs, queuedMs: 0, allowed: false };
      return { ok: false, retryAfterMs, tier: t, reason };
    }
    if (times.length >= limitPerHour) {
      const retryAfterMs = Math.max(1000, 3600 * 1000 - (now - times[0]));
      state.lastWakeGate = { reason, tier: t, at: now, retryAt: now + retryAfterMs, queuedMs: 0, allowed: false };
      return { ok: false, retryAfterMs, tier: t, reason };
    }
    times.push(now);
    state[timeField] = times;
    state.lastWakeAt = now;
    state.wakeCount += 1;
    state.lastWakeGate = { reason, tier: t, at: now, retryAt: 0, queuedMs: 0, allowed: true };
    return { ok: true, tier: t, reason };
  }

  /**
   * 发送限频预占（burst 前调用；失败须回滚 releaseSendSlots）。
   * @returns {{ok: boolean, retryAfterMs?: number}}
   */
  reserveSendSlots(key, count) {
    const state = this.get(key);
    const now = this.now();
    state.sendTimes = state.sendTimes.filter((t) => now - t < 3600 * 1000);
    const perMinute = state.sendTimes.filter((t) => now - t < 60 * 1000).length;
    if (perMinute + count > this.limits.maxSendPerMinute) {
      return { ok: false, retryAfterMs: 60 * 1000 };
    }
    if (state.sendTimes.length + count > this.limits.maxSendPerHour) {
      return { ok: false, retryAfterMs: 3600 * 1000 };
    }
    for (let i = 0; i < count; i++) state.sendTimes.push(now);
    return { ok: true };
  }

  releaseSendSlots(key, count) {
    const state = this.get(key);
    for (let i = 0; i < count; i++) state.sendTimes.pop();
  }

  /** 近 1h 自己发言数（巡逻概率判定用）。 */
  recentSendCount(key) {
    const state = this.get(key);
    const now = this.now();
    return state.sendTimes.filter((t) => now - t < this.limits.recentSendWindowMs).length;
  }
}
