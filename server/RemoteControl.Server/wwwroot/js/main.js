/* 主逻辑：连接、认证、模块化遥控（面板/播放）、触摸板、键盘、宏、AI */
(function () {
  'use strict';

  const state = {
    ws: null,
    token: localStorage.getItem('rc_token') || '',
    authed: false,
    sensitivity: parseFloat(localStorage.getItem('rc_sens') || '1.2'),
    extConnected: false,
    videoMode: false,   // true = 播放控制模块（▲▼音量 / ◀▶进度·长按2x / OK播放）
    pageMode: '',       // 来自扩展：video / feed / grid / other
    playback: { hasVideo: false, title: '', platform: '', isPlaying: false, volume: null, currentTime: 0, duration: 0 },
    macros: [],
    recording: false,
    dragging: false     // 正在拖动进度条（期间不被服务端状态覆盖）
  };
  const LONG_PRESS_MS = 380;

  // ---------- 工具 ----------
  function cmd(action, payload, timeout) {
    return state.ws.request(action, payload || {}, timeout).then((r) => {
      if (r && r.error) {
        // 扩展短暂不可用（正在重连/正忙）属可自愈的偶发情况：同一条提示 5 秒内只弹一次，
        // 避免"老是弹出扩展断线"刷屏挡住操作。
        if (/扩展/.test(r.error)) toastThrottled('ext-err', r.error, 'err');
        else toast(r.error, 'err');
        throw new Error(r.error);
      }
      return r;
    });
  }

  function setConn(online) {
    const dot = $('#conn-dot');
    dot.classList.toggle('offline', !online);
    if (!online) {
      state.authed = false;
      $('#device-name').textContent = '未连接';
      setExt(false);
    }
  }

  function setExt(connected) {
    state.extConnected = connected;
    const badge = $('#ext-badge');
    badge.textContent = connected ? '扩展已连接' : '扩展未连接';
    badge.classList.toggle('online', connected);
    if (!connected) applyModule(''); // 无扩展时无法感知页面形态，退回通用模式
  }

  // ---------- WebSocket ----------
  state.ws = new RcSocket('/ws');
  state.ws.on('open', () => setConn(true));
  state.ws.on('close', () => { setConn(false); setExt(false); });
  state.ws.on('message', (env) => handleEvent(env));
  state.ws.connect();

  // 应用层心跳看门狗：连续两次 ping 没响应就主动重连
  // （手机锁屏、切 WiFi、路由器漫游时 TCP 常常不报错，但消息已经收不到了）
  let pingFails = 0;
  setInterval(() => {
    if (!state.ws.connected) { pingFails = 0; return; }
    cmd('ping', {}, 6000)
      .then(() => { pingFails = 0; })
      .catch(() => {
        if (++pingFails >= 2) { pingFails = 0; state.ws.forceReconnect(); }
      });
  }, 25000);

  // 定期刷新设备/扩展状态：扩展短暂重连时状态栏能自己纠正回来
  setInterval(() => {
    if (state.ws.connected && state.authed) cmd('get_info').then(onInfo).catch(() => {});
  }, 20000);

  function handleEvent(env) {
    if (env.type !== 'event') return;
    switch (env.action) {
      case 'auth_required':
        doAuth();
        break;
      case 'auth_failed':
        onAuthFailed((env.payload && env.payload.error) || '配对失败');
        break;
      case 'info':
        onInfo(env.payload);
        break;
      case 'playback_state':
        onPlayback(env.payload);
        break;
      case 'extension_connected':
      case 'extension_ready':
        setExt(true);
        break;
      case 'extension_disconnected':
        setExt(false);
        break;
      case 'macro_recording':
        setRecording(!!(env.payload && env.payload.recording));
        break;
      case 'macro_finished':
        if (env.payload && env.payload.ok) toast(`宏「${env.payload.name || ''}」执行完成`, 'ok');
        else toast('宏执行失败：' + ((env.payload && env.payload.error) || '未知错误'), 'err');
        break;
    }
  }

  // ---------- 认证 ----------
  async function doAuth() {
    if (state.authed) return;
    if (state.token) {
      try {
        const r = await state.ws.request('auth', { token: state.token }, 6000);
        if (r && r.token) { onAuthed(r); return; }
      } catch (e) { /* 落到配对界面 */ }
      state.token = '';
      localStorage.removeItem('rc_token');
    }
    showPairing();
  }

  function onAuthed(r) {
    state.authed = true;
    state.token = r.token;
    localStorage.setItem('rc_token', r.token);
    if (r.deviceName) $('#device-name').textContent = r.deviceName;
    hidePairing();
    refreshAll();
  }

  function onAuthFailed(msg) {
    state.token = '';
    localStorage.removeItem('rc_token');
    state.authed = false;
    showPairing();
    $('#pairing-error').textContent = msg;
  }

  function showPairing() {
    $('#pairing-overlay').classList.remove('hidden');
    setTimeout(() => $('#pairing-code').focus(), 300);
  }

  function hidePairing() {
    $('#pairing-overlay').classList.add('hidden');
    $('#pairing-error').textContent = '';
  }

  $('#pairing-submit').addEventListener('click', submitPairing);
  $('#pairing-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPairing();
  });

  async function submitPairing() {
    const code = $('#pairing-code').value.trim();
    if (!/^\d{6}$/.test(code)) {
      $('#pairing-error').textContent = '请输入 6 位数字配对码';
      return;
    }
    try {
      const r = await state.ws.request('auth', { code }, 6000);
      if (r && r.token) onAuthed(r);
      else $('#pairing-error').textContent = (r && r.error) || '配对失败';
    } catch (e) {
      $('#pairing-error').textContent = '连接失败，请重试';
    }
  }

  function onInfo(info) {
    if (!info) return;
    if (info.deviceName) $('#device-name').textContent = info.deviceName;
    setExt(!!info.extensionConnected);
    $('#about-text').textContent =
      `局域网智能遥控器 v${info.version || '1.0.0'}\n` +
      `设备：${info.deviceName || '-'}\n` +
      `AI：${info.aiProvider === 'openai' ? '服务端已接入模型（' + info.aiModel + '）' : '未启用（服务端保留 ai_query，见 README）'}`;
  }

  async function refreshAll() {
    try {
      const info = await cmd('get_info');
      if (info) onInfo(info);
    } catch (e) {}
    loadMacros();
    // 连接/配对后立刻拉一次状态，不用等扩展 2 秒一轮的推送
    cmd('get_status').then((r) => { if (r && r.ok) onPlayback(r); }).catch(() => {});
  }

  // ---------- 模式（自动模块切换） ----------
  const CHIP = {
    video: '▶ 播放控制',
    feed: '📺 刷视频',
    grid: '📺 遥控面板',
    other: '🖥 网页',
    '': '📺 遥控器'
  };
  const HINT = {
    video: '◀▶ 快退/快进 · 长按2x　▲▼ 音量 · OK 播放暂停 · ↩ 退出',
    feed: '▲▼ 切换视频 · OK 播放/暂停 · ↩ 返回',
    grid: '方向键选择视频 · OK 打开 · ↩ 返回',
    other: '方向键辅助翻页 · 工具在“•••”里',
    '': '连接电脑后可用五键遥控'
  };

  function applyModule(pm) {
    state.pageMode = pm || '';
    const chip = $('#mode-chip');
    chip.textContent = CHIP[state.pageMode] || CHIP[''];

    // 次要功能键只在对应语义下出现：视频语义→全屏，网格语义→换一换
    $('#aux-fullscreen').classList.toggle('hidden', state.pageMode !== 'video');
    $('#aux-refresh').classList.toggle('hidden', state.pageMode !== 'grid');

    const video = state.pageMode === 'video';
    if (video === state.videoMode) { updateHint(); updateOkGlyph(); return; }
    state.videoMode = video;
    $('#dpad').classList.toggle('video-mode', video);
    updateHint();
    updateOkGlyph();
  }

  function updateHint() {
    // 没有可控浏览器（扩展未连接 = 电脑上没开浏览器）时，OK 直接打开 B 站
    if (!state.videoMode && !state.extConnected) {
      $('#dpad-hint').textContent = state.authed
        ? 'OK 打开 B 站 · 电脑上打开浏览器后自动接管网页'
        : '连接电脑后可用五键遥控';
      return;
    }
    const t = state.videoMode ? HINT.video : (HINT[state.pageMode] || HINT['']);
    $('#dpad-hint').textContent = t;
  }

  function updateOkGlyph() {
    const ok = $('#ok-glyph');
    if (state.videoMode) {
      ok.textContent = state.playback.isPlaying ? '⏸' : '▶';
    } else {
      ok.textContent = 'OK';
    }
  }

  // ---------- 播放状态 ----------
  function onPlayback(p) {
    if (!p) return;
    setExt(true);
    const pb = state.playback;
    pb.hasVideo = p.hasVideo !== false && !!(p.title || p.currentTime || p.duration);
    pb.title = p.title || pb.title;
    pb.platform = p.platform || '';
    if (p.isPlaying !== undefined && p.isPlaying !== null) pb.isPlaying = !!p.isPlaying;
    if (p.volume !== undefined && p.volume !== null) pb.volume = p.volume;
    if (p.muted) pb.volume = 0;
    pb.currentTime = p.currentTime || 0;
    pb.duration = p.duration || 0;
    if (p.pageMode) applyModule(p.pageMode);
    updatePlayer();
  }

  function updatePlayer() {
    const p = state.playback;
    updateOkGlyph();

    if (p.hasVideo && p.title) {
      $('#video-title').textContent = p.title;
      const platform = p.platform ? p.platform.replace(/^www\./, '') : '';
      const time = p.duration > 0
        ? `${formatTime(p.currentTime)} / ${formatTime(p.duration)}`
        : formatTime(p.currentTime);
      $('#video-meta').textContent = platform ? `${platform} · ${time}` : time;
    } else {
      $('#video-title').textContent = state.authed ? '浏览器未播放视频' : '等待连接电脑…';
      $('#video-meta').textContent = state.authed ? '打开视频后用 ◀▶▲▼ OK 控制' : '连接后可控制电脑上的浏览器';
    }

    $('#volume-text').textContent = p.volume != null && p.volume > 0
      ? `🔊 ${Math.round(p.volume * 100)}%`
      : (p.volume === 0 ? '🔇 静音' : '🔊 --');

    // 音量滑杆跟随播放状态（用户正在拖动时不抢）
    if (!volDragging) {
      if (p.volume != null) {
        volSlider.value = Math.round(p.volume * 100);
        $('#vol-val').textContent = Math.round(p.volume * 100) + '%';
      } else {
        $('#vol-val').textContent = '--';
      }
    }

    if (!state.dragging) {
      const pct = p.duration > 0 ? Math.min(100, (p.currentTime / p.duration) * 100) : 0;
      renderProgress(pct);
    }
    $('#progress-bar').classList.toggle('seekable', p.duration > 0);
  }

  // 本地进度平滑（播放中每 0.5s 推进，服务器状态定期校正）
  setInterval(() => {
    const p = state.playback;
    if (state.dragging) return;
    if (p.hasVideo && p.isPlaying && p.duration > 0) {
      p.currentTime = Math.min(p.duration, p.currentTime + 0.5);
      renderProgress(Math.min(100, (p.currentTime / p.duration) * 100));
      $('#video-meta').textContent = (p.platform ? p.platform.replace(/^www\./, '') + ' · ' : '') +
        `${formatTime(p.currentTime)} / ${formatTime(p.duration)}`;
    }
  }, 500);

  // ---------- 进度条拖动跳转 ----------
  const progressBar = $('#progress-bar');
  const progressThumb = $('#progress-thumb');
  let seekDrag = null;

  function renderProgress(pct) {
    pct = Math.max(0, Math.min(100, pct || 0));
    $('#progress-fill').style.width = pct + '%';
    progressThumb.style.left = pct + '%';
  }

  function seekPctFromEvent(e) {
    const r = progressBar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
  }

  progressBar.addEventListener('pointerdown', (e) => {
    const p = state.playback;
    if (!(p.duration > 0)) return; // 没有时长信息（未播放/扩展离线）时不可拖
    e.preventDefault();
    try { progressBar.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    state.dragging = true;
    progressBar.classList.add('dragging');
    seekDrag = { id: e.pointerId, pct: seekPctFromEvent(e) };
    renderProgress(seekDrag.pct * 100);
    $('#video-meta').textContent = `${formatTime(seekDrag.pct * p.duration)} / ${formatTime(p.duration)}`;
  });

  progressBar.addEventListener('pointermove', (e) => {
    if (!seekDrag || e.pointerId !== seekDrag.id) return;
    const p = state.playback;
    seekDrag.pct = seekPctFromEvent(e);
    renderProgress(seekDrag.pct * 100);
    $('#video-meta').textContent = `${formatTime(seekDrag.pct * p.duration)} / ${formatTime(p.duration)}`;
  });

  function endSeek(e) {
    if (!seekDrag || (e && e.pointerId !== seekDrag.id)) return;
    const p = state.playback;
    const target = seekDrag.pct * (p.duration || 0);
    seekDrag = null;
    state.dragging = false;
    progressBar.classList.remove('dragging');
    if (p.duration > 0) {
      p.currentTime = target; // 先本地落位，避免松手瞬间跳回旧位置
      cmd('seek_to', { time: Math.round(target) }).catch(() => {});
    }
  }
  progressBar.addEventListener('pointerup', endSeek);
  progressBar.addEventListener('pointercancel', endSeek);

  // ---------- 音量滑杆（精确调音量） ----------
  const volSlider = $('#vol-slider');
  let volDragging = false;
  let volTimer = null;

  function pushVolume() {
    const v = Math.max(0, Math.min(1, Number(volSlider.value) / 100));
    state.playback.volume = v;
    $('#volume-text').textContent = v > 0 ? `🔊 ${Math.round(v * 100)}%` : '🔇 静音';
    $('#vol-val').textContent = Math.round(v * 100) + '%';
    cmd('set_volume', { value: v }).catch(() => {});
  }

  volSlider.addEventListener('input', () => {
    volDragging = true;
    $('#vol-val').textContent = volSlider.value + '%';
    $('#volume-text').textContent = Number(volSlider.value) > 0 ? `🔊 ${volSlider.value}%` : '🔇 静音';
    // 拖动过程中 150ms 合并一次，避免刷屏式命令
    if (volTimer) clearTimeout(volTimer);
    volTimer = setTimeout(() => { volTimer = null; pushVolume(); }, 150);
  });
  volSlider.addEventListener('change', () => {
    if (volTimer) { clearTimeout(volTimer); volTimer = null; }
    pushVolume();
    volDragging = false;
  });

  // ---------- 主键区：五键 + 返回（语义随模块自动切换） ----------
  // 浏览模式下服务端逐条串行处理 tv_nav，连按会积压排队、看起来"卡"。
  // 这里做合并排队：同一时刻只发一条，方向键连按只保留最新方向，OK/返回排在其后，
  // 保证不丢操作、不堆命令、响应跟手。
  const navPending = [];
  let navRunning = false;

  function tvNav(dir) {
    const isDir = dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right';
    if (navRunning) {
      const last = navPending[navPending.length - 1];
      const lastIsDir = last === 'up' || last === 'down' || last === 'left' || last === 'right';
      if (isDir && lastIsDir) navPending[navPending.length - 1] = dir; // 连按方向键：合并为最新
      else navPending.push(dir);
      return;
    }
    navRunning = true;
    const isMove = isDir; // 纯方向移动不弹提示，避免连按时弹层干扰
    cmd('browser_action', { action: 'tv_nav', payload: { dir } }).then((r) => {
      const res = r && r.result;
      if (res && res.error) {
        // 浏览器没开 / 当前页不可控：OK 直接打开 B 站（遥控器的"回家"语义）
        if (dir === 'ok' && /不支持|无可用标签页/.test(res.error)) {
          openBilibili();
          return;
        }
        toast(res.error, 'err');
      }
      else if (!isMove && res && res.opened) toast('打开：' + res.opened, 'ok', 1500);
      else if (!isMove && res && res.closedModal) toast('已退出视频', 'ok', 1000);
      else if (!isMove && res && res.action === 'play_pause') { /* 静默：OK 控制播放 */ }
    }).catch(() => {})
      .finally(() => {
        navRunning = false;
        const next = navPending.shift();
        if (next) tvNav(next);
      });
  }

  /** 播放模块：长按左/右 → 2 倍速播放（松手恢复）；单击 → 快退/快进 */
  function speedSet(dir, on) {
    if (on) {
      if (state.extConnected) {
        cmd('browser_action', { action: 'speed_start', payload: { rate: 2 } }).catch(() => {
          cmd('key_down', { key: dir === 'left' ? 'left' : 'right' }).catch(() => {});
        });
      } else {
        cmd('key_down', { key: dir === 'left' ? 'left' : 'right' }).catch(() => {});
      }
    } else if (state.extConnected) {
      cmd('browser_action', { action: 'speed_stop' }).catch(() => {
        cmd('key_up', { key: dir === 'left' ? 'left' : 'right' }).catch(() => {});
      });
    } else {
      cmd('key_up', { key: dir === 'left' ? 'left' : 'right' }).catch(() => {});
    }
  }

  function fireDir(btn, dir) {
    // 返回键两种模式语义一致：电脑端根据页面形态决定"退选择/关浮层/关播放标签"
    if (dir === 'back') { tvNav('back'); return; }

    if (state.videoMode) {
      switch (dir) {
        case 'up': cmd('volume_up').catch(() => {}); break;
        case 'down': cmd('volume_down').catch(() => {}); break;
        case 'left': cmd('seek_backward', { seconds: 10 }).catch(() => {}); break;
        case 'right': cmd('seek_forward', { seconds: 10 }).catch(() => {}); break;
        case 'ok': cmd('play_pause').catch(() => {}); break;
      }
      return;
    }

    // 电脑上没开浏览器（扩展未连接）→ OK 打开 B 站
    if (dir === 'ok' && !state.extConnected) {
      openBilibili();
      return;
    }
    tvNav(dir);
  }

  /** 打开 B 站：扩展在线时在当前标签打开，浏览器没开时由电脑端直接启动默认浏览器 */
  function openBilibili() {
    cmd('browser_open', { url: 'https://www.bilibili.com' })
      .then(() => toast('正在打开 B 站…', 'ok', 1500))
      .catch(() => {});
  }

  // 手机切后台/锁屏时必须松开长按中的方向键，否则电脑上会一直按着（卡键）
  const holdEnders = new Set();
  window.addEventListener('blur', () => holdEnders.forEach((fn) => fn()));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) holdEnders.forEach((fn) => fn());
  });

  document.querySelectorAll('.dpad-key[data-dir]').forEach((btn) => {
    const dir = btn.dataset.dir;
    let holdT = null;
    let held = false;

    const startHold = () => {
      // 仅播放模块的左右键支持长按 2x
      if (!state.videoMode || (dir !== 'left' && dir !== 'right')) return;
      holdT = setTimeout(() => {
        holdT = null;
        held = true;
        btn.classList.add('hold');
        btn.dataset.holdJust = '1';
        speedSet(dir, true);
      }, LONG_PRESS_MS);
    };
    const endHold = () => {
      if (holdT) { clearTimeout(holdT); holdT = null; }
      if (held) {
        held = false;
        btn.classList.remove('hold');
        speedSet(dir, false);
      }
    };
    holdEnders.add(endHold);
    btn.addEventListener('pointerdown', startHold);
    btn.addEventListener('pointerup', endHold);
    btn.addEventListener('pointercancel', endHold);
    btn.addEventListener('pointerleave', () => { if (held || holdT) endHold(); });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (btn.dataset.holdJust) { btn.dataset.holdJust = ''; return; } // 长按抬起不触发单击
      fireDir(btn, dir);
    });
  });

  // ---------- 更多工具 底部弹层 ----------
  const sheetMask = $('#sheet-mask');
  function openSheet() { sheetMask.classList.remove('hidden'); }
  function closeSheet() { sheetMask.classList.add('hidden'); }
  $('#btn-more').addEventListener('click', openSheet);
  $('#sheet-close').addEventListener('click', closeSheet);
  sheetMask.addEventListener('click', (e) => { if (e.target === sheetMask) closeSheet(); });

  // ---------- 方向键角落的次要功能键（比方向键小，按语义显隐） ----------
  /** 全屏开关：仅视频语义显示 */
  function doFullscreen() {
    cmd('fullscreen').then((r) => {
      const res = r && (r.via !== undefined ? r : r.result);
      if (!res) return;
      const via = String(res.via || '');
      // 用扩展报告的"动作方向"给反馈，比猜测状态更准（网页全屏与浏览器全屏可能同时存在）
      if (via.indexOf('exit') === 0) toast('已退出全屏', 'ok', 1200);
      else if (via === 'button' || via === 'api') toast('已进入全屏', 'ok', 1200);
    }).catch(() => {});
  }

  /** 换一换：仅网格语义显示 */
  function doRefreshFeed() {
    cmd('browser_action', { action: 'refresh_feed' })
      .then(() => toast('已换一换', 'ok', 1200))
      .catch(() => {});
  }

  $('#aux-fullscreen').addEventListener('click', doFullscreen);
  $('#aux-refresh').addEventListener('click', doRefreshFeed);

  // 快捷动作：上/下集、静音（全屏/换一换已移到方向键角落）
  const quickActs = [
    ['q-prev', () => cmd('prev_episode').catch(() => {})],
    ['q-next', () => cmd('next_episode').catch(() => {})],
    ['q-mute', () => cmd('mute').catch(() => {})]
  ];
  quickActs.forEach(([id, fn]) => {
    $('#' + id).addEventListener('click', fn);
  });

  // 设置入口（打开设置弹层）
  $('#btn-settings').addEventListener('click', () => {
    closeSheet();
    $('#settings-overlay').classList.remove('hidden');
  });
  $('#btn-settings-close').addEventListener('click', () => {
    $('#settings-overlay').classList.add('hidden');
  });

  // 切换浏览器标签页（需扩展）
  $('#btn-tabswitch').addEventListener('click', () => {
    cmd('browser_action', { action: 'next_tab' }).then((r) => {
      const res = r && r.result;
      if (res && res.ok) toast('已切换到：' + (res.tabTitle || res.tabUrl || '下一标签'), null, 1500);
    }).catch(() => {});
  });

  // ---------- 触摸板（在"更多"弹层内） ----------
  // 缩放后的小数位移要累积再发送，否则小位移被取整抹成 0（表现就是"断触/不走")
  let accX = 0;
  let accY = 0;
  new Touchpad($('#touchpad-surface'), {
    onMove: (dx, dy) => {
      accX += dx * state.sensitivity;
      accY += dy * state.sensitivity;
      const mx = Math.trunc(accX);
      const my = Math.trunc(accY);
      if (!mx && !my) return;
      accX -= mx;
      accY -= my;
      cmd('mouse_move', { dx: mx, dy: my }).catch(() => {});
    },
    onTap: () => cmd('mouse_click', { button: 'left' }).catch(() => {}),
    onTwoTap: () => cmd('mouse_click', { button: 'right' }).catch(() => {}),
    onScroll: (steps) => cmd('scroll', { dy: steps }).catch(() => {})
  });

  // ---------- 键盘 ----------
  document.querySelectorAll('.kb-key[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cmd('key_press', { key: btn.dataset.key }).catch(() => {});
    });
  });

  $('#kb-send-text').addEventListener('click', sendText);
  $('#kb-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
  function sendText() {
    const inp = $('#kb-text');
    const text = inp.value;
    if (!text) return;
    cmd('text_type', { text }).then(() => { inp.value = ''; }).catch(() => {});
  }

  $('#kb-send-combo').addEventListener('click', sendCombo);
  $('#kb-combo').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCombo(); });
  function sendCombo() {
    const inp = $('#kb-combo');
    const keys = inp.value.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
    if (!keys.length) return;
    cmd('key_combo', { keys }).then(() => { inp.value = ''; }).catch(() => {});
  }

  // ---------- 宏 ----------
  function loadMacros() {
    cmd('macro_list').then((r) => {
      state.macros = (r && r.macros) || [];
      renderMacros();
      renderMacroManage();
    }).catch(() => {});
  }

  function renderMacros() {
    const grid = $('#macro-grid');
    grid.innerHTML = '';
    state.macros.forEach((m) => {
      const b = document.createElement('button');
      b.className = 'macro-btn';
      const icon = document.createElement('div');
      icon.className = 'macro-icon';
      icon.textContent = '⚡';
      const name = document.createElement('span');
      name.className = 'macro-name';
      name.textContent = m.name;
      b.appendChild(icon);
      b.appendChild(name);
      b.addEventListener('click', () => {
        cmd('macro_execute', { macro_id: m.id })
          .then(() => toast(`正在执行：${m.name}`))
          .catch(() => {});
      });
      grid.appendChild(b);
    });
    if (!state.macros.length) {
      const empty = document.createElement('div');
      empty.className = 'setting-hint';
      empty.style.gridColumn = '1 / -1';
      empty.textContent = '暂无宏，点上方「管理 / 录制」创建';
      grid.appendChild(empty);
    }
  }

  function renderMacroManage() {
    const list = $('#macro-manage-list');
    list.innerHTML = '';
    state.macros.forEach((m) => {
      const item = document.createElement('div');
      item.className = 'macro-manage-item';
      const name = document.createElement('span');
      name.className = 'm-name';
      name.textContent = m.name;
      const steps = document.createElement('span');
      steps.className = 'm-steps';
      steps.textContent = `${m.steps} 步`;
      const del = document.createElement('button');
      del.className = 'mini-btn danger';
      del.textContent = '删除';
      del.addEventListener('click', () => {
        cmd('macro_delete', { macro_id: m.id }).then(() => {
          toast('已删除', 'ok');
          loadMacros();
        }).catch(() => {});
      });
      item.appendChild(name);
      item.appendChild(steps);
      item.appendChild(del);
      list.appendChild(item);
    });
  }

  // ---------- 宏录制 ----------
  function setRecording(rec) {
    state.recording = rec;
    $('#record-banner').classList.toggle('active', rec);
  }

  $('#btn-manage-macros').addEventListener('click', () => {
    $('#settings-overlay').classList.remove('hidden');
  });
  $('#btn-record-start').addEventListener('click', () => {
    cmd('macro_record_start').then(() => {
      setRecording(true);
      $('#settings-overlay').classList.add('hidden');
      toast('开始录制：请在电脑上操作，完成后点「停止并保存」', 'ok', 4000);
    }).catch(() => {});
  });

  $('#btn-record-stop').addEventListener('click', async () => {
    try {
      const r = await cmd('macro_record_stop');
      if (r && r.macro) {
        const name = prompt('宏名称：', r.macro.name || '我的宏');
        if (name) {
          await cmd('macro_save', { macro: { id: r.macro.id, name, steps: r.macro.steps } });
          toast('宏已保存', 'ok');
        } else {
          await cmd('macro_record_cancel').catch(() => {});
        }
        loadMacros();
      }
      setRecording(false);
    } catch (e) {
      setRecording(false);
    }
  });

  $('#btn-record-cancel').addEventListener('click', () => {
    cmd('macro_record_cancel').catch(() => {});
    setRecording(false);
  });

  $('#btn-repair').addEventListener('click', () => {
    localStorage.removeItem('rc_token');
    location.reload();
  });

  // 灵敏度
  const sensSlider = $('#sens-slider');
  sensSlider.value = state.sensitivity;
  $('#sens-value').textContent = state.sensitivity.toFixed(1) + 'x';
  sensSlider.addEventListener('input', () => {
    state.sensitivity = parseFloat(sensSlider.value);
    localStorage.setItem('rc_sens', String(state.sensitivity));
    $('#sens-value').textContent = state.sensitivity.toFixed(1) + 'x';
  });

  // ---------- PWA ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  updatePlayer();
  applyModule('');
})();
