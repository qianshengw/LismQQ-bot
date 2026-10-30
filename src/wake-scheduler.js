// 二代仿真唤醒调度器：合并窗口 / 睡眠唤醒 / 巡逻 / 回复检查 + 防呆三件套。
// 移植自 qq-bridge bridge.js 的调度域，机制改为「桥接代持」：
//   旧版让 AI 在 turn 内挂 5-10 分钟长轮询；本调度器在桥接侧起定时器，
//   到点后调用 onWake(key, reason)（由 bridge 接线到「给该会话发唤醒 prompt」）。
// 时钟可注入（now/setTimeout/clearTimeout），便于假时钟测试。
//
// QUALITY-REPORT P1-01：唤醒限频按「档位」拆分——显式 @（direct）走独立额度，
// 不再被「每分钟 1 次」的常规/巡逻额度卡住；各档互不挤占。
import { evaluateWakeTrigger, WAKE_PRIORITY, tierOfReason } from './social-v2.js';

const NIGHT_HOURS = [23, 0, 1, 2, 3, 4, 5, 6, 7]; // 深夜降巡逻概率

export class WakeScheduler {
  /**
   * @param {object} options
   * @param {SocialV2Store} options.store
   * @param {(key: string, reason: string) => Promise<void>|void} options.onWake - 唤醒回调（桥接注入）
   * @param {object} [options.limits] - 与 store.limits 同源
   * @param {() => number} [options.now]
   * @param {(fn: Function, ms: number) => object} [options.setTimeout]
   * @param {(handle: object) => void} [options.clearTimeout]
   * @param {string} [options.myName] - 昵称（nameMention 判定）
   * @param {object} [options.proactiveConfig] - { proactiveMinMs, proactiveMaxMs } 巡逻间隔（可运行态更新）
   */
  constructor({ store, onWake, limits = {}, now = Date.now, setTimeout: setT = (fn, ms) => setTimeout(fn, ms), clearTimeout: clearT = (h) => clearTimeout(h), myName = '', proactiveConfig = null }) {
    this.store = store;
    this.onWake = onWake;
    this.limits = limits;
    this.now = now;
    this.setT = setT;
    this.clearT = clearT;
    this.myName = myName;
    this.proactiveConfig = proactiveConfig;
    // key -> { timers: Map<purpose, handle>, pendingWakes: [{reason, priority, at}], batchHandle, busy }
    /** @type {Map<string, object>} */
    this.runtimes = new Map();
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    for (const rt of this.runtimes.values()) {
      for (const h of rt.timers.values()) this.clearT(h);
      rt.timers.clear();
      if (rt.batchHandle) this.clearT(rt.batchHandle);
    }
    this.runtimes.clear();
  }

  _runtime(key) {
    let rt = this.runtimes.get(key);
    if (!rt) {
      rt = { timers: new Map(), pendingWakes: [], batchHandle: null, busy: false };
      this.runtimes.set(key, rt);
    }
    return rt;
  }

  _setTimer(key, purpose, ms, fn) {
    const rt = this._runtime(key);
    const old = rt.timers.get(purpose);
    if (old) this.clearT(old);
    const handle = this.setT(() => {
      rt.timers.delete(purpose);
      if (!this.stopped) void fn();
    }, Math.max(0, ms));
    handle?.unref?.();
    rt.timers.set(purpose, handle);
  }

  // ── 消息进来时的触发评估 ────────────────────────────────────────────────────

  /**
   * 评估一条入站消息；命中触发器则调度唤醒（batchWindow 合并）。
   * 未命中时也返回 false，由调用方决定是否进未读缓冲（本方法不管入库）。
   */
  onIncomingMessage(key, message) {
    const state = this.store.get(key);
    const evaluation = evaluateWakeTrigger(state.wakeConfig, message, {
      myName: this.myName,
      lastAiReplyAt: state.lastAiReplyAt ?? 0,
      lastAiReplyWasQuestion: state.lastAiReplyWasQuestion === true,
      now: this.now(),
      followUpWindowMs: this.store.limits.followUpWindowMs ?? 0,
    });
    if (!evaluation.hit) return { hit: false };
    this.scheduleWake(key, evaluation.reason, { messageSeq: message.seq });
    return { hit: true, reason: evaluation.reason };
  }

  /**
   * 调度一次唤醒：进合并窗口（同窗口多因按优先级升级），到点 tryWake。
   *
   * immediate=true = 直通（显式 @ / 私聊）：不排合并窗口，但仍走**该档位**的限频
   * （direct 档独立额度——这是与旧实现最大的区别，见 QUALITY-REPORT P1-01）。
   */
  scheduleWake(key, reason, { immediate = false, tier = null } = {}) {
    if (this.stopped) return;
    const state = this.store.get(key);
    const rt = this._runtime(key);
    const priority = WAKE_PRIORITY[reason] ?? 0;
    const wakeTier = tier ?? tierOfReason(reason);

    if (immediate) {
      rt.pendingWakes.push({ reason, priority, tier: wakeTier, at: this.now(), immediate: true });
      this._flushWakes(key);
      return;
    }

    // 合并窗口：已有 pending 则只做优先级升级
    const existing = rt.pendingWakes.find((w) => w.reason === reason);
    if (existing) existing.priority = Math.max(existing.priority, priority);
    else rt.pendingWakes.push({ reason, priority, tier: wakeTier, at: this.now() });

    if (!rt.batchHandle) {
      const windowMs = state.wakeConfig.batchWindowMs ?? 3000;
      rt.batchHandle = this.setT(() => {
        rt.batchHandle = null;
        this._flushWakes(key);
      }, windowMs);
    }
  }

  _flushWakes(key) {
    const rt = this._runtime(key);
    if (rt.pendingWakes.length === 0) return;
    // 取最高优先级的原因，其余丢弃（对齐旧版 WAKE_PRIORITY 合并语义）
    rt.pendingWakes.sort((a, b) => b.priority - a.priority);
    const best = rt.pendingWakes.shift();
    rt.pendingWakes = [];
    this.tryWake(key, best.reason, { tier: best.tier });
  }

  /**
   * 尝试唤醒：限频 → 忙时暂存 → 触发 onWake。
   * @returns {{woke: boolean, deferred?: string, retryAfterMs?: number, tier?: string, queuedMs?: number}}
   */
  tryWake(key, reason, { tier = null } = {}) {
    if (this.stopped) return { woke: false, deferred: 'stopped' };
    const state = this.store.get(key);
    const rt = this._runtime(key);
    const wakeTier = tier ?? tierOfReason(reason);

    // 忙时暂存（有界），turn 结束后 replay
    if (rt.busy) {
      rt.pendingWakes.push({ reason, priority: WAKE_PRIORITY[reason] ?? 0, tier: wakeTier, at: this.now() });
      if (rt.pendingWakes.length > 20) rt.pendingWakes = rt.pendingWakes.slice(-20);
      return { woke: false, deferred: 'busy', tier: wakeTier, queued: true };
    }

    // 限频（分档）
    const gate = this.store.tryRegisterWake(key, { tier: wakeTier, reason });
    if (!gate.ok) {
      // 超限延后重试不丢弃（对齐旧版语义）。注意 _setTimer 同 purpose 会顶掉旧定时器，
      // 所以重试原因先压入 pendingWakes（有界），到点由重试定时器统一取最高优先级。
      rt.pendingWakes.push({ reason, priority: WAKE_PRIORITY[reason] ?? 0, tier: wakeTier, at: this.now() });
      if (rt.pendingWakes.length > 20) rt.pendingWakes = rt.pendingWakes.slice(-20);
      if (!rt.timers.has('wakeRetry')) {
        this._setTimer(key, 'wakeRetry', gate.retryAfterMs ?? 60000, () => {
          const queued = rt.pendingWakes;
          rt.pendingWakes = [];
          if (queued.length === 0) return;
          queued.sort((a, b) => b.priority - a.priority);
          this.tryWake(key, queued[0].reason, { tier: queued[0].tier });
        });
      }
      return { woke: false, deferred: 'rate-limited', retryAfterMs: gate.retryAfterMs, tier: wakeTier, queued: true };
    }

    const reportError = (error) => {
      console.error(`[social-v2] 唤醒回调失败（${key}/${reason}）:`, error?.message ?? error);
    };
    try { void Promise.resolve(this.onWake(key, reason)).catch(reportError); }
    catch (error) { reportError(error); }
    return { woke: true, tier: wakeTier };
  }

  /** busy 标记（bridge 在回合开始/结束时设置）。 */
  setBusy(key, busy) {
    const rt = this._runtime(key);
    rt.busy = busy;
    if (!busy && rt.pendingWakes.length > 0) {
      // turn 结束补发：取最高优先级
      rt.pendingWakes.sort((a, b) => b.priority - a.priority);
      const best = rt.pendingWakes.shift();
      rt.pendingWakes = [];
      this.tryWake(key, best.reason, { tier: best.tier });
    }
  }

  // ── 定时器族 ──────────────────────────────────────────────────────────────

  /**
   * 睡眠唤醒：infinite=false 时按 sleepUntil 定时（>100s 小步长续期防时钟跳变）。
   */
  /** 清除某会话指定用途的定时器（取消定时/恢复活跃时必须调用，否则已排定时器到点仍会唤醒） */
  clearTimer(key, purpose) {
    const rt = this.runtimes.get(key);
    if (!rt) return;
    const h = rt.timers.get(purpose);
    if (h) {
      this.clearT(h);
      rt.timers.delete(purpose);
    }
  }

  /** 清除睡眠定时器（AI 声明活跃/取消定时时调用） */
  clearSleepTimer(key) {
    this.clearTimer(key, 'sleep');
  }

  setupSleepTimer(key) {
    const state = this.store.get(key);
    if (state.wakeConfig.infinite !== false) return;
    const remain = state.wakeConfig.sleepUntil - this.now();
    if (remain <= 0) {
      // 到点：过期睡眠视为 timeout 唤醒，然后恢复无限潜水
      state.wakeConfig = { ...state.wakeConfig, mode: 'diving', infinite: true, sleepUntil: 0 };
      this.store.save();
      this.tryWake(key, 'timeout');
      return;
    }
    // 小步长：最长 100s 一跳
    const step = Math.min(remain, 100 * 1000);
    this._setTimer(key, 'sleep', step, () => this.setupSleepTimer(key));
  }

  /**
   * 巡逻：自排 min~max（默认 30-90min，可经 config.socialV2.proactiveMin/MaxMs 调整）；
   * 到点按概率判定是否唤醒（基础 0.3，
   * 有待发想法 ×1.4、30min 内自己发过言 ×0.5、深夜 ×0.3、近 1h 发言 ≥5 条 ×0.3），
   * 通过且唤醒限频通过才唤醒；无论是否唤醒都自排下一轮。
   */
  scheduleProactiveCheck(key) {
    const cfg = this.proactiveConfig ?? {};
    const minMs = Number(cfg.proactiveMinMs) || 30 * 60 * 1000;
    const maxMs = Math.max(Number(cfg.proactiveMaxMs) || 90 * 60 * 1000, minMs);
    const delay = minMs + Math.random() * (maxMs - minMs);
    this._setTimer(key, 'proactive', delay, () => {
      this._proactiveCheck(key);
      if (!this.stopped) this.scheduleProactiveCheck(key); // 无条件自排
    });
  }

  _proactiveCheck(key) {
    const state = this.store.get(key);
    const limits = this.store.limits;
    // 潜水中且有明确触发器的会话不巡逻打扰
    if (state.wakeConfig.mode === 'diving' && !state.wakeConfig.infinite) {
      // 有限潜水照常巡逻（巡逻本身受限频保护）
    }
    let p = limits.proactiveBaseProbability ?? 0.3;
    if (state.pendingThoughts.length > 0) p *= limits.proactiveIdeaBoost ?? 1.4;
    const lastSend = Math.max(state.lastAiReplyAt, ...state.sendTimes.slice(-1), 0);
    if (this.now() - lastSend < 30 * 60 * 1000) p *= limits.proactiveRecentPenalty ?? 0.5;
    const hour = new Date(this.now()).getHours();
    if (NIGHT_HOURS.includes(hour)) p *= limits.proactiveNightPenalty ?? 0.3;
    if (this.store.recentSendCount(key) >= limits.recentSendChattyCount) {
      p *= limits.proactiveChattyPenalty ?? 0.3;
    }
    if (Math.random() >= p) return;
    this.tryWake(key, 'proactiveCheck');
  }

  /**
   * 回复检查：AI 发言 30s 后回来看有没有人接。
   *
   * 加权：基础概率 0.5，上一句是问句 ×1.5、burst 连发 ×1.3，上限 0.95。
   * 【原实现的 bug】p 从 1 起步再乘 1.5/1.3，最后 `Math.min(p, 1)` 截成 1，
   * 于是 `Math.random() > 1` 恒为 false —— 所谓「加权」实际永远是 100% 触发。
   */
  scheduleReplyCheck(key, { wasQuestion = false, wasBurst = false } = {}) {
    const base = Number(this.store.limits.replyCheckBaseProbability ?? 0.5);
    let p = base;
    if (wasQuestion) p *= 1.5;
    if (wasBurst) p *= 1.3;
    p = Math.min(0.95, Math.max(0.05, p));
    this._setTimer(key, 'replyCheck', 30 * 1000, () => {
      if (Math.random() > p) return;
      this.tryWake(key, 'replyCheck');
    });
  }

  // ── 防呆 ─────────────────────────────────────────────────────────────────

  /**
   * 防永眠：AI 的 turn 结束后没设任何有效触发条件 → 重置默认配置。
   * @returns {boolean} 是否执行了重置
   */
  ensureWakeable(key) {
    const state = this.store.get(key);
    if (state.wakeConfig.infinite === false && state.wakeConfig.sleepUntil > this.now()) return false;
    const t = state.wakeConfig.triggers ?? {};
    const hasTrigger =
      t.atMention === true ||
      t.nameMention === true ||
      t.question === true ||
      t.poke === true ||
      t.anyMessage === true ||
      (Number(t.probability) > 0) ||
      (Array.isArray(t.keywords) && t.keywords.length > 0) ||
      (Array.isArray(t.speakerIds) && t.speakerIds.length > 0);
    if (hasTrigger) return false;
    state.wakeConfig = {
      mode: 'active',
      infinite: true,
      sleepUntil: 0,
      triggers: { atMention: true, nameMention: true, question: true, poke: true, probability: 0.05 },
      batchWindowMs: 3000,
    };
    this.store.save();
    console.warn(`[social-v2] ${key} 唤醒配置无任何触发条件，已重置默认`);
    return true;
  }

  /**
   * 无行动计数：AI 醒来后既没发消息也没 mark_read → 计数 +1；
   * 连续 ≥3 次 → 重置唤醒配置。AI 有行动时调 noteAction 清零。
   */
  noteNoAction(key) {
    const state = this.store.get(key);
    state.noActionCount += 1;
    if (state.noActionCount >= (this.store.limits.noActionResetThreshold ?? 3)) {
      state.noActionCount = 0;
      state.wakeConfig = { ...state.wakeConfig, mode: 'active', infinite: true, sleepUntil: 0 };
      this.store.save();
      console.warn(`[social-v2] ${key} 连续空醒 ${this.store.limits.noActionResetThreshold} 次，已重置为默认唤醒配置`);
      return true;
    }
    return false;
  }

  noteAction(key) {
    const state = this.store.get(key);
    state.noActionCount = 0;
    state.lastActionAt = this.now();
  }
}
