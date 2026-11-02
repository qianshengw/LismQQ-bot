// LismQQ-bot 主桥：natcat shell（OneBot v11）↔ pi agent。
//
// 数据流：
//   QQ 消息 → OneBotClient 事件 → 会话准入（白名单）→ 每会话串行队列 → SessionAgent.prompt()
//   agent 事件 → onTextDelta（攒文本）→ onRunComplete → sendToQQ（mdToPlain + 分条 + 限速）
//
// 安全边界：
//   - 白名单/黑名单在收发两侧都生效；群聊里只响应 @ 或白名单放行的会话
//   - MCP 发送工具回调内部 HTTP（internalToken + x-agent-call 头），发送前再过一次会话白名单
//   - 所有出站文本过脱敏双闸门（SENSITIVE_RE 启发式 + KNOWN_AGENT_TOKENS 精确名单）
//   - 发送类工具调用会被自动跳过该回合的重复自动转发（防止模型已发过、桥接再发一遍）
//   - 单实例锁 state/bridge.lock（双实例会抢消息，第二个实例 exit 2）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OneBotClient, parseMessageSegments } from './onebot.js';
import { SharedMemoryPool } from './memory-pool.js';
import { SessionManager, SessionAgent } from './pi-host.js';
import { connectMcpTools } from './mcp/wrap.js';
import { createKnownTokens, redactAll, looksSensitive } from './sensitive.js';
import { mdToPlain, splitForQQ, normalizeChatSpacing } from './md-to-plain.js';
import { extractForwardIds, formatForwardMessages, renderForwardBlock, sanitizeForwardId } from './forward.js';
import { fetchImagesForModel, persistImage } from './media.js';
import { resolvePriceTable, normalizeUsage, isPeakAt, ratesAt, costOfBuckets, totalTokensOf } from './model-prices.js';
import { SocialV2Store, canonicalKey as canonicalKeyForV2, keyOf as v2KeyOf, DEFAULT_WAKE_CONFIG, tierOfReason, WAKE_TIER } from './social-v2.js';
import { WakeScheduler } from './wake-scheduler.js';
import { planBurst } from './burst.js';
import { chatBehaviorRules } from './qq-chat-rules.js';
import {
  SocialV1Store,
  isSilentMarker,
  stripSilentMarkers,
  isFarewellPhrase,
  isMustReplyText,
  isDirectedAtAi,
  planSocialTimeline,
  SILENT_MARKER,
} from './social-v1.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── 配置加载 ─────────────────────────────────────────────────────────────────

/**
 * 相对时间格式化：「刚刚 / N 分钟前 / N 小时前 / N 天前」。
 * QUALITY-REPORT P1-03：模型必须知道每条消息**分别**多旧，不能只有一句整体时间。
 * @param {number} ts 时间戳（毫秒）
 * @param {number} [now]
 * @returns {string}
 */
export function formatAge(ts, now = Date.now()) {
  if (!ts || !Number.isFinite(ts)) return '时间未知';
  const ms = now - ts;
  if (ms < 0) return '刚刚';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 绝对时刻（HH:MM 或 MM-DD HH:MM）。 */
function formatClock(ts) {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? `${hh}:${mm}` : `${String(d.getMonth() + 1).padStart(2, '0')}-${d.getDate()} ${hh}:${mm}`;
}

function stripJsonComments(text) {
  return text
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
}

function loadConfig() {
  const configPath = process.env.QQ_BRIDGE_CONFIG ?? path.join(ROOT, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`缺少配置文件 ${configPath}。复制 config.example.jsonc 为 config.json 后编辑。`);
    process.exit(1);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(stripJsonComments(raw));
  // 收敛越界值
  config.sendDelayMs = clampInt(config.sendDelayMs ?? 800, 0, 60000);
  config.maxTurnSeconds = clampInt(config.maxTurnSeconds ?? 900, 30, 3600); // 默认 900s：容纳睡前观察（wait 5min×2 轮）
  config.ackMessage = String(config.ackMessage ?? '');
  config.trigger = { replyAlways: config.trigger?.replyAlways === true };
  config.history = {
    maxMessages: clampInt(config.history?.maxMessages ?? 120, 20, 1000),
    summarize: config.history?.summarize !== false,
  };
  config.memory = {
    enabled: config.memory?.enabled !== false,
    maxRecords: clampInt(config.memory?.maxRecords ?? 300, 10, 5000),
    maxResults: clampInt(config.memory?.maxResults ?? 5, 1, 20),
    autoCaptureUtterance: config.memory?.autoCaptureUtterance !== false,
  };
  return config;
}

function clampInt(value, min, max, fallback = null) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback !== null ? fallback : min;
  return Math.min(Math.max(n, min), max);
}

export function loadSystemPrompt(config, rootDir = ROOT) {
  return `${loadPersonaPrompt(config, rootDir)}\n\n${chatBehaviorRules()}`;
}

function loadPersonaPrompt(config, rootDir = ROOT) {
  const inline = String(config.persona?.systemPrompt ?? '').trim();
  if (inline) return inline;
  const file = String(config.persona?.systemPromptFile ?? '').trim();
  if (file) {
    const filePath = path.isAbsolute(file) ? file : path.join(rootDir, file);
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (error) {
      console.warn(`[config] 读取人设文件失败（${filePath}）: ${error?.message ?? error}`);
    }
  }
  return '你是 QQ 里的中文聊天助手，口语化、简短。';
}

// ── 会话准入 ─────────────────────────────────────────────────────────────────

/**
 * 接话引导词（没有问号但明显在接着谁说话）：QUALITY-REPORT P2-09。
 * 老实现要求必须以问号结尾，于是「然后呢」「继续说」这类典型接话全部漏判。
 */
const CONTINUATION_CUE_RE = /(然后呢|接着说|继续说|继续吧|说吧|说啊|还有呢|接下来呢|所以呢|那然后呢|怎么说呢|干嘛呢|对吧|不对吧|是不是啊|然后$)/;

function sessionKeyOf(message) {
  return message.groupId ? `g${message.groupId}` : `p${message.userId}`;
}

function isAllowed(config, message) {
  const deny = message.groupId ? config.deny?.groups ?? [] : config.deny?.private ?? [];
  const denySet = new Set(deny.map(String));
  if (denySet.has(message.groupId ?? message.userId)) return false;

  const allow = message.groupId ? config.allow?.groups ?? [] : config.allow?.private ?? [];
  if (allow.length === 0) return config.allow?.allowAllWhenEmpty === true;
  return new Set(allow.map(String)).has(message.groupId ?? message.userId);
}

// ── token 账本 ───────────────────────────────────────────────────────────────

class TokenLedger {
  constructor(statePath, { priceTable = null, modelName = '' } = {}) {
    this.statePath = statePath;
    this.priceTable = priceTable ?? resolvePriceTable(null);
    this.modelName = modelName;
    this.total = { input: 0, output: 0, cacheRead: 0, requests: 0, cost: 0 };
    this.bySession = {}; // key -> { input, output, cacheRead, requests, cost }
    /** 按轮明细（JSONL 追加，内存为投影） */
    this.turns = [];
    this.jsonlPath = statePath.replace(/\.json$/, '.jsonl');
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (parsed?.total) this.total = parsed.total;
      if (parsed?.bySession) this.bySession = parsed.bySession;
    } catch {
      // 首次运行
    }
    try {
      const raw = fs.readFileSync(this.jsonlPath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.turns.push(JSON.parse(line));
        } catch {
          // 坏行忽略
        }
      }
      if (this.turns.length > 5000) this.turns = this.turns.slice(-5000);
    } catch {
      // 无明细
    }
  }

  add(sessionKey, usage) {
    const add = (bucket) => {
      bucket.input += usage.input;
      bucket.output += usage.output;
      bucket.cacheRead += usage.cacheRead;
      bucket.requests += 1;
    };
    add(this.total);
    this.bySession[sessionKey] ??= { input: 0, output: 0, cacheRead: 0, requests: 0, cost: 0 };
    add(this.bySession[sessionKey]);

    // 价目折算（DeepSeek 峰谷）：input=未命中桶、cacheRead=命中桶
    const at = Date.now();
    const buckets = normalizeUsage({ inputTokens: usage.input, cacheReadTokens: usage.cacheRead, cacheWriteTokens: 0, outputTokens: usage.output });
    const rates = ratesAt(this.modelName, at, this.priceTable);
    const cost = costOfBuckets(buckets, rates);
    this.total.cost = (this.total.cost ?? 0) + cost.total;
    this.bySession[sessionKey].cost = (this.bySession[sessionKey].cost ?? 0) + cost.total;

    // 按轮明细
    const turn = { t: at, key: sessionKey, tier: rates.tier, ...usage, cost: cost.total };
    this.turns.push(turn);
    if (this.turns.length > 5000) this.turns = this.turns.slice(-5000);
    try {
      fs.appendFileSync(this.jsonlPath, `${JSON.stringify(turn)}\n`, 'utf8');
    } catch {
      // 明细写失败不影响主账本
    }
  }

  /** 控制台 summary：按会话汇总 + 总量（含峰谷金额字段位，P2 价目表接入后填充 cost）。 */
  summary({ limit = 200 } = {}) {
    const conversations = Object.entries(this.bySession)
      .map(([key, s]) => ({
        key,
        ...s,
        totalTokens: s.input + s.output,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));
    const totalTokens = this.total.input + this.total.output;
    return {
      ok: true,
      generatedAt: Date.now(),
      priceVersion: this.priceTable.version,
      currency: this.priceTable.currency,
      symbol: this.priceTable.symbol,
      nowTier: isPeakAt(Date.now(), this.priceTable) ? 'peak' : 'off',
      totals: { ...this.total, totalTokens },
      conversations,
    };
  }

  /** 走势桶（控制台 SVG 图消费）。 */
  series({ hours = 24, maxBuckets = 48 } = {}) {
    const windowMs = Math.max(1, Math.min(24 * 90, Number(hours) || 24)) * 3600 * 1000;
    const maxB = Math.max(6, Math.min(120, Number(maxBuckets) || 48));
    const bucketMs = Math.max(5 * 60 * 1000, Math.ceil(windowMs / maxB));
    const now = Date.now();
    const buckets = new Map();
    for (const turn of this.turns) {
      const age = now - turn.t;
      if (age < 0 || age > windowMs) continue;
      const bucketStart = Math.floor(turn.t / bucketMs) * bucketMs;
      const b = buckets.get(bucketStart) ?? { t: bucketStart, tokens: 0, cost: 0 };
      b.tokens += (turn.input ?? 0) + (turn.output ?? 0);
      // turn.cost 是数字（add() 里已折算），不是 {total} 对象
      b.cost += Number(turn.cost) || 0;
      buckets.set(bucketStart, b);
    }
    const series = [...buckets.values()].sort((a, b) => a.t - b.t);
    return { ok: true, bucketMs, windowMs, buckets: series };
  }

  flush() {
    try {
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ total: this.total, bySession: this.bySession }), 'utf8');
      fs.renameSync(tmp, this.statePath);
    } catch (error) {
      console.warn('[ledger] 保存失败:', error?.message ?? error);
    }
  }
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────

/**
 * 获取单实例锁；返回 false 表示已有实例在跑（进程应 exit 2）。
 * 锁文件存 PID + 时间戳；PID 已死则自动接管（崩溃残留自愈）。
 */
export function acquireInstanceLock(stateDir, { internalPort = null } = {}) {
  const lockPath = path.join(stateDir, 'bridge.lock');
  // 本进程已持有锁（同进程二次调用）直接判占
  if (acquireInstanceLock._held) {
    return { ok: false, pid: process.pid, lockPath };
  }
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const m = raw.match(/^(\d+)\|(\d+)$/);
    if (m) {
      const pid = Number(m[1]);
      if (pid !== process.pid && pidAlive(pid)) {
        return { ok: false, pid, lockPath };
      }
      if (pid === process.pid) {
        return { ok: false, pid, lockPath };
      }
    }
  } catch {
    // 无锁文件，继续
  }
  try {
    fs.writeFileSync(lockPath, `${process.pid}|${Date.now()}\n`, { flag: 'w' });
    acquireInstanceLock._held = true;
    return { ok: true, lockPath };
  } catch (error) {
    return { ok: false, pid: null, lockPath, error: error?.message };
  }
}

/** 释放本进程的锁持有标记（测试用；生产走 releaseInstanceLock）。 */
export function _resetInstanceLockForTest() {
  acquireInstanceLock._held = false;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM'; // EPERM = 进程存在但无权发信号
  }
}

function releaseInstanceLock(stateDir) {
  try {
    const lockPath = path.join(stateDir, 'bridge.lock');
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (raw.startsWith(`${process.pid}|`)) fs.rmSync(lockPath, { force: true });
  } catch {
    // 无锁
  }
}

/** 当前生效的 config.json 路径（测试/部署可经 rootDir 或 env 覆盖）——见 Bridge._configPath。 */

// ── 主桥 ─────────────────────────────────────────────────────────────────────

export class Bridge {
  constructor({ config, rootDir = ROOT, deps = {} }) {
    this.config = config;
    this.rootDir = rootDir;
    this.stateDir = path.join(rootDir, 'state');
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(path.join(this.stateDir, 'sessions'), { recursive: true });

    this.internalToken = String(config.internalToken || '') || this._loadOrCreateToken();
    this.internalPort = Number(config.internalPort ?? 3210);

    // 脱敏双闸门：注册所有运行期已知令牌
    this.knownTokens = createKnownTokens();
    this.knownTokens.add(this.internalToken);
    const modelKey = String(config.model?.apiKey || process.env.DEEPSEEK_API_KEY || '');
    if (modelKey) this.knownTokens.add(modelKey);

    this.bot = deps.bot ?? null; // 测试注入；生产在 start() 里构建
    this.ledger = new TokenLedger(path.join(this.stateDir, 'token-ledger.json'), {
      priceTable: resolvePriceTable(config.pricing),
      modelName: config.model?.model ?? '',
    });

    this.memoryPool = config.memory?.enabled
      ? new SharedMemoryPool({ maxRecords: config.memory.maxRecords, maxResults: config.memory.maxResults })
      : null;
    this._loadMemory();

    // 每会话串行队列 + 未读缓冲（仅在没有 v2 store 时兜底；v2 开启时未读以 socialV2 为唯一事实源）
    /** @type {Map<string, {queue: Promise, busy: boolean, unread: Array<object>, waiters: Array<() => void>}>} */
    this.sessionRuntime = new Map();
    /** 当前回合中模型调用过发送工具的会话 key（跳过自动转发） */
    this.toolSentInTurn = new Set();
    /** 当前回合中**已经真正送达** QQ 的消息（发送回执）——QUALITY-REPORT P1-04 */
    /** @type {Map<string, Array<{text: string, at: number, seq: number}>>} */
    this.turnSendReceipts = new Map();
    /** 引用消息缓存：messageId -> {isMe, author, text}（QUALITY-REPORT P2-09） */
    this._quoteCache = new Map();
    /** 群成员显示名缓存：`${groupId}:${userId}` -> name */
    this._memberNameCache = new Map();
    /** 审批等待表（内部 HTTP 未使用，预留；审批走 beforeToolCall 同步问答） */
    this.approvals = new Map();

    // 二代仿真：状态仓库 + 唤醒调度器（onWake 在 start() 里接线）
    this.socialV2 = config.socialV2?.enabled === false
      ? null
      : new SocialV2Store(this.stateDir, { limits: config.socialV2?.limits });
    this.sendBudget = this.socialV2 ?? new SocialV2Store(this.stateDir, { limits: config.socialV2?.limits });
    this.wakeScheduler = this.socialV2
      ? new WakeScheduler({
          store: this.socialV2,
          onWake: (key, reason) => this._deliverWakePrompt(key, reason),
          myName: String(config.persona?.name ?? ''),
          proactiveConfig: config.socialV2 ?? null, // 运行态可更新（schedule 端点直接改此对象）
        })
      : null;
    /** v2 活动日志（有界） */
    this.v2Activity = [];

    // 一代仿真：状态机（tick 心跳在 start() 里起）
    this.socialV1 = config.socialV1?.enabled === false
      ? null
      : new SocialV1Store(this.stateDir, { limits: config.socialV1?.limits });
    /** v1 活动日志 */
    this.v1Activity = [];

    this.sessionManager = null;
    this.mcpHandles = [];
    this.internalServer = null;
    this.running = false;
    this.myQQId = '';
  }

  /** 当前生效的 config.json 路径（测试/部署可经 rootDir 或 env 覆盖）。 */
  _configPath() {
    return process.env.QQ_BRIDGE_CONFIG ?? path.join(this.rootDir, 'config.json');
  }

  _loadOrCreateToken() {
    const tokenPath = path.join(this.stateDir, 'internal-token');    try {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing) return existing;
    } catch {
      // 不存在
    }
    const token = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(tokenPath, token, 'utf8');
    console.log(`[bridge] 已生成内部访问令牌: ${tokenPath}`);
    return token;
  }

  _loadMemory() {
    if (!this.memoryPool) return;
    const memoryPath = path.join(this.stateDir, 'memory.json');
    try {
      const data = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
      this.memoryPool = SharedMemoryPool.fromJSON(data, {
        maxRecords: this.config.memory.maxRecords,
        maxResults: this.config.memory.maxResults,
      });
      console.log(`[bridge] 已恢复记忆池 ${this.memoryPool.count()} 条`);
    } catch {
      // 首次运行
    }
  }

  saveMemory() {
    if (!this.memoryPool) return;
    try {
      fs.writeFileSync(
        path.join(this.stateDir, 'memory.json'),
        JSON.stringify(this.memoryPool.toJSON()),
        'utf8',
      );
    } catch (error) {
      console.warn('[bridge] 记忆池保存失败:', error?.message ?? error);
    }
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────────

  async start() {
    this.running = true;

    if (!this.bot) {
      this.bot = new OneBotClient({
        wsUrl: this.config.qq.wsUrl,
        httpUrl: this.config.qq.httpUrl ?? '',
        accessToken: this.config.qq.accessToken ?? '',
      });
    }
    this._wireBot();

    this.sessionManager = new SessionManager({
      sessionsDir: path.join(this.stateDir, 'sessions'),
      modelConfig: {
        baseUrl: this.config.model.baseUrl,
        provider: this.config.model.provider,
        model: this.config.model.model,
        apiKey: this.config.model.apiKey || process.env.DEEPSEEK_API_KEY,
        thinkingLevel: this.config.model.thinkingLevel,
        maxTokens: this.config.model.maxTokens,
      },
      systemPrompt: loadSystemPrompt(this.config, this.rootDir),
      memoryPool: this.memoryPool,
      memoryOptions: {
        autoCaptureUtterance: this.config.memory.autoCaptureUtterance,
        maxResults: this.config.memory.maxResults,
      },
      maxMessages: this.config.history.maxMessages,
      maxTurnSeconds: this.config.maxTurnSeconds,
      summarize: this.config.history.summarize,
      toolFactory: this.config.tools?.enabled === false ? null : ({ sessionKey }) => this._buildTools(sessionKey),
      // 注意：approveToolCall 的 sessionKey 由 pi-host 的 SessionManager 按 agent 闭包注入
      // （每个 agent 一个 approve 回调，绑定各自会话 key），绝不共用桥接级变量——并发回合会串号。
      approveToolCallFactory: (sessionKey) => ({ toolName, args }) => this._approveToolCall(sessionKey, toolName, args),
    });

    await this._startInternalHttp();

    for (const key of this.socialV2?.keys() ?? []) {
      this.wakeScheduler.setupSleepTimer(key);
      this.wakeScheduler.scheduleProactiveCheck(key);
    }
    this.bot.connect();
    // NapCat/协议端探活：不阻塞启动（WS 自动重连会接上），但给出明确诊断
    try {
      const login = await this.bot.getLoginInfo();
      this.myQQId = String(login?.user_id ?? '');
      console.log(`[bridge] 机器人身份: ${this.myQQId} (${login?.nickname ?? '?'})`);
    } catch (error) {
      // 区分两种故障：WS 没连上（协议端挂）vs 连上但鉴权/登录态异常
      if (this.bot.connectionState === 'protocol-down') {
        console.warn('[诊断] 协议端（natcat/NapCat）未就绪：');
        console.warn(`  - WS 地址 ${this.config.qq.wsUrl} 连不上——检查 natcat 是否已启动、端口是否与 config.qq.wsUrl 一致`);
        console.warn('  - 桥接将继续运行并自动重连，协议端起来后会自动接上');
      } else {
        console.warn(`[诊断] 协议端已连上但 get_login_info 失败（QQ 可能未登录）：${error?.message ?? error}`);
        console.warn('  - 请检查 natcat 的 QQ 登录态（WebUI 扫码）与 accessToken 配置');
      }
      this.myQQId = '';
    }

    // 定期落盘
    this._memWarnCount = 0;
    this.flushTimer = setInterval(() => {
      this.sessionManager?.saveAll();
      this.saveMemory();
      this.ledger.flush();
      this.socialV1?.save(); // L3：v1 相位落盘（崩机不丢状态机）
      this.socialV2?.save();
      this._checkMemoryWatermark();
    }, 60000);

    // 一代仿真心跳：5 秒 tick 推进状态机
    if (this.socialV1) {
      this.v1LoopTimer = setInterval(() => this._v1Tick(), 5000);
    }

    this.shutdownHandler = () => { void this.stop().catch(error => { console.error('[bridge] 停机失败:', error); process.exitCode = 1; }); };
    process.once('SIGINT', this.shutdownHandler);
    process.once('SIGTERM', this.shutdownHandler);
  }

  /** 内存水位监控（P2-5）：OOM 前留证据；连续告警说明有泄漏需要处理。 */
  _checkMemoryWatermark(thresholdMb = 350) {
    const usage = process.memoryUsage();
    const heapMb = Math.round(usage.heapUsed / 1024 / 1024);
    const rssMb = Math.round(usage.rss / 1024 / 1024);
    if (heapMb > thresholdMb) {
      this._memWarnCount++;
      console.warn(`[bridge] 内存告警 #${this._memWarnCount}: heap=${heapMb}MB rss=${rssMb}MB（阈值 ${thresholdMb}MB）——若持续增长请检查图片/会话堆积`);
    } else if (this._memWarnCount > 0) {
      this._memWarnCount = 0; // 回落即复位
    }
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.flushTimer);    if (this.v1LoopTimer) clearInterval(this.v1LoopTimer);
    this.wakeScheduler?.stop();
    this.socialV1?.save();
    for (const agent of this.sessionManager?.agents.values() ?? []) agent.abort();
    for (const agent of this.sessionManager?.agents.values() ?? []) await agent.waitForIdle();
    await Promise.all([...this.sessionRuntime.values()].map(runtime => runtime.queue));
    this.sessionManager?.saveAll();
    this.saveMemory();
    this.ledger.flush();
    for (const handle of this.mcpHandles) {
      await handle.close().catch(() => {});
    }
    this.bot?.close();
    if (this.internalServer) {
      await new Promise((resolve) => this.internalServer.close(resolve));
    }
    if (this.shutdownHandler) {
      process.removeListener('SIGINT', this.shutdownHandler);
      process.removeListener('SIGTERM', this.shutdownHandler);
    }
    console.log('[bridge] 已退出');
  }

  /** 连接（重）建立后刷新机器人身份——myQQId 只取一次的话，natcat 重启后 @ 判定会永久失效 */
  async _refreshIdentity() {
    try {
      const login = await this.bot.getLoginInfo();
      const newId = String(login?.user_id ?? '');
      if (newId && newId !== this.myQQId) {
        console.log(`[bridge] 机器人身份: ${newId} (${login?.nickname ?? '?'})`);
        this.myQQId = newId;
      }
    } catch (error) {
      console.warn(`[bridge] 刷新身份失败（保留旧值 ${this.myQQId || '空'}）: ${error?.message ?? error}`);
    }
  }

  _wireBot() {
    // lifecycle 帧自报身份——最可靠的 myQQId 来源（比 get_login_info 及时，重连即刷）
    this.bot.on('onSelfId', (sid) => {
      if (sid && sid !== this.myQQId) {
        console.log(`[bridge] 机器人身份(lifecycle): ${sid}`);
        this.myQQId = sid;
      }
    });
    this.bot.on('onOpen', () => {
      void this._refreshIdentity();
    });

    this.bot.on('onPrivateMessage', (message) => {
      void this.handleIncoming({ ...message, groupId: null }).catch(error => console.error('[bridge] 私聊处理失败:', error.message));
    });
    this.bot.on('onGroupMessage', (message) => {
      void this.handleIncoming({ ...message }).catch(error => console.error('[bridge] 群消息处理失败:', error.message));
    });
    this.bot.on('onNotice', ({ raw }) => {
      if (raw?.sub_type !== 'poke' || String(raw.target_id) !== this.myQQId) return;
      void this.handleIncoming({ userId: String(raw.user_id), groupId: raw.group_id ? String(raw.group_id) : null, text: '[戳一戳]', images: [], raw }).catch(error => console.error('[bridge] 戳一戳失败:', error.message));
    });
    this.bot.on('onError', (error) => {
      console.error('[bridge] OneBot 错误:', error?.message ?? error);
    });
  }

  // ── 收到 QQ 消息 ───────────────────────────────────────────────────────────

  async handleIncoming(message) {
    if (message.raw?.post_type === 'message_sent' || (this.myQQId && String(message.userId) === this.myQQId)) return;
    const key = sessionKeyOf(message);
    const runtime = this._runtimeFor(key);

    // 白名单最先判：未放行的消息不进任何状态（v2 入库/印象/唤醒都算消费陌生人内容）
    if (!isAllowed(this.config, message)) return;

    // 发送者显示名（群名片/昵称）：模型该看到「张三」而不是「100」
    const senderName = this._resolveSenderName(message);

    // 引用对象是不是我（QUALITY-REPORT P2-09：不能因为「有 reply 段」就当成对我提问）
    const quote = await this._resolveQuoteTarget(message);

    // ── 未读单一事实源（QUALITY-REPORT P1-02）──
    // 二代仿真开启时，未读只存在 socialV2（带 seq/atMe/questionToMe）；
    // 运行时那份 runtime.unread 只在没有 v2 store 时兜底——两套队列各自消费会重复投喂。
    const atMe = this._isAtMe(message);
    const questionToMe = this._isQuestionToMe(message, { quoteTargetIsMe: quote.isMe });
    const isPoke = message.raw?.sub_type === 'poke';
    const entry = {
      sender: senderName,
      userId: String(message.userId),
      text: message.text,
      hasImage: (message.images ?? []).length > 0,
      images: (message.images ?? []).map((img) => img?.url ?? '').filter(Boolean),
      time: Date.now(),
      eventTime: Number(message.raw?.time ?? 0) || undefined,
      messageId: message.messageId,
    };
    if (this.socialV2) {
      if (!this.socialV2.has(key)) this.socialV2.get(key).wakeConfig.batchWindowMs = this.config.socialV2?.batchWindowMs ?? 3000;
      // v2 store 是唯一事实源：seq 在这里分配
      this.socialV2.pushIncoming(key, {
        ...entry,
        images: message.images ?? [],
        raw: message.raw,
        isPrivate: !message.groupId,
        atMe,
        questionToMe,
        isPoke,
      });
    } else {
      runtime.unread.push({ ...entry, atMe, questionToMe });
      if (runtime.unread.length > 200) runtime.unread.splice(0, runtime.unread.length - 200);
    }
    this._notifyWaiters(key);

    // 二代仿真：触发评估（enabled 时接管群聊响应判定）
    let v2Triggered = false;
    if (this.socialV2 && this.running) {
      if (!this.socialV2.has(key)) this.socialV2.get(key).wakeConfig.batchWindowMs = this.config.socialV2?.batchWindowMs ?? 3000;
      if (!this.wakeScheduler._runtime(key).timers.has('proactive')) this.wakeScheduler.scheduleProactiveCheck(key);
      // 记录群友印象（按昵称/号码）
      if (message.groupId && message.text) {
        this.socialV2.touchImpression(key, senderName, {});
      }
      // 过期闲聊归档（显式请求永不归档）
      this.socialV2.archiveStale(key);
      const directV2 = this.config.socialV2?.mode === 'v2' && atMe;
      if (directV2) {
        // 显式 @：直通（不排合并窗口），且走 **direct 档**独立限频额度——
        // 不再被「每分钟 1 次」的常规额度卡住（QUALITY-REPORT P1-01）。
        this.wakeScheduler.scheduleWake(key, 'atMention', { immediate: true, tier: WAKE_TIER.direct });
        return;
      }
      const evalResult = this.wakeScheduler.onIncomingMessage(key, {
        ...message,
        seq: this.socialV2.get(key).lastUnreadSeq,
        isPrivate: !message.groupId,
        atMe,
        questionToMe,
        isPoke,
      });
      v2Triggered = evalResult.hit;
      this.socialV2.expireMemory(key);
      // v2 模式下：触发唤醒的会话由唤醒 prompt 路径处理，不走常规回复链。
      if (this.config.socialV2?.mode === 'v2') return;
    }
    void v2Triggered;

    // ── 一代仿真：群聊消息走状态机驱动（v1 模式下接管非 @ 消息）──
    // F2：@ 消息（或私聊）永远绕过状态机直接走快速常规链——状态机只管"主动参与"。
    const atMeNow = message.groupId ? atMe : true;
    if (message.groupId && this.socialV1 && this.config.socialV1?.mode === 'v1' && !atMeNow) {
      this._v1Incoming(key, message);
      return;
    }

    if (message.groupId && !atMeNow && !this._shouldRespondInGroup(message)) return;

    // ack 回执（配置了才发；出站同样过脱敏）
    const ack = String(this.config.ackMessage ?? '').trim();
    if (ack) this._sendToQQSafe(message, ack);

    // 异步补齐媒体上下文（引用回查 / 转发展开 / 图片下载）再进队列
    const enrichment = (runtime.enrichmentQueue ?? Promise.resolve()).then(() => this._enrichMessage(message));
    runtime.enrichmentQueue = enrichment.catch(() => {});
    const enriched = await enrichment;
    const text = this._composePrompt(enriched.message);
    if (!text) return;
    this._enqueueTurn(key, enriched.message, text, enriched.images);
  }

  /**
   * 发送者显示名：优先用 OneBot 事件里的群名片/昵称，其次查成员缓存，最后退回 QQ 号。
   * （原 qq-bridge 有 resolveGroupMemberName；pi 版丢了，模型只看到裸 QQ 号。）
   */
  _resolveSenderName(message) {
    const raw = message.raw ?? {};
    const fromEvent = String(raw.sender?.card ?? raw.sender?.nickname ?? '').trim();
    const cacheKey = `${message.groupId ?? 'p'}:${message.userId}`;
    if (fromEvent) {
      this._memberNameCache?.set(cacheKey, fromEvent);
      return fromEvent;
    }
    const cached = this._memberNameCache?.get(cacheKey);
    if (cached) return cached;
    return String(message.userId);
  }

  /**
   * 引用目标解析：引用的是不是机器人自己的消息。
   * QUALITY-REPORT P2-09：老实现只要存在 reply 段就判定「向我提问」，
   * 导致「引用别人 + 有问号」被误当成对我提问。
   * @returns {Promise<{isMe: boolean, author: string, text: string}>}
   */
  async _resolveQuoteTarget(message) {
    const raw = message.raw ?? {};
    const replySeg = (raw.message ?? []).find((seg) => seg?.type === 'reply');
    if (!replySeg) return { isMe: null, author: '', text: '' };
    const replyId = sanitizeForwardId(replySeg.data?.id);
    if (!replyId) return { isMe: false, author: '', text: '' };
    const hit = this._quoteCache?.get(replyId);
    if (hit) return hit;
    let result = { isMe: null, author: '', text: '' };
    try {
      const info = await this.bot.call('get_msg', { message_id: Number(replyId) }, { timeoutMs: 5000 });
      const author = String(info?.sender?.user_id ?? '');
      result = {
        isMe: !!this.myQQId && author === String(this.myQQId),
        author: String(info?.sender?.nickname ?? info?.sender?.card ?? author ?? ''),
        text: String(parseMessageSegments(info?.message).text ?? '').trim().slice(0, 300),
      };
    } catch {
      result = { isMe: null, author: '', text: '' };
    }
    this._quoteCache?.set(replyId, result);
    return result;
  }

  /**
   * v1 入站处理：近期消息入库 → 按当前相位判定（观望概率触发 / 活跃批量检测 /
   * 必回直投）→ 投递或进摘要池。
   */
  _v1Incoming(key, message) {
    const v1 = this.socialV1;
    const text = String(message.text ?? '').trim();
    const entry = {
      sender: String(message.userId),
      text,
      quoteTargetIsSelf: this._isAtMe(message),
      hasMedia: (message.images ?? []).length > 0,
      messageId: message.messageId,
    };
    const recent = v1.appendRecent(key, entry);
    const st = v1.state(key);
    const direct = entry.quoteTargetIsSelf || isMustReplyText(text, {
      myName: String(this.config.persona?.name ?? ''),
      keywords: v1.limits.mustReplyKeywords,
    });

    // 试探窗口内有人说话 → 回活跃
    if (v1.noteActivity(key)) {
      this._v1Log(key, '试探有回应，回活跃');
      recent.handled = true;
      this._enqueueV1Turn(key, this._buildBatchPromptV1(key, [entry], false), []);
      return;
    }

    if (st.phase === 'idle') {
      // 观望期：所有消息进摘要池（之后由批量投喂或触发时一并带给模型）
      v1.appendSummary(key, entry);
      if (v1.shouldTriggerFromIdle(key, { direct })) {
        v1.enterActive(key);
        this._v1Log(key, direct ? '点名触发 → 活跃' : '概率触发 → 活跃');
        // 触发即投递：摘要池里攒的 + 本条
        const seen = v1.drainSummaries(key);
        const promptMsgs = seen.length > 0 ? seen : [{ ...entry }];
        recent.handled = true;
        this._enqueueV1Turn(key, this._buildBatchPromptV1(key, promptMsgs, !direct), []);
      }
      return;
    }

    if (st.phase === 'active') {
      if (direct) {
        recent.handled = true;
        // 必回：带上之前沉默的"已看未回"一起投
        const seen = v1.takeSilentContext(key);
        const promptMsgs = [...seen, entry];
        this._v1Log(key, '必回直投');
        this._enqueueV1Turn(key, this._buildBatchPromptV1(key, promptMsgs, false), []);
        return;
      }
      // 非必回：走批量检测（由 _v1Tick 的 nextCheckAt 驱动），
      // 这里只记活跃证据，让 tick 里判断 skip
      st.lastActiveMessageAt = Date.now();
      return;
    }

    if (st.phase === 'probing') {
      // 试探期有人说话：回活跃（noteActivity 已处理），投递回应
      this._v1Log(key, '试探窗口收到消息');
      this._enqueueV1Turn(key, this._buildBatchPromptV1(key, [entry], false), []);
      return;
    }

    // exiting：不响应，转摘要
    v1.appendSummary(key, entry);
  }

  /**
   * 媒体上下文补齐：
   * - reply 段回查成「[引用 某人：原文]」让 AI 判断这句话对谁说
   * - forward 段展开为可读消息树（限一层，失败降级占位符）
   * - 图片 URL → base64（≤1MiB，GIF 取首帧语义），失败降级为占位说明
   */
  async _enrichMessage(message) {
    const raw = message.raw ?? {};
    const segments = Array.isArray(raw.message) ? raw.message : [];
    const extra = [];
    let images = (message.images ?? []).slice();

    // 引用回查（与 _resolveQuoteTarget 共用缓存，避免同一条引用查两次）
    const replySeg = segments.find((seg) => seg?.type === 'reply');
    if (replySeg) {
      const replyId = sanitizeForwardId(replySeg.data?.id);
      if (replyId) {
        const cached = this._quoteCache.get(replyId);
        if (cached) {
          if (cached.author || cached.text) {
            extra.push(`[引用 ${cached.author || '未知'}：${cached.text || '(无文本)'}]`);
          }
        } else {
          try {
            const info = await this.bot.call('get_msg', { message_id: Number(replyId) }, { timeoutMs: 8000 });
            const sender = String(info?.sender?.nickname ?? info?.sender?.card ?? info?.user_id ?? '').trim();
            const replyParsed = parseMessageSegments(info?.message);
            const body = String(replyParsed.text ?? '').trim().slice(0, 300);
            if (sender || body) {
              extra.push(`[引用 ${sender || '未知'}：${body || '(无文本)'}]`);
            }
            this._quoteCache.set(replyId, {
              isMe: !!this.myQQId && String(info?.sender?.user_id ?? '') === String(this.myQQId),
              author: sender,
              text: body,
            });
          } catch {
            extra.push('[引用（原消息获取失败）]');
            this._quoteCache.set(replyId, { isMe: false, author: '', text: '' });
          }
        }
      }
    }

    // 合并转发展开
    const forwardIds = extractForwardIds(segments);
    for (const fid of forwardIds.slice(0, 2)) {
      try {
        const data = await this.bot.call('get_forward_msg', { message_id: fid }, { timeoutMs: 10000 });
        const messages = formatForwardMessages(data);
        extra.push(renderForwardBlock(fid, messages));
      } catch {
        extra.push(`[转发消息 id=${fid}（展开失败）]`);
      }
    }

    // 图片下载（简化版：≤1MiB、常见格式、GIF 原样传）
    const imageUrls = images.map((img) => img.url).filter(Boolean);
    if (imageUrls.length > 0) {
      const fetched = await fetchImagesForModel(imageUrls, { maxCount: 3 });
      for (const img of fetched) {
        if (img.isAnimated) extra.push('（注：附带一张 GIF 动图）');
      }
      if (fetched.length < imageUrls.length) {
        extra.push(`（注：${imageUrls.length - fetched.length} 张图片未能加载）`);
      }
      images = fetched.map(({ data, mimeType }) => persistImage({ data, mimeType }, this.stateDir));
    }

    return { message: { ...message, text: [message.text?.trim(), ...extra].filter(Boolean).join('\n') }, images };
  }

  _shouldRespondInGroup(message) {
    // 群聊：被 @（含 @全体成员）或引用机器人回复时响应
    const raw = message.raw ?? {};
    const atMe = (raw.message ?? []).some((seg) => {
      if (seg?.type !== 'at') return false;
      const qq = String(seg.data?.qq ?? '');
      return qq === this.myQQId || qq === 'all';
    });
    // 引用了机器人自己的消息：回查被引用消息的发送者
    const replySeg = (raw.message ?? []).find((seg) => seg?.type === 'reply');
    if (replySeg && this.myQQId) {
      // 同步语境下不额外回查（handleIncoming 的 _enrichMessage 已处理内容注入）；
      // 这里宽松放行引用段存在的情况——被引用者是不是自己由模型根据注入的引用内容判断。
      // 若需要严格判定，控制台/上机后可开 requireSelfQuote。
      return this.config.trigger?.replyAlways === true;
    }
    return false;
  }

  _composePrompt(message) {
    const parts = [];
    if (message.groupId) parts.push(`[群消息 from ${message.userId}]`);
    if (message.text) parts.push(message.text.trim());
    // @/私聊直投：沉默不是选项（transcript 里有 [SILENT] 暗号，显式禁止防止模型借用）
    const isDirect = !message.groupId || this._isAtMe(message);
    if (isDirect) parts.push('（有人直接对你说话：必须回应正文，不要输出 [SILENT]，不要沉默。）');
    return parts.filter(Boolean).join(' ');
  }

  /** @ 判定（含 @全体成员）。myQQId 未知时退化为「有 at 段即命中」——宁可多响应不漏 @。 */
  _isAtMe(message) {
    const raw = message.raw ?? {};
    return (raw.message ?? []).some((seg) => {
      if (seg?.type !== 'at') return false;
      const qq = String(seg.data?.qq ?? '');
      if (qq === 'all') return true;
      return this.myQQId ? qq === this.myQQId : true;
    });
  }

  /**
   * 指向性提问判定（QUALITY-REPORT P2-09）。
   *
   * 老实现要求「必须以问号结尾」且「只要有 reply 段就算对我提问」——于是
   * 「然后呢」「继续说」这类明显在接话的问法全部漏判，而「引用别人 + 有问号」却误命中。
   *
   * 现在：
   *   - 直接对我说话（@我 / 引用的是我）→ 一定算
   *   - 有问号 + 提到我名字 / 措辞指向我 → 算
   *   - 没问号但带接话引导词（然后呢 / 继续说 / 说啊）→ 也算
   *   - 明确知道引用的是**别人** → 不算（只有提到我名字才算）
   *
   * @param {object} message
   * @param {object} [opts]
   * @param {boolean} [opts.quoteTargetIsMe] - 被引用的消息是不是我发的（null = 未知）
   */
  _isQuestionToMe(message, { quoteTargetIsMe = null } = {}) {
    const text = String(message.text ?? '').trim();
    if (!text) return false;
    if (this._isAtMe(message)) return true;
    if (quoteTargetIsMe === true) return true;
    const name = String(this.config.persona?.name ?? '').trim();
    const nameMention = !!name && text.includes(name);
    // 明确知道引用的是别人 → 不能当成对我提问（只有提到我名字才算）
    if (quoteTargetIsMe === false) return nameMention;
    const hasQuestionMark = /[?？]/.test(text);
    // isDirectedAtAi 覆盖「你在吗 / 能不能 / 怎么回事 / 说句话」这类指向性措辞
    const directed = isDirectedAtAi(text);
    if (hasQuestionMark && (nameMention || directed)) return true;
    if (!hasQuestionMark && (nameMention || CONTINUATION_CUE_RE.test(text))) return true;
    return false;
  }

  // ── 二代仿真：唤醒 prompt 投递 ─────────────────────────────────────────────

  _v2Log(key, line) {
    this.v2Activity.push({ t: Date.now(), key, line: String(line).slice(0, 200) });
    if (this.v2Activity.length > 500) this.v2Activity = this.v2Activity.slice(-500);
  }

  /**
   * 唤醒 prompt：给该会话的 SessionAgent 发一条「你醒了，看看发生了什么」的增量消息。
   * 走每会话串行队列（与常规回复同一队列，保证顺序）。
   */
  async _deliverWakePrompt(key, reason) {
    if (!this.running || !this.socialV2 || this.config.socialV2?.mode !== 'v2') return;
    this._v2Log(key, `唤醒（${reason}）`);
    const runtime = this._runtimeFor(key);
    runtime.queue = runtime.queue.then(async () => {
      if (!this.running || !this.socialV2 || this.config.socialV2?.mode !== 'v2' || !this._sessionSendable(key)) return;
      // A busy turn may already have consumed and answered the triggering message
      // through qq_wait_for_messages. Do not replay an empty user-triggered wake.
      if (['private', 'atMention', 'followUp', 'nameMention', 'question', 'poke',
        'keyword', 'speaker', 'anyMessage', 'probability', 'unreadContinuation'].includes(reason)
          && this._selectWakeBatch(key).batch.length === 0) {
        this._v2Log(key, `跳过已处理消息的重复唤醒（${reason}）`);
        return;
      }
      try {
        await this._runWakeTurn(key, reason);
      } catch (error) {
        console.error(`[social-v2] 唤醒回合失败（${key}）:`, error?.message ?? error);
      }
    });
  }

  /** 时间观念行：把关键时间戳翻译成「多久之前」，治模型不知今夕何夕。 */
  _buildTimeSenseLine(key, state, unread) {
    const now = Date.now();
    const ago = (ts) => {
      if (!ts) return null;
      const ms = now - ts;
      if (ms < 0 || !Number.isFinite(ms)) return null;
      const min = Math.floor(ms / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return `${min} 分钟前`;
      const h = Math.floor(min / 60);
      if (h < 24) return `${h} 小时前`;
      return `${Math.floor(h / 24)} 天前`;
    };
    const bits = [];
    bits.push(`现在是 ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`);
    const lastIncoming = ago(state.lastIncomingAt);
    if (lastIncoming && unread.length > 0) bits.push(`最新未读发于${lastIncoming}`);
    else if (lastIncoming) bits.push(`群里最后一条消息是${lastIncoming}`);
    const lastReply = ago(state.lastAiReplyAt);
    if (lastReply) bits.push(`你上次发言是${lastReply}`);
    const lastWake = ago(state.lastWakeAt);
    if (lastWake && state.wakeCount > 1) bits.push(`上次醒来是${lastWake}`);
    return bits.join('；');
  }

  /** 自我身份行：让模型知道「我是谁、别人怎么叫我」。 */
  _buildIdentityLine(state) {
    const name = String(this.config.persona?.name ?? '').trim();
    if (!name) return '';
    return `你是「${name}」（QQ ${this.myQQId || '未知'}）——群友用 @${name} 或直接叫「${name}」就是在叫你`;
  }

  /** 参与度建议行：根据近 1 小时发言量给「该多话还是收敛」的软指引。 */
  _buildParticipationLine(key, state) {
    const recent = (state.sendTimes ?? []).filter((t) => Date.now() - t < 3600 * 1000).length;
    if (recent >= 8) return `你最近 1 小时已经发了 ${recent} 条——注意收敛，没有明确指向你的话题可以简短或不接`;
    if (recent === 0) return '你最近 1 小时还没发过言——可以适当活跃一点，但接话仍要看话题是否与你相关';
    return `你最近 1 小时发了 ${recent} 条——保持自然节奏`;
  }

  /** 唤醒原因定制引导（对齐原版按 reason 分剧本）。 */
  _buildReasonHint(reason, hasUnread) {
    switch (reason) {
      case 'proactiveCheck':
        return '（这是一次主动巡逻：没有非读不可的消息，看看近况，有想接的话题就自然插一句，没有就安静设置唤醒条件结束，不必强找话题。）';
      case 'replyCheck':
        return hasUnread
          ? '（有人接了你刚才的话——正常回应即可。）'
          : '（这是发言后的回看：没人接话就正常收尾，不要为此重复发言或自问自答。）';
      case 'timeout':
        return '（你设定的定时到了——处理积压的消息，或按当前情况重新安排唤醒条件。）';
      case 'poke':
        return '（有人戳了你——可以用 qq_send_message 简单回应一下。）';
      case 'unreadContinuation':
        return '（上一轮没处理完的剩余未读——继续处理这批，然后正常收尾。）';
      case 'manual':
        return '（管理员手动唤醒你——按未读情况正常处理。）';
      case 'atMention':
        return ''; // @ 场景已有【重要】段，不重复
      default:
        return '';
    }
  }

  /**
   * 渲染一条未读消息（模型可读格式）。
   * QUALITY-REPORT P1-03：必须带**绝对时刻 + 相对年龄 + 指向标注**，
   * 模型才知道这条消息是刚刚发生的还是两小时前的旧账。
   */
  _renderUnreadMessage(m, now = Date.now()) {
    const age = formatAge(m.time, now);
    const clock = formatClock(m.time);
    const flag = m.atMe === true ? ' ←@了你' : (m.questionToMe === true ? ' ←向你提问' : '');
    const media = m.hasImage ? '（含图片）' : '';
    const who = m.sender || m.userId || '某人';
    // seq 只在 v2 队列里有（兼容队列的条目没有 seq）
    const seqTag = Number.isFinite(m.seq) ? `[seq=${m.seq}] ` : '';
    return `- ${seqTag}${who}（${clock ? `${clock}，` : ''}${age}）：${String(m.text ?? '')}${media}${flag}`;
  }

  /**
   * 唤醒 prompt：给模型「你醒了，看看发生了什么」。
   * @param {string} key
   * @param {string} reason
   * @param {Array<object>} [unread] - 本批投喂的未读（默认取未展示的）
   * @param {object} [opts]
   * @param {Array<object>} [opts.background] - 老积压（转背景，不逐条补答）
   */
  _buildWakePrompt(key, reason, unread = this.socialV2?.peekUnread(key) ?? [], { background = [] } = {}) {
    const state = this.socialV2.get(key);
    const isPrivate = key.startsWith('p');
    const memory = this.socialV2.formatMemory(key);
    // @ 等价场景：@ 唤醒 / 私聊（私聊即"对你说话"）/ 未读里有人 @ 或向我提问
    const hasAtMe = reason === 'atMention' || isPrivate
      || unread.some((m) => m.atMe === true || m.questionToMe === true);
    const parts = [];
    if (!state.bootstrapSent) {
      parts.push(
        isPrivate
          ? '【唤醒】你在一个 QQ 私聊会话里醒来。'
          : '【唤醒】你在一个 QQ 群聊里醒来。'
      );
      // 会话初始提示词（控制台预写的圈子背景，只注入一次）
      const initialPrompt = String(state.initialPrompt ?? '').trim();
      if (initialPrompt) {
        parts.push(`【关于这个会话】${initialPrompt}`);
      }
      state.bootstrapSent = true;
    } else {
      parts.push(`【唤醒原因】${reason}${this._buildReasonHint(reason, unread.length > 0)}`);
    }
    // 上次没回应的纠错提示（QUALITY-REPORT P1-04：给一次短纠错机会）
    const correction = String(state.pendingCorrection ?? '').trim();
    if (correction) {
      parts.push(`【纠错】${correction}`);
      state.pendingCorrection = '';
    }
    // 上下文注入族：时间观念 / 自我身份 / 参与度
    const timeLine = this._buildTimeSenseLine(key, state, unread);
    if (timeLine) parts.push(`【现在】${timeLine}`);
    const identityLine = this._buildIdentityLine(state);
    if (identityLine) parts.push(`【你是谁】${identityLine}`);
    const participationLine = this._buildParticipationLine(key, state);
    if (participationLine) parts.push(`【节奏】${participationLine}`);
    if (unread.length > 0) {
      const now = Date.now();
      parts.push('【未读消息】（按时间序，最后一条最新；每条带时刻与相对年龄）');
      for (const m of unread) parts.push(this._renderUnreadMessage(m, now));
      // 老积压：只给背景，不逐条补答（QUALITY-REPORT P1-03）
      if (background.length > 0) {
        parts.push(`（另有 ${background.length} 条更早的未读没展示，属于背景，不要逐条补答）`);
      }
      const staleMin = Math.max(1, Math.round((this.config.socialV2?.staleChatMs ?? 30 * 60 * 1000) / 60000));
      parts.push(`（超过 ${staleMin} 分钟的旧消息多半只是刷到旧聊天记录，不用逐条回应；只回应最新的几条）`);
      parts.push('（回应最新的几条即可；更早的消息如果之前已经回应过就不要再回）');
    } else {
      parts.push('（没有新消息——可能是定时唤醒。想看看群里的近况可以用 qq_get_group_history。）');
    }
    parts.push('【你的记忆】');
    parts.push(memory);
    if (hasAtMe) {
      parts.push('【重要】有人 @ 了你或直接向你说话：本次必须给出回应（用 qq_send_message / qq_send_burst 发言）。'
        + '沉默不是选项——不要输出 [SILENT]，不要只设置唤醒配置就结束。');
    }
    parts.push(
      '你可以：用 qq_send_message / qq_send_burst 发言（想分条说就用数组）；' +
      '用 qq_mark_read 确认已读；用 qq_set_wake_config 设置下次醒来的条件；' +
      '用 memory_write 记住用户的长期偏好（只记稳定事实，别记闲聊）。'
    );
    parts.push('【收尾流程】记住：你输出的任何文字都会被直接发进群里。决定不参与时，一个字都不要输出，'
      + '直接用 qq_set_wake_config 潜水（或 qq_mark_read 确认已读）安静收尾；'
      + '不要输出「我撤了」「群里没聊我的」这类解释、旁白或收尾话。回应后按系统中的等待与收尾规则观察；不要抢半句。');
    return parts.join('\n');
  }

  /**
   * 选本批投喂的未读（QUALITY-REPORT P1-03）。
   *
   * 老的实现是 `peekUnread(key).slice(0, 20)` —— 从**最老**开始取，
   * 于是 21 条积压 + 最后一条是新 @ 时，第一批 20 条完全看不到那个 @，
   * 模型拿着 reason=atMention 却只看到旧内容，容易回错对象。
   *
   * 现在：
   *   - 有显式请求（@/提问）时，优先带上**最新**的显式请求 + 必要上下文；
   *   - 更老的部分只作为背景（不逐条补答），不会被丢，也不会被误当成刚发生；
   *   - 只有普通闲聊时，取最近的 limit 条。
   *
   * @returns {{batch: Array<object>, background: Array<object>, newestExplicit: object|null}}
   */
  _selectWakeBatch(key, { limit = 20 } = {}) {
    const state = this.socialV2.get(key);
    const pending = [...new Map([...(state.pendingExplicit ?? []), ...this.socialV2.peekUnread(key)].map(m => [m.seq, m])).values()].sort((a,b) => a.seq-b.seq);
    if (pending.length === 0) return { batch: [], background: [], newestExplicit: null };
    if (pending.length <= limit) return { batch: pending, background: [], newestExplicit: null };
    // 最新显式请求的位置
    let explicitIdx = -1;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (this.socialV2.isExplicitMessage(pending[i])) { explicitIdx = i; break; }
    }
    if (explicitIdx >= 0) {
      const start = Math.max(0, explicitIdx - 2); // 带上 2 条上下文
      const batch = pending.slice(start, start + limit);
      const background = pending.slice(0, start);
      return { batch, background, newestExplicit: pending[explicitIdx] };
    }
    const batch = pending.slice(-limit);
    const background = pending.slice(0, pending.length - limit);
    return { batch, background, newestExplicit: null };
  }

  /**
   * 记一次**实际送达** QQ 的发送回执（QUALITY-REPORT P1-04）。
   * 「投喂过」不等于「回应了」——只有真发出去才算回应。
   */
  _recordSendReceipt(key, text, seqs = this._runtimeFor(key).responseSeqs ?? []) {
    if (!this.turnSendReceipts.has(key)) this.turnSendReceipts.set(key, []);
    this.turnSendReceipts.get(key).push({ text: String(text ?? '').slice(0, 200), at: Date.now(), seq: 0 });
    this.toolSentInTurn.add(key);
    if (this.socialV2 && seqs.length) {
      this.socialV2.markReadSeqs(key, seqs);
      this.socialV2.markHandled(key, seqs);
    }
  }

  /** 发送失败时撤销回执（回执是「已回应」的判据，不能留下假的）。 */
  _revokeSendReceipt(key, text) {
    const list = this.turnSendReceipts.get(key);
    if (!list || list.length === 0) return;
    const target = String(text ?? '').slice(0, 200);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].text === target) { list.splice(i, 1); break; }
    }
    if (list.length === 0) this.toolSentInTurn.delete(key);
  }

  /** 本回合是否已经真的发出去过东西。 */
  _hasRealSend(key) {
    return (this.turnSendReceipts.get(key)?.length ?? 0) > 0;
  }

  /**
   * 出站统一闸门（QUALITY-REPORT P2-08）。
   * 所有出口（send / reply / burst / 唤醒兜底 / 常规转发）都必须过这里——
   * 之前的实现只有 reply 过滤了 SILENT、burst 只剥 SILENT，底层发送不拦退场话，
   * 文档说的「六出口全拦」并不成立。
   *
   * @param {string} text
   * @param {object} [opts]
   * @param {boolean} [opts.plain] - 已是纯文本（不再做 mdToPlain）
   * @returns {{ok: boolean, text?: string, blocked?: 'silent'|'farewell'|'empty'}}
   */
  _guardOutbound(text, { plain = false } = {}) {
    const raw = String(text ?? '');
    if (isSilentMarker(raw)) return { ok: false, blocked: 'silent' };
    const stripped = normalizeChatSpacing(stripSilentMarkers(plain ? raw : mdToPlain(raw)));
    if (!stripped) return { ok: false, blocked: 'silent' };
    if (isFarewellPhrase(stripped)) return { ok: false, blocked: 'farewell' };
    const safe = redactAll(stripped, this.knownTokens);
    if (!safe) return { ok: false, blocked: 'empty' };
    if (isFarewellPhrase(safe)) return { ok: false, blocked: 'farewell' };
    return { ok: true, text: safe };
  }

  async _runWakeTurn(key, reason) {
    if (!this.sessionManager) return;
    // Reserve before asynchronous session creation, otherwise simultaneous @s
    // can all pass the scheduler's busy check and queue redundant turns.
    this.wakeScheduler?.setBusy(key, true);
    let agent;
    try {
      agent = await this.sessionManager.get(key);
    } catch (error) {
      this.wakeScheduler?.setBusy(key, false);
      throw error;
    }
    if (!this.running || !this.socialV2 || !this.wakeScheduler || this.config.socialV2?.mode !== 'v2') {
      this.wakeScheduler?.setBusy(key, false);
      return;
    }
    this.toolSentInTurn.delete(key);
    this.turnSendReceipts.delete(key);
    this._runtimeFor(key).responseSeqs = [];
    this._runtimeFor(key).answerQueue = Promise.resolve();
    this._runtimeFor(key).waitBudgetMs = 12 * 60 * 1000; // 每回合观察总时长预算（复刻原版 15min 租约自由度）
    this.wakeScheduler.setBusy(key, true);

    agent.listeners.onToolCall = () => {};
    agent.listeners.onTurnUsage = ({ usage }) => {
      this.ledger.add(key, usage);
    };
    const turnStore = this.socialV2;
    const turnState = turnStore.get(key);
    const currentTurn = () => this.running && this.socialV2 === turnStore && turnStore.conversations.get(key) === turnState;
    // P1-05：首答即时外发——assistant 消息完成即发，不等整个观察回合结束
    agent.listeners.onAssistantMessage = (payload) => {
      const rt = this._runtimeFor(key);
      rt.answerQueue = (rt.answerQueue ?? Promise.resolve()).then(() => currentTurn() ? this._maybeSendImmediateAnswer(key, payload) : undefined);
    };

    // 本批投喂的未读：最新显式请求优先（QUALITY-REPORT P1-03）
    const { batch: promptUnread, background } = this._selectWakeBatch(key);
    this._runtimeFor(key).responseSeqs = promptUnread.map(m => m.seq);
    const wakeUnreadMaxSeq = promptUnread.length > 0 ? Math.max(...promptUnread.map((m) => m.seq)) : 0;
    const enrichedUnread = [];
    const visionImages = [];
    const hadUnread = promptUnread.length;
    // @ 等价场景（与 _buildWakePrompt 的 hasAtMe 同口径）：@ 唤醒 / 私聊 / 未读里有 @ 或向我提问。
    // 此场景禁止沉默——没回应就不确认已读，并安排有限重试。
    const hasAtMe = reason === 'atMention' || key.startsWith('p')
      || promptUnread.some((m) => m.atMe === true || m.questionToMe === true);
    let errorMessage = null; // finally 的续读判定要用（try 内赋值）
    let skipContinuation = false; // 违规重试回合：finally 不再续读（防止与重试互相咬合成死循环）
    // 睡前观察硬闸数据：本回合投喂过未读 → 收尾（mark_read/wake_config）前应至少观察一场
    this._runtimeFor(key).hadUnreadThisTurn = hadUnread > 0;
    try {
      for (const m of promptUnread) {
        const enriched = await this._enrichMessage({ ...m, images: m.images ?? [], raw: m.raw ?? {} });
        enrichedUnread.push({ ...m, text: enriched.message.text });
        visionImages.push(...enriched.images);
      }
      const promptText = this._buildWakePrompt(key, reason, enrichedUnread, { background });
      if (!currentTurn() || this.config.socialV2?.mode !== 'v2') return;
      // 记录「已展示」：只推进水位，不移除队列——出错时下一轮还能重投（无丢消息）
      this.socialV2.markShownSeqs(key, promptUnread.map((m) => m.seq), { tool: 'wake-prompt' });
      // 显式请求单独记账：已展示但未回应的不能被归档吞掉
      this.socialV2.trackExplicitPending(key, promptUnread);
      const turn = await agent.prompt(promptText, visionImages.slice(0, 3));
      await this._runtimeFor(key).answerQueue;
      errorMessage = turn.errorMessage ?? null;
      const reply = turn.text;
      if (!currentTurn() || this.config.socialV2?.mode !== 'v2') return;

      // ── P1-04：有没有「确实回应了」以实际发送回执为准 ──
      // 旧实现只判断最终文本是不是完整 [SILENT]：空文本、只设唤醒配置、只写记忆都不匹配，
      // 于是「投喂过」被当成「已回应」——未读被清掉，显式请求静默丢失。
      const responded = this._hasRealSend(key);
      const silentish = !this._guardOutbound(reply).ok;
      if (!errorMessage && hasAtMe && hadUnread > 0 && !responded && silentish) {
        const st = this.socialV2.get(key);
        const oldestSeq = promptUnread[0]?.seq ?? 0;
        const sameBatchRetry = st.atSilentViolationSeq === oldestSeq;
        st.lastAtSilentViolationAt = Date.now();
        st.atSilentViolationSeq = oldestSeq;
        st.unansweredSeq = wakeUnreadMaxSeq;
        st.unansweredRetries = sameBatchRetry ? (st.unansweredRetries ?? 0) + 1 : 1;
        if (!sameBatchRetry && (st.unansweredRetries ?? 0) <= 2) {
          // 追加一次短纠错提示 + 有限重试（同一批最多 2 次，绝不无限循环）
          st.pendingCorrection = '上一轮你被点名/被提问，但这一轮没有发出任何回复（既没有文字，也没有调用发送工具）。'
            + '这次必须用 qq_send_message 或 qq_send_burst 把回复发出去——也可以直接输出回复正文。';
          this._v2Log(key, '未回应（显式请求没有任何发送回执），保留未读并重试');
          this.wakeScheduler.scheduleWake(key, 'atMention', { immediate: true, tier: WAKE_TIER.direct });
        } else {
          this._v2Log(key, '未回应（同一批已重试过），保留未读等自然唤醒');
        }
        skipContinuation = true;
        return;
      }

      // 兜底发送：模型没走发送工具、也没被即时首答通道发出去、但确实有未读要回时，
      // 把文字回复发出去。（唤醒路径原本完全依赖模型主动调 qq_send_message，
      //   模型一旦只吐文字，消息就会凭空消失。）
      // 巡逻唤醒（无未读）不兜底：那种情况模型若想发言应主动用发送工具。
      if (!errorMessage && reply && hadUnread > 0 && !responded) {
        const guard = this._guardOutbound(reply);
        if (!guard.ok) {
          this._v2Log(key, guard.blocked === 'farewell' ? '退场话术被拦截（常驻角色不退场）' : '[SILENT] 沉默（唤醒兜底）');
        } else {
          let delivered = true;
          for (const seg of splitForQQ(guard.text, 4000)) {
            if (!seg || isFarewellPhrase(seg)) continue;
            try {
              const res = await this._sendToSession(key, seg);
              if (res?.blocked) continue;
              this._recordSendReceipt(key, seg);
            } catch (error) {
              delivered = false;
              console.error('[bridge] 唤醒兜底发送失败:', error?.message ?? error);
              break;
            }
          }
          if (!delivered) return; // 保留未读，下一次唤醒重试。
        }
      }

      // F3：AI 有行动 → 自动确认投喂过的未读已读。
      // 不依赖模型记得调 qq_mark_read；否则同批旧消息残留会在下次唤醒重复出现。
      // 出错回合（timeout/connection error/400）不清未读：下次醒来重试这批消息。
      // 显式请求且**没有实际发送**时不得当作普通已读（见上面的违规分支）。
      // 只清理**本批确实展示过**的那些 seq——不能用 markRead(maxSeq) 越界清掉没展示过的老消息。
      if (!errorMessage && wakeUnreadMaxSeq > 0 && (this._hasRealSend(key) || !hasAtMe)) {
        this.socialV2.markReadSeqs(key, promptUnread.map((m) => m.seq));
        if (this._hasRealSend(key)) this.socialV2.markHandled(key, promptUnread.map(m => m.seq));
      }
      // turn 结束：防呆判定（出错回合不算空醒——不是模型不想动，是没跑成）
      if (errorMessage) {
        this._v2Log(key, `唤醒回合出错: ${errorMessage}`);
        // Retry transient transport failure once per batch, only before QQ delivery.
        const state = this.socialV2.get(key);
        if (hadUnread > 0 && !this._hasRealSend(key)
            && /Connection error|Request timed out|fetch failed/i.test(errorMessage)
            && state.networkRetrySeq !== wakeUnreadMaxSeq) {
          state.networkRetrySeq = wakeUnreadMaxSeq;
          this._v2Log(key, '模型网络请求失败：保留未读并安排一次重试；重复失败等待后续唤醒');
          this.wakeScheduler.scheduleWake(key, reason, { tier: tierOfReason(reason) });
        }
        return; // 请求失败不计入模型空醒。
      }
      const acted = this._hasRealSend(key) || hadUnread > 0;
      if (acted) {
        this.wakeScheduler.noteAction(key);
      } else {
        this.wakeScheduler.noteNoAction(key);
      }
      this.wakeScheduler.ensureWakeable(key);
    } catch (error) {
      errorMessage = error?.message ?? String(error);
      throw error;
    } finally {
      agent.listeners.onAssistantMessage = undefined;
      this.wakeScheduler?.setBusy(key, false);
      this.sessionManager.save(key);
      this.socialV2?.save();
      // 分批续读：本批消费后仍有**可展示**的剩余未读 → 立即调度下一次唤醒继续处理。
      // （老积压（seq ≤ shownSeq）不再进入下一批——它们是背景，不是待办。）
      // 出错回合/违规重试回合不续调度：先让模型恢复，剩余未读等自然触发/巡逻，避免连环重试。
      const stillPending = this.socialV2
        ? this.socialV2.peekUnread(key, { afterSeq: this.socialV2.get(key).shownSeq ?? 0 })
        : [];
      if (!errorMessage && !skipContinuation && this.running && stillPending.length > 0) {
        this.wakeScheduler?.scheduleWake(key, 'unreadContinuation');
      }
    }
  }

  /**
   * 首答即时外发（QUALITY-REPORT P1-05）。
   *
   * 旧实现里，模型只输出文字再进入 wait 观察时，文字要等整个回合（最长 900s）
   * 结束才由兜底路径发出——用户在群里等的是「立刻回一句」。
   * 现在：assistant 消息**完成**时（pi 的 message_end 事件，不是流式碎片）立刻发。
   *
   * 跳过条件：
   *   - 这条 assistant 消息里带了发送类工具调用 → 由工具自己发，避免双发；
   *   - 本回合已经发过 → 避免重复；
   *   - 文本是 [SILENT] / 退场话 → 出站闸门拦掉。
   */
  async _maybeSendImmediateAnswer(key, { text, toolNames = [], message } = {}) {
    if (!text) return;
    if (message?.stopReason === 'error' || message?.stopReason === 'aborted') return;
    const sendTools = /(^|_)(qq_)?(send_message|reply|send_burst)$/;
    if (toolNames.some((n) => sendTools.test(String(n)))) return;
    const guard = this._guardOutbound(text);
    if (!guard.ok) return;
    const seqs = [...(this._runtimeFor(key).responseSeqs ?? [])];
    // Only successful OneBot responses count as delivery.
    try {
      const res = await this._sendToSession(key, guard.text);
      if (!res?.blocked) this._recordSendReceipt(key, guard.text, seqs);
    } catch (error) {
      console.error('[bridge] 首答即时发送失败:', error?.message ?? error);
    }
  }

  /**
   * 手动唤醒（控制台用）。
   * QUALITY-REPORT P1-01：返回「已排队 / 被限频 + 还要等多久」，
   * 而不是笼统的 ok:false——运维要能看出到底发生了什么。
   */
  manualWake(key, reason = 'manual') {
    key = canonicalKeyForV2(key);
    if (!key) return { woke: false, error: '会话 key 非法', status: 400 };
    if (!this.wakeScheduler) return { woke: false, error: '二代仿真未启用' };
    if (!this._sessionSendable(key)) return { woke: false, error: '会话不在白名单内', status: 403 };
    if (this.config.socialV2?.mode !== 'v2') return { woke: false, error: '二代未接管', status: 409 };
    const r = this.wakeScheduler.tryWake(key, reason);
    if (r.woke) return { ...r, status: 200, note: '已唤醒' };
    if (r.deferred === 'rate-limited') {
      return {
        ...r,
        status: 429,
        error: `被限频：${r.tier ?? ''} 档额度已用完，约 ${Math.ceil((r.retryAfterMs ?? 0) / 1000)} 秒后可重试`,
      };
    }
    if (r.deferred === 'busy') {
      return { ...r, status: 202, note: '该会话正在回合中，已排队，回合结束后自动唤醒' };
    }
    return { ...r, status: 409, error: r.deferred ?? '未唤醒' };
  }

  // ── 一代仿真：状态机接线 ───────────────────────────────────────────────────

  _v1Log(key, line) {
    this.v1Activity.push({ t: Date.now(), key, line: String(line).slice(0, 200) });
    if (this.v1Activity.length > 500) this.v1Activity = this.v1Activity.slice(-500);
  }

  /** v1 白名单内的会话 key 集合（供 tick 过滤）。 */
  _v1AllowedKeys() {
    const allowGroups = new Set((this.config.allow?.groups ?? []).map(String));
    const allowPrivate = new Set((this.config.allow?.private ?? []).map(String));
    const denyGroups = new Set((this.config.deny?.groups ?? []).map(String));
    const denyPrivate = new Set((this.config.deny?.private ?? []).map(String));
    const empty = (this.config.allow?.allowAllWhenEmpty === true
      && allowGroups.size === 0 && allowPrivate.size === 0);
    const keys = new Set();
    for (const key of this.socialV1.keys()) {
      const id = key.slice(1);
      const isGroup = key.startsWith('g');
      if ((isGroup ? denyGroups : denyPrivate).has(id)) continue;
      if (empty || (isGroup ? allowGroups : allowPrivate).has(id)) keys.add(key);
    }
    return keys;
  }

  /** 5 秒心跳：推进 v1 状态机（冷场试探/活跃超时/退场兜底）+ 活跃期批量检测。 */
  _v1Tick() {
    if (this.config.socialV1?.mode !== 'v1') return;
    if (!this.socialV1 || !this.running) return;
    try {
      // S3：只遍历仍在白名单内的会话（被移出白名单的旧会话不再自动发言）
      const allowedKeys = this._v1AllowedKeys();
      // 活跃期批量检测（对齐旧版 socialLoopTick 的 active 分支）
      for (const key of allowedKeys) {
        const st = this.socialV1.state(key);
        if (st.phase !== 'active' || Date.now() < st.nextCheckAt) continue;
        const newMsgs = this.socialV1.recentMessagesOf(key).filter((m) => !m.handled && m.time >= st.lastCheckAt);
        if (newMsgs.length === 0) continue; // 留给 store.tick 推进冷场/试探。
        for (const m of newMsgs) m.handled = true;
        st.lastCheckAt = Date.now();
        st.lastActiveMessageAt = Date.now();
        st.nextCheckAt = Date.now() + (this.socialV1.limits.activeCheckMinMs
          + Math.random() * (this.socialV1.limits.activeCheckMaxMs - this.socialV1.limits.activeCheckMinMs));
        if (newMsgs.length === 0) continue; // 冷场由 tick 的 idleWindow 分支处理
        const mustReply = newMsgs.some((m) => m.quoteTargetIsSelf)
          || newMsgs.some((m) => isMustReplyText(m.text, {
            myName: String(this.config.persona?.name ?? ''),
            keywords: this.socialV1.limits.mustReplyKeywords,
          }));
        if (!mustReply && this.socialV1.shouldSkipInActive(key, newMsgs.length)) {
          // 选择性沉默："看到了但没接"——进 silentContext 与摘要池
          this._v1Log(key, `活跃期 ${newMsgs.length} 条普通消息选择沉默`);
          this.socialV1.addSilentContext(key, newMsgs);
          for (const m of newMsgs) this.socialV1.appendSummary(key, m);
          continue;
        }
        // 投递：沉默期消息 + 新消息一起给模型
        const seen = this.socialV1.takeSilentContext(key);
        const promptMsgs = [...seen, ...newMsgs];
        this._v1Log(key, `活跃期投递 ${promptMsgs.length} 条`);
        this._enqueueV1Turn(key, this._buildBatchPromptV1(key, promptMsgs, !mustReply), []);
      }
      // 状态机转移（试探/退场/兜底）——同样只对白名单内会话
      this.socialV1.tick((key, kind) => {
        if (kind === 'probe') {
          this._v1Log(key, '冷场试探');
          this._enqueueV1Turn(key, this._buildProbePrompt(key), []);
        } else if (kind === 'exit') {
          this._v1Log(key, '活跃超时，开始退场');
          this._enqueueV1Turn(key, this._buildFarewellPrompt(key), []);
        }
      }, { allowedKeys: this._v1AllowedKeys() });
    } catch (error) {
      console.error('[social-v1] tick 异常:', error?.message ?? error);
    }
  }

  /** v1 近期上下文块（活跃期批量 prompt 用）。 */
  _buildV1ContextBlock(key) {
    const recent = this.socialV1.recentMessagesOf(key).slice(-this.socialV1.limits.contextWindow);
    return recent.map((m) => `${m.handled ? '（已处理的上下文）' : ''}${m.sender}：${m.text}`).join('\n') || '（暂无）';
  }

  _buildBatchPromptV1(key, promptMsgs, canSkip) {
    const parts = [
      '【群聊近况】',
      this._buildV1ContextBlock(key),
      '【刚刚发生的】',
      promptMsgs.map((m) => `${m.sender}：${m.text}`).join('\n') || '（无）',
    ];
    if (canSkip) {
      parts.push('（这些不是点名你的消息。不想接就只输出 [SILENT]，想接就直接回复内容。多余的话不要说。）');
    } else {
      parts.push('（这些消息在等你回应。回复内容即可，[SILENT] 不可用。）');
    }
    return parts.join('\n');
  }

  _buildProbePrompt(key) {
    return [
      '【群聊近况】',
      this._buildV1ContextBlock(key),
      '（群里冷场了。你可以试探性说一句接话，或只输出 [SILENT] 表示继续沉默。多余的话不要说。）',
    ].join('\n');
  }

  _buildFarewellPrompt(key) {
    // 退场相不再要求告别语（用户要求全程禁退场话）：模型可选择说一句**新的、
    // 与聊天内容相关的自然话**（不许用「我先撤了/去忙了/告辞」这类口头禅），或直接 [SILENT] 安静退场。
    return [
      '【群聊近况】',
      this._buildV1ContextBlock(key),
      '（你在群里活跃挺久了，现在该退场了。不要说「我先撤了」「去忙了」「告辞」这类收尾口头禅——' +
      '要么接一句和刚才聊天内容相关的自然的话（可以是回应之前的话题、留个话头），要么只输出 [SILENT] 安静退场。多余的话不要说。）',
    ].join('\n');
  }

  /**
   * v1 回合投递：与常规/v2 共用每会话串行队列。
   * AI 输出 [SILENT] → 不发送；否则按 CJK 空格分条 + 节奏发送。
   */
  _enqueueV1Turn(key, promptText, images) {
    const runtime = this._runtimeFor(key);
    runtime.queue = runtime.queue.then(async () => {
      if (!this.running) return;
      try {
        await this._runV1Turn(key, promptText, images ?? []);
      } catch (error) {
        console.error(`[social-v1] 回合失败（${key}）:`, error?.message ?? error);
      }
    });
  }

  async _runV1Turn(key, promptText, images) {
    const agent = await this.sessionManager.get(key);
    this.toolSentInTurn.delete(key);
    this.turnSendReceipts.delete(key);
    this._runtimeFor(key).responseSeqs = [];
    this._runtimeFor(key).answerQueue = Promise.resolve();
    this._runtimeFor(key).waitBudgetMs = 12 * 60 * 1000; // 每回合观察总时长预算

    agent.listeners.onTurnUsage = ({ usage }) => {
      this.ledger.add(key, usage);
    };
    // P1-05：首答即时外发（v1 同样受益——回复不用等回合收尾）
    agent.listeners.onAssistantMessage = (payload) => {
      const rt = this._runtimeFor(key);
      rt.answerQueue = (rt.answerQueue ?? Promise.resolve()).then(() => this._maybeSendImmediateAnswer(key, payload));
    };

    try {
      const { text: reply, errorMessage } = await agent.prompt(promptText, images);
      await this._runtimeFor(key).answerQueue;
      if (!this.socialV1 || this.config.socialV1?.mode !== 'v1') return;
      if (errorMessage) {
        this._v1Log(key, `回合出错: ${errorMessage}`);
        return;
      }
      if (isSilentMarker(reply)) {
        this._v1Log(key, '[SILENT] 潜水');
        return; // 不发送
      }
      if (this._hasRealSend(key)) {
        this._v1Log(key, '已发出消息（首答或发送工具）');
        this.socialV1.noteAiReply(key);
        this.socialV1.save();
        return;
      }
      // 白名单复核（S3）：会话可能在会话建立后被移出白名单
      if (!this._sessionSendable(key)) {
        this._v1Log(key, '会话已不在发送白名单内，跳过发送');
        return;
      }
      // CJK 空格分条 + 节奏发送（统一出站闸门：SILENT/退场话/脱敏）
      const timeline = planSocialTimeline(stripSilentMarkers(mdToPlain(reply)), this.socialV1.limits)
        .filter((seg) => !isFarewellPhrase(seg));
      const runtime = this._runtimeFor(key);
      const isGroup = key.startsWith('g');
      for (let i = 0; i < timeline.length; i++) {
        const guard = this._guardOutbound(timeline[i], { plain: true });
        if (!guard.ok) continue;
        const res = await this._sendToSession(key, guard.text);
        if (res?.blocked) continue;
        this._recordSendReceipt(key, guard.text);
        if (i < timeline.length - 1) {
          // 条间 1~3s，20% 概率长间隔 2.5~5s
          const gap = Math.random() < 0.2
            ? 2500 + Math.random() * 2500
            : 1000 + Math.random() * 2000;
          await sleep(gap);
        }
      }
      this.socialV1.noteAiReply(key);
      this.socialV1.save();
      void runtime;
    } finally {
      this.sessionManager.save(key);
      // 退场收尾（S2）：退场 prompt 的回合结束后立即回观望，不再静默 60 分钟
      if (this.socialV1?.exitingKeys.has(key)) {
        this.socialV1.finishExit(key);
        this._v1Log(key, '退场话说完，回观望');
      }
    }
  }

  /**
   * 睡眠时长钳制（QUALITY-REPORT P2-07）。
   *
   * 以前 sleepMinMs / sleepMaxMs 只在 /api/socialv2/schedule 里保存与回显，
   * 全 src 没有任何执行端消费——UI 改了「最短/最长睡眠」对模型毫无约束。
   * 现在它们是**硬限制**：模型（或控制台）请求的睡眠时长会被夹到 [min, max]，
   * 同时保留原有的 4 小时上限。
   *
   * @param {number} until - 目标唤醒时间戳
   * @returns {{until: number, clamped: string|null}}
   */
  _clampSleepUntil(until) {
    const now = Date.now();
    const minMs = clampInt(Number(this.config.socialV2?.sleepMinMs ?? 60 * 1000), 30 * 1000, 4 * 3600 * 1000, 60 * 1000);
    const maxMs = clampInt(Number(this.config.socialV2?.sleepMaxMs ?? 120 * 60 * 1000), minMs, 24 * 3600 * 1000, 120 * 60 * 1000);
    const hardMaxMs = 4 * 3600 * 1000;
    const requested = Number(until);
    if (!Number.isFinite(requested) || requested <= 0) return { until: 0, clamped: null };
    let target = requested;
    let clamped = null;
    if (target - now > hardMaxMs) {
      target = now + hardMaxMs;
      clamped = `最长 ${Math.round(hardMaxMs / 60000)} 分钟`;
    }
    if (target - now > maxMs) {
      target = now + maxMs;
      clamped = `最长 ${Math.round(maxMs / 60000)} 分钟`;
    }
    if (target - now < minMs) {
      target = now + minMs;
      clamped = `最短 ${Math.round(minMs / 60000)} 分钟`;
    }
    return { until: Math.round(target), clamped };
  }

  _runtimeFor(key) {
    let runtime = this.sessionRuntime.get(key);
    if (!runtime) {
      runtime = { queue: Promise.resolve(), unread: [], waiters: [], busy: false };
      this.sessionRuntime.set(key, runtime);
    }
    return runtime;
  }

  _notifyWaiters(key) {
    const runtime = this.sessionRuntime.get(key);
    if (!runtime) return;
    const waiters = runtime.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  /** 每会话串行：同一会话的回合逐个跑；运行中收到的新消息携带完整内容继续排队。 */
  _enqueueTurn(key, message, text, images) {
    const runtime = this._runtimeFor(key);
    runtime.queue = runtime.queue.then(async () => {
      if (!this.running) return;
      try {
        await this._runTurn(key, message, text, images, runtime);
      } catch (error) {
        console.error(`[bridge] 回合失败（${key}）:`, error?.message ?? error);
        this._sendToQQSafe(message, '（处理出错了，稍后再试试）');
      }
    });
  }

  async _runTurn(key, message, text, images, runtime) {
    const agent = await this.sessionManager.get(key);
    this.toolSentInTurn.delete(key);
    this.turnSendReceipts.delete(key);
    this._runtimeFor(key).answerQueue = Promise.resolve();
    runtime.waitBudgetMs = 12 * 60 * 1000; // 每回合观察总时长预算

    agent.listeners.onTextDelta = () => {}; // 文本在 run 结束后统一发送（QQ 不适合逐字刷屏）
    agent.listeners.onToolCall = () => {};
    agent.listeners.onTurnUsage = ({ usage }) => {
      this.ledger.add(key, usage);
    };
    // P1-05：首答即时外发（不等整个回合结束）
    agent.listeners.onAssistantMessage = (payload) => {
      const rt = this._runtimeFor(key);
      rt.answerQueue = (rt.answerQueue ?? Promise.resolve()).then(() => this._maybeSendImmediateAnswer(key, payload));
    };

    agent.captureUtterance(text);

    // vision 入参：{data(base64), mimeType}；文本里已含「动图」提示
    const visionImages = (images ?? [])
      .filter((img) => img?.data && img?.mimeType)
      .map(({ data, mimeType }) => ({ data, mimeType }));

    // New messages remain in the same serial queue, carrying their full text and images.
    try {
      const { text: reply, errorMessage } = await agent.prompt(text, visionImages);
      await this._runtimeFor(key).answerQueue;
      if (errorMessage) {
        console.error(`[bridge] ${key} 模型错误: ${errorMessage}`);
        this._sendToQQSafe(message, '（模型这次没答上来，稍后再试试）');
        return;
      }
      // 模型没有用发送工具 → 自动转发最终回复（即时首答已发过则不重复）
      if (!this._hasRealSend(key)) {
        await this.sendToQQ(message, reply);
      }
    } finally {
      this.sessionManager.save(key);
    }
  }

  // ── 发送 QQ ────────────────────────────────────────────────────────────────

  /**
   * 常规链路出站（模型最终回复自动转发）。
   * P2-08：统一出站闸门——SILENT / 退场话 / 脱敏一次过；分条后再逐条复检。
   */
  async sendToQQ(message, text) {
    if (!this._sessionSendable(sessionKeyOf(message))) return;
    const key = sessionKeyOf(message);
    const guard = this._guardOutbound(text);
    if (!guard.ok) return; // silent / farewell / empty 一律不外发
    const segments = splitForQQ(guard.text, 4000);
    let sent = 0;
    for (const seg of segments) {
      if (!seg || isFarewellPhrase(seg)) continue;
      const segGuard = this._guardOutbound(seg, { plain: true });
      if (!segGuard.ok) continue;
      try {
        const res = await this._sendToSession(key, segGuard.text);
        if (res?.blocked) continue;
        sent++;
        this._recordSendReceipt(key, segGuard.text);
      } catch (error) {
        console.error('[bridge] 发送失败:', error?.message ?? error);
        break;
      }
      if (segments.length > 1 && this.config.sendDelayMs > 0) {
        await sleep(this.config.sendDelayMs);
      }
    }
    return sent;
  }

  _sendToQQSafe(message, text) {
    void this.sendToQQ(message, text).catch(() => {});
  }

  // ── 工具构建（MCP stdio → AgentTool）───────────────────────────────────────

  async _buildTools(sessionKey) {
    if (!this._toolsReady) {
      this._toolsReady = this._initializeTools().catch(error => { this._toolsReady = null; throw error; });
    }
    await this._toolsReady;
    return [
      ...this._qqTools.map(tool => ({ ...tool, execute: (id, params, signal) =>
        tool.execute(id, { ...(params ?? {}), __qqSession: sessionKey }, signal) })),
      ...this._webTools,
    ];
  }

  async _initializeTools() {
    if (this.mcpHandles.length === 0) {
      const qqTools = await connectMcpTools({
        command: process.execPath,
        args: [path.join(ROOT, 'src', 'mcp', 'qq-tools-server.mjs')],
        env: {
          QQ_BRIDGE_BASE: `http://127.0.0.1:${this.internalPort}`,
          QQ_BRIDGE_TOKEN: this.internalToken,
          QQ_WAIT_TIMEOUT_MS: '620000',
        },
        requestTimeoutMs: 620000, // 长轮询工具
      });
      let webTools;
      try { webTools = await connectMcpTools({
        command: process.execPath,
        args: [path.join(ROOT, 'src', 'mcp', 'web-search-server.mjs')],
        env: {
          WEB_SEARCH_API_KEY: this.config.model.apiKey || process.env.DEEPSEEK_API_KEY || '',
          WEB_SEARCH_BASE_URL: this.config.model.baseUrl ?? 'https://api.deepseek.com',
          WEB_SEARCH_MODEL: this.config.model.model ?? 'deepseek-chat',
        },
      });
      } catch (error) { await qqTools.close().catch(() => {}); throw error; }
      this.mcpHandles.push(qqTools, webTools);
      this._qqTools = qqTools.tools;
      this._webTools = webTools.tools;
    }
  }

  /**
   * 工具审批（beforeToolCall）：发送类工具的会话准入校验。
   * qq_send_message / qq_reply 固定发送「当前会话」（桥接内部 API 按 x-qq-session 绑定），
   * 无法指定其他目标；这里复核**当前会话本身**是否在收侧白名单内（双保险）。
   */
  async _approveToolCall(sessionKey, toolName, _args) {
    const isSend = /^mcp_qq_(send_message|reply|send_burst)$/.test(toolName);
    if (!isSend) return { allow: true };
    if (!this._sessionSendable(sessionKey)) return { allow: false, reason: '当前会话不在发送白名单内' };
    return { allow: true };
  }

  // ── 内部 HTTP（QQ 工具回调 + 轻量控制面）────────────────────────────────────

  async _startInternalHttp() {
    this.internalServer = http.createServer((req, res) => {
      void this._handleInternal(req, res).catch((error) => {
        res.writeHead(error?.status ?? 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error?.message ?? 'internal error', retryAfterMs: error?.retryAfterMs }));
      });
    });
    // Default to loopback; LAN binding must be explicitly configured.
    this.internalHost = String(this.config.internalHost ?? '127.0.0.1').trim() || '127.0.0.1';
    await new Promise((resolve, reject) => {
      this.internalServer.once('error', reject);
      this.internalServer.listen(this.internalPort, this.internalHost, () => {
        this.internalServer.removeListener('error', reject);
        resolve();
      });
    });
    this.internalPort = this.internalServer.address().port;
    const scope = this.internalHost === '127.0.0.1' || this.internalHost === 'localhost' ? '仅本机' : `局域网（${this.internalHost}）`;
    console.log(`[bridge] 内部 HTTP 就绪 http://${this.internalHost}:${this.internalPort}（${scope}，控制面免鉴权）`);
  }

  /** 控制面免鉴权（局域网信任 + Origin 校验防跨站）；Agent 工具回调始终需要 x-agent-call + internalToken。 */
  _authed(req) {
    if ((req.url ?? '').startsWith('/agent/')) {
      const tokenOk = req.headers['x-console-token'] === this.internalToken;
      return tokenOk && req.headers['x-agent-call'] === '1';
    }
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; }
    }
    return true;
  }

  _currentSessionKey(req) {
    // 工具回调必须声明会话上下文：QQ 工具是「当前会话」语义，会话 key 由桥接绑定在运行中的回合上
    return String(req.headers['x-qq-session'] ?? '');
  }

  /**
   * 取未读给模型（QUALITY-REPORT P1-02：单一事实源 + 游标）。
   *
   * 统一走 socialV2 的 seq 队列：首屏、qq_get_unread_messages、qq_wait_for_messages
   * 读的是**同一份**未读，老实现里运行时队列和 v2 队列各读各的，
   * 于是「首屏看过的消息」会被随后的「等新消息」再读一遍。
   *
   * runtime.unread 只作为**兼容兜底**保留：入站消息现在只写 socialV2，
   * 因此同一条消息不会同时存在于两个队列（这正是重复投喂的根因）；
   * 但外部代码/测试直接往 runtime.unread 塞消息时仍能被读到。
   *
   * @returns {{messages: Array<object>, throughSeq: number, lastReadThroughSeq: number}}
   */
  _takeUnreadForModel(key, { afterSeq = 0, limit = 0 } = {}) {
    if (!key || !this.socialV2) {
      const runtime = this.sessionRuntime.get(key);
      const messages = runtime ? runtime.unread.splice(0) : [];
      return { messages: messages.map((m) => ({ ...m, text: this._renderPlainMessage(m) })), throughSeq: 0, lastReadThroughSeq: 0 };
    }
    const state = this.socialV2.get(key);
    // 游标：显式 afterSeq 优先；缺省用「已经展示过的水位」，避免重复投喂
    const cursor = afterSeq > 0 ? afterSeq : (state.shownSeq ?? 0);
    const raw = this._pendingUnread(key, cursor, limit);
    this._runtimeFor(key).responseSeqs = raw.map(m => m.seq).filter(Number.isFinite);
    const messages = raw.map((m) => this._renderModelMessage(m));
    if (raw.length > 0) {
      const seqs = raw.map((m) => m.seq).filter((n) => Number.isFinite(n));
      if (seqs.length > 0) {
        this.socialV2.markShownSeqs(key, seqs, { tool: 'qq_get_unread_messages' });
        this.socialV2.trackExplicitPending(key, raw);
      }
      this._drainLegacyUnread(key);
    }
    const throughSeq = raw.length > 0
      ? Math.max(...raw.map((m) => (Number.isFinite(m.seq) ? m.seq : 0)), cursor)
      : cursor;
    return {
      messages,
      throughSeq,
      lastReadThroughSeq: state.lastReadThroughSeq ?? 0,
    };
  }

  /**
   * 合并「待读」消息：socialV2 队列（带 seq）优先，其后是兼容用的 runtime.unread。
   * @returns {Array<object>}
   */
  _pendingUnread(key, cursor = 0, limit = 0) {
    const store = this.socialV2;
    const fromStore = store ? store.peekUnread(key, { afterSeq: cursor }) : [];
    const runtime = this.sessionRuntime.get(key);
    const legacy = runtime ? runtime.unread.slice() : [];
    let list = [...fromStore, ...legacy];
    if (limit > 0 && list.length > limit) list = list.slice(-limit);
    return list;
  }

  /** 清空兼容用的 runtime.unread（避免同一条消息被读两次）。 */
  _drainLegacyUnread(key) {
    const runtime = this.sessionRuntime.get(key);
    if (runtime && runtime.unread.length > 0) runtime.unread.splice(0);
  }

  /** 渲染给模型看的未读条目（带相对时间与指向标注）。 */
  _renderModelMessage(m) {
    const rendered = this._renderUnreadMessage(m);
    return { ...m, text: rendered, content: String(m.text ?? ''), relativeTime: formatAge(m.time) };
  }

  /** 没有 v2 时的兜底渲染。 */
  _renderPlainMessage(m) {
    const age = formatAge(m.time);
    const who = m.sender || m.userId || '某人';
    const flag = m.atMe === true ? ' ←@了你' : (m.questionToMe === true ? ' ←向你提问' : '');
    return `${who}（${age}）：${String(m.text ?? '')}${flag}`;
  }

  async _handleInternal(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sendJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    // 控制台页面路由在鉴权之前：HTML 本身不含敏感数据（令牌由页面 JS 用于后续 API 请求），
    // 浏览器顶层导航无法携带自定义请求头，若把页面也拦在鉴权后控制台将完全打不开。
    if (url.pathname === '/' || url.pathname === '/console') {
      const htmlPath = path.join(ROOT, 'public', 'console.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(html);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('控制台页面缺失：public/console.html');
      }
      return;
    }

    // 静态资源（本地 Alpine.js，无外网依赖）
    if (url.pathname === '/alpine.js') {
      try {
        const js = fs.readFileSync(path.join(ROOT, 'public', 'alpine.js'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'X-Alpine-Mode': 'local-v3' });
        res.end(js);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('alpine.js missing');
      }
      return;
    }

    if (!this._authed(req)) {
      sendJson(401, { error: 'unauthorized' });
      return;
    }

    if (url.pathname === '/api/simulation' && req.method === 'GET') {
      sendJson(200, { v1: { enabled: !!this.socialV1, mode: this.config.socialV1?.mode ?? 'off' }, v2: { enabled: !!this.socialV2, mode: this.config.socialV2?.mode ?? 'off' } }); return;
    }
    if (url.pathname === '/api/simulation' && req.method === 'POST') {
      const body = await readJsonBody(req);
      for (const v of ['v1', 'v2']) {
        if (!body[v] || typeof body[v].enabled !== 'boolean' || !['off', v].includes(body[v].mode)) { sendJson(400, { error: '模式参数非法' }); return; }
      }
      const file = this._configPath();
      const raw = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
      for (const v of ['v1', 'v2']) raw[v === 'v1' ? 'socialV1' : 'socialV2'] = { ...raw[v === 'v1' ? 'socialV1' : 'socialV2'], ...body[v] };
      this._writeConfigFile(file, raw);
      this.config.socialV1 = raw.socialV1; this.config.socialV2 = raw.socialV2;
      clearInterval(this.v1LoopTimer);
      if (!body.v1.enabled) { this.socialV1?.save(); this.socialV1 = null; }
      else { this.socialV1 ??= new SocialV1Store(this.stateDir, { limits: raw.socialV1.limits }); this.v1LoopTimer = setInterval(() => this._v1Tick(), 5000); }
      this.wakeScheduler?.stop();
      if (!body.v2.enabled) { this.socialV2?.save(); this.socialV2 = null; this.wakeScheduler = null; }
      else {
        this.socialV2 ??= new SocialV2Store(this.stateDir, { limits: raw.socialV2.limits });
        this.wakeScheduler = new WakeScheduler({ store: this.socialV2, onWake: (key, reason) => this._deliverWakePrompt(key, reason), myName: String(this.config.persona?.name ?? ''), proactiveConfig: this.config.socialV2 });
        for (const key of this.socialV2.keys()) { this.wakeScheduler.setupSleepTimer(key); this.wakeScheduler.scheduleProactiveCheck(key); }
      }
      sendJson(200, { ok: true }); return;
    }

    // ── agent 工具回调端点（x-qq-session 绑定当前会话）──
    if (url.pathname === '/agent/unread' && req.method === 'GET') {
      const key = this._currentSessionKey(req);
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0) || 0;
      const limit = clampInt(Number(url.searchParams.get('limit') ?? 0), 0, 200, 0);
      const result = this._takeUnreadForModel(key, { afterSeq, limit });
      sendJson(200, result);
      return;
    }
    if (url.pathname === '/agent/history' && req.method === 'GET') {
      const key = this._currentSessionKey(req);
      const count = clampInt(Number(url.searchParams.get('count') ?? 20), 1, 50);
      if (!key.startsWith('g')) {
        sendJson(200, { messages: [] });
        return;
      }
      try {
        const messages = await this.bot.getGroupHistory(key.slice(1), count);
        sendJson(200, { messages });
      } catch (error) {
        sendJson(502, { error: error?.message ?? 'get_group_msg_history 失败' });
      }
      return;
    }
    if (url.pathname === '/agent/send' && req.method === 'POST') {
      const key = this._currentSessionKey(req);
      if (!this._sessionSendable(key)) {
        sendJson(403, { error: key ? `会话 ${key} 不在发送白名单内` : '会话上下文缺失（x-qq-session 未设置）' });
        return;
      }
      const body = await readJsonBody(req);
      const messages = Array.isArray(body?.messages) ? body.messages : [String(body?.messages ?? '')];
      const count = Math.min(messages.length, 10);
      // P2-08：统一出站闸门（SILENT / 退场话 / 脱敏）。
      // 过滤**先于**额度预占：被拦下的条目不占额度，未发送路径必须回滚。
      const prepared = [];
      const blocked = [];
      for (const t of messages.slice(0, 10)) {
        const guard = this._guardOutbound(t);
        if (!guard.ok) { blocked.push({ text: String(t).slice(0, 40), reason: guard.blocked }); continue; }
        prepared.push(guard.text);
      }
      if (prepared.length === 0) {
        sendJson(200, { sent: [], blocked, note: blocked.length > 0 ? '内容被出站策略拦截（沉默标记/退场话/空内容）' : '[SILENT]' });
        return;
      }
      // S4：限频预占（与 burst 同一套账本），失败 429——单发不能绕过 maxSendPerMinute/Hour
      let reserved = 0;
      if (this._sendBudget()) {
        const gate = this._sendBudget().reserveSendSlots(key, prepared.length);
        if (!gate.ok) {
          sendJson(429, { error: '发送限频', retryAfterMs: gate.retryAfterMs });
          return;
        }
        reserved = prepared.length;
      }
      const sent = [];
      let failed = false;
      for (const text of prepared) {
        try {
          const res = await this._sendToSession(key, text, undefined, { reserved: true });
          if (res?.blocked) { blocked.push({ text: text.slice(0, 40), reason: res.blocked }); continue; }
          sent.push(text);
          this._recordSendReceipt(key, text);
        } catch (error) {
          failed = true;
          break;
        }
        if (this.config.sendDelayMs > 0) await sleep(this.config.sendDelayMs);
      }
      if ((failed || sent.length < prepared.length) && this._sendBudget()) {
        // 按实际未发送数回滚
        this._sendBudget().releaseSendSlots(key, prepared.length - sent.length);
      }
      sendJson(failed ? 502 : 200, failed ? { error: 'QQ 发送失败', sent, blocked } : { sent, blocked });
      return;
    }
    if (url.pathname === '/agent/reply' && req.method === 'POST') {
      const key = this._currentSessionKey(req);
      if (!this._sessionSendable(key)) {
        sendJson(403, { error: key ? `会话 ${key} 不在发送白名单内` : '会话上下文缺失（x-qq-session 未设置）' });
        return;
      }
      const body = await readJsonBody(req);
      // P2-08：统一出站闸门——引用回复同样不许发沉默标记/退场话
      const guard = this._guardOutbound(body?.text ?? '');
      if (!guard.ok) {
        sendJson(200, { sent: false, blocked: guard.blocked, note: '内容被出站策略拦截（沉默标记/退场话/空内容）' });
        return;
      }
      const messageId = Number(body?.messageId ?? 0);
      try {
        const res = await this._sendToSession(key, guard.text, messageId);
        if (res?.blocked) {
          sendJson(200, { sent: false, blocked: res.blocked, note: '内容被出站策略拦截（沉默标记/退场话）' });
          return;
        }
      } catch (error) {
        // 限频（429）与其它失败区分开——前端要能区分「等一会」和「坏了」
        sendJson(error?.status ?? 502, { error: error?.message ?? 'QQ 发送失败' });
        return;
      }
      this._recordSendReceipt(key, guard.text);
      sendJson(200, { sent: true, text: guard.text });
      return;
    }
    if (url.pathname === '/agent/wait' && req.method === 'POST') {
      const key = this._currentSessionKey(req);
      const body = await readJsonBody(req);
      // 睡前观察（对齐原版长轮询）：AI 回合内挂 wait 等新消息，消息到达立即返回、超时返回空。
      // 观察总时长预算（复刻原版 15 分钟租约的自由度）：每回合 waitBudgetMs=12 分钟，
      // 每次 wait 按实际等待时长扣减；轮数不限——短观察可以多轮，预算用完立即返回空。
      // （等待时间占用回合时长，maxTurnSeconds 需相应放宽。）
      const runtime = this._runtimeFor(key);
      if (runtime.waitBudgetMs === undefined) runtime.waitBudgetMs = 12 * 60 * 1000; // 兜底（正常由回合开始初始化）
      const timeoutSeconds = clampInt(Number(body?.timeoutSeconds ?? 300), 1, 600);
      // 单次等待不超过剩余预算（截断到秒）——预算见底时也允许最后一小段观察
      const effectiveSeconds = Math.max(1, Math.min(timeoutSeconds, Math.floor(runtime.waitBudgetMs / 1000)));
      if (runtime.waitBudgetMs <= 0) {
        sendJson(200, { messages: [], waitBudgetLeftMs: 0, note: '本回合观察时间预算已用完，请用 qq_set_wake_config 收尾' });
        return;
      }
      // 静默窗：收到消息后再静默 8s 才返回（对方连发多条时不抢答）；0 = 立即返回
      const quietMs = clampInt(Number(body?.quietMs ?? 8000), 0, 60000);
      const waitStart = Date.now();
      const raw = await this._waitForMessages(key, effectiveSeconds, quietMs);
      runtime.waitBudgetMs -= (Date.now() - waitStart);
      // F2：观察结果带相对时间与指向标注（模型要知道这条消息有多新、是不是在叫它）
      runtime.responseSeqs = raw.map(m => m.seq).filter(Number.isFinite);
      const messages = raw.map((m) => (this.socialV2 ? this._renderModelMessage(m) : { ...m, text: this._renderPlainMessage(m) }));
      sendJson(200, { messages, waitBudgetLeftMs: Math.max(0, runtime.waitBudgetMs), throughSeq: this._lastThroughSeq(key) });
      return;
    }
    if (url.pathname === '/agent/wake-config' && req.method === 'POST') {
      const key = this._currentSessionKey(req);
      if (!this.socialV2) {
        sendJson(400, { error: '二代仿真未启用' });
        return;
      }
      // 睡前观察硬闸：本回合投喂过未读但模型一次观察都没做就急着收尾 → 409 指引先观察。
      // （对齐原版 preSleepWaitBlockedV2；豁免：上一轮观察超限的 note 已说明可直接收尾——
      //   waitBudgetMs 小于初始预算说明已观察过，放行）
      const rt = this._runtimeFor(key);
      const body = await readJsonBody(req);
      const state = this.socialV2.get(key);
      const c = body ?? {};
      // 睡前观察硬闸：投喂过未读但没做观察，就要「设潜水/定时睡」→ 409 指引先观察。
      // （对齐原版 preSleepWaitBlockedV2。只拦「要睡了」的显式转换；管理 active/触发器等不受影响。
      //   豁免：观察预算用完（waitBudgetMs<=0）说明观察额度用尽，放行。）
      const wantsSleep = c.mode === 'diving' || c.infinite === false;
      if (wantsSleep && rt.hadUnreadThisTurn === true && !(rt.waitBudgetMs !== undefined && rt.waitBudgetMs < 12 * 60 * 1000)) {
        sendJson(409, {
          error: '睡前观察未完成：处理完未读后先调 qq_wait_for_messages(timeoutSeconds=300) 观察一场（有人接话继续陪聊，超时没人说再收尾）',
          canObserve: true,
        });
        return;
      }
      // 触发器列表类型校验：类型错误直接 400，保留原状态（坏类型会让后续 join/评估抛异常）
      if (c.triggers !== undefined) {
        const bad = c.triggers === null || typeof c.triggers !== 'object' || Array.isArray(c.triggers)
          || (c.triggers.keywords !== undefined && !Array.isArray(c.triggers.keywords))
          || (c.triggers.speakerIds !== undefined && !Array.isArray(c.triggers.speakerIds));
        if (bad) {
          sendJson(400, { error: 'triggers 类型非法（keywords/speakerIds 必须为数组）' });
          return;
        }
      }
      const previousWake = structuredClone(state.wakeConfig);
      // 白名单字段合并（防未知字段注入）
      let clampNote = null;
      if (c.mode === 'active' || c.mode === 'diving') state.wakeConfig.mode = c.mode;
      if (typeof c.infinite === 'boolean') state.wakeConfig.infinite = c.infinite;
      if (Number.isFinite(Number(c.sleepUntil))) {
        // 硬钳制：定时睡眠最长 4 小时——防止模型把定时设得过长导致长期失联；
        // 同时套用配置里的「睡眠最短/最长」——QUALITY-REPORT P2-07：
        // 这两个值以前只保存不回显，没有任何执行端消费；现在它们是真实约束。
        const { until, clamped } = this._clampSleepUntil(Number(c.sleepUntil));
        state.wakeConfig.sleepUntil = until;
        if (clamped) clampNote = `睡眠时长已按配置的最小/最大值调整为${clamped}`;
      }
      // 模式归一：有定时睡眠的必须是 diving（消灭 active+定时 的 UI 盲区组合）
      if (state.wakeConfig.infinite === false && state.wakeConfig.mode !== 'diving') {
        state.wakeConfig.mode = 'diving';
      }
      if (c.triggers && typeof c.triggers === 'object') {
        const t = state.wakeConfig.triggers;
        for (const k of ['nameMention', 'question', 'poke', 'anyMessage']) {
          if (typeof c.triggers[k] === 'boolean') t[k] = c.triggers[k];
        }
        if (Array.isArray(c.triggers.keywords)) t.keywords = c.triggers.keywords.map((x) => String(x).slice(0, 40)).slice(0, 20);
        if (Array.isArray(c.triggers.speakerIds)) t.speakerIds = c.triggers.speakerIds.map((x) => String(x).replace(/\D/g, '')).filter(Boolean).slice(0, 50);
        if (Number.isFinite(Number(c.triggers.probability))) t.probability = Math.min(1, Math.max(0, Number(c.triggers.probability)));
      }
      // 硬钳制：atMention 是最后的保险丝，潜水时强制开启不可关闭（模型无法让用户失联）
      if (c.triggers && typeof c.triggers === 'object' && typeof c.triggers.atMention === 'boolean' && c.triggers.atMention === false) {
        state.wakeConfig.mode = 'diving';
        state.wakeConfig.triggers.atMention = true;
      } else if (state.wakeConfig.mode === 'diving') {
        state.wakeConfig.triggers.atMention = true;
      }
      if (Number.isFinite(Number(c.batchWindowMs))) state.wakeConfig.batchWindowMs = clampInt(Number(c.batchWindowMs), 1000, 60000, 8000);
      const saved = this.socialV2.save();
      if (!saved) {
        state.wakeConfig = previousWake;
        sendJson(500, { ok: false, error: '保存二代状态失败（磁盘写入失败），运行态未提交' });
        return;
      }
      this.wakeScheduler?.noteAction(key);
      if (state.wakeConfig.infinite === false) {
        this.wakeScheduler.setupSleepTimer(key);
      } else {
        this.wakeScheduler.clearSleepTimer(key);
      }
      sendJson(200, { ok: true, wakeConfig: state.wakeConfig, note: clampNote ?? undefined });
      return;
    }
    if (url.pathname === '/agent/mark-read' && req.method === 'POST') {
      const key = this._currentSessionKey(req);
      if (!this.socialV2) {
        sendJson(400, { error: '二代仿真未启用' });
        return;
      }
      // 睡前观察硬闸（同 wake-config）：投喂过未读但没观察就收尾 → 409 指引
      // 豁免：观察预算已动用过（waitBudgetMs < 满额）说明至少做过一场观察
      const rt = this._runtimeFor(key);
      if (rt.hadUnreadThisTurn === true && !(rt.waitBudgetMs !== undefined && rt.waitBudgetMs < 12 * 60 * 1000)) {
        sendJson(409, {
          error: '睡前观察未完成：先调 qq_wait_for_messages(timeoutSeconds=300) 观察一场再确认已读收尾',
          canObserve: true,
        });
        return;
      }
      const body = await readJsonBody(req);
      // P1-02：已读只推进「已读水位」，不等于「已回应」——
      // 显式请求是否回应由实际发送回执判定（见 _runWakeTurn）。
      const readSeq = this.socialV2.markRead(key, Number(body?.seq ?? 0), { tool: String(body?.tool ?? 'qq_mark_read') });
      this.wakeScheduler?.noteAction(key);
      sendJson(200, {
        ok: true,
        lastReadThroughSeq: readSeq,
        shownSeq: this.socialV2.get(key).shownSeq ?? 0,
        handledSeq: this.socialV2.get(key).handledSeq ?? 0,
      });
      return;
    }
    if (url.pathname === '/agent/memory' && req.method === 'POST') {
      const key = this._currentSessionKey(req);
      if (!this.socialV2) {
        sendJson(400, { error: '二代仿真未启用' });
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body?.action ?? 'append');
      let result;
      if (action === 'append') result = this.socialV2.appendMemory(key, body);
      else if (action === 'remove') result = this.socialV2.removeMemory(key, body);
      else if (action === 'clear') result = this.socialV2.clearMemory(key, body);
      else result = { ok: false, error: `未知 action: ${action}` };
      if (result.ok) {
        this.socialV2.save();
        this.wakeScheduler?.noteAction(key);
      }
      sendJson(result.ok ? 200 : 400, result);
      return;
    }
    if (url.pathname === '/agent/memory' && req.method === 'GET') {
      const key = this._currentSessionKey(req);
      if (!this.socialV2) {
        sendJson(400, { error: '二代仿真未启用' });
        return;
      }
      sendJson(200, { memory: this.socialV2.formatMemory(key) });
      return;
    }
    if (url.pathname === '/agent/burst' && req.method === 'POST') {
      const key = this._currentSessionKey(req);
      if (!this._sessionSendable(key)) {
        sendJson(403, { error: key ? `会话 ${key} 不在发送白名单内` : '会话上下文缺失（x-qq-session 未设置）' });
        return;
      }
      const body = await readJsonBody(req);
      // P2-08：统一出站闸门——burst 里的沉默标记/退场话条目先剔除，再校验/预占额度
      const blocked = [];
      const burstInput = [];
      for (const t of (Array.isArray(body?.messages) ? body.messages : [])) {
        const guard = this._guardOutbound(t);
        if (!guard.ok) { blocked.push({ text: String(t).slice(0, 40), reason: guard.blocked }); continue; }
        burstInput.push(guard.text);
      }
      if (burstInput.length === 0) {
        // 全部被出站策略拦下：正常返回「没发」，不是 400（模型不该因此报错重试）
        sendJson(200, { sent: [], blocked, note: '内容被出站策略拦截（沉默标记/退场话/空内容）' });
        return;
      }
      const plan = planBurst(burstInput, { gapMode: body?.gapMode, limits: this.socialV2?.limits });
      if (!plan.ok) {
        sendJson(400, { error: plan.error });
        return;
      }
      if (plan.messages.length === 0) {
        sendJson(200, { sent: [], blocked, note: '内容被出站策略拦截（沉默标记/退场话/空内容）' });
        return;
      }
      // 限频预占（失败回滚）
      const gate = this._sendBudget().reserveSendSlots(key, plan.messages.length);
      if (gate && !gate.ok) {
        sendJson(429, { error: '发送限频', retryAfterMs: gate.retryAfterMs });
        return;
      }
      const sent = [];
      try {
        for (let i = 0; i < plan.messages.length; i++) {
          const safe = plan.messages[i];
          if (!safe) continue;
          const res = await this._sendToSession(key, safe, undefined, { reserved: true });
          if (res?.blocked) { blocked.push({ text: String(safe).slice(0, 40), reason: res.blocked }); continue; }
          sent.push(safe);
          this._recordSendReceipt(key, safe);
          if (i < plan.gaps.length) await sleep(plan.gaps[i]);
        }
        if (this.socialV2) {
          const state = this.socialV2.get(key);
          state.lastAiReplyAt = Date.now();
          state.lastAiReplyWasQuestion = /[?？]\s*$/.test(String(plan.messages[plan.messages.length - 1] ?? ''));
          this.socialV2.save();
          // 回复检查：30s 后回看有没有人接（与 send/reply/兜底同一策略，QUALITY-REPORT P2-09）
          const lastMsg = plan.messages[plan.messages.length - 1] ?? '';
          this.wakeScheduler?.scheduleReplyCheck(key, { wasQuestion: /[?？]\s*$/.test(String(lastMsg)), wasBurst: plan.messages.length > 1 });
        }
        sendJson(200, { sent, blocked });
      } catch (error) {
        // M6：按实际未发送数回滚（原 _sentCount 从未定义，恒释放全部）
        this._sendBudget().releaseSendSlots(key, Math.max(0, plan.messages.length - (sent?.length ?? 0)));
        sendJson(502, { error: error?.message ?? '发送失败', sent, blocked });
      }
      return;
    }
    if (url.pathname === '/agent/v2-status' && req.method === 'GET') {
      const key = this._currentSessionKey(req);
      if (!this.socialV2) {
        sendJson(400, { error: '二代仿真未启用' });
        return;
      }
      const state = this.socialV2.get(key);
      sendJson(200, {
        key,
        wakeConfig: state.wakeConfig,
        unreadCount: state.unread.length,
        lastReadThroughSeq: state.lastReadThroughSeq,
        noActionCount: state.noActionCount,
        memory: this.socialV2.formatMemory(key),
      });
      return;
    }
    if (url.pathname === '/agent/status' && req.method === 'GET') {
      const key = this._currentSessionKey(req);
      const runtime = this.sessionRuntime.get(key);
      sendJson(200, {
        sessionKey: key,
        type: key.startsWith('g') ? 'group' : 'private',
        unread: runtime?.unread.length ?? 0,
        busy: this.sessionManager?.has(key) ? (await this.sessionManager.get(key)).isBusy() : false,
      });
      return;
    }

    if (url.pathname === '/api/runtime' && req.method === 'GET') {
      sendJson(200, {
        ok: true,
        runtime: {
          ackMessage: this.config.ackMessage ?? '',
          sendDelayMs: this.config.sendDelayMs ?? 800,
          maxTurnSeconds: this.config.maxTurnSeconds ?? 300,
          historyMaxMessages: this.config.history?.maxMessages ?? 120,
          historySummarize: this.config.history?.summarize !== false,
          internalHost: this.internalHost ?? this.config.internalHost ?? '127.0.0.1',
          internalPort: this.internalPort,
          wsUrl: this.config.qq?.wsUrl ?? '',
          httpUrl: this.config.qq?.httpUrl ?? '',
        },
      });
      return;
    }
    if (url.pathname === '/api/runtime' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const configPath = this._configPath();
      try {
        const raw = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8')));
        // 白名单字段：只接受这几项运行参数（其余需改 config 重启）
        // P2-10：先算候选 → 落盘 → 再提交内存（落盘失败内存完全不动）
        const candidate = {};
        if (body.ackMessage !== undefined) candidate.ackMessage = String(body.ackMessage ?? '').slice(0, 200);
        if (Number.isFinite(Number(body.sendDelayMs))) candidate.sendDelayMs = clampInt(Number(body.sendDelayMs), 0, 60000, 800);
        if (Number.isFinite(Number(body.maxTurnSeconds))) candidate.maxTurnSeconds = clampInt(Number(body.maxTurnSeconds), 30, 3600, 300);
        if (Number.isFinite(Number(body.historyMaxMessages))) candidate.historyMaxMessages = clampInt(Number(body.historyMaxMessages), 20, 1000, 120);
        if (typeof body.historySummarize === 'boolean') candidate.historySummarize = body.historySummarize;

        if (candidate.ackMessage !== undefined) raw.ackMessage = candidate.ackMessage;
        if (candidate.sendDelayMs !== undefined) raw.sendDelayMs = candidate.sendDelayMs;
        if (candidate.maxTurnSeconds !== undefined) raw.maxTurnSeconds = candidate.maxTurnSeconds;
        if (candidate.historyMaxMessages !== undefined) raw.history = { ...(raw.history ?? {}), maxMessages: candidate.historyMaxMessages };
        if (candidate.historySummarize !== undefined) raw.history = { ...(raw.history ?? {}), summarize: candidate.historySummarize };

        this._writeConfigFile(configPath, raw);
        // 落盘成功 → 提交运行态

        if (candidate.ackMessage !== undefined) this.config.ackMessage = candidate.ackMessage;
        if (candidate.sendDelayMs !== undefined) this.config.sendDelayMs = candidate.sendDelayMs;
        if (candidate.maxTurnSeconds !== undefined) {
          this.config.maxTurnSeconds = candidate.maxTurnSeconds;
          this.sessionManager?.applyRuntimeLimits({ maxTurnSeconds: candidate.maxTurnSeconds });
        }
        if (candidate.historyMaxMessages !== undefined) {
          this.config.history ??= {};
          this.config.history.maxMessages = candidate.historyMaxMessages;
          this.sessionManager?.applyRuntimeLimits({ maxMessages: candidate.historyMaxMessages });
        }
        if (candidate.historySummarize !== undefined) {
          this.config.history ??= {};
          this.config.history.summarize = candidate.historySummarize;
          this.sessionManager?.applyRuntimeLimits({ summarize: candidate.historySummarize });
        }
        sendJson(200, { ok: true, note: '已保存并即时生效（已开始的回合不追溯，下一个回合起按新值）' });
      } catch (error) {
        sendJson(400, { ok: false, error: error?.message ?? '写 config 失败（运行态未变更）' });
      }
      return;
    }

    if (url.pathname === '/api/model' && req.method === 'GET') {
      const m = this.config.model ?? {};
      const key = String(m.apiKey ?? '');
      sendJson(200, {
        ok: true,
        model: {
          provider: m.provider ?? 'deepseek',
          model: m.model ?? '',
          baseUrl: m.baseUrl ?? '',
          apiKeyMasked: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '',
          hasApiKey: key.length > 0,
          thinkingLevel: m.thinkingLevel ?? 'off',
          maxTokens: m.maxTokens ?? 2048,
        },
        builtins: ['deepseek-flash', 'deepseek-v4-pro'],
      });
      return;
    }
    if (url.pathname === '/api/model' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const configPath = this._configPath();
      try {
        const raw = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8')));
        raw.model ??= {};
        const m = { ...this.config.model };
        // 白名单字段校验
        if (body.provider !== undefined) {
          const p = String(body.provider).trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
          if (!p) throw new Error('provider 非法');
          raw.model.provider = p;
          m.provider = p;
        }
        if (body.model !== undefined) {
          const mid = String(body.model).trim().slice(0, 120);
          if (!mid) throw new Error('model 非法');
          raw.model.model = mid;
          m.model = mid;
        }
        if (body.baseUrl !== undefined) {
          const url = String(body.baseUrl).trim();
          if (url && !/^https?:\/\//.test(url)) throw new Error('baseUrl 必须 http(s)://');
          // 语义明确（P2-10）：baseUrl 传空串 = **显式清空**（不是「保留旧值」）
          raw.model.baseUrl = url;
          m.baseUrl = url;
        }
        let keepApiKey = false;
        if (body.apiKey !== undefined) {
          const key = String(body.apiKey).trim();
          if (key.length > 0) {
            raw.model.apiKey = key;
            m.apiKey = key;
            this.knownTokens.add(key); // 新 key 进脱敏名单
          } else {
            // 语义明确（P2-10）：apiKey 传空串 = **保留旧 key**（控制台脱敏提交场景）
            keepApiKey = true;
          }
        }
        if (body.thinkingLevel !== undefined) {
          const level = String(body.thinkingLevel);
          if (!['off', 'minimal', 'low', 'medium', 'high'].includes(level)) throw new Error('thinkingLevel 非法');
          raw.model.thinkingLevel = level;
          m.thinkingLevel = level;
        }
        if (Number.isFinite(Number(body.maxTokens))) {
          raw.model.maxTokens = clampInt(Number(body.maxTokens), 64, 32768, 2048);
          m.maxTokens = raw.model.maxTokens;
        }
        // 先验证新配置可用，再落盘（避免写了配置但模型根本加载不了）
        const { createSessionAgent } = await import('./pi-host.js');
        await createSessionAgent({ modelConfig: m, systemPrompt: '' });
        this._writeConfigFile(configPath, raw);

        // 落盘成功 → 提交运行态
        this.config.model = m;
        const result = await this.sessionManager?.reconfigure({
          modelConfig: {
            baseUrl: m.baseUrl,
            provider: m.provider,
            model: m.model,
            apiKey: m.apiKey || process.env.DEEPSEEK_API_KEY,
            thinkingLevel: m.thinkingLevel,
            maxTokens: m.maxTokens,
            keepApiKey,
          },
          systemPrompt: loadSystemPrompt(this.config, this.rootDir),
        });
        sendJson(200, {
          ok: true,
          model: { provider: m.provider, model: m.model, baseUrl: m.baseUrl, thinkingLevel: m.thinkingLevel, maxTokens: m.maxTokens },
          note: (result?.pending ? `已保存，${result.pending} 个会话待回合结束生效` : '已保存并生效') + (keepApiKey ? '（API Key 保留原值）' : ''),
          version: result?.version ?? null,
          applied: result?.applied ?? 0,
          pendingSessions: result?.pending ?? 0,
        });
      } catch (error) {
        // P2-10：失败必须非 2xx，且运行态完全不变
        sendJson(400, { ok: false, error: error?.message ?? '写 config 失败（运行态未变更）' });
      }
      return;
    }

    // ── 控制台：二代仿真 ──
    if (url.pathname === '/api/socialv2/states' && req.method === 'GET') {
      if (!this.socialV2) {
        sendJson(200, { ok: true, enabled: false, states: [] });
        return;
      }
      const states = this.socialV2.keys().map((key) => {
        const s = this.socialV2.get(key);
        const t = s.wakeConfig.triggers ?? {};
        const wakeable = t.atMention === true || t.nameMention === true || t.question === true
          || t.poke === true || t.anyMessage === true || Number(t.probability) > 0
          || (Array.isArray(t.keywords) && t.keywords.length > 0)
          || (Array.isArray(t.speakerIds) && t.speakerIds.length > 0);
        return {
          key,
          mode: s.wakeConfig.mode,
          infinite: s.wakeConfig.infinite,
          sleepUntil: s.wakeConfig.sleepUntil,
          hasTimer: s.wakeConfig.infinite === false && s.wakeConfig.sleepUntil > Date.now(),
          wakeable,
          triggers: {
            atMention: t.atMention === true,
            nameMention: t.nameMention === true,
            question: t.question === true,
            poke: t.poke === true,
            anyMessage: t.anyMessage === true,
            keywords: Array.isArray(t.keywords) ? t.keywords.length : 0,
            speakerIds: Array.isArray(t.speakerIds) ? t.speakerIds.length : 0,
            probability: Number(t.probability) || 0,
          },
          unreadCount: s.unread.length,
          noActionCount: s.noActionCount,
          wakeCount: s.wakeCount,
          topics: s.activeTopics.length,
          thoughts: s.pendingThoughts.length,
          impressions: Object.keys(s.memberImpressions).length,
          lastIncomingAt: s.lastIncomingAt,
          lastAiReplyAt: s.lastAiReplyAt,
        };
      });
      sendJson(200, { ok: true, enabled: true, states });
      return;
    }
    if (url.pathname === '/api/socialv2/wake' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = this.manualWake(String(body?.sessionKey ?? ''), String(body?.reason ?? 'manual'));
      sendJson(r.status ?? 200, { ok: r.woke === true, ...r });
      return;
    }
    if (url.pathname === '/api/socialv2/state' && req.method === 'GET') {
      const key = String(url.searchParams.get('key') ?? '');
      if (!this.socialV2 || !this.socialV2.has(key)) {
        sendJson(404, { ok: false, error: '会话无二代状态' });
        return;
      }
      const s = this.socialV2.get(key);
      sendJson(200, {
        ok: true,
        key,
        lastConsoleAction: s.lastConsoleAction ?? null,
        wakeConfig: s.wakeConfig,
        initialPrompt: s.initialPrompt ?? '',
        unread: s.unread.map(({ seq, sender, userId, text, time, messageId, atMe, questionToMe }) => ({ seq, sender, userId, text, time, messageId, atMe, questionToMe })),
        recentMessages: s.recentMessages.slice(-30).map(({ seq, sender, text, time, messageId }) => ({ seq, sender, text, time, messageId })),
        memory: this.socialV2.formatMemory(key),
        lastReadThroughSeq: s.lastReadThroughSeq,
        noActionCount: s.noActionCount,
        wakeCount: s.wakeCount,
      });
      return;
    }
    if (url.pathname === '/api/socialv2/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const key = String(body?.sessionKey ?? '');
      if (!this.socialV2 || !this.socialV2.has(key)) {
        sendJson(404, { ok: false, error: '会话无二代状态' });
        return;
      }
      const s = this.socialV2.get(key);
      if (body?.wakeConfig && typeof body.wakeConfig === 'object') {
        const c = body.wakeConfig;
        const t = c.triggers;
        if (Array.isArray(c) || (c.mode !== undefined && !['active', 'diving'].includes(c.mode)) ||
            (c.infinite !== undefined && typeof c.infinite !== 'boolean') ||
            (c.batchWindowMs !== undefined && (!Number.isFinite(c.batchWindowMs) || c.batchWindowMs < 0 || c.batchWindowMs > 60000)) ||
            (t !== undefined && (!t || typeof t !== 'object' || Array.isArray(t) ||
              ['atMention', 'nameMention', 'question', 'poke', 'anyMessage'].some(k => t[k] !== undefined && typeof t[k] !== 'boolean') ||
              ['keywords', 'speakerIds'].some(k => t[k] !== undefined && (!Array.isArray(t[k]) || t[k].some(v => typeof v !== 'string'))) ||
              (t.probability !== undefined && (!Number.isFinite(t.probability) || t.probability < 0 || t.probability > 1))))) {
          sendJson(400, { error: '唤醒配置字段类型或范围非法' }); return;
        }
        if (body.wakeConfig.infinite === false && (!Number.isFinite(body.wakeConfig.sleepUntil) || body.wakeConfig.sleepUntil <= Date.now())) {
          sendJson(400, { error: '定时唤醒必须是未来时间' }); return;
        }
        const candidate = {
          ...s.wakeConfig,
          ...body.wakeConfig,
          triggers: { ...s.wakeConfig.triggers, ...(body.wakeConfig.triggers ?? {}) },
        };
        // P2-07：控制台设定的睡眠同样受「最短/最长睡眠」硬钳制
        if (Number.isFinite(Number(body.wakeConfig.sleepUntil)) && Number(body.wakeConfig.sleepUntil) > 0) {
          const { until, clamped } = this._clampSleepUntil(Number(body.wakeConfig.sleepUntil));
          candidate.sleepUntil = until;
          if (clamped) body.__clampNote = `睡眠时长已调整为${clamped}`;
        }
        const previousWake = s.wakeConfig;
        const previousAction = s.lastConsoleAction;
        s.wakeConfig = candidate;
        s.lastConsoleAction = { at: Date.now(), text: s.wakeConfig.infinite === false ? '已设定定时唤醒' : '已更新配置；当前无定时任务' };
        const saved = this.socialV2.save();
        if (!saved) {
          s.wakeConfig = previousWake;
          s.lastConsoleAction = previousAction;
          sendJson(500, { ok: false, error: '保存二代状态失败（磁盘写入失败），运行态未提交' });
          return;
        }
        if (s.wakeConfig.infinite === false) this.wakeScheduler?.setupSleepTimer(key);
        else this.wakeScheduler?.clearSleepTimer(key);
        sendJson(200, { ok: true, wakeConfig: s.wakeConfig, note: body.__clampNote ?? undefined });
        return;
      }
      sendJson(200, { ok: true, wakeConfig: s.wakeConfig });
      return;
    }
    if (url.pathname === '/api/socialv2/initial-prompt' && req.method === 'POST') {
      // 会话初始提示词：预写圈子背景/氛围/忌讳，下次首次唤醒注入一次
      const body = await readJsonBody(req);
      const key = String(body?.sessionKey ?? '');
      if (!this.socialV2 || !this.socialV2.has(key)) {
        sendJson(404, { ok: false, error: '会话无二代状态' });
        return;
      }
      const s = this.socialV2.get(key);
      const text = String(body?.initialPrompt ?? '').trim().slice(0, 2000);
      const prevPrompt = s.initialPrompt;
      const prevBootstrap = s.bootstrapSent;
      s.initialPrompt = text;
      if (text) s.bootstrapSent = false; // 有新背景 → 下次唤醒重新注入
      s.lastConsoleAction = { at: Date.now(), text: text ? '已更新会话初始提示词' : '已清空会话初始提示词' };
      // P2-10：持久化失败必须是非 2xx，且不提交运行态（内存与文件保持一致）
      if (!this.socialV2.save()) {
        s.initialPrompt = prevPrompt;
        s.bootstrapSent = prevBootstrap;
        sendJson(500, { ok: false, error: '保存二代状态失败（磁盘写入失败），运行态未提交' });
        return;
      }
      sendJson(200, { ok: true, initialPrompt: s.initialPrompt });
      return;
    }
    if (url.pathname === '/api/socialv2/initial-prompt' && req.method === 'GET') {
      const key = String(new URL(req.url ?? '/', 'http://localhost').searchParams.get('key') ?? '');
      if (!this.socialV2 || !this.socialV2.has(key)) {
        sendJson(404, { ok: false, error: '会话无二代状态' });
        return;
      }
      sendJson(200, { ok: true, initialPrompt: this.socialV2.get(key).initialPrompt ?? '' });
      return;
    }
    if (url.pathname === '/api/socialv2/activity' && req.method === 'GET') {
      sendJson(200, { ok: true, activity: this.v2Activity.slice(-100).reverse() });
      return;
    }
    if (url.pathname === '/api/socialv2/schedule' && req.method === 'GET') {
      if (!this.socialV2) {
        sendJson(200, { ok: false, enabled: false });
        return;
      }
      const L = this.socialV2.limits;
      sendJson(200, {
        ok: true,
        schedule: {
          proactiveMinMs: this.config.socialV2?.proactiveMinMs ?? 30 * 60 * 1000,
          proactiveMaxMs: this.config.socialV2?.proactiveMaxMs ?? 90 * 60 * 1000,
          sleepMinMs: this.config.socialV2?.sleepMinMs ?? 60 * 1000,
          sleepMaxMs: this.config.socialV2?.sleepMaxMs ?? 120 * 60 * 1000,
          batchWindowMs: this.config.socialV2?.batchWindowMs ?? DEFAULT_WAKE_CONFIG.batchWindowMs,
          burstMaxMessages: L.burstMaxMessages,
          // 分档唤醒限频（QUALITY-REPORT P1-01）
          maxWakePerMinute: L.maxWakePerMinute,
          maxWakePerHour: L.maxWakePerHour,
          maxDirectWakePerMinute: L.maxDirectWakePerMinute,
          maxDirectWakePerHour: L.maxDirectWakePerHour,
          maxFollowUpWakePerMinute: L.maxFollowUpWakePerMinute,
          maxFollowUpWakePerHour: L.maxFollowUpWakePerHour,
          maxProactiveWakePerMinute: L.maxProactiveWakePerMinute,
          maxProactiveWakePerHour: L.maxProactiveWakePerHour,
          followUpWindowMs: L.followUpWindowMs,
          staleChatMs: L.staleChatMs,
          maxSendPerMinute: L.maxSendPerMinute,
          maxSendPerHour: L.maxSendPerHour,
        },
      });
      return;
    }
    if (url.pathname === '/api/socialv2/schedule' && req.method === 'POST') {
      if (!this.socialV2) {
        sendJson(400, { ok: false, error: '二代仿真未启用' });
        return;
      }
      const body = await readJsonBody(req);
      const configPath = this._configPath();
      try {
        const raw = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8')));
        raw.socialV2 ??= {};
        // 运行态即时生效（限频在 store.limits 上）
        const L = this.socialV2.limits;
        const numFields = [
          ['batchWindowMs', 1000, 60000],
          ['proactiveMinMs', 5 * 60 * 1000, 24 * 3600 * 1000],
          ['proactiveMaxMs', 5 * 60 * 1000, 24 * 3600 * 1000],
          ['sleepMinMs', 30 * 1000, 24 * 3600 * 1000],
          ['sleepMaxMs', 30 * 1000, 24 * 3600 * 1000],
        ];
        // 先算出**候选值**，落盘成功后才提交内存（P2-10：内存与文件不得分叉）
        const candidate = {};
        for (const [field, min, max] of numFields) {
          if (Number.isFinite(Number(body[field]))) {
            candidate[field] = clampInt(Number(body[field]), min, max, min);
          }
        }
        // P2-07/P2-10：最小值不得大于最大值（否则「最短/最长睡眠」互相矛盾）
        const curMin = candidate.sleepMinMs ?? Number(raw.socialV2.sleepMinMs ?? this.config.socialV2?.sleepMinMs ?? 60 * 1000);
        const curMax = candidate.sleepMaxMs ?? Number(raw.socialV2.sleepMaxMs ?? this.config.socialV2?.sleepMaxMs ?? 120 * 60 * 1000);
        if (curMin > curMax) {
          sendJson(400, { ok: false, error: '睡眠最短时间不得大于最长时间' });
          return;
        }
        const proMin = candidate.proactiveMinMs ?? Number(raw.socialV2.proactiveMinMs ?? this.config.socialV2?.proactiveMinMs ?? 30 * 60 * 1000);
        const proMax = candidate.proactiveMaxMs ?? Number(raw.socialV2.proactiveMaxMs ?? this.config.socialV2?.proactiveMaxMs ?? 90 * 60 * 1000);
        if (proMin > proMax) {
          sendJson(400, { ok: false, error: '巡逻最短间隔不得大于最长间隔' });
          return;
        }
        const limitCandidate = {};
        for (const f of ['maxWakePerMinute', 'maxWakePerHour', 'maxSendPerMinute', 'maxSendPerHour', 'burstMaxMessages',
          'maxDirectWakePerMinute', 'maxDirectWakePerHour', 'maxFollowUpWakePerMinute', 'maxFollowUpWakePerHour',
          'maxProactiveWakePerMinute', 'maxProactiveWakePerHour']) {
          if (Number.isFinite(Number(body[f]))) {
            limitCandidate[f] = clampInt(Number(body[f]), 1, 1000, L[f] ?? 1);
          }
        }
        // 落盘（原子写）——失败则内存完全不动
        raw.socialV2 = { ...raw.socialV2, ...candidate, limits: { ...(raw.socialV2.limits ?? {}), ...limitCandidate } };
        this._writeConfigFile(configPath, raw);
        // 提交运行态
        this.config.socialV2 = { ...(this.config.socialV2 ?? {}), ...candidate, limits: { ...(this.config.socialV2?.limits ?? {}), ...limitCandidate } };
        for (const [k, v] of Object.entries(limitCandidate)) L[k] = v;
        for (const key of this.socialV2.keys()) {
          if (candidate.batchWindowMs !== undefined) this.socialV2.get(key).wakeConfig.batchWindowMs = candidate.batchWindowMs;
          this.wakeScheduler.scheduleProactiveCheck(key);
        }
        this.socialV2.save();
        sendJson(200, { ok: true, schedule: raw.socialV2, limits: L });
      } catch (error) {
        sendJson(500, { ok: false, error: error?.message ?? '写 config 失败（运行态未变更）' });
      }
      return;
    }
    if (url.pathname === '/api/socialv2/memory' && req.method === 'POST') {
      // 记忆编辑（控制台）：append / remove / clear
      const body = await readJsonBody(req);
      const key = String(body?.sessionKey ?? '');
      if (!this.socialV2 || !this.socialV2.has(key)) {
        sendJson(404, { ok: false, error: '会话无二代状态' });
        return;
      }
      const action = String(body?.action ?? 'append');
      let result;
      if (action === 'append') result = this.socialV2.appendMemory(key, body);
      else if (action === 'remove') result = this.socialV2.removeMemory(key, body);
      else if (action === 'clear') result = this.socialV2.clearMemory(key, body);
      else result = { ok: false, error: `未知 action: ${action}` };
      if (result.ok) this.socialV2.save();
      sendJson(result.ok ? 200 : 400, { ok: result.ok, error: result.error, memory: this.socialV2.formatMemory(key) });
      return;
    }
    if (url.pathname === '/api/socialv2/reset' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const key = String(body?.sessionKey ?? '');
      if (!this.socialV2) {
        sendJson(400, { ok: false, error: '二代仿真未启用' });
        return;
      }
      const rt = this.wakeScheduler?._runtime(key);
      if (rt) {
        for (const h of rt.timers.values()) clearTimeout(h);
        if (rt.batchHandle) clearTimeout(rt.batchHandle);
        this.wakeScheduler.runtimes.delete(key);
      }
      const had = this.socialV2.delete(key);
      this.socialV2.save();
      this._v2Log(key, '控制台重置二代状态');
      sendJson(200, { ok: true, had });
      return;
    }

    // ── 控制台：一代仿真 ──
    if (url.pathname === '/api/socialv1/states' && req.method === 'GET') {
      if (!this.socialV1) {
        sendJson(200, { ok: true, enabled: false, states: [], pendingSummaries: {} });
        return;
      }
      const states = [];
      const pendingSummaries = {};
      const keys = new Set([...this.socialV1.states.keys(), ...this.socialV1.recentMessages.keys()]);
      for (const key of keys) {
        const st = this.socialV1.state(key);
        states.push({
          key,
          phase: st.phase,
          lastActiveMessageAt: st.lastActiveMessageAt || null,
          activeDeadlineAt: st.activeDeadlineAt || null,
          lastAiReplyAt: st.lastAiReplyAt || null,
          activeEnteredAt: st.activeEnteredAt || null,
        });
        const entry = this.socialV1.pendingSummaries.get(key);
        pendingSummaries[key] = entry ? entry.items.length : 0;
      }
      sendJson(200, { ok: true, enabled: true, states, pendingSummaries, config: this.socialV1.limits });
      return;
    }
    if (url.pathname === '/api/socialv1/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!this.socialV1) {
        sendJson(400, { ok: false, error: '一代仿真未启用' });
        return;
      }
      const configPath = this._configPath();
      try {
        const raw = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8')));
        raw.socialV1 ??= {};
        const clean = {};
        for (const [f, min, max] of [['triggerProbability',0,1],['skipProbability',0,1],['idleRetryProbability',0,1],['contextWindow',1,100],['idleWindowMs',1000,86400000],['maxReplyChars',1,4000]]) {
          if (body[f] !== undefined) { if (!Number.isFinite(Number(body[f]))) throw new Error(f + ' 非法'); clean[f] = Math.min(max, Math.max(min, Number(body[f]))); }
        }
        if (Array.isArray(body.mustReplyKeywords)) clean.mustReplyKeywords = body.mustReplyKeywords.map(x => String(x).slice(0,40)).slice(0,30);
        Object.assign(body, clean);
        raw.socialV1.limits = { ...raw.socialV1.limits, ...clean };
        // P2-10：先落盘再提交内存（写失败则运行态不变）
        this._writeConfigFile(configPath, raw);
        // 运行态即时生效（只接受白名单数值字段）
        const L = this.socialV1.limits;
        const numFields = ['triggerProbability', 'skipProbability', 'contextWindow', 'idleWindowMs', 'idleRetryProbability', 'maxReplyChars'];
        for (const f of numFields) {
          if (Number.isFinite(Number(body[f]))) L[f] = Number(body[f]);
        }
        if (Array.isArray(body.mustReplyKeywords)) {
          L.mustReplyKeywords = body.mustReplyKeywords.map((x) => String(x).slice(0, 40)).slice(0, 30);
        }
        sendJson(200, { ok: true, config: L });
      } catch (error) {
        sendJson(500, { ok: false, error: error?.message ?? '写 config 失败（运行态未变更）' });
      }
      return;
    }
    if (url.pathname === '/api/socialv1/activity' && req.method === 'GET') {
      sendJson(200, { ok: true, activity: this.v1Activity.slice(-100).reverse() });
      return;
    }
    if (url.pathname === '/api/socialv1/state' && req.method === 'POST') {
      // 手动设相位（对齐旧版 /api/social/state）
      const body = await readJsonBody(req);
      const key = String(body?.sessionKey ?? '');
      const phase = String(body?.phase ?? '');
      if (!this.socialV1) {
        sendJson(400, { ok: false, error: '一代仿真未启用' });
        return;
      }
      if (!['idle', 'active'].includes(phase)) {
        sendJson(400, { ok: false, error: 'phase 只支持 idle | active' });
        return;
      }
      if (phase === 'active') {
        this.socialV1.enterActive(key);
      } else {
        this.socialV1.leaveActive(key);
      }
      this.socialV1.save();
      this._v1Log(key, `控制台手动设相位 → ${phase}`);
      sendJson(200, { ok: true, phase });
      return;
    }
    if (url.pathname === '/api/socialv1/flush' && req.method === 'POST') {
      // 立刻投喂观望期攒的摘要（对齐旧版 /api/social/flush）
      const body = await readJsonBody(req);
      const key = String(body?.sessionKey ?? '');
      if (!this.socialV1) {
        sendJson(400, { ok: false, error: '一代仿真未启用' });
        return;
      }
      if (!this.socialV1.hasSummaries(key)) {
        sendJson(200, { ok: false, error: '该会话没有待投喂的摘要' });
        return;
      }
      const seen = this.socialV1.drainSummaries(key);
      this._enqueueV1Turn(key, this._buildBatchPromptV1(key, seen, true), []);
      this._v1Log(key, `控制台手动投喂 ${seen.length} 条摘要`);
      sendJson(200, { ok: true, fed: seen.length });
      return;
    }

    if (url.pathname === '/agent/groups' && req.method === 'GET') {
      try {
        const groups = await this.bot.call('get_group_list', {}, { timeoutMs: 10000 });
        const list = (Array.isArray(groups) ? groups : []).map((g) => ({
          groupId: String(g.group_id ?? ''),
          groupName: g.group_name ?? '',
          memberCount: g.member_count ?? null,
        }));
        sendJson(200, { groups: list });
      } catch (error) {
        sendJson(502, { error: error?.message ?? 'get_group_list 失败' });
      }
      return;
    }
    if (url.pathname === '/agent/members' && req.method === 'GET') {
      const key = this._currentSessionKey(req);
      if (!key.startsWith('g')) {
        sendJson(400, { error: '该工具只在群会话可用' });
        return;
      }
      try {
        const members = await this.bot.call('get_group_member_list', { group_id: Number(key.slice(1)) }, { timeoutMs: 15000 });
        const list = (Array.isArray(members) ? members : []).map((m) => ({
          userId: String(m.user_id ?? ''),
          nickname: m.nickname ?? '',
          card: m.card ?? '',
          role: m.role ?? 'member',
        }));
        sendJson(200, { members: list });
      } catch (error) {
        sendJson(502, { error: error?.message ?? 'get_group_member_list 失败' });
      }
      return;
    }
    if (url.pathname === '/agent/forward' && req.method === 'GET') {
      const forwardId = String(url.searchParams.get('id') ?? '').trim();
      if (!forwardId || forwardId.length > 256 || !/^[\w:.\-/=+@]+$/.test(forwardId)) {
        sendJson(400, { error: 'forwardId 非法' });
        return;
      }
      try {
        // OneBot v11：get_forward_msg 兼容 message_id / id 两种键（NapCat 两者都认）
        const data = await this.bot.call('get_forward_msg', { message_id: forwardId, id: forwardId }, { timeoutMs: 15000 });
        sendJson(200, data ?? {});
      } catch (error) {
        sendJson(502, { error: error?.message ?? 'get_forward_msg 失败' });
      }
      return;
    }

    // ── 轻量控制面（本机令牌）──
    if (url.pathname === '/status' && req.method === 'GET') {
      sendJson(200, {
        running: this.running,
        myQQId: this.myQQId,
        sessions: this.sessionManager ? [...this.sessionManager.agents.keys()] : [],
        sessionBusy: this.sessionManager ? Object.fromEntries([...this.sessionManager.agents.entries()].map(([k, a]) => [k, a.isBusy()])) : {},
        ledger: this.ledger.total,
        memory: this.memoryPool ? { count: this.memoryPool.count() } : null,
        model: {
          provider: this.config.model?.provider,
          model: this.config.model?.model,
          baseUrl: this.config.model?.baseUrl,
        },
        connected: this.bot?.connected ?? false,
        connection: {
          state: this.bot?.connectionState ?? 'idle',
          lastError: this.bot?.lastError ?? '',
          lastErrorAt: this.bot?.lastErrorAt ?? 0,
          wsUrl: this.config.qq?.wsUrl ?? '',
        },
        simulation: {
          v2: this.socialV2 ? { enabled: true, mode: this.config.socialV2?.mode ?? 'off' } : { enabled: false, mode: null },
          v1: this.socialV1 ? { enabled: true, mode: this.config.socialV1?.mode ?? 'off' } : { enabled: false, mode: null },
        },
      });
      return;
    }
    if (url.pathname === '/api/tokens/summary' && req.method === 'GET') {
      const limit = clampInt(Number(url.searchParams.get('limit')) || 200, 1, 500);
      sendJson(200, this.ledger.summary({ limit }));
      return;
    }
    if (url.pathname === '/api/tokens/series' && req.method === 'GET') {
      const hours = clampInt(Number(url.searchParams.get('hours')) || 24, 1, 24 * 90);
      const buckets = clampInt(Number(url.searchParams.get('buckets')) || 48, 6, 120);
      sendJson(200, this.ledger.series({ hours, maxBuckets: buckets }));
      return;
    }
    if (url.pathname === '/api/persona' && req.method === 'GET') {
      const { file, content } = this._readPersonaFile();
      sendJson(200, { ok: true, file, content });
      return;
    }
    if (url.pathname === '/api/persona' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const content = String(body?.content ?? '');
      const r = this._writePersonaFile(content);
      if (!r.ok) {
        // P2-10：写盘失败必须是非 2xx，不能「ok:false 但 HTTP 200」
        sendJson(500, { ok: false, error: `人设文件写入失败：${r.error}` });
        return;
      }
      // 层3 防复发：人设以文件为唯一来源——清空 config.json 里的 inline 值（非空时它优先级高于文件）
      try {
        const configPath = this._configPath();
        const raw = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8')));
        if (String(raw.persona?.systemPrompt ?? '').trim()) {
          raw.persona.systemPrompt = '';
          this._writeConfigFile(configPath, raw);
          this.config.persona.systemPrompt = '';
        }
      } catch {
        // inline 清理失败不阻塞保存（下次 loadSystemPrompt 仍以文件为准）
      }
      // P1-06：热生效不再全局等待所有会话 idle。
      //   传入**解析后**的人设（空文件 → loadSystemPrompt 走默认兜底，永远非空），
      //   避免「保存成功却仍是旧人设」的空 trim 拒绝路径。
      const resolved = loadSystemPrompt(this.config, this.rootDir);
      try {
        const result = await this.sessionManager?.reconfigure({ systemPrompt: resolved });
        sendJson(200, {
          ok: true,
          note: result?.pending ? `已保存，${result.pending} 个会话待回合结束生效` : '已保存并生效（历史会话保留，人设已替换）',
          version: result?.version ?? null,
          applied: result?.applied ?? 0,
          pendingSessions: result?.pending ?? 0,
        });
      } catch (error) {
        // reconfigure 失败时文件已保存——下次重启或重建会话仍会生效
        sendJson(200, { ok: true, note: `已保存；即时生效失败（${error?.message ?? error}），新会话将使用新人设` });
      }
      return;
    }
    if (url.pathname === '/api/whitelist' && req.method === 'GET') {
      sendJson(200, {
        ok: true,
        allow: { ...(this.config.allow ?? {}) },
        deny: { ...(this.config.deny ?? {}) },
      });
      return;
    }
    if (url.pathname === '/api/whitelist' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = this._writeWhitelist(body);
      if (!r.ok) {
        sendJson(400, { ok: false, error: r.error });
        return;
      }
      sendJson(200, { ok: true });
      return;
    }
    if (url.pathname === '/memory' && req.method === 'GET') {
      const key = url.searchParams.get('session');
      sendJson(200, {
        ok: true,
        records: this.memoryPool ? this.memoryPool.listRecords(key ? { namespace: key } : {}) : [],
      });
      return;
    }
    if (url.pathname === '/memory' && req.method === 'DELETE') {
      const key = url.searchParams.get('session');
      const removed = this.memoryPool ? this.memoryPool.clear(key ?? null) : 0;
      this.saveMemory();
      sendJson(200, { ok: true, removed });
      return;
    }
    if (url.pathname === '/sessions/abort' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const key = String(body?.sessionKey ?? '');
      const agent = this.sessionManager?.has(key) ? await this.sessionManager.get(key) : null;
      if (!agent) {
        sendJson(404, { ok: false, error: '会话不存在' });
        return;
      }
      if (!agent.isBusy()) {
        sendJson(200, { ok: true, aborted: false, note: '会话空闲，无需中断' });
        return;
      }
      agent.abort();
      sendJson(200, { ok: true, aborted: true });
      return;
    }
    if (url.pathname === '/sessions/retire' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const key = String(body?.sessionKey ?? '');
      if (!key) {
        sendJson(400, { error: 'sessionKey 必填' });
        return;
      }
      await this.sessionManager.retire(key);
      this.sessionRuntime.delete(key);
      sendJson(200, { retired: key });
      return;
    }

    sendJson(404, { error: 'not found' });
  }

  /** 会话 key 是否可发送（白名单复核；工具回调与 beforeToolCall 双侧把关的内部 HTTP 一侧）。 */
  _sessionSendable(key) {
    if (!key) return false;
    const deny = key.startsWith('g')
      ? this.config.deny?.groups ?? []
      : this.config.deny?.private ?? [];
    const id = key.slice(1);
    if (new Set(deny.map(String)).has(id)) return false;
    const allow = key.startsWith('g')
      ? this.config.allow?.groups ?? []
      : this.config.allow?.private ?? [];
    if (allow.length === 0) return this.config.allow?.allowAllWhenEmpty === true;
    return new Set(allow.map(String)).has(id);
  }

  _sendBudget() { return this.socialV2 ?? this.sendBudget; }

  async _sendToSession(key, text, replyToMessageId, { reserved = false } = {}) {
    if (!/^[gp]\d+$/.test(key) || !this._sessionSendable(key)) throw new Error('会话不允许发送');
    // P2-08：最后一道闸——退场话/沉默标记绝不允许从任何路径发出去。
    // （老实现的底层发送不做退场话检查，reply/burst 因此能把「我先撤了」送进群里。）
    if (isSilentMarker(text)) return { blocked: 'silent' };
    if (isFarewellPhrase(String(text ?? '').trim())) return { blocked: 'farewell' };
    const store = this._sendBudget();
    if (!reserved && store) {
      const gate = store.reserveSendSlots(key, 1);
      if (!gate.ok) throw Object.assign(new Error('发送限频'), { status: 429, retryAfterMs: gate.retryAfterMs });
    }
    try {
      if (key.startsWith('g')) {
        const message = replyToMessageId
          ? [
              { type: 'reply', data: { id: replyToMessageId } },
              { type: 'text', data: { text } },
            ]
          : text;
        await this.bot.sendGroupMessage(key.slice(1), message);
      } else {
        await this.bot.sendPrivateMessage(key.slice(1), text);
      }
      if (store) {
        const st = store.get(key);
        st.lastAiReplyAt = Date.now();
        st.lastAiReplyWasQuestion = /[?？]\s*$/.test(String(text ?? '').trim());
      }
      return { sent: true };
    } catch (error) {
      if (!reserved) store?.releaseSendSlots(key, 1);
      throw error;
    }
  }

  /**
   * 睡前观察等待：等到新消息或超时。
   *
   * 【P1-02】只等**游标之后**的新消息：
   *   - v2 开启时游标 = socialV2 的 shownSeq（模型已经看过的）；
   *   - 首屏已经展示过的消息不会再被「等新消息」读一遍。
   * 没有 v2 时退回运行时队列（仅兜底）。
   *
   * @param {string} key
   * @param {number} timeoutSeconds 总等待上限
   * @param {number} quietMs 静默窗：收到消息后再静默观察这么久才返回——对方连发多条时不抢答
   */
  _waitForMessages(key, timeoutSeconds, quietMs = 8000) {
    const runtime = this._runtimeFor(key);
    const store = this.socialV2;
    const cursor = store ? (store.get(key).shownSeq ?? 0) : 0;
    const pending = () => this._pendingUnread(key, cursor);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutSeconds * 1000;
      let settled = false;
      let quietTimer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (quietTimer) clearTimeout(quietTimer);
        // 把自己从 waiters 里摘掉（老实现不摘，反复超时会积累残留回调）
        const idx = runtime.waiters.indexOf(waiterFn);
        if (idx >= 0) runtime.waiters.splice(idx, 1);
        resolve(value);
      };
      // 真实超时定时器：没有新消息时也能到期返回（原实现只在消息到达时被唤醒，
      // 静默会话的 wait 永远挂起——质检测试超时暴露的隐性缺陷）
      const timer = setTimeout(() => finish([]), Math.max(0, deadline - Date.now()));
      const take = () => {
        const list = pending();
        if (list.length === 0) return [];
        if (store) {
          const seqs = list.map((m) => m.seq).filter((n) => Number.isFinite(n));
          if (seqs.length > 0) {
            this.socialV2.markShownSeqs(key, seqs, { tool: 'qq_wait_for_messages' });
            this.socialV2.trackExplicitPending(key, list);
          }
        }
        this._drainLegacyUnread(key);
        // 返回**原始**消息（渲染成模型可读格式由 /agent/wait 端点负责——
        // 这样内部调用拿到的仍是结构化原文）
        return list;
      };
      const check = () => {
        if (settled) return; // 旧 waiter 残留调用：不得消费属于后继等待的消息
        if (pending().length > 0) {
          // 静默窗：等 quietMs 内没有更多消息才返回（防抢答）；总 deadline 仍生效
          if (quietMs > 0 && Date.now() + quietMs < deadline) {
            if (quietTimer) clearTimeout(quietTimer);
            quietTimer = setTimeout(() => {
              if (!settled && pending().length > 0) finish(take());
            }, quietMs);
            runtime.waiters.push(waiterFn);
            return;
          }
          finish(take());
          return;
        }
        if (Date.now() >= deadline) {
          finish([]);
          return;
        }
        runtime.waiters.push(waiterFn);
      };
      const waiterFn = () => check();
      check();
    });
  }

  /** 当前会话已投喂到的 seq 水位（工具返回用）。 */
  _lastThroughSeq(key) {
    if (!this.socialV2) return 0;
    const state = this.socialV2.get(key);
    return state.shownSeq ?? 0;
  }

  /**
   * 原子写 config.json（先写 .tmp 再 rename）。
   * 抽成方法是为了让「落盘失败 → 运行态不变」这条路径可测（P2-10）。
   * @throws {Error} 写盘失败（调用方必须先落盘、后提交运行态）
   */
  _writeConfigFile(configPath, raw) {
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, configPath);
  }

  // ── 人设文件读写 ───────────────────────────────────────────────────────────

  _personaFilePath() {
    const file = String(this.config.persona?.systemPromptFile ?? 'roles/default.md').trim();
    return path.isAbsolute(file) ? file : path.join(this.rootDir, file);
  }

  _readPersonaFile() {
    const filePath = this._personaFilePath();
    try {
      return { file: path.relative(ROOT, filePath), content: fs.readFileSync(filePath, 'utf8') };
    } catch (error) {
      return { file: path.relative(ROOT, filePath), content: '', error: error?.message };
    }
  }

  _writePersonaFile(content) {
    const filePath = this._personaFilePath();
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, String(content ?? ''), 'utf8');
      fs.renameSync(tmp, filePath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message };
    }
  }

  // ── 白名单写回 config.json ────────────────────────────────────────────────

  _writeWhitelist(body) {
      const configPath = this._configPath();
    try {
      const raw = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8')));
      const normIds = (v) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(/^\d+$/.test.bind(/^\d+$/));
      raw.allow = {
        private: normIds(body?.allow?.private),
        groups: normIds(body?.allow?.groups),
        allowAllWhenEmpty: body?.allow?.allowAllWhenEmpty === true,
      };
      raw.deny = {
        private: normIds(body?.deny?.private),
        groups: normIds(body?.deny?.groups),
      };
      this._writeConfigFile(configPath, raw);
      // 运行态即时生效
      this.config.allow = raw.allow;
      this.config.deny = raw.deny;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message };
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export async function main() {
  const config = loadConfig();

  // 单实例锁：双实例会抢 QQ 消息、互踢会话映射
  const stateDir = path.join(ROOT, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = acquireInstanceLock(stateDir, { internalPort: config.internalPort });
  if (!lock.ok) {
    console.error(`已有桥接实例在运行（PID ${lock.pid}，锁 ${lock.lockPath}）。如确认无残留进程，删除锁文件后重试。`);
    process.exit(2);
  }

  // Fatal errors must produce a non-zero exit so systemd can restart a broken process.
  process.on('uncaughtExceptionMonitor', error => {
    console.error('[bridge] 致命异常:', error?.stack ?? error);
  });
  // 未处理的 Promise 拒绝：Node 15+ 默认直接杀死进程（"运行一天就停"的独立崩溃源）。
  // 降级为日志报错——单条消息链路故障不应拖死整只 bot。
  process.on('unhandledRejection', (reason) => {
    console.error('[bridge] 未处理的 Promise 拒绝:', reason?.stack ?? reason);
  });

  const bridge = new Bridge({ config });
  await bridge.start();
  return bridge;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error('[bridge] 启动失败:', error);
    process.exit(1);
  });
}

export { parseMessageSegments, SessionAgent };
