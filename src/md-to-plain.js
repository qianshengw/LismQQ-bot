// Markdown → QQ 纯文本（移植自 qq-bridge/src/md-to-plain.js，O(n) 有界改造保留）。
// 候选长度必须有界：`[^\]]*` 在大量 "!["（模型被诱导输出）时每次都扫到串尾是 O(n²)。
export function mdToPlain(md) {
  let s = String(md ?? '');
  // 代码块：保留内容，去掉围栏
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''));
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片/链接：保留文字，链接附在括号里（QQ 可点）
  s = s.replace(/!\[([^\]\n]{0,500})\]\(([^)\s]{1,2000})\)/g, (_, alt, url) => (alt || url));
  s = s.replace(/\[([^\]\n]{1,500})\]\(([^)\s]{1,2000})\)/g, '$1 ($2)');
  // 粗体/斜体/删除线
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  // 单个 * 斜体：不跨行 + 标记内不贴空白（否则 "2 * 3 * 4" 乘法式被整段删掉）
  s = s.replace(/\*(?!\s)([^*\n]*?[^\s*])\*/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 标题符 / 引用符
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^>\s?/gm, '');
  // 列表符
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  s = s.replace(/^\s*\d+\.\s+/gm, (m) => m.trim() + ' ');
  // 表格分隔行丢弃，其余按行保留文本
  s = s
    .split('\n')
    .filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line))
    .join('\n');
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '');
  // 折叠连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 按 QQ 单条消息长度上限切分（默认 4000 字，群消息上限留余量）。
 * 先按空行分块（空块丢弃），块内超长再按长度切；切点优先换行；
 * 代理对（emoji）不切一半；至少推进一个完整码点（防零进度死循环）。
 */
export function splitForQQ(text, max = 4000, maxChunks = 10) {
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 4000;
  const chunks = Math.max(1, Math.floor(Number(maxChunks) || 10));
  const normalized = String(text ?? '').trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const parts = [];
  for (const block of blocks) {
    if (block.length <= safeMax) {
      parts.push(block);
      continue;
    }
    let rest = block;
    while (rest.length > safeMax) {
      let cut = rest.lastIndexOf('\n', safeMax - 1);
      let eat = 0;
      if (cut <= 0) {
        cut = safeMax; // 硬切
      } else {
        eat = 1; // 换行符保留给前一段
      }
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      if (cut <= 0) {
        const first = rest.charCodeAt(0);
        const second = rest.charCodeAt(1);
        cut = first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? 2 : 1;
        eat = 0;
      }
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut + eat);
    }
    if (rest.length > 0) parts.push(rest);
  }
  const capped = parts.slice(0, chunks);
  if (parts.length > chunks && capped.length > 0) {
    capped[chunks - 1] = (capped[chunks - 1] ?? '') + '\n…（内容过长已截断）';
  }
  return capped;
}

/** 按码点截断（不切开代理对）。 */
export function truncateText(text, max) {
  const s = String(text ?? '');
  const limit = Math.max(1, Math.floor(Number(max) || 100));
  if (s.length <= limit) return s;
  // 回退一个码元避免切在代理对中间
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${s.slice(0, cut)}…`;
}

/** Compact accidental paragraph spacing in short chat; preserve lists and long text. */
export function normalizeChatSpacing(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  const lines = s.split(/\n+/).map(x => x.trim()).filter(Boolean);
  if (s.length <= 120 && lines.length === 2 && lines.every(x => x.length <= 60)
      && !lines.some(x => /^(?:[•*+>]|- |\d+[.)、])/.test(x))
      && !/[{};]|```/.test(s) && /[\u3400-\u9fff]/.test(s)) {
    return lines.join(' ');
  }
  return s.replace(/\n{3,}/g, '\n\n');
}
