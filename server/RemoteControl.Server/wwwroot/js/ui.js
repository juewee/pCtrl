/* UI 工具：DOM 快捷方式、Toast、触摸板手势识别 */

const $ = (s) => document.querySelector(s);

/* 轻量提示：同一时刻最多保留一条，新提示立即顶掉旧的，
   避免连续操作时多条弹窗叠加/滞留造成的视觉与输入干扰 */
let _toastTimer = null;

function toast(msg, type = '', duration = 2800) {
  const container = $('#toast-container');
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  container.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  container.appendChild(el);
  _toastTimer = setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  }, duration);
}

/* 同一条提示短时间内只弹一次：断线/扩展不可用这类提示反复弹出非常干扰操作 */
const _throttledToastAt = new Map();

function toastThrottled(key, msg, type = '', duration = 2400, gapMs = 5000) {
  const now = Date.now();
  if (now - (_throttledToastAt.get(key) || 0) < gapMs) return;
  _throttledToastAt.set(key, now);
  toast(msg, type, duration);
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 触摸板手势：
 *  - 单指滑动 → onMove(dx, dy)（约 30ms 合并一次，位移不丢）
 *  - 单指轻点 → onTap()（左键）
 *  - 双指滑动 → onScroll(steps)（垂直滚轮，steps 正=向上）
 *  - 双指点按 → onTwoTap()（右键）
 *
 * 稳定性要点（"断触"修复）：
 *  1. 指针表自愈：系统手势接管/事件丢失时 pointerup 可能收不到，残留指针会让
 *     下一次单指滑动被当成双指滚动（表现为触摸板彻底没反应，只能刷新页面）。
 *     这里在 window 上兜底监听 pointerup/pointercancel，并重置异常残留状态。
 *  2. 浏览器把滑动当成页面滚动时会发 pointercancel：CSS 已加 touch-action:none，
 *     这里再 preventDefault，双保险。
 *  3. pointercancel 只清状态，不再被当成"轻点"，避免误点电脑鼠标。
 *  4. 位移按 30ms 合并后整段发送，既跟手又不会撞上服务端 60 条/秒的限流。
 */
class Touchpad {
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers || {};
    this.pointers = new Map();
    this.down = null;
    this.hadTwo = false;
    this.cancelled = false;
    this.scrollAcc = 0;
    this.pending = { dx: 0, dy: 0 };
    this.flushTimer = null;
    this.lastFlush = 0;
    this.MOVE_INTERVAL_MS = 30;
    this.STALE_MS = 8000;

    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onCancel(e));
    el.addEventListener('lostpointercapture', (e) => this.onCancel(e));

    // 兜底：手指抬起/被系统手势打断时，事件可能不落在触摸板上
    window.addEventListener('pointerup', (e) => this.onUp(e), true);
    window.addEventListener('pointercancel', (e) => this.onCancel(e), true);
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });
  }

  onDown(e) {
    // 上一次抬手的指针没清掉（事件丢失）会让单指变成"双指滚动"，这里直接重置
    if (this.pointers.size >= 2) this.reset();
    this.pruneStale();

    try { this.el.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: Date.now() });
    if (e.pointerType !== 'mouse' && e.cancelable) e.preventDefault();

    this.el.classList.add('active-touch');
    this.showDot(e);

    if (this.pointers.size === 1) {
      this.cancelled = false;
      this.hadTwo = false;
      this.down = { x: e.clientX, y: e.clientY, t: Date.now(), moved: 0 };
    } else if (this.pointers.size === 2) {
      this.hadTwo = true;
      this.scrollAcc = 0;
    }
  }

  onMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (e.pointerType !== 'mouse' && e.cancelable) e.preventDefault();

    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    p.t = Date.now();
    this.moveDot(e);

    if (this.pointers.size === 1) {
      if (this.down) this.down.moved += Math.abs(dx) + Math.abs(dy);
      this.pending.dx += dx;
      this.pending.dy += dy;
      this.scheduleFlush();
    } else if (this.pointers.size === 2) {
      // 双指垂直滑动 → 滚轮（上滑 = 向上滚动）
      this.scrollAcc += dy;
      const TH = 26;
      if (Math.abs(this.scrollAcc) >= TH) {
        const steps = Math.trunc(this.scrollAcc / TH);
        this.scrollAcc -= steps * TH;
        this.h.onScroll(-steps);
      }
    }
  }

  onUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size > 0) return;

    const gestureMs = this.down ? Date.now() - this.down.t : 9999;
    const wasCancelled = this.cancelled;
    this.flushPending(); // 抬手前把最后一段位移补发出去

    if (!wasCancelled) {
      if (this.hadTwo) {
        // 双指快速点按 → 右键
        if (gestureMs < 500) this.h.onTwoTap();
      } else if (this.down && gestureMs < 260 && this.down.moved < 14) {
        this.h.onTap();
      }
    }
    this.reset();
  }

  /** 被系统手势/滚动接管：只清理状态，绝不触发点击 */
  onCancel(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this.cancelled = true;
    if (this.pointers.size === 0) this.reset();
  }

  reset() {
    this.pointers.clear();
    this.down = null;
    this.hadTwo = false;
    this.cancelled = false;
    this.scrollAcc = 0;
    this.pending = { dx: 0, dy: 0 };
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.el.classList.remove('active-touch');
    this.hideDot();
  }

  /** 清掉长时间没有更新的指针（事件彻底丢失的兜底） */
  pruneStale() {
    const now = Date.now();
    this.pointers.forEach((p, id) => {
      if (now - p.t > this.STALE_MS) this.pointers.delete(id);
    });
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    const wait = Math.max(0, this.MOVE_INTERVAL_MS - (Date.now() - this.lastFlush));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPending();
    }, wait);
  }

  flushPending() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const p = this.pending;
    this.pending = { dx: 0, dy: 0 };
    this.lastFlush = Date.now();
    if (p.dx || p.dy) this.h.onMove(p.dx, p.dy);
  }

  showDot(e) {
    if (!this.dot) {
      this.dot = document.createElement('div');
      this.dot.className = 'touch-dot';
      this.el.appendChild(this.dot);
    }
    const rect = this.el.getBoundingClientRect();
    this.dot.style.left = e.clientX - rect.left + 'px';
    this.dot.style.top = e.clientY - rect.top + 'px';
  }

  moveDot(e) {
    if (!this.dot || this.pointers.size > 1) return;
    const rect = this.el.getBoundingClientRect();
    this.dot.style.left = Math.max(0, Math.min(rect.width, e.clientX - rect.left)) + 'px';
    this.dot.style.top = Math.max(0, Math.min(rect.height, e.clientY - rect.top)) + 'px';
  }

  hideDot() {
    if (this.dot) {
      this.dot.remove();
      this.dot = null;
    }
  }
}
