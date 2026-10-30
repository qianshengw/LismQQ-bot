// burst 连发发送：条数上限、限频预占、间隔三模式（auto/fixed/byLength）。
// 移植自 qq-bridge bridge.js 的 send-burst / computeGapsV2 域；发送执行由 bridge 注入。
export const BURST_DEFAULTS = Object.freeze({
  burstMaxMessages: 8,
  burstMaxChars: 500,
  gapMode: 'auto', // auto | fixed | byLength
  gapMinMs: 1000,
  gapMaxMs: 3000,
  longGapProbability: 0.2,
  longGapMinMs: 2500,
  longGapMaxMs: 5000,
  fixedGapMs: 1500,
  gapBaseMs: 800,
  gapPerCharMs: 20,
});

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 计算连发间隔序列（条数-1 个间隔）。
 * - auto：1~3s 随机 + longGapProbability 概率长间隔 2.5~5s
 * - fixed：固定 fixedGapMs
 * - byLength：按上一条字数 800 + 20ms/字，封顶 10s
 */
export function computeGaps(messages, opts = {}) {
  const o = { ...BURST_DEFAULTS, ...opts };
  const gaps = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (o.gapMode === 'fixed') {
      gaps.push(clampInt(o.fixedGapMs, 200, 60000, 1500));
      continue;
    }
    if (o.gapMode === 'byLength') {
      const chars = String(messages[i] ?? '').length;
      gaps.push(Math.min(10000, o.gapBaseMs + chars * o.gapPerCharMs));
      continue;
    }
    // auto
    let gap = o.gapMinMs + Math.random() * (o.gapMaxMs - o.gapMinMs);
    if (Math.random() < o.longGapProbability) {
      gap = o.longGapMinMs + Math.random() * (o.longGapMaxMs - o.longGapMinMs);
    }
    gaps.push(Math.round(gap));
  }
  return gaps;
}

/**
 * 校验并规整一次 burst 请求。
 * @returns {{ok: true, messages: string[], gaps: number[]} | {ok: false, error: string}}
 */
export function planBurst(rawMessages, { gapMode, limits = {}, sendTimes = [] } = {}) {
  const o = { ...BURST_DEFAULTS, ...limits, gapMode };
  const list = (Array.isArray(rawMessages) ? rawMessages : [String(rawMessages ?? '')])
    .map((m) => String(m ?? '').trim())
    .filter(Boolean);
  if (list.length === 0) return { ok: false, error: '没有可发送的内容' };
  const maxCount = o.burstMaxMessages ?? 8;
  if (list.length > maxCount) return { ok: false, error: `连发条数超上限（${list.length} > ${maxCount}）` };
  for (const m of list) {
    if (m.length > (o.burstMaxChars ?? 500)) return { ok: false, error: `单条超长（${m.length} > ${o.burstMaxChars} 字）` };
  }
  return { ok: true, messages: list, gaps: computeGaps(list, o) };
}
