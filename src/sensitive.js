// 共享的敏感信息审计正则与脱敏工具（移植自 qq-bridge/src/sensitive.js + bridge.js 脱敏段）。
//
// 双闸门设计（有意互补，不是重复实现）：
//   ① SENSITIVE_RE 启发式：抓"长得像路径 / 像凭据赋值"的文本，任何出站文本都过一遍；
//   ② KNOWN_AGENT_TOKENS 精确名单：抓**已知的**运行期令牌原文（内部 HTTP token、模型 API key）。
//     32 位十六进制裸令牌不匹配正则（既不是路径也没有赋值形态），只有精确名单能拦住它。
//
// ⚠️ 不要往 SENSITIVE_RE 里加 [0-9a-f]{32}：表情 md5、图片 URL、消息里的十六进制串
// 本身就是 32-hex，加进去会把正常表情包与消息整条拦掉。收紧令牌泄漏走精确名单。

export const SENSITIVE_RE =
  /((?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,}))/i;

/**
 * 已知运行期令牌精确名单（Set<string>）。
 * 桥接启动/配置变更时注册；发送出站文本与写日志前都用它做精确替换。
 */
export function createKnownTokens() {
  const tokens = new Set();
  const MAX = 512;

  return {
    /** 注册一个令牌（空串/过短忽略）。 */
    add(token) {
      const t = String(token ?? '');
      if (t.length < 8) return;
      tokens.add(t);
      if (tokens.size > MAX) {
        // 超限时按注册序淘汰最旧（Set 迭代序即插入序）
        for (const old of tokens) {
          if (tokens.size <= MAX) break;
          tokens.delete(old);
        }
      }
    },

    delete(token) {
      tokens.delete(String(token ?? ''));
    },

    has(token) {
      return tokens.has(String(token ?? ''));
    },

    /** 文本里含任一已知令牌（精确子串匹配）。 */
    includesAny(text) {
      const s = String(text ?? '');
      for (const t of tokens) {
        if (s.includes(t)) return true;
      }
      return false;
    },

    /** 把文本中出现的已知令牌全部替换为占位符。 */
    redact(text, placeholder = '[已脱敏]') {
      let out = String(text ?? '');
      for (const t of tokens) {
        if (out.includes(t)) out = out.split(t).join(placeholder);
      }
      return out;
    },

    size() {
      return tokens.size;
    },
  };
}

/**
 * 启发式脱敏：SENSITIVE_RE 命中的片段替换为 ***。
 * 正则无 g 标志，这里动态补 g 做全局替换。
 */
export function redactByPattern(text) {
  const raw = String(text ?? '');
  if (!raw) return raw;
  const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
  return raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
}

/**
 * 双闸门合并脱敏：先过精确名单，再过启发式。
 * 出站文本（QQ 发送、日志、审计记录）统一走这里。
 */
export function redactAll(text, knownTokens) {
  let out = String(text ?? '');
  if (knownTokens) out = knownTokens.redact(out);
  return redactByPattern(out);
}

/** 文本是否命中任一闸门（审计判定用，不做替换）。 */
export function looksSensitive(text, knownTokens) {
  const s = String(text ?? '');
  if (SENSITIVE_RE.test(s)) return true;
  if (knownTokens && knownTokens.includesAny(s)) return true;
  return false;
}
