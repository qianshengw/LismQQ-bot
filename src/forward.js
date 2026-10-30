// 合并转发精简解析 + 引用回查辅助（移植自 qq-bridge/src/forward.js 精简版）。
// 只格式化，不访问网络；调用方负责"forward id 必须来自当前会话已见消息"的校验。
import { truncateText } from './md-to-plain.js';

/** forward id 白名单字符校验（拒绝空白/控制字符当 OneBot 参数）。 */
export function sanitizeForwardId(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 256) return '';
  if (!/^[\w:.\-/=+@]+$/.test(s)) return '';
  return s;
}

export function forwardIdFromData(data) {
  const d = data && typeof data === 'object' ? data : {};
  return sanitizeForwardId(d?.id ?? d?.res_id ?? d?.file_id ?? d?.forward_id ?? '');
}

/** 从消息段数组提取全部去重后的 forward id。 */
export function extractForwardIds(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object' || seg.type !== 'forward') continue;
    const id = forwardIdFromData(seg.data);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function segmentText(seg) {
  if (typeof seg === 'string') return seg;
  if (!seg || typeof seg !== 'object') return '';
  const d = seg.data ?? {};
  switch (seg.type) {
    case 'text': return String(d.text ?? '');
    case 'at': return d.qq === 'all' ? '@全体成员' : `@${d.qq ?? ''}`;
    case 'face': return `[表情${d.id ?? ''}]`;
    case 'image': return '[图片]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'file': return `[文件${d.name ?? ''}]`;
    case 'reply': return '[引用]';
    case 'forward': return '[转发]';
    case 'json': return '[卡片消息]';
    default: return `[${seg.type ?? '未知'}]`;
  }
}

function sanitizeCqString(s) {
  // CQ 码字符串转占位符，避免原样塞给 AI
  return String(s ?? '').replace(/\[CQ:[^\]]*\]/gi, '[媒体]');
}

/**
 * 把 get_forward_msg 的返回格式化为适合 AI 阅读的紧凑结构。
 * 兼容两种形状：{ messages: [...] }（OneBot v11 标准）与数组直给。
 * @returns {Array<{sender: string, text: string, time?: number}>}
 */
export function formatForwardMessages(data) {
  const raw = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
  const out = [];
  for (const item of raw.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const sender = String(item.sender?.nickname ?? item.sender?.card ?? item.user_id ?? '').trim() || '未知';
    let text = '';
    if (Array.isArray(item.message)) text = item.message.map(segmentText).join(' ').trim();
    else if (typeof item.content === 'string') text = sanitizeCqString(item.content).trim();
    else if (typeof item.message === 'string') text = sanitizeCqString(item.message).trim();
    if (!text) text = '[空消息]';
    out.push({ sender, text: truncateText(text, 300), time: item.time });
  }
  return out;
}

/** 转发树渲染成 prompt 注入文本（限深一层，防嵌套爆炸）。 */
export function renderForwardBlock(forwardId, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return `[转发消息 id=${forwardId}（展开失败）]`;
  const lines = messages.slice(0, 30).map((m) => `- ${m.sender}: ${m.text}`);
  return `[转发消息 id=${forwardId}]\n${lines.join('\n')}`;
}
