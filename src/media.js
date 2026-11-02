// 图片抓取简化版：OneBot 图片 URL → pi vision 可吃的 { data(base64), mimeType }。
// 语义对齐旧桥 media-normalize 的"能不动就不动"取舍，但不引入 ffmpeg：
//   - ≤ maxBytes 且格式 pi 兼容（jpeg/png/webp）→ 原样放行
//   - GIF → 只取第一帧（Node 原生无法解码 GIF 帧；提示模型这是动图）
//   - 超限/其他格式 → 无 sharp 可用时放行原图（由 pi 侧/端点侧兜底）或拒绝
// 一切抓取走 safe-fetch（SSRF 逐跳校验）。
import { assertResolvablePublicHost, isAllowedHost } from './safe-fetch.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024; // 1MiB：base64 后 ≈1.33MB，token 成本可控
const FETCH_TIMEOUT_MS = 15000;

const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function mimeFromBytes(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return '';
}

/**
 * 抓取并归一化一张图。
 * @param {string} url
 * @returns {Promise<{ok: true, data: string, mimeType: string} | {ok: false, error: string}>}
 */
export async function fetchImageForModel(url) {
  // 逐跳解析（M7）：跟随重定向但每一跳都重新做 SSRF 校验（safeFetch 的 redirect:'manual'
  // 只覆盖文本路径；这里为拿原始字节自驱动循环，校验规则与 safeFetch 一致）。
  let current = String(url ?? '');
  for (let hop = 0; hop <= 4; hop++) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      return { ok: false, error: 'URL 非法' };
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !isAllowedHost(parsed.hostname)) {
      return { ok: false, error: '图片地址被拒（内网/非法）' };
    }
    const resolvable = await assertResolvablePublicHost(parsed.hostname);
    if (!resolvable.ok) return { ok: false, error: resolvable.reason };

    let response;
    try {
      response = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
    } catch (error) {
      return { ok: false, error: `下载失败: ${error?.message ?? error}` };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { ok: false, error: `重定向缺少 Location（HTTP ${response.status}）` };
      if (hop === 4) return { ok: false, error: '重定向次数超限' };
      current = new URL(location, parsed).toString();
      try { await response.body?.cancel(); } catch { /* 已结束 */ }
      continue;
    }
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); return { ok: false, error: '图片过大（超过 1MB）' }; }
        chunks.push(value);
      }
    } catch (error) { return { ok: false, error: '图片读取失败或超时' }; }
    const arrayBuf = Buffer.concat(chunks);
    if (arrayBuf.byteLength > MAX_BYTES) {
      return { ok: false, error: `图片过大（${Math.round(arrayBuf.byteLength / 1024)}KB > 1MB 上限）` };
    }
    const buf = Buffer.from(arrayBuf);
    const mime = mimeFromBytes(buf);
    if (!mime) return { ok: false, error: '无法识别的图片格式' };
    if (mime === 'image/gif') {
      // 简化版：GIF 不解码帧，直接按原字节传（多数端点接受 GIF 首帧渲染），
      // mimeType 标 gif，模型提示里会注明"这是动图"。
      return { ok: true, data: buf.toString('base64'), mimeType: 'image/gif' };
    }
    if (!SUPPORTED_MIME.has(mime)) {
      return { ok: false, error: `不支持的格式: ${mime}` };
    }
    return { ok: true, data: buf.toString('base64'), mimeType: mime };
  }
  return { ok: false, error: 'unreachable' };
}

/** 批量处理：最多取 maxCount 张，单张失败降级为占位说明。 */
export async function fetchImagesForModel(urls, { maxCount = 3 } = {}) {
  const list = (Array.isArray(urls) ? urls : []).slice(0, maxCount);
  const out = [];
  for (const url of list) {
    const r = await fetchImageForModel(url);
    if (r.ok) out.push({ data: r.data, mimeType: r.mimeType, isAnimated: r.mimeType === 'image/gif' });
  }
  return out;
}

// ── 图片落盘（内存治理：transcript 只存引用，prompt 时才读文件）──────────────

const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/**
 * 把 base64 图片写入磁盘，返回引用形状（不再携带 base64）。
 * 同一张图（hash 相同）跳过重复写。写盘失败降级为内联 data（旧路径，不丢图）。
 * @param {{data: string, mimeType: string, isAnimated?: boolean}} img
 * @param {string} stateDir
 * @returns {{imagePath?: string, data?: string, mimeType: string, isAnimated?: boolean}}
 */
export function persistImage(img, stateDir) {
  if (!img?.data) return img;
  try {
    const dir = path.join(stateDir, 'images');
    fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash('sha1').update(img.data).digest('hex').slice(0, 20);
    const ext = EXT_BY_MIME[img.mimeType] ?? '.bin';
    const imagePath = path.join(dir, `${hash}${ext}`);
    if (!fs.existsSync(imagePath)) {
      const tmp = `${imagePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(img.data, 'base64'));
      fs.renameSync(tmp, imagePath);
    }
    return { imagePath, mimeType: img.mimeType, isAnimated: img.isAnimated };
  } catch (error) {
    console.warn(`[media] 图片落盘失败（降级内联）: ${error?.message ?? error}`);
    return img; // 兜底：保持旧的内联 data 形状
  }
}

/** prompt 前把 imagePath 读回 base64（模型 API 只认内联 data）。 */
export function loadImageForPrompt(imagePath) {
  try {
    const buf = fs.readFileSync(imagePath);
    const mime = mimeFromBytes(buf);
    return { data: buf.toString('base64'), mimeType: mime || 'image/png' };
  } catch (error) {
    console.warn(`[media] 图片读取失败（prompt 侧降级）: ${error?.message ?? error}`);
    return null;
  }
}
