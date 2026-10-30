// SharedMemoryPool 的 JS 移植（源自 LightphpAgent src/Memory/SharedMemoryPool.php，Apache-2.0 项目）。
// 内存型 append-first 共享池：token 重叠打分检索 + CJK bigram 分词（中文子串可命中）+
// 停用词过滤 + FIFO 容量淘汰。检索是词面匹配——零词面重叠的同义改写召回不到。
//
// 分区约定（沿用 LightphpAgent 的隔离设计）：
//   - 用户提问写入 scope='utterance'（对偏好召回不可见）
//   - 偏好注入只检索 scope='user'
//   - 每个 QQ 会话一个命名空间（namespace），互不可见

const ENGLISH_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'had', 'has', 'have',
  'he', 'her', 'his', 'i', 'in', 'is', 'it', 'its', 'my', 'not', 'of', 'on', 'or', 'our', 'she',
  'so', 'that', 'the', 'their', 'them', 'there', 'they', 'this', 'to', 'was', 'we', 'were',
  'will', 'with', 'you', 'your',
]);

const CJK_STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '它们', '这个', '那个', '这些', '那些', '什么', '怎么',
  '因为', '所以', '但是', '如果', '虽然', '可以', '应该', '需要', '已经', '还是', '或者',
  '以及', '对于', '关于', '通过', '进行', '一个', '一些', '一下', '一样', '时候', '现在',
  '不是', '就是', '知道', '觉得', '然后', '而且', '由于', '为了', '根据', '按照', '随着',
]);

const CJK_RUN_PATTERN = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]+/g;
const HAS_CJK_PATTERN = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/u;

/** 把文本切成打分词元：小写化、按空白切、剥首尾标点、停用词过滤；CJK 段额外产出字符 bigram。 */
export function tokenize(text) {
  const tokens = new Set();
  const lowered = String(text ?? '').toLowerCase();
  for (const raw of lowered.split(/\s+/)) {
    if (!raw) continue;
    const clean = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!clean || ENGLISH_STOPWORDS.has(clean)) continue;
    tokens.add(clean);
    for (const bigram of cjkBigrams(clean)) {
      if (!CJK_STOPWORDS.has(bigram)) tokens.add(bigram);
    }
  }
  return [...tokens];
}

/** 每段 CJK 串的字符 bigram；单字符保留自身（让单字查询有东西可匹配）。 */
export function cjkBigrams(text) {
  if (!HAS_CJK_PATTERN.test(text)) return [];
  const bigrams = [];
  const runs = text.match(CJK_RUN_PATTERN) ?? [];
  for (const run of runs) {
    const chars = [...run];
    if (chars.length < 2) {
      bigrams.push(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) {
      bigrams.push(chars[i] + chars[i + 1]);
    }
  }
  return bigrams;
}

let seq = 0;

/**
 * @param {object} options
 * @param {number} options.maxRecords  容量上限，FIFO 淘汰最旧
 * @param {number} options.maxResults  retrieve 默认返回上限
 */
export class SharedMemoryPool {
  constructor({ maxRecords = 300, maxResults = 5 } = {}) {
    if (maxRecords <= 0) throw new Error('maxRecords 必须大于 0');
    if (maxResults <= 0) throw new Error('maxResults 必须大于 0');
    this.maxRecords = maxRecords;
    this.maxResults = maxResults;
    /** @type {Array<{id: string, memory: string, namespace: string, source: string, scope: string, ts: number, metadata: object}>} */
    this.records = [];
  }

  /**
   * 写入一条记忆。
   * @param {string} data
   * @param {object} opts - { namespace, source='user', scope='user', metadata }
   * @returns {{stored: boolean, id: string}}
   */
  store(data, { namespace = '', source = 'user', scope = 'user', metadata = {} } = {}) {
    const record = {
      id: `m-${Date.now().toString(36)}-${++seq}`,
      memory: String(data),
      namespace: String(namespace),
      source,
      scope,
      ts: Date.now(),
      metadata,
    };
    this.records.push(record);
    this._evictOverflow();
    return { stored: true, id: record.id };
  }

  /**
   * 检索：namespace 内按 scope/source 过滤后做 token 重叠打分排序。
   * 纯停用词/空查询返回空（M-28：无信号查询不该返回全量）。
   * @returns {Array<{id, memory, source, scope, ts, metadata, score}>}
   */
  retrieve(query, { namespace = '', scope = null, source = null, limit = null } = {}) {
    const maxResults = limit ?? this.maxResults;
    if (maxResults <= 0) return [];
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const candidates = this.records.filter(
      (r) => r.namespace === namespace && (scope === null || r.scope === scope) && (source === null || r.source === source),
    );
    const scored = candidates
      .map((record, index) => ({ record, index, score: this._score(queryTokens, record.memory) }))
      .filter((entry) => entry.score > 0);
    scored.sort((a, b) => (b.score - a.score) || (b.index - a.index));

    return scored.slice(0, maxResults).map(({ record, score }) => ({ ...record, score }));
  }

  /** 枚举（不过相关性过滤），调试/控制台用。 */
  listRecords({ namespace = null, scope = null, source = null } = {}) {
    return this.records.filter(
      (r) =>
        (namespace === null || r.namespace === namespace) &&
        (scope === null || r.scope === scope) &&
        (source === null || r.source === source),
    );
  }

  /** 清空；返回删除条数。 */
  clear(namespace = null) {
    if (namespace === null) {
      const count = this.records.length;
      this.records = [];
      return count;
    }
    const before = this.records.length;
    this.records = this.records.filter((r) => r.namespace !== namespace);
    return before - this.records.length;
  }

  count() {
    return this.records.length;
  }

  /** 序列化（进程重启恢复用）。 */
  toJSON() {
    return this.records;
  }

  static fromJSON(data, options) {
    const pool = new SharedMemoryPool(options);
    if (Array.isArray(data)) {
      pool.records = data.filter((r) => r && typeof r.memory === 'string');
    }
    return pool;
  }

  _evictOverflow() {
    const overflow = this.records.length - this.maxRecords;
    if (overflow <= 0) return;
    this.records = this.records.slice(overflow);
  }

  _score(queryTokens, memory) {
    const recordTokens = new Set(tokenize(memory));
    let hits = 0;
    for (const token of queryTokens) {
      if (recordTokens.has(token)) hits++;
    }
    return hits;
  }
}

/**
 * 把检索结果渲染成注入上下文的偏好块（对应 LightphpAgent 的「##用户偏好」）。
 * @param {Array} results retrieve() 的返回
 */
export function renderPreferenceBlock(results) {
  if (!Array.isArray(results) || results.length === 0) return '';
  const lines = results.map((r) => String(r.memory ?? '')).filter((s) => s.length > 0);
  if (lines.length === 0) return '';
  return `\n##用户偏好\n用户之前提到了:\n${lines.join('\n')}`;
}
