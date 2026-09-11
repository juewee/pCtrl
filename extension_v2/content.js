/*
 * content script：注入到所有页面，识别 <video>/<audio> 并执行播放控制。
 * 通过 chrome.runtime.onMessage 接收 background 转发的指令。
 */
(function () {
  if (window.__remoteControlInstalled) return;
  window.__remoteControlInstalled = true;

  function videos() {
    return Array.from(document.querySelectorAll('video'));
  }

  /** 选择页面中面积最大的视频元素（主播放器） */
  function mainVideo() {
    const vs = videos()
      .filter((v) => v.clientWidth > 40 || v.clientHeight > 40)
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    return vs[0] || null;
  }

  /** 站点可读标题：抖音等信息流页 document.title 恒定，取当前视频描述文案 */
  function friendlyTitle() {
    let t = '';
    try {
      const d = document.querySelector('[data-e2e="video-desc"], [class*="video-info-detail"] [class*="title"], .xgplayer-video-info-wrap [class*="title"]');
      if (d) t = d.textContent.replace(/\s+/g, ' ').trim();
    } catch (e) { /* 忽略选择器/取值异常 */ }
    if (t) return t.slice(0, 80);
    const dt = document.title;
    return (dt || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /** 当前页"交互形态"，驱动手机遥控器自动切换按键语义 */
  function pageModeOf() {
    if (/douyin\.com\/(video|note)/.test(location.pathname)) return 'feed'; // 抖音单视频页本质是可上下刷的播放流
    if (isDouyinModal()) return 'feed'; // 抖音大屏浮层：刷视频语义（▲▼切、OK 播放/暂停）
    if (isDouyinGrid()) return 'grid'; // 卡片网格：空间选卡
    if (isDouyinFeed()) return 'feed'; // 信息流：上下切换视频
    const v = mainVideo();
    if (v) {
      const r = v.getBoundingClientRect();
      const wide = r.width >= 420 && r.width / Math.max(1, window.innerWidth) >= 0.4;
      if (wide) return 'video'; // 传统横屏播放页：←→进度/倍速、▲▼音量、OK 播放
    }
    if (/bilibili\.com|youtube\.com|douyin\.com/.test(location.hostname)) return 'grid';
    return 'other';
  }

  function status(v) {
    return {
      ok: true,
      hasVideo: !!v,
      pageMode: pageModeOf(),
      title: friendlyTitle(),
      platform: location.hostname,
      isPlaying: v ? !v.paused : false,
      paused: v ? v.paused : null,
      volume: v ? v.volume : null,
      muted: v ? v.muted : null,
      rate: v ? v.playbackRate : null,
      fullscreen: fullscreenNow(),
      currentTime: v ? v.currentTime : 0,
      duration: v && isFinite(v.duration) ? v.duration : 0
    };
  }

  /** 派发完整的鼠标事件序列（部分站点只监听 mousedown/mouseup） */
  function realClick(el) {
    try {
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch (e) {
      try { el.click(); } catch (_) {}
    }
  }

  /** 播放器外层容器（全屏容器而不是 <video>，弹幕和控件才能一起全屏） */
  function playerContainer(v) {
    if (!v) return document.documentElement;
    return v.closest(
      '.bpx-player-container, #bilibili-player, .bilibili-player, .xgplayer, .html5-video-player, .video-js, [class*="player-container"]'
    ) || v.parentElement || document.documentElement;
  }

  // ---------- 全屏：严格"切换"语义 ----------
  // 曾经的问题：旧实现发现"网页全屏/宽屏"状态时，先点按钮退出网页全屏、再点全屏按钮进浏览器全屏，
  // 于是用户看到"点了全屏 → 全屏被取消 → 马上又全屏"。现在先判断当前是否真的在全屏，
  // 在 → 只退出并直接返回；不在 → 才尝试进入，绝不在同一次调用里又退又进。
  let _fsBusy = false;
  let _fsCooldownUntil = 0;

  function browserFullscreenEl() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
  }

  /**
   * 站点自己实现的"伪全屏"（CSS 铺满，不走 Fullscreen API）：
   *  - B站 bpx 播放器 data-screen="web"（网页全屏/宽屏）、data-screen="full"
   *  - 旧版 B站 .bilibili-player-web-fullscreen
   *  - YouTube 影院模式 ytp-fullwindow
   */
  function siteFullscreenKind() {
    const box = document.querySelector('.bpx-player-container[data-screen], .bilibili-player[data-screen]');
    if (box) {
      const s = (box.getAttribute('data-screen') || '').toLowerCase();
      if (s === 'web' || s === 'wide') return 'bili-web';
      if (s === 'full') return 'bili-full';
      return ''; // data-screen="normal"：明确不在全屏，忽略其他 class 猜测
    }
    if (document.querySelector('.bpx-player-web-fullscreen, .bilibili-player-web-fullscreen')) return 'bili-web';
    const ytp = document.querySelector('.html5-video-player');
    if (ytp && ytp.classList.contains('ytp-fullwindow')) return 'ytp-window';
    return '';
  }

  function fullscreenNow() {
    return !!browserFullscreenEl() || !!siteFullscreenKind();
  }

  /** 退出站点伪全屏：点它自己的开关按钮（同一个按钮就是切换开关） */
  async function exitSiteFullscreen(kind) {
    let btn = null;
    if (kind === 'ytp-window') {
      btn = document.querySelector('.ytp-size-button');
    } else if (kind === 'bili-full') {
      btn = document.querySelector('.bpx-player-ctrl-full') ||
        document.querySelector('.bilibili-player-video-btn-fullscreen');
    } else {
      btn = document.querySelector('.bpx-player-ctrl-wide') ||
        document.querySelector('.bilibili-player-video-btn-web-fullscreen') ||
        document.querySelector('[aria-label*="网页全屏"]');
    }
    if (btn && btn.offsetParent !== null) {
      realClick(btn);
      await new Promise((r) => setTimeout(r, 220));
    }
    return !siteFullscreenKind();
  }

  async function toggleFullscreen(v) {
    if (_fsBusy) return { ok: false, error: '全屏正在切换中，请稍候' };
    if (Date.now() < _fsCooldownUntil) {
      return { ok: true, via: 'cooldown', fullscreen: fullscreenNow() };
    }
    _fsBusy = true;
    try {
      // 1) 已在全屏 → 只退出
      if (browserFullscreenEl()) {
        try {
          if (document.exitFullscreen) await document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } catch (e) { /* 忽略 */ }
        await new Promise((r) => setTimeout(r, 120));
        return { ok: true, via: 'exit', fullscreen: fullscreenNow() };
      }
      const kind = siteFullscreenKind();
      if (kind) {
        await exitSiteFullscreen(kind);
        return { ok: true, via: 'exit-' + kind, fullscreen: fullscreenNow() };
      }

      // 2) 不在全屏 → 优先点站点真实全屏按钮（播放器自己处理，弹幕/控件一起全屏）
      const btnSelectors = [
        '.bpx-player-ctrl-full',                   // B站新版 bpx 播放器（浏览器全屏）
        '.bilibili-player-video-btn-fullscreen',   // B站旧版播放器
        '.ytp-fullscreen-button',                  // YouTube
        '[data-e2e="xgplayer-page-full-screen"]',  // 抖音 xgplayer
        '.xgplayer-fullscreen', '.xgplayer-page-full-screen',
        '[aria-label="浏览器全屏"]',
        '[aria-label*="全屏" i]',
        'button[class*="fullscreen"]',
        '[class*="fullscreen-btn"]'
      ];
      for (const sel of btnSelectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          realClick(btn);
          await new Promise((r) => setTimeout(r, 300));
          if (fullscreenNow()) return { ok: true, via: 'button', fullscreen: true };
          break; // 点了但没进全屏（合成事件被忽略或手势限制），走 API 兜底
        }
      }

      // 3) API 兜底：对播放器容器请求全屏（弹幕控件一起全屏）
      const el = playerContainer(v);
      try {
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        return { ok: true, via: 'api', fullscreen: fullscreenNow() };
      } catch (e) {
        return { ok: false, error: '全屏被浏览器拦截，请先在电脑网页上点一下页面再试' };
      }
    } finally {
      // 切换后短暂冷却：防止重复/回退命令紧接着再切一次，造成"取消又全屏"的抖动
      _fsBusy = false;
      _fsCooldownUntil = Date.now() + 700;
    }
  }

  // ---------- 长按倍速 ----------
  let _savedRate = null;
  function speedStart(v, rate) {
    if (!v) return { ok: false, error: '未检测到视频' };
    if (_savedRate === null) _savedRate = v.playbackRate;
    v.playbackRate = Number(rate) || 2;
    return status(v);
  }
  function speedStop(v) {
    if (v && _savedRate !== null) v.playbackRate = _savedRate;
    _savedRate = null;
    return status(v);
  }

  // ---------- 首页"换一换/刷新内容" ----------
  function refreshFeed() {
    // B站首页推荐流的"换一换"按钮（2026 新版为 .feed-roll-btn 内的 button.roll-btn；
    // 旧版为 .flexible-roll-btn，注意新版页面里该元素带 hidden 类不可点）
    const btn =
      document.querySelector('.feed-roll-btn button.roll-btn') ||
      document.querySelector('button.roll-btn') ||
      document.querySelector('.feed-roll-btn') ||
      document.querySelector('.flexible-roll-btn:not(.hidden)') ||
      document.querySelector('.rollback-btn') ||
      document.querySelector('[aria-label*="换一换"]') ||
      document.querySelector('[title*="换一换"]');
    if (btn && btn.offsetParent !== null) {
      realClick(btn);
      return { ok: true, refreshed: true };
    }
    // 其他站点：刷新整个标签页
    location.reload();
    return { ok: true, reloaded: true };
  }

  // ---------- 电视遥控式空间导航（上下左右选视频，OK 打开，返回上一页） ----------
  let _tvFocus = null;
  let _tvGhost = null; // 独立顶层高亮框：避免被播放器等兄弟元素盖住

  function ensureTvStyle() {
    if (_tvGhost) return;
    const g = document.createElement('div');
    g.id = '__rc-tv-ghost__';
    g.style.cssText =
      'position:fixed; left:0; top:0; width:0; height:0; display:none; pointer-events:none; z-index:2147483647;' +
      'border:3px solid #6c5ce7; border-radius:10px; box-sizing:border-box;' +
      'box-shadow:0 0 0 4px rgba(108,92,231,.35), 0 0 26px rgba(108,92,231,.95);' +
      'background:rgba(108,92,231,.08);';
    document.documentElement.appendChild(g);
    _tvGhost = g;
    window.addEventListener('scroll', syncTvGhost, { passive: true, capture: true });
    window.addEventListener('resize', syncTvGhost, { passive: true });
    window.addEventListener('wheel', syncTvGhost, { passive: true });
  }

  function syncTvGhost() {
    if (!_tvGhost || !_tvFocus || _tvGhost.style.display === 'none') return;
    const r = _tvFocus.getBoundingClientRect();
    if (!r.width) return;
    _tvGhost.style.left = (r.left - 5) + 'px';
    _tvGhost.style.top = (r.top - 5) + 'px';
    _tvGhost.style.width = (r.width + 10) + 'px';
    _tvGhost.style.height = (r.height + 10) + 'px';
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  /** 导航排除区域：首页轮播 banner、广告位、页头横幅等非视频卡片元素 */
  const TV_EXCLUDE_SEL = [
    '.carousel', '.carousel-container', '.vui_carousel',
    '[class*="carousel"]', '[class*="banner"]', '[class*="swiper"]', // B站首页顶部轮播大图
    'ytd-ad-slot-renderer', '[class*="ad-slot"]', '[class*="masthead"]' // YouTube 广告位
  ].join(', ');

  /** 收集页面上可导航的视频卡片/链接（B站/抖音/YouTube 等通用） */
  function tvCandidates() {
    // 抖音精选/大屏网格页：以封面图容器为卡片（小卡无 <a>，统一走空间导航）
    if (isDouyinGrid()) return douyinGridCandidates();
    const cardSel = '.bili-video-card, ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer';
    const inExcluded = (el) => !!(el.closest && el.closest(TV_EXCLUDE_SEL));
    const nodes = new Set();
    document.querySelectorAll(cardSel).forEach((el) => {
      if (isVisible(el) && !inExcluded(el)) nodes.add(el);
    });
    document
      .querySelectorAll('a[href*="/video/"], a[href*="/bangumi/play/"], a[href*="watch?v="]')
      .forEach((a) => {
        if (!isVisible(a)) return;
        // 链接若已包含在卡片内，导航时以卡片为准
        if (a.closest(cardSel)) return;
        // 轮播 banner / 广告位里的推广链接不参与方向导航
        if (inExcluded(a)) return;
        nodes.add(a);
      });
    return Array.from(nodes);
  }

  function tvLabel(el) {
    const t =
      el.getAttribute('title') ||
      el.getAttribute('aria-label') ||
      (el.querySelector('img[alt]') && el.querySelector('img[alt]').alt) ||
      (el.querySelector('.bili-video-card__info--tit, #video-title, .title, h3') &&
        el.querySelector('.bili-video-card__info--tit, #video-title, .title, h3').textContent.trim()) ||
      el.textContent.trim().slice(0, 40);
    return (t || '').replace(/\s+/g, ' ').slice(0, 40);
  }

  function setTvFocus(el) {
    _tvFocus = el;
    if (el) {
      ensureTvStyle();
      _tvGhost.style.display = 'block';
      syncTvGhost();
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (_tvGhost) {
      _tvGhost.style.display = 'none';
    }
  }

  function tvMove(dir) {
    const cands = tvCandidates();
    if (!cands.length) return { ok: false, error: '当前页面没有可选项' };

    if ((dir === 'up' || dir === 'left') && !_tvFocus) {
      setTvFocus(cands[cands.length - 1]);
      return { ok: true, label: tvLabel(_tvFocus), count: cands.length };
    }
    if (!_tvFocus || !document.contains(_tvFocus)) {
      setTvFocus(cands[0]);
      return { ok: true, label: tvLabel(_tvFocus), count: cands.length };
    }

    const cur = _tvFocus.getBoundingClientRect();
    const cx = cur.left + cur.width / 2;
    const cy = cur.top + cur.height / 2;
    let best = null;
    let bestScore = Infinity;

    for (const el of cands) {
      if (el === _tvFocus) continue;
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      const dx = ex - cx;
      const dy = ey - cy;
      let primary, secondary, aligned;
      if (dir === 'down') { primary = dy; secondary = Math.abs(dx); aligned = dy > 20; }
      else if (dir === 'up') { primary = -dy; secondary = Math.abs(dx); aligned = dy < -20; }
      else if (dir === 'right') { primary = dx; secondary = Math.abs(dy); aligned = dx > 20; }
      else { primary = -dx; secondary = Math.abs(dy); aligned = dx < -20; }
      if (!aligned) continue;
      // 主轴距离为主权重，横向/纵向偏移为次权重
      const score = primary * 1.4 + secondary * 0.8;
      if (score < bestScore) { bestScore = score; best = el; }
    }

    if (best) {
      setTvFocus(best);
      return { ok: true, label: tvLabel(best), count: cands.length };
    }
    // 该方向已到边缘：保持当前项
    return { ok: true, label: tvLabel(_tvFocus), count: cands.length, edge: true };
  }

  function tvOk() {
    if (!_tvFocus || !document.contains(_tvFocus)) return { ok: false, error: '请先用方向键选择' };
    const target = _tvFocus.matches('a[href]') ? _tvFocus : _tvFocus.querySelector('a[href]') || _tvFocus;
    const label = tvLabel(_tvFocus);
    setTvFocus(null);
    realClick(target);
    return { ok: true, opened: label };
  }

  async function tvBack() {
    // 精选网格 / 抖音"浮层式"大屏播放（仍在页面内，非 /video 详情标签）：返回只退一层，不关标签
    const inDyOverlay = isDouyinModal() && !/\/video\/|\/note\//.test(location.pathname);
    const wasGrid = isDouyinGrid() || inDyOverlay;
    setTvFocus(null);
    if (wasGrid) {
      // 抖音精选页点开过视频（modal_id 浮层/大屏播放）：返回 = 关闭浮层回到卡片网格
      if (/modal_id=/.test(location.search) && inDyOverlay) {
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        } catch (e) { /* 忽略 */ }
        await new Promise((r) => setTimeout(r, 150));
        if (/modal_id=/.test(location.search) && history.length > 1) history.back(); // SPA 浮层一般由 history 状态打开
        return { ok: true, closedModal: true };
      }
      return { ok: true, cleared: true }; // 纯网格态："返回"仅退出卡片选择，不后退/不关标签
    }
    // 播放/详情页多数由新标签打开（B站等），"返回"语义 = 关掉本标签回到来源页
    try {
      const resp = await new Promise((res) => {
        chrome.runtime.sendMessage({ __rcTab: 'smartBack' }, res);
      });
      if (resp && resp.closed) return { ok: true, closedTab: true };
    } catch (e) { /* 无 background 时忽略 */ }
    if (history.length > 1) { history.back(); return { ok: true, back: true }; }
    return { ok: true, edge: true };
  }

  /** 平台适配：下一集/上一集按钮选择器 */
  function clickEpisode(next) {
    const selectors = next
      ? [
          '.bpx-player-ctrl-next',          // B站新版
          '.bilibili-player-video-btn-next', // B站旧版
          '.xgplayer-playswitch-next',      // 西瓜播放器切集（抖音/头条等字节系）
          '.ytp-next-button',               // YouTube
          '[aria-label*="下一个"]',
          '[aria-label*="下一集"]',
          '[aria-label*="下一条"]',
          '[title*="下一个"]',
          '[title*="下一集"]'
        ]
      : [
          '.bpx-player-ctrl-prev',
          '.bilibili-player-video-btn-prev',
          '.xgplayer-playswitch-prev',
          '.ytp-prev-button',
          '[aria-label*="上一个"]',
          '[aria-label*="上一集"]',
          '[aria-label*="上一条"]',
          '[title*="上一个"]',
          '[title*="上一集"]'
        ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        return true;
      }
    }
    // 抖音/头条等信息流站点：没有切集按钮，用滚轮切换上/下条视频
    if (/douyin\.com|ixigua\.com|toutiao\.com/.test(location.hostname)) {
      return switchFeedVideo(next);
    }
    return false;
  }

  /** 信息流站点（抖音网页版等）：模拟滚轮切换上/下条视频 */
  function switchFeedVideo(next) {
    const target =
      document.querySelector('[data-e2e="feed-active-video"]') ||
      document.querySelector('.xgplayer') ||
      (document.querySelector('video') && document.querySelector('video').closest('div')) ||
      document.documentElement;
    target.dispatchEvent(
      new WheelEvent('wheel', { deltaY: next ? 240 : -240, deltaX: 0, bubbles: true, cancelable: true })
    );
    return true;
  }

  /** 抖音视频浮层/大屏播放态（URL 带 modal_id）：此时是全屏刷视频模式，方向键=滚轮切换，OK=播放暂停 */
  function isDouyinModal() {
    return /douyin\.com/.test(location.hostname) && /modal_id=/.test(location.search);
  }

  /** 抖音精选/大屏卡片网格页判定：多张封面卡 + 可选横屏大播放器（区别于竖屏 feed 与单视频详情页） */
  function isDouyinGrid() {
    if (!/douyin\.com/.test(location.hostname)) return false;
    if (isDouyinModal()) return false; // 大屏播放态不再按卡片网格处理
    if (/\/video\/|\/note\//.test(location.pathname)) return false; // 单视频播放/详情页不按网格处理
    if (location.pathname.indexOf('jingxuan') >= 0) return true; // 精选页必然是卡片网格布局
    const hasBig = Array.from(document.querySelectorAll('video')).some((vd) => {
      if (!vd.offsetParent) return false;
      const r = vd.getBoundingClientRect();
      return r.width >= 700 && r.height >= 280;
    });
    if (hasBig) return true;
    // 无大播放器时按可见封面卡数量判断（多列卡片网格）
    let covers = 0;
    document.querySelectorAll('img').forEach((im) => {
      const r = im.getBoundingClientRect();
      if (im.offsetParent && r.width >= 300 && r.width <= 800 && r.height >= 150 && r.height <= 520) covers++;
    });
    return covers >= 4;
  }

  /** 抖音精选网格：收集"封面图所属容器"作为卡片（小卡无 <a>，统一用空间导航高亮） */
  function douyinGridCandidates() {
    const nodes = new Set();
    const EXCL = 'header, nav, footer, [data-e2e="douyin-navigation"], [data-e2e="searchbar-input"], .semi-tabs-header, .semi-tabs-nav, [class*="semi-tabs-tab"], [class*="semi-tabs-bar"]';
    const inExcl = (el) => {
      for (let p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (p.matches && p.matches(EXCL)) return true;
      }
      return false;
    };
    const coverRect = (im) => {
      const r = im.getBoundingClientRect();
      return r.width >= 150 && r.width <= 2400 && r.height >= 80 && r.height <= 1400;
    };
    // 1) 封面图卡：封面图的直接父容器即卡片单元；若同一卡槽已挂载可见播放器（大屏自动播/hover 预览），以卡槽为单元
    document.querySelectorAll('img').forEach((im) => {
      if (!im.offsetParent || !coverRect(im)) return;
      if (inExcl(im)) return;
      const cover = im.parentElement;
      if (!cover || cover === document.body || !cover.offsetParent || inExcl(cover)) return;
      const slot = cover.parentElement;
      let unit = cover;
      if (slot && slot !== document.body && slot.offsetParent) {
        const pv = slot.querySelector('.xgplayer video, .basePlayerContainer video');
        if (pv && pv.offsetParent) unit = slot; // 卡槽内有播放器（大播放器/hover 预览）→ OK 可感知播放/暂停
      }
      nodes.add(unit);
    });
    // 2) 兜底：可见大播放器/正在预览的小播放器，若其容器内没有已收集的封面图则自身作为卡
    document.querySelectorAll('video').forEach((vd) => {
      const r = vd.getBoundingClientRect();
      if (!vd.offsetParent || r.width < 150 || r.width > 2400 || r.height < 80) return;
      const host = vd.closest('.xgplayer, [class*="videoImage"]') || vd.parentElement;
      if (!host || inExcl(host)) return;
      const hasCover = Array.from(host.querySelectorAll('img')).some((i) => i.offsetParent);
      if (!hasCover) nodes.add(host);
    });
    return Array.from(nodes).filter((el) => isVisible(el) && el !== document.body);
  }

  /** 精选网格 OK：大播放器卡 = 播放/暂停；普通小卡 = 点击卡片（同鼠标行为） */
  function tvOkGrid() {
    if (!_tvFocus || !document.contains(_tvFocus)) return { ok: false, error: '请先用方向键选择' };
    const label = tvLabel(_tvFocus);
    const vd = _tvFocus.querySelector('video');
    if (vd) {
      const r = vd.getBoundingClientRect();
      if (r.width >= 700) { // 焦点在大播放器卡：切换播放/暂停
        if (vd.paused) vd.play().catch(() => {});
        else vd.pause();
        setTvFocus(null);
        return { ok: true, action: 'play_pause', label };
      }
    }
    const target = _tvFocus.matches('a[href]') ? _tvFocus : _tvFocus.querySelector('a[href]') || _tvFocus;
    setTvFocus(null);
    realClick(target);
    return { ok: true, opened: label };
  }

  /** 抖音 PC 信息流/精选大屏：上下遥控键 = 切上/下一条，OK = 播放/暂停 */
  function isDouyinFeed() {
    if (!/douyin\.com/.test(location.hostname)) return false;
    if (isDouyinModal()) return true; // 大屏播放态视为 feed：滚轮切换 + OK 播放暂停
    if (document.querySelector('[data-e2e="feed-active-video"]') || document.querySelector('.slider-video')) return true;
    // 精选页：单支大视频自动播（横屏 xgplayer），无列表/无切条按钮时用滚轮语义切换
    const xg = document.querySelector('.xgplayer');
    if (xg && xg.getBoundingClientRect().width > 600 && xg.querySelector('video')?.duration > 0) return true;
    return false;
  }

  /** 向页面派发真实方向键事件（部分大屏播放器监听全局方向键切视频） */
  function dispatchArrow(dir) {
    const key = dir === 'down' ? 'ArrowDown' : dir === 'up' ? 'ArrowUp' : dir === 'left' ? 'ArrowLeft' : 'ArrowRight';
    const target = document.querySelector('.xgplayer, .douyin-player') || document.activeElement || document.body;
    const opts = { key, code: key, keyCode: dir === 'down' ? 40 : 38, which: dir === 'down' ? 40 : 38, bubbles: true, cancelable: true, composed: true };
    try { target.dispatchEvent(new KeyboardEvent('keydown', opts)); } catch (e) { /* 忽略 */ }
    try { target.dispatchEvent(new KeyboardEvent('keyup', opts)); } catch (e) { /* 忽略 */ }
  }

  function douyinFeedNav(dir) {
    const nb = document.querySelector('.xgplayer-playswitch-next, [data-e2e="video-switch-next-arrow"]');
    const pb = document.querySelector('.xgplayer-playswitch-prev, [data-e2e="video-switch-prev-arrow"]');
    const disabled = (el) => !!(el && el.classList.contains('disabled'));
    if (dir === 'down') {
      if (nb && !disabled(nb)) { realClick(nb); return { ok: true, action: 'next' }; }
      if (switchFeedVideo(true)) return { ok: true, action: 'next' };
      dispatchArrow('down');
      return { ok: true, action: 'next', via: 'key' };
    }
    if (dir === 'up') {
      if (pb && !disabled(pb)) { realClick(pb); return { ok: true, action: 'prev' }; }
      if (switchFeedVideo(false)) return { ok: true, action: 'prev' };
      dispatchArrow('up');
      return { ok: true, action: 'prev', via: 'key' };
    }
    if (dir === 'ok') {
      const v = mainVideo();
      if (v) {
        if (v.paused) v.play().catch(() => {});
        else v.pause();
        return { ok: true, action: 'play_pause' };
      }
    }
    return { ok: true, edge: true }; // left/right 在竖屏信息流中无意义
  }

  async function handle(action, payload) {
    payload = payload || {};
    const v = mainVideo();

    switch (action) {
      case 'play':
        if (v) await v.play().catch(() => {});
        return status(v);
      case 'pause':
        if (v) v.pause();
        return status(v);
      case 'play_pause':
        if (v) {
          if (v.paused) await v.play().catch(() => {});
          else v.pause();
        }
        return status(v);
      case 'seek':
        if (v) {
          if (payload.delta != null) v.currentTime = Math.max(0, v.currentTime + Number(payload.delta));
          else if (payload.time != null) v.currentTime = Math.max(0, Number(payload.time));
        }
        return status(v);
      case 'volume':
        if (v) {
          if (payload.value != null) v.volume = Math.min(1, Math.max(0, Number(payload.value)));
          if (payload.delta != null) v.volume = Math.min(1, Math.max(0, v.volume + Number(payload.delta)));
          v.muted = false;
        }
        return status(v);
      case 'mute':
        if (v) v.muted = payload.value != null ? !!payload.value : !v.muted;
        return status(v);
      case 'fullscreen':
        return toggleFullscreen(v);
      case 'speed_start':
        return speedStart(v, payload.rate);
      case 'speed_stop':
        return speedStop(v);
      case 'refresh_feed':
        return refreshFeed();
      case 'tv_nav':
        if (payload.dir === 'back') return tvBack();
        if (isDouyinGrid()) { // 精选/大屏卡片网格：方向=空间选卡，OK=点击卡（大播放器卡=播放/暂停）
          if (payload.dir === 'ok') return tvOkGrid();
          if (['up', 'down', 'left', 'right'].includes(payload.dir)) return tvMove(payload.dir);
          return { ok: false, error: '未知方向: ' + payload.dir };
        }
        if (isDouyinFeed()) return douyinFeedNav(payload.dir);
        if (payload.dir === 'ok') return tvOk();
        if (['up', 'down', 'left', 'right'].includes(payload.dir)) return tvMove(payload.dir);
        return { ok: false, error: '未知方向: ' + payload.dir };
      case 'next_episode':
        return { ok: clickEpisode(true) };
      case 'prev_episode':
        return { ok: clickEpisode(false) };
      case 'click': {
        if (!payload.selector) return { ok: false, error: '缺少 selector' };
        const el = document.querySelector(payload.selector);
        if (!el) return { ok: false, error: '元素未找到' };
        el.click();
        return { ok: true };
      }
      case 'get_status':
        return status(v);
      case 'inspect': {
        // 只读诊断：返回页面播放器结构，用于给新站点做适配（对用户无副作用）
        const chain = (el, depth) => {
          const arr = [];
          let p = el;
          for (let i = 0; p && i < depth; i++) {
            const c = typeof p.className === 'string' ? p.className.trim() : '';
            arr.push(p.tagName.toLowerCase() + (c ? '.' + c.split(/\s+/).slice(0, 4).join('.') : ''));
            p = p.parentElement;
          }
          return arr;
        };
        const vs = videos().map((el) => {
          const r = el.getBoundingClientRect();
          return {
            w: Math.round(r.width), h: Math.round(r.height),
            paused: el.paused, muted: el.muted, rate: el.playbackRate,
            srcHost: (el.currentSrc || el.src || '').replace(/^https?:\/\/([^/]+).*$/, '$1').slice(0, 40),
            chain: chain(el, 6)
          };
        }).sort((a, b) => b.w * b.h - a.w * a.h);
        // 播放器/控制条内出现的 class 词汇表
        const classVocab = new Set();
        document.querySelectorAll('[class*="player" i], [class*="control" i], [class*="fullscreen" i]')
          .forEach((el) => {
            if (typeof el.className !== 'string') return;
            el.className.split(/\s+/).forEach((c) => {
              if (/player|control|fullscreen|play|next|prev|volume|screen/i.test(c)) classVocab.add(c);
            });
          });
        const labelCandidates = [];
        ['h1', '[data-e2e="video-desc"]', '[class*="desc" i]', '[class*="title" i]'].forEach((sel) => {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) labelCandidates.push(sel + ' → ' + el.textContent.trim().slice(0, 50));
        });
        // 页面形态判定
        const feedInfo = {
          feedActive: !!document.querySelector('[data-e2e="feed-active-video"]'),
          sliderVideo: !!document.querySelector('.slider-video'),
          xgplayer: !!document.querySelector('.xgplayer'),
          douyinPlayer: !!document.querySelector('[class*="LivePlayer"], [class*="douyin-player"]')
        };
        // 播放器/信息区内可操作的按钮（data-e2e 或 icon class，含可见性）
        const actionable = [];
        const seen = new Set();
        document.querySelectorAll('[data-e2e], [class*="fullscreen" i], [class*="playswitch"], [class*="player-play"], [class*="player-pause"], [class*="player-next"], [class*="player-prev"]').forEach((el) => {
          const e2e = el.getAttribute('data-e2e');
          const cls = typeof el.className === 'string' ? el.className.trim() : '';
          if (!e2e && cls.split(/\s+/).length > 4) return; // 纯哈希类太多，跳过
          const key = e2e || cls.split(/\s+/)[0];
          if (seen.has(key)) return;
          seen.add(key);
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) return;
          const hasVid = !!el.closest('.xgplayer, .douyin-player');
          actionable.push({ key, e2e: e2e || null, cls: (cls.split(/\s+/).slice(0, 3).join(' ')).slice(0, 60), w: Math.round(r.width), h: Math.round(r.height), inPlayer: hasVid, visible: !!el.offsetParent });
        });
        // 可见中文文案（非导航区），帮助判断当前视频/页面内容
        const visibleTexts = [];
        const NAV_SEL = '[data-e2e="douyin-navigation"], header, footer, nav, .semi-tabs';
        const bodyEx = document.body;
        const walker = document.createTreeWalker(bodyEx, NodeFilter.SHOW_ELEMENT);
        let node;
        const excludeAncestor = (el) => !!(el.closest && el.closest(NAV_SEL));
        while ((node = walker.nextNode()) && visibleTexts.length < 30) {
          if (node.children.length > 3) continue;
          const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length < 4 || t.length > 80) continue;
          if (!/[\u4e00-\u9fa5A-Za-z]/.test(t)) continue;
          if (excludeAncestor(node)) continue;
          const r = node.getBoundingClientRect();
          if (r.width < 30 || r.height < 10 || !node.offsetParent) continue;
          visibleTexts.push({ text: t.slice(0, 60), cls: (typeof node.className === 'string' ? node.className.trim().split(/\s+/).slice(0, 3).join(' ') : node.tagName).slice(0, 50) });
        }
        // 疑似视频列表容器（含多个可点封面项）
        const listCands = [];
        document.querySelectorAll('[class*="list" i], [class*="video" i], [class*="card" i], [class*="cover" i], [class*="item" i], [class*="swiper"]').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 200 || r.height < 60) return;
          const links = el.querySelectorAll('a[href]');
          if (links.length >= 3) {
            listCands.push({ cls: (typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 4).join(' ') : '').slice(0, 70), w: Math.round(r.width), h: Math.round(r.height), links: links.length });
          }
        });
        // XPath 链分析：给定一个页面元素 XPath，反推向上各级稳定容器（用于适配卡片布局）
        const xpathDump = payload && payload.xpath ? (() => {
          try {
            const out = [];
            const it = document.evaluate(payload.xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < it.snapshotLength && i < 4; i++) {
              const el = it.snapshotItem(i);
              if (!(el instanceof Element)) continue;
              const chain = [];
              let p = el;
              for (let k = 0; p && k < 10; k++) {
                const c = typeof p.className === 'string' ? p.className.trim() : '';
                chain.push(p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') + (c ? '.' + c.split(/\s+/).slice(0, 3).join('.') : ''));
                p = p.parentElement;
              }
              const r = el.getBoundingClientRect();
              out.push({ chain, w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), hasImg: !!el.querySelector('img'), hasVideo: !!el.querySelector('video'), href: (el.closest('a[href]') || {}).href || null });
            }
            return out;
          } catch (e) { return [{ error: String(e) }]; }
        })() : undefined;
        // 抖音精选等"多播放器卡片布局"：dump 各可见播放器/封面的容器结构（临时诊断用）
        const dyLayout = (() => {
          if (!/douyin\.com/.test(location.hostname)) return undefined;
          const out = { players: [], covers: [] };
          const chainOf = (el, depth, clsN) => {
            const arr = [];
            let p = el;
            for (let i = 0; p && i < depth; i++) {
              const c = typeof p.className === 'string' ? p.className.trim() : '';
              arr.push(p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') + (c ? '.' + c.split(/\s+/).slice(0, clsN).join('.') : ''));
              p = p.parentElement;
            }
            return arr;
          };
          const rect = (el) => {
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
          };
          document.querySelectorAll('video').forEach((vd) => {
            const r = vd.getBoundingClientRect();
            if (r.width < 50 || r.height < 40 || !vd.offsetParent) return;
            out.players.push({ rect: rect(vd), paused: vd.paused, chain: chainOf(vd.parentElement, 5, 3) });
          });
          const seenC = new Set();
          document.querySelectorAll('img').forEach((im) => {
            const r = im.getBoundingClientRect();
            if (r.width < 100 || r.height < 50 || r.width > 900 || !im.offsetParent) return;
            // 只保留尺寸像封面的图（过滤头像/图标）
            const key = Math.round(r.width / 10) + '_' + Math.round(r.height / 10) + '_' + (im.src || '').slice(0, 60);
            if (seenC.has(key)) return;
            seenC.add(key);
            const parentCls = typeof im.parentElement.className === 'string' ? im.parentElement.className.trim() : '';
            out.covers.push({ rect: rect(im), alt: (im.alt || '').slice(0, 20), pCls: parentCls.split(/\s+/).slice(0, 3).join(' '), chain: chainOf(im.parentElement, 3, 3) });
          });
          return out;
        })();
        // 抖音精选网格诊断：定位 tvCandidates 空集原因
        const debugGrid = (() => {
          if (!/douyin\.com/.test(location.hostname)) return undefined;
          const st = { isGrid: isDouyinGrid(), total: 0, imgOk: 0, offNull: 0, sizeFail: 0, parentNull: 0, vids: 0 };
          document.querySelectorAll('img').forEach((im) => {
            st.total++;
            if (!im.offsetParent) { st.offNull++; return; }
            const r = im.getBoundingClientRect();
            if (r.width < 150 || r.width > 2400 || r.height < 80 || r.height > 1400) { st.sizeFail++; return; }
            const p = im.parentElement;
            if (!p || !p.offsetParent) { st.parentNull++; return; }
            st.imgOk++;
          });
          st.vids = document.querySelectorAll('video').length;
          let cands = [], err = null;
          try { cands = douyinGridCandidates(); } catch (e) { err = String(e); }
          st.candErr = err;
          st.candCount = cands.length;
          st.sample = cands.slice(0, 4).map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName, cls: (typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 3).join(' ') : ''), w: Math.round(r.width), h: Math.round(r.height), alt: (el.querySelector && el.querySelector('img[alt]') || {}).alt ? el.querySelector('img[alt]').alt.slice(0, 16) : null }; });
          return st;
        })();
        return {
          ok: true,
          url: location.href.slice(0, 120),
          title: document.title.slice(0, 80),
          videos: vs.slice(0, 3),
          feed: feedInfo,
          playerClasses: [...classVocab].slice(0, 60),
          actionable: actionable.slice(0, 40),
          visibleTexts: visibleTexts.slice(0, 24),
          listCandidates: listCands.slice(0, 10),
          labelCandidates: labelCandidates.slice(0, 6),
          fullscreenNow: !!(document.fullscreenElement || document.webkitFullscreenElement),
          xpathDump,
          dyLayout,
          debugGrid
        };
      }
      default:
        return { ok: false, error: '未知动作: ' + action };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.__rc) return;
    handle(msg.action, msg.payload)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  });
})();
