/* 眼部平扫节拍器 —— 界面逻辑
 *
 * 这个文件只做三件事：
 *   1. 从输入框读设置、存到本地；
 *   2. 把引擎发来的事件画到屏幕上；
 *   3. 把按钮接到引擎上。
 * 所有和「什么时候响」有关的计算都在 metronome.js 里，这里不碰。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var DEFAULTS = {
    bpm: 52,
    roundTripsPerSet: 8,
    sets: 3,
    restSeconds: 10,
    countInBeats: 3,
    mode: 'jump',
    volume: 0.7
  };

  var STORAGE_KEY = 'eye-sweep-metronome-v1';

  // 每个数字输入框对应哪个设置、合法范围是多少
  var NUMBER_FIELDS = [
    { id: 'inBpm',        key: 'bpm',              min: 20, max: 300 },
    { id: 'inRoundTrips', key: 'roundTripsPerSet', min: 1,  max: 200 },
    { id: 'inSets',       key: 'sets',             min: 1,  max: 99  },
    { id: 'inRest',       key: 'restSeconds',      min: 0,  max: 600 },
    { id: 'inCountIn',    key: 'countInBeats',     min: 0,  max: 20  }
  ];

  var el = {
    settingsPanel: $('settingsPanel'),
    btnSettings:   $('btnSettings'),
    btnDefaults:   $('btnDefaults'),
    btnPreview:    $('btnPreview'),
    btnStart:      $('btnStart'),
    btnReset:      $('btnReset'),
    inVolume:      $('inVolume'),
    segMode:       $('segMode'),
    planSummary:   $('planSummary'),
    setNow:        $('setNow'),
    setTotal:      $('setTotal'),
    rtNow:         $('rtNow'),
    rtTotal:       $('rtTotal'),
    bpmNow:        $('bpmNow'),
    barFill:       $('barFill'),
    panelLeft:     $('panelLeft'),
    panelRight:    $('panelRight'),
    dot:           $('dot'),
    overlay:       $('overlay'),
    overlayText:   $('overlayText'),
    overlaySub:    $('overlaySub'),
    hint:          $('hint'),
    audioWarning:  $('audioWarning')
  };

  NUMBER_FIELDS.forEach(function (f) { el[f.id] = $(f.id); });

  // ---------- 运行状态 ----------
  var phase = 'idle';         // idle（没在跑）| running（进行中）| paused（已暂停）
  var config = null;
  var completedBeats = 0;
  var restInfo = null;        // 正在休息时：{ startedAt, duration, set }
  var overlayCache = { main: null, sub: null };  // 避免每帧重复写 DOM
  var wakeLock = null;

  // ---------- 节拍引擎 ----------
  var metronome = new EyeSweepMetronome({
    onEvent: handleEvent,
    onFrame: handleFrame,
    onStop:  handleEngineStop
  });

  /* ================= 小工具 ================= */

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function totalBeats() {
    return config.sets * config.roundTripsPerSet * 2;
  }

  function formatDuration(sec) {
    var s = Math.max(0, Math.round(sec));
    var m = Math.floor(s / 60);
    s = s % 60;
    return m > 0 ? m + ' 分 ' + s + ' 秒' : s + ' 秒';
  }

  /* ================= 设置的读取与保存 ================= */

  function loadSaved() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (e) {
      return {};   // 存的东西坏了就当没有，用默认值
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) { /* 无痕模式等场景写不进去，忽略即可 */ }
  }

  function currentMode() {
    var btn = el.segMode.querySelector('button.is-current');
    return btn ? btn.dataset.mode : DEFAULTS.mode;
  }

  function setMode(mode) {
    Array.prototype.forEach.call(el.segMode.querySelectorAll('button'), function (b) {
      b.classList.toggle('is-current', b.dataset.mode === mode);
    });
  }

  function syncChips() {
    var cur = String(parseInt($('inBpm').value, 10));
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
      c.classList.toggle('is-current', c.dataset.bpm === cur);
    });
  }

  /** 把设置写进各个输入框（打开页面时、点「恢复默认」时用） */
  function fillInputs(cfg) {
    NUMBER_FIELDS.forEach(function (f) { el[f.id].value = cfg[f.key]; });
    el.inVolume.value = Math.round((cfg.volume != null ? cfg.volume : DEFAULTS.volume) * 100);
    setMode(cfg.mode);
    syncChips();
  }

  /** 从输入框读回设置。越界的值直接纠正回输入框，用户看得见。 */
  function readInputs() {
    var cfg = {};
    NUMBER_FIELDS.forEach(function (f) {
      var node = el[f.id];
      var n = parseInt(node.value, 10);
      if (!isFinite(n)) n = DEFAULTS[f.key];
      n = clamp(n, f.min, f.max);
      node.value = n;
      cfg[f.key] = n;
    });
    cfg.mode = currentMode();
    cfg.volume = clamp(parseInt(el.inVolume.value, 10) / 100, 0, 1);
    return cfg;
  }

  function applyConfig() {
    config = readInputs();
    metronome.configure(config);
    metronome.setVolume(config.volume);

    // 跳动模式圆点瞬间到位（0s），平滑模式约用一拍的时长移过去
    var dur = config.mode === 'smooth' ? (60 / config.bpm) : 0;
    document.documentElement.style.setProperty('--beat-dur', dur + 's');

    // 手动在输入框里改了节拍，预设按钮的高亮也要跟着变
    syncChips();
    save();
    renderPlan();
  }

  function renderPlan() {
    el.setTotal.textContent = config.sets;
    el.rtTotal.textContent  = config.roundTripsPerSet;
    el.bpmNow.textContent   = config.bpm;

    if (phase === 'idle') {
      el.setNow.textContent = '–';
      el.rtNow.textContent  = '–';
      el.barFill.style.width = '0%';
    }

    var beatDur = 60 / config.bpm;
    var seconds = config.countInBeats * beatDur
                + totalBeats() * beatDur
                + (config.sets - 1) * config.restSeconds;

    el.planSummary.textContent =
      '共 ' + config.sets + ' 组 × ' + config.roundTripsPerSet +
      ' 个来回，约 ' + formatDuration(seconds) + '（含休息）';
  }

  /* ================= 画面 ================= */

  function clearPanels() {
    el.panelLeft.classList.remove('is-active');
    el.panelRight.classList.remove('is-active');
  }

  function lightSide(side) {
    var isLeft = side === 'left';
    el.panelLeft.classList.toggle('is-active', isLeft);
    el.panelRight.classList.toggle('is-active', !isLeft);

    // 跳动模式：圆点就停在指示的那一侧。
    // 平滑模式：圆点在「这一拍对应的那一侧」起步，匀速扫向对面，
    //           正好在下一拍响起时抵达另一头，形成不间断的往返扫视。
    var dotSide = (config.mode === 'smooth') ? (isLeft ? 'right' : 'left') : side;
    el.dot.classList.toggle('at-left',  dotSide === 'left');
    el.dot.classList.toggle('at-right', dotSide === 'right');
  }

  function showOverlay(main, sub) {
    if (overlayCache.main !== main) { el.overlayText.textContent = main; overlayCache.main = main; }
    if (overlayCache.sub  !== sub)  { el.overlaySub.textContent  = sub;  overlayCache.sub  = sub; }
    el.overlay.hidden = false;
  }

  function hideOverlay() {
    if (el.overlay.hidden) return;
    el.overlay.hidden = true;
    overlayCache.main = null;
    overlayCache.sub  = null;
  }

  function dimDot(on) {
    el.dot.classList.toggle('is-dim', on);
  }

  function setSettingsEnabled(on) {
    Array.prototype.forEach.call(el.settingsPanel.querySelectorAll('input, button'),
      function (node) { node.disabled = !on; });
    el.btnSettings.disabled = !on;
    if (!on) toggleSettings(false);   // 开跑就把设置收起来，省得误触
  }

  function toggleSettings(force) {
    var open = (typeof force === 'boolean') ? force : el.settingsPanel.hidden;
    el.settingsPanel.hidden = !open;
    el.btnSettings.setAttribute('aria-expanded', String(open));
    el.btnSettings.textContent = open ? '收起设置' : '设置';
  }

  /* ================= 引擎回调 ================= */

  function handleEvent(ev) {
    switch (ev.kind) {
      case 'countin':
        clearPanels();
        dimDot(true);
        showOverlay(String(ev.label), '准备');
        el.hint.textContent = '预备拍…听到第 1 声就看向左侧。';
        break;

      case 'beat':
        completedBeats++;
        dimDot(false);
        hideOverlay();
        lightSide(ev.side);
        el.setNow.textContent = ev.set;
        el.rtNow.textContent  = ev.roundTrip;
        el.barFill.style.width = (completedBeats / totalBeats() * 100).toFixed(1) + '%';
        el.hint.textContent = '第 ' + ev.set + ' 组 · 第 ' + ev.roundTrip +
                              ' / ' + ev.roundTripCount + ' 个来回';
        break;

      case 'restStart':
        restInfo = { startedAt: ev.time, duration: ev.duration, set: ev.set };
        clearPanels();
        dimDot(true);
        el.hint.textContent = '休息中，下一组会自动开始。';
        break;

      case 'restEnd':
        restInfo = null;
        break;

      case 'finish':
        restInfo = null;
        clearPanels();
        dimDot(true);
        showOverlay('完成', '共 ' + config.sets + ' 组 × ' +
                             config.roundTripsPerSet + ' 个来回');
        el.hint.textContent = '全部做完了。慢眨几次眼，让眼睛放松一下。';
        break;
    }
  }

  /** 每个动画帧都跑，主要用来刷新休息倒计时 */
  function handleFrame(elapsed) {
    if (!restInfo) return;
    var remaining = restInfo.duration - (elapsed - restInfo.startedAt);
    if (remaining < 0) remaining = 0;
    showOverlay(String(Math.ceil(remaining)),
                '秒后开始第 ' + (restInfo.set + 1) + ' 组');
  }

  function handleEngineStop() {
    phase = 'idle';
    restInfo = null;
    el.btnStart.textContent = '开始';
    el.btnStart.classList.remove('is-paused');
    setSettingsEnabled(true);
    releaseWakeLock();
  }

  /* ================= 开始 / 暂停 / 重置 ================= */

  function startFresh() {
    applyConfig();

    completedBeats = 0;
    restInfo = null;
    el.barFill.style.width = '0%';
    el.setNow.textContent = '1';
    el.rtNow.textContent  = '1';

    // 圆点回到起点（第 1 拍看左）
    el.dot.classList.remove('at-right');
    el.dot.classList.add('at-left');
    dimDot(false);

    if (!metronome.start()) {
      el.audioWarning.hidden = false;
      return;
    }

    phase = 'running';
    el.btnStart.textContent = '暂停';
    el.btnStart.classList.remove('is-paused');
    setSettingsEnabled(false);
    requestWakeLock();
  }

  function pauseRun() {
    metronome.pause();
    phase = 'paused';
    el.btnStart.textContent = '继续';
    el.btnStart.classList.add('is-paused');
    clearPanels();
    dimDot(true);
    el.hint.textContent = '已暂停。点「继续」接着做。';
    setSettingsEnabled(true);
    releaseWakeLock();
  }

  function resumeRun() {
    metronome.resume();
    phase = 'running';
    el.btnStart.textContent = '暂停';
    el.btnStart.classList.remove('is-paused');
    dimDot(false);
    el.hint.textContent = '继续…';
    setSettingsEnabled(false);
    requestWakeLock();
  }

  function resetAll() {
    metronome.stop();
    phase = 'idle';
    restInfo = null;
    completedBeats = 0;

    clearPanels();
    hideOverlay();
    dimDot(false);
    el.dot.classList.remove('at-right');
    el.dot.classList.add('at-left');

    el.btnStart.textContent = '开始';
    el.btnStart.classList.remove('is-paused');
    el.hint.textContent = '眼睛看着亮起的一侧。准备好了就点「开始」。';

    setSettingsEnabled(true);
    releaseWakeLock();
    renderPlan();
  }

  /* ================= 屏幕常亮 ================= */

  function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      navigator.wakeLock.request('screen')
        .then(function (lock) { wakeLock = lock; })
        .catch(function () { /* 拿不到就算了，不影响训练 */ });
    } catch (e) { /* 同上 */ }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    try { wakeLock.release(); } catch (e) { /* 忽略 */ }
    wakeLock = null;
  }

  /* ================= 事件绑定 ================= */

  el.btnStart.addEventListener('click', function () {
    if (phase === 'running')     pauseRun();
    else if (phase === 'paused') resumeRun();
    else                         startFresh();
  });

  el.btnReset.addEventListener('click', resetAll);

  el.btnSettings.addEventListener('click', function () { toggleSettings(); });

  el.btnDefaults.addEventListener('click', function () {
    fillInputs(Object.assign({}, DEFAULTS));
    onSettingsChanged();
  });

  el.btnPreview.addEventListener('click', function () {
    metronome.setVolume(clamp(parseInt(el.inVolume.value, 10) / 100, 0, 1));
    if (!metronome.preview()) el.audioWarning.hidden = false;
  });

  function onSettingsChanged() {
    applyConfig();
    if (phase !== 'idle') resetAll();   // 改了设置就从头上再来
  }

  NUMBER_FIELDS.forEach(function (f) {
    el[f.id].addEventListener('input',  onSettingsChanged);
    el[f.id].addEventListener('change', onSettingsChanged);
  });

  el.inVolume.addEventListener('input', onSettingsChanged);

  Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
    chip.addEventListener('click', function () {
      $('inBpm').value = chip.dataset.bpm;
      onSettingsChanged();   // applyConfig 里会同步按钮高亮
    });
  });

  Array.prototype.forEach.call(el.segMode.querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () {
      setMode(b.dataset.mode);
      onSettingsChanged();
    });
  });

  // 切回页面时重新申请屏幕常亮
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && phase === 'running') requestWakeLock();
  });

  /* ================= 启动 ================= */

  function init() {
    fillInputs(Object.assign({}, DEFAULTS, loadSaved()));
    applyConfig();   // 这一步会顺手把越界的存档值纠正掉
    resetAll();

    if (!metronome.isSupported()) el.audioWarning.hidden = false;
  }

  init();
})();
