// 一代仿真（socialV1）：四相状态机 + 选择性参与 + 静默摘要池。
// 移植自 qq-bridge bridge.js 的 social 域（状态机转移与判定语义保持一致）。
// 纯逻辑模块：状态判定/概率/摘要池都在这里；prompt 拼装与投递由 bridge 接线。
//
// 四相状态机（与旧版一致）：
//   idle（观望）   → active：明确点名 / 随机 triggerProbability
//   active（活跃） → exiting：活跃超时（15-30min 随机）
//                  → probing：冷场 6min + 25% 概率试探
//                  → idle：冷场 + 未中试探概率
//   probing（试探）→ active：窗口内有人说话；窗口过 → idle
//   exiting（退场）→ idle：AI 退场话说完（bridge 回调）或 60min 兜底
//
// 驱动：调用方（bridge）起 5 秒心跳调 tick()。
import fs from 'node:fs';
import path from 'node:path';

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** CJK 汉字判定（只认表意汉字；不把全角标点当 CJK——避免「你好 ，世界」被误分）。 */
export function isCjkChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/**
 * 按「CJK 空格」分条：空格两侧只要有一侧是汉字，就把空格当分条信号。
 * 英文/数字之间的空格保留（不影响 "2 cats" 这类）。
 */
export function splitByCjkSpaces(src) {
  const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length <= 1) return tokens;
  const groups = [];
  let cur = tokens[0];
  for (let i = 1; i < tokens.length; i++) {
    const prevLast = [...cur].pop() || '';
    const currFirst = [...tokens[i]][0] || '';
    if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
      groups.push(cur);
      cur = tokens[i];
    } else {
      cur = `${cur} ${tokens[i]}`;
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

/** 超长硬切（按码点，代理对保护）。 */
export function splitLongSegment(text, maxChars) {
  const s = String(text ?? '');
  const max = Math.max(1, Math.floor(Number(maxChars) || 500));
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max - 1);
    if (cut <= 0) cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    if (cut <= 0) cut = 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * v1 回复 → QQ 消息时间线：AI 用空格表示分条；每条再按 maxChars 硬拆。
 * @returns {string[]}
 */
export function planSocialTimeline(text, { maxReplyChars = 500, burstEnabled = true } = {}) {
  const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!src) return [];
  const parts = burstEnabled ? splitByCjkSpaces(src) : [src];
  const out = [];
  for (const part of parts) {
    out.push(...splitLongSegment(part, maxReplyChars));
  }
  return out.filter(Boolean);
}

// ── [SILENT] ────────────────────────────────────────────────────────────────

export const SILENT_MARKER = '[SILENT]';

// 容忍尾随标点/空白/重复（模型常画蛇添足："……就只输出 [SILENT]" → 实际输出 "[SILENT]。"）
export const SILENT_MARKER_RE = /^\s*(?:\[SILENT\][\s。.，,、!！?？~～]*)+$/i;

export function isSilentMarker(text) {
  return SILENT_MARKER_RE.test(String(text ?? ''));
}

/** 剥除消息内散落的 [SILENT] 标记（发送前兜底；剥完为空则整条视为沉默）。 */
export function stripSilentMarkers(text) {
  return String(text ?? '').replace(/\[SILENT\]/gi, '').trim();
}

// 退场话术（整句）：模型从 v1 退场相学舌的固定收尾模式，用户要求全程禁用。
export const FAREWELL_PHRASE_RE = /^(?:那|那么)?(?:我)?(?:先)?(?:撤了|撤啦|下了|下线(?:了)?|去(?:忙|吃饭|睡觉|洗澡|干活)(?:了|啦|咯)|告辞(?:了)?|回见(?:啦|了)?|闪了|溜了|跑了|开溜(?:了)?|撤退(?:了)?|下播(?:了)?|潜水去了|先走(?:一步|了)|收工(?:了)?)[\s。.~～!！?？]*$/;

/** 整句退场话术判定（≤20 字短句；带实质内容的不算）。 */
export function isFarewellPhrase(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 20) return false;
  return FAREWELL_PHRASE_RE.test(s);
}

// ── 默认配置（对齐旧版）────────────────────────────────────────────────────

export const DEFAULT_V1_LIMITS = Object.freeze({
  triggerProbability: 0.1, // 观望期普通消息触发活跃的概率
  skipProbability: 0.15, // 活跃期非必回消息的沉默概率
  contextWindow: 20, // 近期消息窗口（条）
  activeCheckMinMs: 10 * 1000,
  activeCheckMaxMs: 30 * 1000,
  activeReplyDelayMinMs: 2 * 1000,
  activeReplyDelayMaxMs: 8 * 1000,
  activeDurationEnabled: true,
  activeDurationMinMs: 15 * 60 * 1000,
  activeDurationMaxMs: 30 * 60 * 1000,
  idleWindowMs: 6 * 60 * 1000, // 活跃期冷场阈值
  idleRetryProbability: 0.25, // 冷场试探概率
  idleRetryWaitMs: 2 * 60 * 1000, // 试探等待窗口
  maxReplyChars: 500,
  burstEnabled: true,
  mustReplyKeywords: ['deepseek', 'ai', '人工智能', '机器人', '模型'],
  exitingTimeoutMs: 60 * 60 * 1000, // 退场兜底
  summaryMaxItems: 60,
  silentContextMax: 30,
});

// ── 指向性判定（对齐旧版 isDirectedAtAi 的正则族）──────────────────────────

const AI_MENTION_RE = /deepseek|claude|chatgpt|gpt|机器人|小鱼|小鲸|d指令|d老师|d师姐|人工智能|\bds\b|\bai\b|人工智障|模型/i;
const CHALLENGE_RE = /强|弱|行不行|能不能|会不会|是不是|厉害|水平|几斤几两|比一比|比划|赢|输|菜|牛|牛.*强|棒.*牛/i;
const QUESTION_RE = /[?？]+|怎么|为什么|啥|谁/i;
const YOU_RE = /(你|您).{0,10}(比|强|弱|牛|\?|？|怎么样|是不是|能不能|行不行|有没有|好|没有|在|会|懂|厉害|菜|一般|说说|赢|输)/i;
const DIRECT_YOU_RE = /^(你|您)(是不是|行不行|能不能|会不会|好不好|在|没在)/i;
const YOU_OR_AI_RE = /(你|您)说[^。？?！!]{0,14}(怎么办|怎么弄|咋|哪|么|呢|\?)/i;
const URGENT_RE = /怎么说|怎么回事|说句话|说话呀|怎么不说话|不说话|装死|在不在|装聋|说啥/i;

/** 是否"指向 AI"的发言（点名/挑战/提问 AI/追问）。 */
export function isDirectedAtAi(text) {
  const lower = String(text ?? '').toLowerCase();
  if (AI_MENTION_RE.test(lower) && (QUESTION_RE.test(lower) || CHALLENGE_RE.test(lower))) return true;
  if (YOU_RE.test(lower)) return true;
  if (DIRECT_YOU_RE.test(lower)) return true;
  if (YOU_OR_AI_RE.test(lower)) return true;
  if (URGENT_RE.test(lower)) return true;
  return false;
}

/** 活跃期"必回"判定：@ 昵称 / 必回关键词 / 指向 AI。关键词按词边界匹配（M3：避免 "ai" 命中 wait/rain）。 */
export function isMustReplyText(text, { myName = '', keywords = [] } = {}) {
  const lower = String(text ?? '').toLowerCase();
  if (myName && lower.includes(String(myName).toLowerCase())) return true;
  for (const kw of keywords) {
    const k = String(kw).toLowerCase();
    if (!k) continue;
    // 短英文词按词边界匹配（与 social-v2 的 evaluateWakeTrigger 同规则）；中文/含非字母数字的关键词用包含匹配
    const pattern = /^[a-z0-9]+$/i.test(k) ? new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
    if (pattern ? pattern.test(lower) : lower.includes(k)) return true;
  }
  return isDirectedAtAi(text);
}

// ── 状态机 ──────────────────────────────────────────────────────────────────

export function newV1State(now = Date.now()) {
  return {
    phase: 'idle', // idle | active | probing | exiting
    lastCheckAt: 0,
    nextCheckAt: 0,
    lastActiveMessageAt: 0,
    activeEnteredAt: 0,
    activeDeadlineAt: 0, // 活跃超时（退场）
    probeDeadline: 0,
    activeExitAt: 0, // 退场开始时刻
    lastAiReplyAt: 0,
    createdAt: now,
  };
}

export class SocialV1Store {
  constructor(stateDir = null, { limits = {}, now = Date.now } = {}) {
    this.limits = { ...DEFAULT_V1_LIMITS, ...limits };
    this.now = now;
    this.stateDir = stateDir;
    /** @type {Map<string, object>} key -> v1 state */
    this.states = new Map();
    /** key -> 近期消息（活跃期批量检测用；内存态，重启清零与旧版一致） */
    this.recentMessages = new Map();
    /** key -> {items, since} 观望期摘要池（被跳过的消息） */
    this.pendingSummaries = new Map();
    /** key -> [msg] 已读未回（活跃期 skip 的消息；下次投递一并带给模型） */
    this.silentContext = new Map();
    /** 正在退场的 key 集合（turn 结束时判定退场话归属） */
    this.exitingKeys = new Set();
    // 持久化（states 淡持久化，recent 不存——旧版 states 是内存态，这里持久化是为了重启不丢相位）
    this.filePath = stateDir ? path.join(stateDir, 'social-v1.json') : null;
    this._load();
  }

  _load() {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const [key, st] of Object.entries(raw?.states ?? {})) {
        this.states.set(key, { ...newV1State(), ...st, key });
      }
    } catch {
      // 首次运行
    }
  }

  save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const states = {};
      for (const [key, st] of this.states) states[key] = st;
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, states }), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      console.warn('[social-v1] 保存失败:', error?.message ?? error);
    }
  }

  state(key) {
    let st = this.states.get(key);
    if (!st) {
      st = newV1State(this.now());
      this.states.set(key, st);
    }
    return st;
  }

  has(key) {
    return this.states.has(key);
  }

  keys() {
    return [...this.states.keys()];
  }

  delete(key) {
    this.states.delete(key);
    this.recentMessages.delete(key);
    this.pendingSummaries.delete(key);
    this.silentContext.delete(key);
    this.exitingKeys.delete(key);
  }

  // ── 近期消息 / 摘要池 ─────────────────────────────────────────────────────

  appendRecent(key, { sender, text, quoteTargetIsSelf = false, hasMedia = false, messageId = '' }) {
    if (!this.recentMessages.has(key)) this.recentMessages.set(key, []);
    const arr = this.recentMessages.get(key);
    arr.push({
      sender: String(sender ?? ''),
      text: String(text ?? ''),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      hasMedia: !!hasMedia,
      messageId: String(messageId ?? ''),
      time: this.now(),
    });
    const cap = Math.max(50, this.limits.contextWindow * 2);
    while (arr.length > cap) arr.shift();
    return arr[arr.length - 1];
  }

  recentMessagesOf(key) {
    return this.recentMessages.get(key) ?? [];
  }

  appendSummary(key, msg) {
    if (!this.pendingSummaries.has(key)) {
      this.pendingSummaries.set(key, { items: [], since: this.now() });
    }
    const entry = this.pendingSummaries.get(key);
    entry.items.push({
      sender: String(msg.sender ?? ''),
      text: String(msg.text ?? ''),
      isOwner: !!msg.isOwner,
      hasMedia: !!msg.hasMedia,
      messageId: String(msg.messageId ?? ''),
      time: this.now(),
    });
    if (entry.items.length > this.limits.summaryMaxItems) entry.items.shift();
  }

  /** 取走全部待投喂摘要（并重置池起点）。 */
  drainSummaries(key) {
    const entry = this.pendingSummaries.get(key);
    if (!entry || entry.items.length === 0) return [];
    const items = entry.items.slice();
    entry.items = [];
    entry.since = this.now();
    return items;
  }

  hasSummaries(key) {
    const entry = this.pendingSummaries.get(key);
    return !!entry && entry.items.length > 0;
  }

  addSilentContext(key, msgs) {
    const silent = this.silentContext.get(key) ?? [];
    silent.push(...msgs);
    this.silentContext.set(key, silent.slice(-this.limits.silentContextMax));
  }

  takeSilentContext(key) {
    const msgs = this.silentContext.get(key) ?? [];
    this.silentContext.delete(key);
    return msgs;
  }

  // ── 状态转移 ──────────────────────────────────────────────────────────────

  /** 进入活跃期（随机活跃时长 = 退场 deadline）。 */
  enterActive(key) {
    const now = this.now();
    const st = this.state(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(this.limits.activeCheckMinMs, this.limits.activeCheckMaxMs);
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    st.activeDeadlineAt = this.limits.activeDurationEnabled !== false
      ? now + randInt(this.limits.activeDurationMinMs, this.limits.activeDurationMaxMs)
      : 0;
    st.activeExitAt = 0;
    return st;
  }

  /** 回到观望。 */
  leaveActive(key) {
    const st = this.state(key);
    st.phase = 'idle';
    st.activeDeadlineAt = 0;
    st.activeExitAt = 0;
    st.probeDeadline = 0;
    this.exitingKeys.delete(key);
    this.save();
    return st;
  }

  /** 进入试探期。 */
  enterProbing(key) {
    const now = this.now();
    const st = this.state(key);
    st.phase = 'probing';
    st.probeDeadline = now + this.limits.idleRetryWaitMs;
    return st;
  }

  /** 开始退场（投递退场 prompt 后调用；AI 说完由 bridge 回调 finishExit）。 */
  startExit(key) {
    const now = this.now();
    const st = this.state(key);
    st.phase = 'exiting';
    st.activeExitAt = now;
    this.exitingKeys.add(key);
    return st;
  }

  /** 退场完成（AI 退场话说完）。 */
  finishExit(key) {
    this.exitingKeys.delete(key);
    return this.leaveActive(key);
  }

  /**
   * 观望期：普通消息是否随机触发活跃。
   * @returns {boolean}
   */
  shouldTriggerFromIdle(key, { direct = false } = {}) {
    if (direct) return true;
    return Math.random() < this.limits.triggerProbability;
  }

  /**
   * 活跃期批量检测的沉默判定（skip 概率随压力降低；刚回复 60s 内不沉默）。
   * @returns {boolean} true = 选择性沉默（消息进摘要池）
   */
  shouldSkipInActive(key, newMsgsCount, { mustReply = false } = {}) {
    if (mustReply) return false;
    let skipProb = Math.min(1, Math.max(0, this.limits.skipProbability));
    const st = this.state(key);
    const sinceAiReply = this.now() - (st.lastAiReplyAt || 0);
    if (sinceAiReply < 60000) skipProb = 0;
    const pressure = Math.min(0.5, newMsgsCount * 0.1);
    skipProb = Math.max(0, skipProb - pressure);
    return Math.random() < skipProb;
  }

  /**
   * 心跳 tick：推进状态机（冷场试探 / 活跃超时 / 试探超时 / 退场兜底）。
   * @param {(key: string, kind: 'probe'|'exit', state: object) => void} onEvent
   *   kind='probe'：应投递试探 prompt；kind='exit'：应投递退场 prompt
   * @param {object} [options] - { allowedKeys?: Set<string>|null } 限制处理的会话（白名单过滤由调用方传入）
   * @returns {Array<{key: string, kind: string}>} 本 tick 触发的事件
   */
  tick(onEvent = () => {}, { allowedKeys = null } = {}) {
    const now = this.now();
    const events = [];
    for (const [key, st] of this.states) {
      if (allowedKeys && !allowedKeys.has(key)) continue;
      if (st.phase === 'active') {
        // 活跃超时 → 退场
        if (st.activeDeadlineAt && now >= st.activeDeadlineAt) {
          this.startExit(key);
          events.push({ key, kind: 'exit' });
          onEvent(key, 'exit', st);
          continue;
        }
        if (now >= st.nextCheckAt) {
          st.nextCheckAt = now + randInt(this.limits.activeCheckMinMs, this.limits.activeCheckMaxMs);
          const newMsgs = this.recentMessagesOf(key).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          if (newMsgs.length > 0) {
            st.lastActiveMessageAt = now; // 有消息就续活跃（deadline 不变）
          } else if (now - st.lastActiveMessageAt >= this.limits.idleWindowMs) {
            // 冷场：试探或回观望
            if (Math.random() < this.limits.idleRetryProbability) {
              this.enterProbing(key);
              events.push({ key, kind: 'probe' });
              onEvent(key, 'probe', st);
            } else {
              this.leaveActive(key);
            }
          }
        }
      } else if (st.phase === 'probing') {
        if (now > st.probeDeadline) {
          this.leaveActive(key); // 试探无回应 → 100% 回观望
        }
      } else if (st.phase === 'exiting') {
        if (now - st.activeExitAt > this.limits.exitingTimeoutMs) {
          // 60min 兜底强制回观望
          this.finishExit(key);
        }
      }
    }
    return events;
  }

  /** 试探/活跃窗口内收到新消息 → probing 回 active。 */
  noteActivity(key) {
    const st = this.states.get(key);
    if (st && st.phase === 'probing') {
      this.enterActive(key);
      return true;
    }
    return false;
  }

  noteAiReply(key) {
    const st = this.state(key);
    st.lastAiReplyAt = this.now();
  }
}
