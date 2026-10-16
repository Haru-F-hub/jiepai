/* 眼部平扫节拍器 —— 节拍引擎
 *
 * 为什么不用 setInterval 每隔一段时间响一声？
 * 因为 setInterval 的误差会累积：每拍偏几毫秒，几十拍之后就明显走偏，
 * 听着会觉得「越走越乱」。
 *
 * 这里的做法叫「提前排程」：
 *   1. 声音不是现在响，而是按精确时间点写进音频硬件的时钟里；
 *   2. 一个 25 毫秒的定时器不断往前补，永远保证未来 0.12 秒内的声音已排好；
 *   3. 到底什么时候响，由音频硬件时钟说了算，不由 JavaScript 说了算。
 * 所以做十分钟也不会偏。
 *
 * 屏幕上的圆点读的是同一个音频时钟（见 _visualLoop），
 * 所以「看到的」和「听到的」是同一时刻，不会一个快一个慢。
 */
(function (global) {
  'use strict';

  var LOOKAHEAD_MS     = 25;    // 排程定时器多久跑一次
  var SCHEDULE_AHEAD_S = 0.12;  // 提前多久把声音排进音频队列
  var TICK_LENGTH      = 0.09;  // 单声「嘀」的时长（秒）
  var TICK_FREQ        = 1000;  // 音高（赫兹）。左右两侧用同一个音高。
  var START_PADDING    = 0.06;  // 按下开始后留一点点起播余量

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function toInt(value, fallback) {
    var n = parseInt(value, 10);
    return isFinite(n) ? n : fallback;
  }

  /** 把外部传来的设置收拾成一定合法、一定能用的样子 */
  function normalizeConfig(raw) {
    raw = raw || {};
    return {
      bpm:              clamp(toInt(raw.bpm, 52), 20, 300),
      roundTripsPerSet: clamp(toInt(raw.roundTripsPerSet, 8), 1, 200),
      sets:             clamp(toInt(raw.sets, 3), 1, 99),
      restSeconds:      clamp(toInt(raw.restSeconds, 10), 0, 600),
      countInBeats:     clamp(toInt(raw.countInBeats, 3), 0, 20),
      mode:             raw.mode === 'smooth' ? 'smooth' : 'jump'
    };
  }

  function EyeSweepMetronome(handlers) {
    handlers = handlers || {};
    this.onEvent = handlers.onEvent || function () {};  // 有事件到达屏幕时调用
    this.onFrame = handlers.onFrame || function () {};  // 每一动画帧调用，用来跑休息倒计时
    this.onStop  = handlers.onStop  || function () {};  // 整条时间线走完时调用

    this.audioCtx     = null;
    this.masterGain   = null;
    this.live         = [];   // 已排进队列、还没播完的发声节点
    this.timeline     = [];   // 整场训练的事件表
    this.config       = normalizeConfig(null);
    this.startTime    = 0;    // 音频时钟上的起跑时刻
    this.audioCursor  = 0;    // 排程排到第几个事件
    this.visualCursor = 0;    // 画面走到第几个事件
    this.pausedElapsed = 0;   // 暂停时已经走过了多少秒
    this.timerId = null;
    this.rafId   = null;
    this.running = false;
    this.volume  = 0.7;
  }

  /* ================= 对外接口 ================= */

  EyeSweepMetronome.prototype.configure = function (raw) {
    this.config = normalizeConfig(raw);
    return this.config;
  };

  /** 这份设置总共多少拍（不含预备拍和休息） */
  EyeSweepMetronome.prototype.totalBeats = function () {
    return this.config.sets * this.config.roundTripsPerSet * 2;
  };

  EyeSweepMetronome.prototype.isSupported = function () {
    return !!(global.AudioContext || global.webkitAudioContext);
  };

  /** 从头跑一遍 */
  EyeSweepMetronome.prototype.start = function () {
    if (this.running) return false;
    if (!this._ensureAudio()) return false;

    this.timeline      = this._buildTimeline(this.config);
    this.audioCursor   = 0;
    this.visualCursor  = 0;
    this.pausedElapsed = 0;
    this.startTime     = this.audioCtx.currentTime + START_PADDING;
    this.running       = true;

    this._scheduleLoop();
    this._visualLoop();
    return true;
  };

  EyeSweepMetronome.prototype.pause = function () {
    if (!this.running) return;
    this.pausedElapsed = Math.max(0, this.audioCtx.currentTime - this.startTime);
    this._halt();
  };

  EyeSweepMetronome.prototype.resume = function () {
    if (this.running || !this.audioCtx || !this.timeline.length) return;
    if (!this._ensureAudio()) return;

    // 把起跑时刻往前挪，让「已经走过的秒数」接得上
    this.startTime = this.audioCtx.currentTime - this.pausedElapsed;

    var next = this._firstIndexAfter(this.pausedElapsed);
    this.audioCursor  = next;
    this.visualCursor = next;
    this.running = true;

    this._scheduleLoop();
    this._visualLoop();
  };

  /** 完全停下并清空（重置） */
  EyeSweepMetronome.prototype.stop = function () {
    this._halt();
    this.timeline      = [];
    this.audioCursor   = 0;
    this.visualCursor  = 0;
    this.pausedElapsed = 0;
  };

  EyeSweepMetronome.prototype.setVolume = function (value) {
    this.volume = clamp(Number(value) || 0, 0, 1);
    if (this.masterGain) {
      // 用渐变而不是直接赋值，避免拖动滑块时出现「啪」的爆音
      this.masterGain.gain.setTargetAtTime(this.volume, this.audioCtx.currentTime, 0.02);
    }
  };

  /** 「试听」按钮用：立刻响一声 */
  EyeSweepMetronome.prototype.preview = function () {
    if (!this._ensureAudio()) return false;
    this._playTick(this.audioCtx.currentTime + 0.02, false);
    return true;
  };

  /* ================= 内部：音频环境 ================= */

  EyeSweepMetronome.prototype._ensureAudio = function () {
    if (!this.audioCtx) {
      var Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) return false;
      this.audioCtx = new Ctor();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.audioCtx.destination);
    }
    // 手机浏览器要求「用户先点过页面」才允许出声
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return true;
  };

  EyeSweepMetronome.prototype._halt = function () {
    this.running = false;
    if (this.timerId) { clearTimeout(this.timerId); this.timerId = null; }
    if (this.rafId)   { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this._killScheduled();
  };

  EyeSweepMetronome.prototype._killScheduled = function () {
    for (var i = 0; i < this.live.length; i++) {
      try { this.live[i].stop(0); } catch (e) { /* 已经自然停了就忽略 */ }
      try { this.live[i].disconnect(); } catch (e) { /* 同上 */ }
    }
    this.live.length = 0;
  };

  /** 记下这个发声节点，播完自动从名单里去掉 */
  EyeSweepMetronome.prototype._keep = function (osc) {
    var self = this;
    this.live.push(osc);
    osc.onended = function () {
      var i = self.live.indexOf(osc);
      if (i >= 0) self.live.splice(i, 1);
    };
  };

  /* ================= 内部：时间线 ================= */

  /**
   * 把整场训练铺成一张事件表（单位：秒，从 0 起算）。
   *
   *   预备拍 ×N  →  第1组每一拍  →  休息  →  第2组每一拍  →  …  →  结束
   *
   * 一拍 = 眼睛移到一侧。所以第 1 拍看左、第 2 拍看右，两拍才是一个来回。
   */
  EyeSweepMetronome.prototype._buildTimeline = function (cfg) {
    var beatDur     = 60 / cfg.bpm;
    var beatsPerSet = cfg.roundTripsPerSet * 2;
    var events = [];
    var t = 0;
    var set, b, c;

    // 开始前的预备拍：N、N-1、…、1
    for (c = cfg.countInBeats; c >= 1; c--) {
      events.push({ time: t, kind: 'countin', label: c });
      t += beatDur;
    }

    for (set = 1; set <= cfg.sets; set++) {
      for (b = 0; b < beatsPerSet; b++) {
        events.push({
          time: t,
          kind: 'beat',
          set: set,
          side: b % 2 === 0 ? 'left' : 'right',   // 第 1 拍看左，第 2 拍看右
          roundTrip: Math.floor(b / 2) + 1,
          roundTripCount: cfg.roundTripsPerSet
        });
        t += beatDur;
      }

      // 这一组做完了，插一段休息（最后一组后面不休息）
      if (set < cfg.sets) {
        events.push({ time: t, kind: 'restStart', set: set, duration: cfg.restSeconds });
        events.push({ time: t + cfg.restSeconds, kind: 'restEnd', nextSet: set + 1 });
        t += cfg.restSeconds;
      }
    }

    events.push({ time: t, kind: 'finish' });
    return events;
  };

  /** 第一个「时间点仍在 after 之后」的事件的下标 */
  EyeSweepMetronome.prototype._firstIndexAfter = function (after) {
    for (var i = 0; i < this.timeline.length; i++) {
      if (this.timeline[i].time > after) return i;
    }
    return this.timeline.length;
  };

  /* ================= 内部：排程与画面 ================= */

  EyeSweepMetronome.prototype._scheduleLoop = function () {
    if (!this.running) return;
    var self = this;
    var now = this.audioCtx.currentTime;

    // 把未来 0.12 秒内该响的声音，按精确时间点排进音频队列
    while (this.audioCursor < this.timeline.length &&
           this.startTime + this.timeline[this.audioCursor].time <= now + SCHEDULE_AHEAD_S) {
      var ev = this.timeline[this.audioCursor];
      this._scheduleSound(ev, this.startTime + ev.time);
      this.audioCursor++;
    }

    // 全部排完了就不用再补；画面循环会自己走到结尾
    if (this.audioCursor >= this.timeline.length) return;

    this.timerId = setTimeout(function () { self._scheduleLoop(); }, LOOKAHEAD_MS);
  };

  EyeSweepMetronome.prototype._visualLoop = function () {
    if (!this.running) return;
    var self = this;
    var elapsed = this.audioCtx.currentTime - this.startTime;

    // 把「到点了」的事件逐个交给界面
    while (this.visualCursor < this.timeline.length &&
           this.timeline[this.visualCursor].time <= elapsed) {
      var ev = this.timeline[this.visualCursor];
      this.visualCursor++;
      this.onEvent(ev, elapsed);
    }

    this.onFrame(elapsed);

    // 时间线走完后再多留半秒，让收尾的提示音播完
    if (this.visualCursor >= this.timeline.length && this.timeline.length) {
      var last = this.timeline[this.timeline.length - 1];
      if (elapsed >= last.time + 0.5) {
        this._halt();
        this.onStop();
        return;
      }
    }

    this.rafId = requestAnimationFrame(function () { self._visualLoop(); });
  };

  /* ================= 内部：发声 ================= */

  EyeSweepMetronome.prototype._scheduleSound = function (ev, when) {
    switch (ev.kind) {
      case 'countin':
        this._playTick(when, true);
        break;

      case 'beat':
        this._playTick(when, false);
        break;

      case 'restStart':
        // 一组做完：两声短促的上行音，提醒你可以放松了
        this._playNotes(when, [660, 990], 0.20, 0.13, 0.45);
        break;

      case 'finish':
        // 全部做完：四声上行音
        this._playNotes(when, [660, 880, 1100, 1320], 0.26, 0.15, 0.55);
        break;

      default:
        break;
    }
  };

  /** 一声「嘀」。预备拍音量小一点，正式拍实一点。 */
  EyeSweepMetronome.prototype._playTick = function (when, isCountIn) {
    var ctx  = this.audioCtx;
    var osc  = ctx.createOscillator();
    var gain = ctx.createGain();
    var peak = isCountIn ? 0.45 : 0.9;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(TICK_FREQ, when);

    // 指数包络：极快起音 + 快速衰减。听起来干脆，不会糊成一团。
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + TICK_LENGTH);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(when);
    osc.stop(when + TICK_LENGTH + 0.03);
    this._keep(osc);
  };

  /** 一串音符，用来做「一组完成」和「全部完成」的提示 */
  EyeSweepMetronome.prototype._playNotes = function (when, freqs, noteLen, gap, peak) {
    var self = this;
    freqs.forEach(function (freq, i) {
      var t    = when + i * gap;
      var osc  = self.audioCtx.createOscillator();
      var gain = self.audioCtx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + noteLen);

      osc.connect(gain);
      gain.connect(self.masterGain);
      osc.start(t);
      osc.stop(t + noteLen + 0.03);
      self._keep(osc);
    });
  };

  global.EyeSweepMetronome = EyeSweepMetronome;
})(window);
