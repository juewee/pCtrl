/* WebSocket 封装：自动重连、请求/响应关联、事件分发 */
class RcSocket {
  constructor(path) {
    this.url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path;
    this.ws = null;
    this.handlers = {};
    this.pending = new Map();
    this.retry = 800;
    this.closedByUser = false;
    this._id = 0;
    this.lastMessageAt = 0;   // 最近一次收到服务端消息的时间
    this.STALE_MS = 45000;    // 超过该时长没有任何消息 → 判定连接假死
    this._reconnecting = false;
  }

  on(evt, cb) {
    (this.handlers[evt] = this.handlers[evt] || []).push(cb);
  }

  emit(evt, arg) {
    (this.handlers[evt] || []).forEach((cb) => {
      try { cb(arg); } catch (e) { console.error(e); }
    });
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** 连接是否可能已"假死"（手机锁屏/切 WiFi 时 TCP 可能不报错，但消息已经收不到了） */
  get stale() {
    return !!this.connected && this.lastMessageAt > 0 && Date.now() - this.lastMessageAt > this.STALE_MS;
  }

  connect() {
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 800;
      this.lastMessageAt = Date.now();
      this.emit('open');
    };

    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let env;
      try { env = JSON.parse(ev.data); } catch (e) { return; }

      // 响应：与 pending 请求按 id 关联
      if (env.id && this.pending.has(env.id)) {
        const p = this.pending.get(env.id);
        this.pending.delete(env.id);
        clearTimeout(p.timer);
        if (env.type === 'response') p.resolve(env.payload);
        else p.reject(new Error('unexpected message type'));
        return;
      }
      this.emit('message', env);
    };

    ws.onclose = () => {
      // 已被 forceReconnect 换掉的旧连接：不要重复触发重连
      if (this.ws !== ws) return;
      this.ws = null;
      this.emit('close');
      this.failAll(new Error('连接已断开'));
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      try { ws.close(); } catch (e) { /* 忽略 */ }
    };
  }

  scheduleReconnect() {
    setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 1.6, 10000);
  }

  /** 强制重连：用于连接假死（TCP 未断但消息收不到）的场景 */
  forceReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    const old = this.ws;
    this.ws = null;
    try { if (old) old.close(); } catch (e) { /* 忽略 */ }
    this.emit('close');
    this.failAll(new Error('连接已重置，正在重连'));
    setTimeout(() => {
      this._reconnecting = false;
      this.connect();
    }, 400);
  }

  send(env) {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify(env));
    return true;
  }

  /** 发送命令并等待响应，超时/断连时 reject */
  request(action, payload = {}, timeout = 8000) {
    return new Promise((resolve, reject) => {
      // 假死连接先踢掉：否则命令会一直等到超时，界面看起来"连着的但没反应"
      if (this.stale) {
        this.forceReconnect();
        reject(new Error('连接已断开，正在重连'));
        return;
      }
      const id = 'm' + (++this._id) + '_' + Date.now();
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('请求超时'));
        }
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });

      const ok = this.send({ id, type: 'command', action, payload, timestamp: Date.now() });
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('未连接到电脑'));
      }
    });
  }

  failAll(err) {
    this.pending.forEach((p) => { clearTimeout(p.timer); p.reject(err); });
    this.pending.clear();
  }
}
