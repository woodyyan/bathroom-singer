(function () {
  'use strict';

  var FONT_SIZES = [40, 52, 64, 80];
  var FALLBACK_INTERVAL = 4; // 无时间戳时每行停留秒数
  var AUTONEXT_DELAY = 3;    // 唱完到自动切下一首的间隔秒数

  var els = {
    start: document.getElementById('start'),
    startBtn: document.getElementById('startBtn'),
    startHint: document.getElementById('startHint'),
    app: document.getElementById('app'),
    songTitle: document.getElementById('songTitle'),
    songArtist: document.getElementById('songArtist'),
    songCount: document.getElementById('songCount'),
    voice: document.getElementById('voice'),
    voiceLabel: document.getElementById('voiceLabel'),
    lyrics: document.getElementById('lyrics'),
    progressBar: document.getElementById('progressBar'),
    hint: document.getElementById('hint'),
    toast: document.getElementById('toast'),
    fsBanner: document.getElementById('fsBanner'),
    fsClose: document.getElementById('fsClose')
  };

  var songs = [];
  var songIndex = 0;
  var lines = [];
  var lineTimes = [];
  var hasTimestamps = false;
  var currentLine = 0;
  var playing = false;
  var fontLevel = 1;
  var shuffle = true;        // 默认随机播放
  var order = [];            // 播放顺序（song 索引的排列）
  var orderPos = 0;          // 当前在 order 中的位置
  var listening = false;
  var recognizing = false;
  var startPerf = 0;
  var baseOffset = 0;
  var rafId = null;
  var wakeLock = null;
  var toastTimer = null;

  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var speechSupported = !!SpeechRecognition;
  var synth = window.speechSynthesis;
  var recognition = null;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  // ---------- LRC 解析 ----------
  function parseLRC(lrc) {
    var out = [];
    var re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    lrc.split('\n').forEach(function (raw) {
      var text = raw.replace(re, '').trim();
      if (!text) return;
      re.lastIndex = 0;
      var times = [];
      var m;
      while ((m = re.exec(raw)) !== null) {
        var min = parseInt(m[1], 10);
        var sec = parseInt(m[2], 10);
        var frac = m[3] ? parseInt((m[3] + '00').slice(0, 3), 10) / 1000 : 0;
        times.push(min * 60 + sec + frac);
      }
      if (times.length === 0) {
        out.push({ time: null, text: text });
      } else {
        times.forEach(function (t) { out.push({ time: t, text: text }); });
      }
    });
    out.sort(function (a, b) {
      return (a.time == null ? Infinity : a.time) - (b.time == null ? Infinity : b.time);
    });
    return out;
  }

  function buildSongs() {
    var src = (typeof SONGS !== 'undefined') ? SONGS : [];
    songs = src.map(function (s) {
      return { title: s.title, artist: s.artist, lines: parseLRC(s.lrc || '') };
    });
  }

  // ---------- 渲染 ----------
  function renderLyrics() {
    els.lyrics.innerHTML = '';
    lines.forEach(function (l, i) {
      var div = document.createElement('div');
      div.className = 'line';
      div.textContent = l.text;
      div.dataset.index = i;
      els.lyrics.appendChild(div);
    });
  }

  function loadSong(index) {
    if (songs.length === 0) return;
    songIndex = (index + songs.length) % songs.length;
    var song = songs[songIndex];
    lines = song.lines;
    hasTimestamps = lines.length > 0 && lines.every(function (l) { return l.time != null; });
    lineTimes = lines.map(function (l, i) {
      return hasTimestamps ? l.time : i * FALLBACK_INTERVAL;
    });
    els.songTitle.textContent = song.title;
    els.songArtist.textContent = song.artist || '';
    renderLyrics();
    currentLine = 0;
    baseOffset = 0;
    startPerf = performance.now();
    requestAnimationFrame(function () { goToLine(0, false); });
  }

  // ---------- 播放顺序（随机/顺序） ----------
  function buildOrder(keepCurrent) {
    var n = songs.length;
    var idx = [];
    for (var k = 0; k < n; k++) idx.push(k);
    // Fisher-Yates 洗牌
    for (var i = n - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    if (keepCurrent && n > 1 && order.length) {
      // 把当前歌提到队首，其余随机（用于「重新随机」）
      var cur = order[orderPos];
      var at = idx.indexOf(cur);
      if (at > 0) { idx.splice(at, 1); idx.unshift(cur); }
    }
    order = idx;
    orderPos = 0;
  }

  function loadByOrder(pos) {
    if (order.length === 0) return;
    orderPos = ((pos % order.length) + order.length) % order.length;
    loadSong(order[orderPos]);
    updateCount();
  }

  // 当前歌曲在播放顺序中的位置：第 X / 共 N 首
  function updateCount() {
    if (!els.songCount || order.length === 0) return;
    els.songCount.textContent = '第 ' + (orderPos + 1) + ' / 共 ' + order.length + ' 首';
  }

  function goToLine(i, animate) {
    if (lines.length === 0) return;
    if (i < 0) i = 0;
    if (i >= lines.length) i = lines.length - 1;
    currentLine = i;
    var nodes = els.lyrics.children;
    for (var k = 0; k < nodes.length; k++) {
      nodes[k].classList.toggle('active', k === i);
    }
    var el = nodes[i];
    if (el) {
      if (!animate) els.lyrics.style.transition = 'none';
      var stageH = els.lyrics.parentElement.clientHeight;
      var offset = el.offsetTop + el.offsetHeight / 2 - stageH / 2;
      els.lyrics.style.transform = 'translateY(' + (-offset) + 'px)';
      if (!animate) {
        void els.lyrics.offsetHeight; // 强制回流后再恢复过渡
        els.lyrics.style.transition = '';
      }
    }
  }

  // ---------- 播放控制 ----------
  function play() {
    if (playing || lines.length === 0) return;
    playing = true;
    startPerf = performance.now();
    updateToggleLabel();
  }
  function pause() {
    if (!playing) return;
    baseOffset += (performance.now() - startPerf) / 1000;
    playing = false;
    updateToggleLabel();
  }
  function togglePlay() { playing ? pause() : play(); }
  function updateToggleLabel() {
    var b = document.querySelector('[data-act="toggle"]');
    if (b) b.textContent = playing ? '暂停' : '继续';
  }

  function goLine(delta) {
    pause();
    var target = clamp(currentLine + delta, 0, lines.length - 1);
    baseOffset = lineTimes[target] || 0;
    goToLine(target, true);
    var total = lineTimes[lineTimes.length - 1] + (hasTimestamps ? 2 : FALLBACK_INTERVAL);
    els.progressBar.style.width = Math.min(100, (baseOffset / total) * 100) + '%';
  }

  function nextSong() { loadByOrder(orderPos + 1); play(); speak('下一首'); }
  function prevSong() { loadByOrder(orderPos - 1); play(); speak('上一首'); }
  function restart() { baseOffset = 0; startPerf = performance.now(); goToLine(0, true); play(); }

  function reshuffle() {
    shuffle = true;
    buildOrder(true);   // 保留当前歌为首，后续队列重新随机
    updateModeHint();
    updateCount();
    showToast('已重新随机');
    speak('已重新随机');
  }
  function setShuffle(on) {
    shuffle = on;
    if (on) {
      buildOrder(true);
    } else {
      order = [];
      for (var k = 0; k < songs.length; k++) order.push(k);
      orderPos = songIndex;
    }
    updateModeHint();
    updateCount();
    showToast(on ? '已随机播放' : '已顺序播放');
    speak(on ? '已随机播放' : '已顺序播放');
  }
  function updateModeHint() {
    if (!els.hint) return;
    var base = shuffle ? '随机播放' : '顺序播放';
    els.hint.textContent = '模式：' + base + ' · 说：下一首 · 重新随机 · 暂停 · 字体大一点';
  }

  function setFont(delta) {
    fontLevel = clamp(fontLevel + delta, 0, FONT_SIZES.length - 1);
    document.documentElement.style.setProperty('--lyric-size', FONT_SIZES[fontLevel] + 'px');
    goToLine(currentLine, false);
    var msg = delta > 0 ? '字体大一点' : '字体小一点';
    showToast(msg);
    speak(msg);
  }

  // ---------- 主循环：按时间推进当前行 ----------
  function tick() {
    if (playing && lines.length) {
      var elapsed = baseOffset + (performance.now() - startPerf) / 1000;
      var i = 0;
      for (var k = 0; k < lineTimes.length; k++) {
        if (lineTimes[k] <= elapsed) i = k; else break;
      }
      if (i !== currentLine) goToLine(i, true);
      var total = lineTimes[lineTimes.length - 1] + (hasTimestamps ? 2 : FALLBACK_INTERVAL);
      els.progressBar.style.width = Math.min(100, (elapsed / total) * 100) + '%';
      if (elapsed >= total + AUTONEXT_DELAY) nextSong();
    }
    rafId = requestAnimationFrame(tick);
  }

  // ---------- 语音朗读确认 ----------
  function pickZhVoice() {
    if (!synth) return null;
    var vs = synth.getVoices();
    for (var i = 0; i < vs.length; i++) {
      if (/zh|cmn|Chinese/i.test(vs[i].lang + vs[i].name)) return vs[i];
    }
    return null;
  }
  function speak(text) {
    if (!synth) return;
    try {
      synth.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.05;
      var v = pickZhVoice();
      if (v) u.voice = v;
      synth.speak(u);
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 回显提示 ----------
  function showToast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 1500);
  }

  // ---------- 声控指令 ----------
  var COMMANDS = [
    { re: /下一行|下一句/, fn: function () { goLine(1); showToast('下一行'); speak('下一行'); } },
    { re: /上一行|上一句/, fn: function () { goLine(-1); showToast('上一行'); speak('上一行'); } },
    { re: /下一首|下首|下一曲/, fn: function () { nextSong(); showToast('下一首'); } },
    { re: /上一首|上一曲|前一首/, fn: function () { prevSong(); showToast('上一首'); } },
    { re: /回到开头|从头|重新唱|重新开始/, fn: function () { restart(); showToast('回到开头'); speak('回到开头'); } },
    { re: /暂停|停一下|停住/, fn: function () { pause(); showToast('已暂停'); speak('已暂停'); } },
    { re: /继续|接着唱|播放|开始唱/, fn: function () { play(); showToast('继续'); speak('继续'); } },
    { re: /字体大一点|大一点|放大|字号大/, fn: function () { setFont(1); } },
    { re: /字体小一点|小一点|缩小|字号小/, fn: function () { setFont(-1); } },
    { re: /这首歌|歌名|叫什么/, fn: function () { var s = songs[songIndex]; showToast(s.title); speak(s.title); } },
    { re: /重新随机|换个顺序|换一批|重新洗牌/, fn: function () { reshuffle(); } },
    { re: /顺序播放|取消随机|不要随机/, fn: function () { setShuffle(false); } },
    { re: /随机播放|开启随机/, fn: function () { setShuffle(true); } },
    { re: /全屏|全屏显示|全屏幕|填满屏幕/, fn: function () { enterFullscreen(); } }
  ];

  function handleCommand(transcript) {
    transcript = (transcript || '').trim();
    if (!transcript) return;
    for (var i = 0; i < COMMANDS.length; i++) {
      if (COMMANDS[i].re.test(transcript)) { COMMANDS[i].fn(); return; }
    }
    if (transcript === '大' || transcript === '大一点') { setFont(1); return; }
    if (transcript === '小' || transcript === '小一点') { setFont(-1); return; }
    showToast('没听清');
  }

  // ---------- 语音识别 ----------
  function setVoiceState(on, label) {
    if (on) {
      els.voice.classList.add('listening');
      els.voiceLabel.textContent = '聆听中';
    } else {
      els.voice.classList.remove('listening');
      els.voiceLabel.textContent = label || '已停止';
    }
  }

  function setupRecognition() {
    if (!speechSupported) return;
    recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onstart = function () { recognizing = true; setVoiceState(true); };
    recognition.onresult = function (e) {
      var t = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        t += e.results[i][0].transcript;
      }
      handleCommand(t);
    };
    recognition.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        listening = false;
        setVoiceState(false, '麦克风未授权');
      }
    };
    recognition.onend = function () {
      recognizing = false;
      if (listening) {
        setTimeout(function () {
          if (listening && !recognizing) {
            try { recognition.start(); } catch (err) { /* 忽略 */ }
          }
        }, 300);
      } else {
        setVoiceState(false);
      }
    };
  }

  // ---------- 屏幕常亮 ----------
  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
    }).catch(function () { /* 忽略 */ });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && 'wakeLock' in navigator && !wakeLock) {
      requestWakeLock();
    }
  });

  // ---------- 全屏 / PWA 引导 ----------
  // iOS Safari 出于苹果安全策略不支持 Element Fullscreen API，无法用 JS 收起地址栏；
  // 唯一真正满屏的方式是「添加到主屏幕」以 PWA 独立模式启动（navigator.standalone=true）。
  function canFullscreenApi() {
    var el = document.documentElement;
    return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen);
  }
  function enterFullscreen() {
    // 已从主屏启动 → 已经是无地址栏全屏
    if (window.navigator.standalone) {
      showToast('已在全屏模式');
      speak('已在全屏模式');
      return;
    }
    var el = document.documentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (req) {
      try {
        var p = req.call(el);
        if (p && typeof p.then === 'function') {
          p.catch(function () { showFsGuide(); }); // 用户拒绝/不支持 → 引导
        }
        return;
      } catch (e) { /* 落到引导 */ }
    }
    showFsGuide();
  }
  function showFsGuide() {
    if (window.navigator.standalone) {
      showToast('已在全屏模式');
      speak('已在全屏模式');
      return;
    }
    if (els.fsBanner) els.fsBanner.classList.add('show');
  }
  function hideFsGuide() {
    if (els.fsBanner) els.fsBanner.classList.remove('show');
  }
  function maybeShowFsHint() {
    if (window.navigator.standalone) return;   // 已全屏
    if (canFullscreenApi()) { enterFullscreen(); return; } // 桌面/安卓：直接真全屏
    showFsGuide();                              // iOS Safari：引导添加到主屏幕
  }

  // ---------- 启动 ----------
  function startExperience() {
    els.start.style.display = 'none';
    els.app.classList.add('show');
    buildOrder(false);   // 每次进入都重新随机
    loadByOrder(0);
    applyFont();
    updateModeHint();
    requestWakeLock();
    maybeShowFsHint();   // 可全屏则直接全屏；iOS 则引导添加到主屏幕
    if (speechSupported) {
      listening = true;
      try { recognition.start(); } catch (err) { /* 忽略 */ }
    } else {
      setVoiceState(false, '浏览器不支持语音');
      els.hint.textContent = '当前浏览器不支持语音，可用下方按钮控制';
    }
    play();
    rafId = requestAnimationFrame(tick);
    // 在用户手势内触发一次朗读，解锁后续语音反馈
    var s = songs[songIndex];
    speak('随机播放，' + s.title);
  }

  function applyFont() {
    document.documentElement.style.setProperty('--lyric-size', FONT_SIZES[fontLevel] + 'px');
    goToLine(currentLine, false);
  }

  function onControlClick(e) {
    var act = e.target.getAttribute('data-act');
    if (!act) return;
    if (act === 'prev') prevSong();
    else if (act === 'next') nextSong();
    else if (act === 'toggle') togglePlay();
    else if (act === 'shuffle') reshuffle();
    else if (act === 'fullscreen') enterFullscreen();
    else if (act === 'font+') setFont(1);
    else if (act === 'font-') setFont(-1);
  }

  function init() {
    buildSongs();
    setupRecognition();
    if (!speechSupported) {
      els.startHint.textContent = '提示：语音控制需 iPad Safari，其他浏览器可用下方按钮';
    }
    els.startBtn.addEventListener('click', startExperience);
    document.querySelector('.controls').addEventListener('click', onControlClick);
    if (els.fsClose) els.fsClose.addEventListener('click', hideFsGuide);
    if (synth && 'onvoiceschanged' in synth) { synth.onvoiceschanged = function () { }; }
  }

  init();
})();
