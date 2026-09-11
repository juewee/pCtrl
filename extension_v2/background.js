/*
 * background service worker：
 *  - 连接电脑端本地 WebSocket（ws://127.0.0.1:8972），断线自动重连
 *  - 接收电脑端指令，转发给当前标签页的 content script
 *  - 定期查询播放状态并回传电脑端
 *
 * 稳定性要点（MV3 service worker 空闲 30s 会被浏览器回收，回收后 WebSocket 断开）：
 *  1. 15s 应用层心跳：既是保活（Chrome 116+ WebSocket 收发会重置空闲计时），
 *     也让电脑端能判断"连接是否真的活着"（半开连接检测）。
 *  2. chrome.alarms 每 30s 唤醒一次，SW 被回收后能自动把连接拉回来。
 *  3. 标签页切换/浏览器启动等事件也会唤醒 SW 并检查连接。
 *  4. 重连退避 0.5s→5s，成功后立刻复位。
 */
const WS_URL = 'ws://127.0.0.1:8972/';
const STATUS_INTERVAL_MS = 2000;
const HEARTBEAT_MS = 15000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
const INJECT_RETRY_COOLDOWN_MS = 30000;

let ws = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let statusTimer = null;
let heartbeatTimer = null;
let lastStatus = '';
let connecting = false;
const injectFailedAt = new Map(); // tabId -> 时间戳（避免每 2s 重复注入失败的标签页）

function isOpen() {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function connect() {
  if (isOpen() || connecting) return;
  connecting = true;

  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    connecting = false;
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    connecting = false;
    reconnectDelay = RECONNECT_MIN_MS;
    console.log('[遥控扩展] 已连接电脑端');
    send({ type: 'event', action: 'extension_ready', payload: { version: chrome.runtime.getManifest().version }, timestamp: Date.now() });
    startStatusPolling();
    startHeartbeat();
  };

  socket.onclose = () => {
    if (ws === socket) ws = null;
    connecting = false;
    stopStatusPolling();
    stopHeartbeat();
    scheduleReconnect();
  };

  socket.onerror = () => {
    try { socket.close(); } catch (e) { /* 忽略 */ }
  };

  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.type === 'command') handleCommand(msg);
  };
}

/** 任何"该有连接"的时机都可以调用：没连上就立刻重连 */
function ensureConnection() {
  if (!isOpen()) {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    connect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 1.6, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(env) {
  if (isOpen()) {
    try {
      ws.send(JSON.stringify(env));
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

function respond(msg, payload) {
  send({
    id: msg.id,
    type: 'response',
    action: msg.action,
    payload: payload,
    timestamp: Date.now()
  });
}

async function handleCommand(msg) {
  const action = msg.action;
  const payload = msg.payload || {};

  // 电脑端探活：必须尽快回，且不依赖页面
  if (action === 'ping') {
    respond(msg, { pong: true, at: Date.now() });
    return;
  }

  // 由 background 直接处理的标签页级操作
  if (action === 'open_url' && payload.url) {
    if (payload.newTab) {
      await chrome.tabs.create({ url: payload.url });
    } else {
      const tab = await getActiveTab();
      if (tab && tab.id) await chrome.tabs.update(tab.id, { url: payload.url });
      else await chrome.tabs.create({ url: payload.url });
    }
    respond(msg, { ok: true });
    return;
  }

  if (action === 'search' && payload.query) {
    const url = 'https://www.bing.com/search?q=' + encodeURIComponent(payload.query);
    const tab = await getActiveTab();
    if (tab && tab.id) await chrome.tabs.update(tab.id, { url });
    else await chrome.tabs.create({ url });
    respond(msg, { ok: true });
    return;
  }

  // 切换浏览器标签页（电视遥控场景：在多个标签间跳转）
  if (action === 'next_tab' || action === 'prev_tab') {
    const dir = action === 'next_tab' ? 1 : -1;
    const tabs = await chrome.tabs.query({ currentWindow: true });
    if (tabs.length <= 1) { respond(msg, { ok: false, error: '仅一个标签页' }); return; }
    const active = tabs.find((t) => t.active) || tabs[0];
    const idx = tabs.indexOf(active);
    const next = tabs[(idx + dir + tabs.length) % tabs.length];
    await chrome.tabs.update(next.id, { active: true });
    respond(msg, { ok: true, tabTitle: (next.title || '').slice(0, 60), tabUrl: (next.url || '').slice(0, 80) });
    return;
  }

  // 其余动作转发给当前标签页 content script
  const result = await forwardToActiveTab(action, payload);
  respond(msg, result || { ok: false, error: '无可用标签页' });
}

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  } catch (e) {
    return null;
  }
}

function isInjectableUrl(url) {
  return /^https?:|^file:/.test(url || '');
}

/** 向当前标签页转发消息；content script 未就位时先注入再重试 */
async function forwardToActiveTab(action, payload) {
  const tab = await getActiveTab();
  if (!tab || !tab.id || !isInjectableUrl(tab.url)) return { ok: false, error: '当前页面不支持控制' };

  const message = { __rc: true, action, payload };

  const first = await sendToTab(tab.id, message);
  if (first && first.ok !== undefined) return first;

  // content script 未加载（扩展刚安装/刷新）→ 注入后重试一次；
  // 同一标签页 30s 内注入失败过就不再反复尝试（否则每 2s 轮询都会白试一次）
  const failedAt = injectFailedAt.get(tab.id) || 0;
  if (Date.now() - failedAt < INJECT_RETRY_COOLDOWN_MS) return { ok: false, error: '页面无响应' };

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    injectFailedAt.delete(tab.id);
  } catch (e) {
    injectFailedAt.set(tab.id, Date.now());
    return { ok: false, error: '注入失败: ' + e.message };
  }
  const second = await sendToTab(tab.id, message);
  return second || { ok: false, error: '页面无响应' };
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// content script 请求（电视遥控"返回"）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return;
  const tabId = sender.tab.id;
  const url = sender.tab.url || '';
  if (msg.__rcTab === 'smartBack') {
    (async () => {
      // 播放/详情页且窗口不止一个标签 → 关闭本标签（相当于回到来源列表页）
      const isPlayPage = /\/video\/|\/bangumi\/play|\/play\/|watch\?v=|douyin\.com\/video|youtube\.com\/watch/.test(url);
      if (isPlayPage) {
        const all = await chrome.tabs.query({});
        if (all.length > 1) {
          // 先回复再关闭，避免标签销毁导致响应丢失
          sendResponse({ ok: true, closed: true });
          try { await chrome.tabs.remove(tabId); } catch (e) { /* 忽略 */ }
          return;
        }
      }
      sendResponse({ ok: true, closed: false });
    })();
    return true; // 异步响应
  }
  if (msg.__rcTab === 'close') {
    (async () => {
      const all = await chrome.tabs.query({});
      if (all.length <= 1) return sendResponse({ ok: false, single: true });
      await chrome.tabs.remove(tabId);
      sendResponse({ ok: true });
    })();
    return true; // 异步响应
  }
});

// ---------- 保活与唤醒 ----------
// MV3 service worker 空闲 30s 会被浏览器休眠，休眠后 WebSocket 断开且重连定时器被冻结。
// chrome.alarms 每 30s 唤醒 SW：没连上就重连，连上了就补一次心跳。
function ensureAlarm() {
  try {
    chrome.alarms.create('rc-keepalive', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name !== 'rc-keepalive') return;
      if (!isOpen()) {
        stopStatusPolling();
        stopHeartbeat();
        ensureConnection();
      } else {
        send({ type: 'event', action: 'heartbeat', payload: { t: Date.now(), via: 'alarm' }, timestamp: Date.now() });
      }
    });
  } catch (e) { /* alarms 不可用时降级为不自动唤醒 */ }
}

// 这些事件都会唤醒 service worker：顺手检查一下连接，断线时立刻拉回来
try {
  chrome.runtime.onStartup.addListener(ensureConnection);
  chrome.runtime.onInstalled.addListener(ensureConnection);
  chrome.tabs.onActivated.addListener(ensureConnection);
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading') injectFailedAt.delete(tabId);
    ensureConnection();
  });
  chrome.tabs.onRemoved.addListener((tabId) => injectFailedAt.delete(tabId));
  chrome.windows.onFocusChanged.addListener(ensureConnection);
} catch (e) { /* 个别 API 不可用时忽略 */ }

// ---------- 应用层心跳 ----------
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!isOpen()) {
      stopHeartbeat();
      ensureConnection();
      return;
    }
    send({ type: 'event', action: 'heartbeat', payload: { t: Date.now() }, timestamp: Date.now() });
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---------- 状态轮询 ----------
function startStatusPolling() {
  stopStatusPolling();
  statusTimer = setInterval(pollAndReport, STATUS_INTERVAL_MS);
  pollAndReport();
}

function stopStatusPolling() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

async function pollAndReport() {
  if (!isOpen()) return;
  let st = null;
  try {
    st = await forwardToActiveTab('get_status', {});
  } catch (e) {
    return;
  }
  if (!st || st.ok === false) return;
  // 状态无变化时不重复推送（播放进度除外）
  const sig = JSON.stringify({ ...st, currentTime: st.currentTime ? Math.floor(st.currentTime / 3) : 0 });
  if (sig === lastStatus && st.isPlaying) return;
  lastStatus = sig;
  send({ type: 'event', action: 'playback_state', payload: st, timestamp: Date.now() });
}

ensureAlarm();
connect();
