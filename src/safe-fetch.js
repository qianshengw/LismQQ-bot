// 只读 HTTP(S) 安全抓取（移植自 qq-bridge/src/safe-fetch.js，精简保留全部安全语义）：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，防 DNS rebinding
// - IPv4-mapped IPv6 / NAT64 内嵌 IPv4 也按内网判
// - 手动跟随重定向，每一跳重新校验
// - 响应体限量读取，每次请求有含响应体的总时限
import dns from 'node:dns';
import net from 'node:net';

const dnsLookup = dns.promises.lookup;

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // ::ffff:0:7f00:1、::c0a8:101 等非规范 IPv4-mapped/compatible 写法
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

/** 判定一个 IP 是否内网/保留段。无法识别的一律当内网处理（fail-closed）。 */
export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  if (!family || h.includes('%')) return true;
  if (family === 4) {
    const parts = h.split('.').map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true; // 本网络/私网/环回
    if (a === 169 && b === 254) return true; // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true; // 私网
    if (a === 192 && b === 168) return true; // 私网
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试
    if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET
    if (a >= 224) return true; // 组播/保留
    if (a === 255) return true;
    return false;
  }
  // IPv6
  const embedded = parseEmbeddedIpv4(h);
  if (embedded) return isPrivateIp(embedded);
  if (h === '::' || h === '::1') return true; // 未指定/环回
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // 链路本地
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA
  if (h.startsWith('ff')) return true; // 组播
  if (h.startsWith('2001:db8')) return true; // 文档段
  return false;
}

/** 主机名能否放行（字面量检查，不做 DNS）。 */
export function isAllowedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (net.isIP(h)) return !isPrivateIp(h);
  return true;
}

/**
 * 解析主机名并校验全部解析结果；任一是内网即拒绝（防 DNS rebinding）。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function assertResolvablePublicHost(hostname) {
  const h = String(hostname || '');
  if (net.isIP(h)) {
    return isPrivateIp(h) ? { ok: false, reason: `内网地址被拒: ${h}` } : { ok: true };
  }
  let records;
  try {
    records = await dnsLookup(h, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: `DNS 解析失败: ${h}` };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: `DNS 无解析结果: ${h}` };
  }
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      return { ok: false, reason: `域名解析到内网地址被拒: ${h} -> ${record.address}` };
    }
  }
  return { ok: true };
}

/**
 * 安全抓取：http/https、逐跳 SSRF 校验、限量读取。
 * @param {string} url
 * @param {object} [options] - { headers, timeoutMs, maxBytes, maxRedirects }
 * @returns {Promise<{status: number, text: string, contentType: string, url: string}>}
 * @throws {Error} SSRF 拒绝/超时/HTTP 层错误
 */
export async function safeFetch(url, { headers = {}, timeoutMs = 20000, maxBytes = 512 * 1024, maxRedirects = 4 } = {}) {
  let current = String(url ?? '');
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error('URL 非法');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`协议被拒: ${parsed.protocol}`);
    }
    if (!isAllowedHost(parsed.hostname)) {
      throw new Error(`主机被拒: ${parsed.hostname}`);
    }
    const resolvable = await assertResolvablePublicHost(parsed.hostname);
    if (!resolvable.ok) throw new Error(resolvable.reason);

    let response;
    try {
      response = await fetch(parsed, {
        headers: { 'user-agent': 'lismqq-bot/0.1 (+safe-fetch)', ...headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(error?.message ?? '抓取失败');
    }

    // 重定向手动跟随，每一跳重新校验
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`重定向缺少 Location（HTTP ${response.status}）`);
      if (hop === maxRedirects) throw new Error('重定向次数超限');
      current = new URL(location, parsed).toString();
      try {
        await response.body?.cancel();
      } catch {
        // 已结束
      }
      continue;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const reader = response.body?.getReader();
    const chunks = [];
    let total = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            break;
          }
        }
      } catch {
        // 读一半失败：返回已读部分
      }
    }
    return {
      status: response.status,
      text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
      contentType,
      url: parsed.toString(),
    };
  }
  throw new Error('unreachable');
}
