// OneBot v11 客户端：正向 WebSocket（接收事件 + action 调用）+ 可选 HTTP API（主动调用）。
// 对接 natcat shell；与 SnowLuma 版桥接的事件契约保持一致（onPrivateMessage/onGroupMessage/onNotice）。
// WebSocket 用 Node 22+ 的全局 WebSocket（undici）；access_token 兜底走 query 参数。

const GLOBAL_WS = globalThis.WebSocket;

// OneBot permits either segment arrays or CQ strings. Normalize before bridge
// trigger detection so a CQ string cannot throw on .find/.some or hide an @.
export function normalizeMessageSegments(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const decode = s => s.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
  const result = [];
  let offset = 0;
  for (const match of value.matchAll(/\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > offset) result.push({ type: 'text', data: { text: decode(value.slice(offset, match.index)) } });
    const data = Object.fromEntries(match[2].split(',').filter(Boolean).map(part => {
      const eq = part.indexOf('=');
      return eq < 0 ? [part, ''] : [part.slice(0, eq), decode(part.slice(eq + 1))];
    }));
    result.push({ type: match[1], data });
    offset = match.index + match[0].length;
  }
  if (offset < value.length) result.push({ type: 'text', data: { text: decode(value.slice(offset)) } });
  return result;
}

function assertGlobalWebSocket() {
  if (typeof GLOBAL_WS !== 'function') {
    throw new Error('globalThis.WebSocket 不可用：需要 Node.js >= 22（natcat 桥接要求 >= 22.19）');
  }
}

/** 把 OneBot 消息段数组归一化为 { text, images }；images 元素是 { url, file, summary }。 */
export function parseMessageSegments(segments) {
  const out = { text: '', images: [] };
  if (!Array.isArray(segments)) {
    if (typeof segments === 'string') out.text = segments;
    return out;
  }
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    switch (seg.type) {
      case 'text':
        out.text += typeof seg.data?.text === 'string' ? seg.data.text : '';
        break;
      case 'image': {
        const url = seg.data?.url || seg.data?.file || '';
        if (url) out.images.push({ url, file: seg.data?.file, summary: seg.data?.summary });
        break;
      }
      case 'face':
        out.text += `[表情:${seg.data?.id ?? ''}]`;
        break;
      case 'at':
        out.text += `[@${seg.data?.qq ?? ''}]`;
        break;
      case 'reply':
        out.text += `[回复:${seg.data?.id ?? ''}]`;
        break;
      case 'record':
        out.text += '[语音]';
        break;
      case 'forward':
        out.text += '[合并转发]';
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * OneBot v11 客户端。
 *
 * 事件：
 *   onPrivateMessage({ userId, text, images, raw })
 *   onGroupMessage({ groupId, userId, text, images, raw })
 *   onNotice({ type, raw })
 *   onOpen / onClose / onError(error)
 */
export class OneBotClient {
  constructor({ wsUrl, httpUrl = '', accessToken = '', reconnectMinMs = 1000, reconnectMaxMs = 30000 }) {
    assertGlobalWebSocket();
    if (!wsUrl) throw new Error('OneBot wsUrl 未配置');
    this.wsUrl = wsUrl;
    this.httpUrl = httpUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.ws = null;
    this.closedByUser = false;
    this.reconnectTimer = null;
    this.echoSeq = 0;
    this.pendingCalls = new Map(); // echo -> { resolve, reject, timer }
    this.handlers = {};
    this.selfId = ''; // 从 lifecycle/heartbeat 帧自报的身份（最可靠）
    this.connected = false;
    this.lastFrameAt = 0; // 任何入站帧刷新（看门狗用）
    this.watchdogTimer = null;
    this.watchdogKills = 0;
    this.staleMs = 90000;
    // 连接状态追踪（诊断用）：protocol-down = WS 连不上（协议端未启动）；
    // reconnecting = 曾连上后断开；auth-failed = 连上但鉴权/登录态异常。
    this.connectionState = 'connecting';
    this.lastError = '';
    this.lastErrorAt = 0;
    this.lastConnectAt = 0;
  }

  on(event, fn) {
    this.handlers[event] = fn;
    return this;
  }

  _emit(event, ...args) {
    const fn = this.handlers[event];
    if (fn) {
      try {
        fn(...args);
      } catch (error) {
        console.error(`[onebot] ${event} 处理器异常:`, error?.message ?? error);
      }
    }
  }

  _wsHeaders() {
    if (!this.accessToken) return undefined;
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  connect() {
    this.closedByUser = false;
    this._open();
  }

  _open() {
    let ws;
    try {
      ws = new GLOBAL_WS(this.wsUrl, { headers: this._wsHeaders() });
    } catch (error) {
      // undici WebSocket 构造器可能不接受自定义 headers（原生实现用浏览器式签名）；
      // access token 兜底：OneBot v11 也接受 query 参数 access_token。
      const url = new URL(this.wsUrl);
      if (this.accessToken && !url.searchParams.has('access_token')) {
        url.searchParams.set('access_token', this.accessToken);
      }
      ws = new GLOBAL_WS(url.toString());
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.connected = true;
      this.connectionState = 'connected';
      this.lastFrameAt = Date.now();
      this._startWatchdog();
      this.lastError = '';
      this.lastConnectAt = Date.now();
      console.log(`[onebot] 已连接 ${this.wsUrl}`);
      this._emit('onOpen');
    });
    ws.addEventListener('message', (event) => {
      let frame;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      } catch {
        console.warn('[onebot] 丢弃非 JSON 帧');
        return;
      }
      this._handleFrame(frame);
    });
    ws.addEventListener('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this._stopWatchdog();
      this._rejectAllPending(new Error('OneBot WebSocket 已关闭'));
      if (wasConnected) {
        console.warn('[onebot] 连接关闭');
        this.connectionState = 'reconnecting';
      }
      this._emit('onClose');
      if (!this.closedByUser) this._scheduleReconnect();
    });
    ws.addEventListener('error', (event) => {
      const message = event?.error?.message ?? event?.message ?? '连接错误';
      // WS 连不上 = 协议端（natcat/NapCat）未就绪
      if (!this.connected) {
        this.connectionState = 'protocol-down';
        this.lastError = `无法连接 ${this.wsUrl}（协议端未启动或端口不一致）`;
      } else {
        this.lastError = message;
      }
      this.lastErrorAt = Date.now();
      console.error(`[onebot] 错误: ${message}`);
      this._emit('onError', new Error(message));
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectMinMs * Math.max(1, Math.floor(Math.random() * 3) + 1),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this._open();
    }, delay);
  }

  _rejectAllPending(error) {
    for (const [, entry] of this.pendingCalls) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pendingCalls.clear();
  }

  _handleFrame(frame) {
    this.lastFrameAt = Date.now();
    if (frame === null || typeof frame !== 'object') return;
    // action 响应（带 echo）
    if (frame.echo !== undefined && (frame.status !== undefined || frame.retcode !== undefined)) {
      const entry = this.pendingCalls.get(String(frame.echo));
      if (entry) {
        this.pendingCalls.delete(String(frame.echo));
        clearTimeout(entry.timer);
        if (frame.retcode === 0 || frame.status === 'ok' || frame.status === 'async') {
          entry.resolve(frame.data ?? frame);
        } else {
          entry.reject(new Error(`OneBot action 失败 retcode=${frame.retcode} status=${frame.status} wording=${frame.wording ?? ''}`));
        }
      }
      return;
    }
    // 事件帧
    if (frame.post_type === 'message' || frame.post_type === 'message_sent') {
      frame = { ...frame, message: normalizeMessageSegments(frame.message ?? frame.raw_message) };
      const parsed = parseMessageSegments(frame.message);
      if (frame.message_type === 'private') {
        this._emit('onPrivateMessage', {
          userId: String(frame.user_id),
          text: parsed.text,
          images: parsed.images,
          messageId: frame.message_id,
          raw: frame,
        });
      } else if (frame.message_type === 'group') {
        this._emit('onGroupMessage', {
          groupId: String(frame.group_id),
          userId: String(frame.user_id),
          text: parsed.text,
          images: parsed.images,
          messageId: frame.message_id,
          raw: frame,
        });
      }
      return;
    }
    if (frame.post_type === 'notice' || frame.post_type === 'request' || frame.post_type === 'meta_event') {
      if (frame.post_type === 'meta_event') {
        // lifecycle/heartbeat 帧自带 self_id（NapCat 每次连接都会推）——
        // 比 get_login_info 更可靠的身份来源，重连后自动刷新
        if (frame.self_id) {
          const sid = String(frame.self_id);
          if (sid !== this.selfId) {
            this.selfId = sid;
            this._emit('onSelfId', sid);
          }
        }
        if (frame.meta_event_type === 'heartbeat') return;
      }
      this._emit('onNotice', { type: frame.post_type, raw: frame });
    }
  }

  /**
   * 调用一个 OneBot action。优先 HTTP API（配置了 httpUrl 时），否则走 WS。
   * @returns Promise<data>
   */
  async call(action, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.httpUrl) return this._callHttp(action, params, timeoutMs);
    return this._callWs(action, params, timeoutMs);
  }

  async _callHttp(action, params, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('HTTP 调用超时')), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
      const response = await fetch(`${this.httpUrl}/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (body.retcode !== 0 && body.status !== 'ok' && body.status !== 'async') {
        throw new Error(`OneBot HTTP ${action} 失败 retcode=${body.retcode} wording=${body.wording ?? ''}`);
      }
      return body.data ?? body;
    } finally {
      clearTimeout(timer);
    }
  }

  _callWs(action, params, timeoutMs) {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      return Promise.reject(new Error('OneBot WebSocket 未连接'));
    }
    const echo = `qqb-${Date.now().toString(36)}-${++this.echoSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(echo);
        reject(new Error(`OneBot action ${action} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pendingCalls.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  // ── 便捷方法 ──────────────────────────────────────────────────────────────

  async sendPrivateMessage(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }

  async sendGroupMessage(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message });
  }

  async getLoginInfo() {
    return this.call('get_login_info', {}, { timeoutMs: 8000 });
  }

  async getGroupHistory(groupId, count = 20) {
    const data = await this.call('get_group_msg_history', { group_id: Number(groupId), count });
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    return messages.map((m) => {
      const parsed = parseMessageSegments(m.message ?? m.raw_message);
      return {
        messageId: m.message_id,
        userId: String(m.user_id ?? ''),
        senderNickname: m.sender?.nickname ?? '',
        text: parsed.text,
        images: parsed.images,
        time: m.time,
      };
    });
  }

  _startWatchdog() {
    this._stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (!this.connected || this.closedByUser) { this._stopWatchdog(); return; }
      const stale = Date.now() - this.lastFrameAt;
      if (stale > this.staleMs) {
        console.warn(`[onebot] 看门狗：${Math.round(stale / 1000)}s 无入站帧——疑似假连接，主动断开重连（第 ${++this.watchdogKills} 次）`);
        this.connectionState = 'reconnecting';
        try { this.ws?.close(); } catch { /* 半开连接 close 可能无响应，重连定时器兜底 */ }
        this._stopWatchdog();
      }
    }, 15000);
  }

  _stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  close() {
    this.closedByUser = true;
    this._stopWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._rejectAllPending(new Error('客户端已关闭'));
    try {
      this.ws?.close();
    } catch {
      // 已关闭
    }
    this.connected = false;
  }
}
