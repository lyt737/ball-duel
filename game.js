/*
 * 球影对决 - 客户端主控
 * - 输入：WASD/方向键移动、鼠标瞄准、按住左键连发弓箭
 * - 模式：本地练习（人机 AI） / 在线联机（WebSocket 房间号，服务端权威模拟）
 */
(function () {
  'use strict';

  var Eng = window.DuelEngine;
  var R = window.Renderer;
  var C = Eng.C;

  /* ---------- DOM 工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function setText(id, t) { $(id).textContent = t; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 全局状态 ---------- */
  var mode = null;            // null | 'practice' | 'online'
  var role = 0;
  var names = ['红方球手', '蓝方球手'];
  var lastSnap = null;
  var prevSnapObj = null;
  // 网络插值：保存最近若干快照及各自本地到达时间（20Hz 服务端下需留足够缓冲）
  var hist = []; // [{s, t}]
  var histMax = 6;
  var lastPhase = '';
  var lastPhaseT = -1;
  var inPlay = false;

  var keys = { w: false, a: false, s: false, d: false };
  var fireDown = false;
  var boostHeld = false;   // 冲刺键是否按住
  var boostRequest = false;// 需要上报一次的冲刺（边沿）
  var snipeRequest = false;// 需要上报一次的右键秒杀箭（边沿）
  var localBoostRemain = 0; // 联机本地"预测冲刺"剩余时间（视觉补偿，等服务器快照跟上）
  var mouseCss = { x: 0, y: 0, has: false };

  var practiceGame = null;
  var practiceTime = 0;
  var aiSwap = 1;
  var aiShootTimer = 0;

  var ws = null;
  var netKind = null;      // 'ws'(本地/局域网自建服务器) | 'mqtt'(公共中继，静态部署用)
  var lastSendT = 0;
  var audioEnabled = true;

  // 是否本地/局域网访问（能连到自建 server.js）
  function isLocalHost() {
    var h = location.hostname;
    if (!h) return true;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
      /^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  }

  // 统一发送入口：自动选择 WS 或 MQTT
  function netSend(obj) {
    if (netKind === 'mqtt' && window.MQTTNet) { window.MQTTNet.send(obj); return true; }
    return wsSend(obj);
  }

  // 公共中继状态回调
  function onNetStatus(s, extra) {
    if (s === 'ok') netTip('公共中继已连接…', 'ok');
    else if (s === 'ready') netTip('房间已就绪（中继模式）', 'ok');
    else if (s === 'fail') { netTip(extra || '公共中继连接失败', 'err'); showToast(extra || '连接失败，请重试', 3600); }
  }

  /* =========================================================
   *                       音效（合成）
   * ========================================================= */
  var AC = null;
  function ensureAudio() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (AC && AC.state === 'suspended') AC.resume();
  }
  function tone(f0, f1, dur, vol, type) {
    if (!audioEnabled || !AC) return;
    var t = AC.currentTime;
    var o = AC.createOscillator();
    var g = AC.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(AC.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, ff) {
    if (!audioEnabled || !AC) return;
    var t = AC.currentTime;
    var len = Math.floor(AC.sampleRate * dur);
    var buf = AC.createBuffer(1, len, AC.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = AC.createBufferSource();
    src.buffer = buf;
    var f = AC.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = ff;
    var g = AC.createGain();
    g.gain.setValueAtTime(vol, t);
    src.connect(f); f.connect(g); g.connect(AC.destination);
    src.start(t);
  }
  var SFX = {
    shot: function () { tone(480, 220, 0.09, 0.05, 'square'); noise(0.06, 0.04, 2600); },
    hitMe: function () { tone(220, 70, 0.16, 0.2, 'sawtooth'); noise(0.1, 0.14, 800); },
    hitEnemy: function () { tone(300, 120, 0.12, 0.1, 'triangle'); },
    wall: function () { noise(0.05, 0.04, 1400); },
    tick: function () { tone(900, 680, 0.06, 0.1, 'sine'); },
    go: function () { tone(620, 900, 0.18, 0.14, 'sine'); },
    roundWin: function () { tone(523, 523, 0.11, 0.12, 'triangle'); setTimeout(function () { tone(784, 784, 0.16, 0.12, 'triangle'); }, 110); },
    roundLose: function () { tone(330, 240, 0.22, 0.14, 'triangle'); },
    matchWin: function () { var n = [523, 659, 784, 1046]; n.forEach(function (f, i) { setTimeout(function () { tone(f, f, 0.18, 0.14, 'triangle'); }, i * 130); }); },
    matchLose: function () { var n = [392, 330, 262, 196]; n.forEach(function (f, i) { setTimeout(function () { tone(f, f * 0.96, 0.2, 0.13, 'triangle'); }, i * 140); }); },
    boost: function () { tone(280, 900, 0.16, 0.12, 'sine'); noise(0.12, 0.08, 3200); },
    snipe: function () { tone(1400, 2000, 0.08, 0.09, 'square'); noise(0.06, 0.05, 6000); }
  };
  function playEvent(ev) {
    if (!ev) return;
    if (ev.t === 'shot') SFX.shot();
    else if (ev.t === 'hit') { if (ev.j === role) SFX.hitMe(); else SFX.hitEnemy(); }
    else if (ev.t === 'hitWall') SFX.wall();
    else if (ev.t === 'go') SFX.go();
    else if (ev.t === 'boost') { if (ev.i !== role) SFX.boost(); } // 自己的冲刺已在按键时即时发声
    else if (ev.t === 'snipe') { if (ev.i !== role) SFX.snipe(); }
    else if (ev.t === 'snipeHit') { if (ev.j === role) { SFX.hitMe(); SFX.snipe(); } else { SFX.hitEnemy(); SFX.snipe(); } }
    else if (ev.t === 'roundOver') { if (ev.winner === role) SFX.roundWin(); else if (ev.winner >= 0) SFX.roundLose(); }
    else if (ev.t === 'matchOver') { if (ev.winner === role) SFX.matchWin(); else SFX.matchLose(); }
  }

  /* =========================================================
   *                    界面 / 覆盖层
   * ========================================================= */
  function showScreen(name) {
    $('menu').classList.toggle('hidden', name !== 'menu');
    $('lobby').classList.toggle('hidden', name !== 'lobby');
  }
  function showHud(v) {
    $('hud').classList.toggle('hidden', !v);
    inPlay = v;
    // 进入对局时取消焦点：防止空格/回车误触发仍聚焦的按钮（导致跳到打字/退出）
    if (v && document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
  }
  function showBig(v, cls) {
    var el = $('countdown');
    el.className = 'big' + (cls ? ' ' + cls : '') + (v ? '' : ' hidden');
  }
  function showBanner(v, html) {
    var el = $('banner');
    el.classList.toggle('hidden', !v);
    if (v) el.innerHTML = html;
  }
  var toastTimer = null;
  function showToast(text, ms) {
    var el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2600);
  }
  function netTip(msg, cls) {
    var el = $('netTip');
    el.textContent = msg || '';
    el.className = 'netTip ' + (cls || '');
  }
  function updateSndBtn() {
    var b = $('btnSnd');
    b.textContent = audioEnabled ? '音效 开' : '音效 关';
    b.classList.toggle('off', !audioEnabled);
  }
  function setNameOfInput() {
    var n = $('nameIn').value.trim();
    if (!n) n = '神秘球手' + Math.floor(100 + Math.random() * 900);
    try { localStorage.setItem('qyj_name', n); } catch (e) {}
    return n;
  }

  /* =========================================================
   *                        输入
   * ========================================================= */
  function bindInput() {
    var DOWN = {
      w: 'w', s: 's', a: 'a', d: 'd',
      arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd'
    };
    function isTyping() {
      var el = document.activeElement;
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    }
    // 对局中禁止"空格/回车"激活页面按钮，防止跳屏/误触发退出；但不拦截冲刺逻辑
    window.addEventListener('keydown', function (e) {
      var k = e.key;
      if (inPlay && (k === ' ' || k === 'Spacebar' || k === 'Enter')) {
        var tgt = e.target;
        // 若焦点在按钮上，空格会被当作"点按"：阻止默认并移除焦点
        if (tgt && (tgt.tagName === 'BUTTON' || tgt.tagName === 'A' || tgt.hasAttribute('role'))) {
          e.preventDefault();
          e.stopPropagation();
          if (tgt.blur) tgt.blur();
        }
      }
    }, true);
    window.addEventListener('keydown', function (e) {
      if (isTyping()) return;
      var k = e.key.toLowerCase();
      if (k === 'shift' || k === ' ') {
        e.preventDefault();
        if (e.repeat || boostHeld) return;
        boostHeld = true;
        boostRequest = true; // 单次触发：下一帧上报给服务器
        localBoostFeedback();
        return;
      }
      var map = DOWN[k];
      if (map) { e.preventDefault(); keys[map] = true; }
    });
    window.addEventListener('keyup', function (e) {
      var k = e.key.toLowerCase();
      if (k === 'shift' || k === ' ') { boostHeld = false; return; }
      var map = DOWN[k];
      if (map) keys[map] = false;
    });
    window.addEventListener('mousemove', function (e) {
      mouseCss.x = e.clientX; mouseCss.y = e.clientY; mouseCss.has = true;
    });
    window.addEventListener('mousedown', function (e) {
      ensureAudio();
      // 点击场上时移除按钮焦点（防止后续空格误触发按钮）
      if (inPlay && document.activeElement && document.activeElement.blur) document.activeElement.blur();
      if (e.button === 0) {
        var was = fireDown;
        fireDown = true;
        // 按下瞬间立即把"开火"送给服务器 + 本地火光反馈，避免"开局攻击有冷却"的错觉
        if (!was) {
          pushInputNow();
          localShotFeedback();
        }
      } else if (e.button === 2) {
        // 右键：一发极快的秒杀箭（边沿触发，冷却由服务器保证）
        e.preventDefault();
        if (snipeRequest) return;
        snipeRequest = true;
        pushInputNow();        // 立即上报
        localSnipeFeedback();  // 本地立即反馈
      }
    });
    window.addEventListener('mouseup', function (e) {
      if (e.button === 0) {
        fireDown = false;
        // 松手立即停止
        pushInputNow();
      }
    });
    window.addEventListener('blur', function () {
      keys.w = keys.a = keys.s = keys.d = false;
      fireDown = false;
      boostHeld = false;
      snipeRequest = false;
    });
    window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('pointerdown', ensureAudio);
  }

  function updateMoveFromKeys() {
    var dx = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
    var dy = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) { dx /= len; dy /= len; }
    return { dx: dx, dy: dy };
  }
  function aimAngle() {
    var p = lastSnap ? lastSnap.players[role] : null;
    var bx = p ? p.x : C.W * 0.2;
    var by = p ? p.y : C.H * 0.5;
    if (!mouseCss.has) return p ? p.aim : 0;
    var w = R.toWorld(mouseCss.x, mouseCss.y);
    return Math.atan2(w.y - by, w.x - bx);
  }

  /* =========================================================
   *                     本地练习（对战 AI）
   * ========================================================= */
  function startPractice() {
    if (mode === 'online') leaveOnline(false);
    resetAllFx();
    mode = 'practice';
    role = 0;
    names = [setNameOfInput() + '（你）', '电脑 AI'];
    practiceGame = Eng.createGame();
    practiceTime = 0;
    aiSwap = 1;
    aiShootTimer = 0.6;
    lastPhase = '';
    showScreen('none');
    showHud(true);
    setNames(names);
    setScores(0, 0, 1);
    showBig(false);
    showBanner(false);
    updateSndBtn();
  }

  function angDiff(a, b) {
    var d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function aiThink(dt) {
    practiceTime += dt;
    var me = practiceGame.players[1];
    var opp = practiceGame.players[0];
    var dx = opp.x - me.x, dy = opp.y - me.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / dist, uy = dy / dist;

    var danger = null;
    var arrows = practiceGame.arrows;
    for (var i = 0; i < arrows.length; i++) {
      var a = arrows[i];
      if (a.owner !== 0) continue;
      var adx = me.x - a.x, ady = me.y - a.y;
      var ad = Math.sqrt(adx * adx + ady * ady) || 1;
      var spd = Math.hypot(a.vx, a.vy) || 1;
      var dot = (a.vx * adx + a.vy * ady) / (spd * ad);
      if (dot > 0.88 && ad < 260) { danger = a; break; }
    }

    var moveX = 0, moveY = 0;
    if (danger) {
      var dv = Math.hypot(danger.vx, danger.vy) || 1;
      var nxx = danger.vx / dv, nyy = danger.vy / dv;
      moveX = -nyy * aiSwap; moveY = nxx * aiSwap;
      if (Math.random() < 0.02) aiSwap = -aiSwap;
    } else {
      var strafe = Math.sin(practiceTime * 0.8) * 0.9;
      moveX = strafe * -uy + (dist > 480 ? ux * 0.8 : 0) + (dist < 260 ? -ux * 0.9 : 0);
      moveY = strafe * ux + (dist > 480 ? uy * 0.8 : 0) + (dist < 260 ? -uy * 0.9 : 0);
    }

    var lead = dist / C.ARROW_SPEED;
    var tx = opp.x + opp.vx * lead * 0.8;
    var ty = opp.y + opp.vy * lead * 0.8;
    var aim = Math.atan2(ty - me.y, tx - me.x);
    if (Math.random() < 0.25) aim += (Math.random() - 0.5) * 0.05;

    aiShootTimer -= dt;
    var fire = false;
    if (me.quiver > 0 && dist > 130 && dist < 1000) {
      if (Math.abs(angDiff(aim, me.aim)) < 0.14 && aiShootTimer <= 0) {
        fire = true;
        aiShootTimer = 0.15 + Math.random() * 0.1;
      }
    }
    var ml = Math.sqrt(moveX * moveX + moveY * moveY);
    if (ml > 1) { moveX /= ml; moveY /= ml; }
    me.ctrl.dx = moveX; me.ctrl.dy = moveY; me.ctrl.aim = aim; me.ctrl.fire = fire;
  }

  /* =========================================================
   *                    在线联机
   * ========================================================= */
  var pendingSend = []; // 连接尚未就绪时要补发的消息

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return ws;
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try { ws = new WebSocket(proto + '://' + location.host); } catch (e) { return null; }

    ws.onopen = function () {
      netTip('服务器已连接，可创建/加入房间', 'ok');
      // 补发连接建立前积压的消息（创建/加入），解决“点加入没反应”
      for (var i = 0; i < pendingSend.length; i++) {
        if (ws.readyState === 1) ws.send(pendingSend[i]);
      }
      pendingSend.length = 0;
      // URL 携带房间号自动入房
      var qs = new URLSearchParams(location.search);
      if (qs.get('room')) {
        var c = qs.get('room').trim().toUpperCase();
        if (c) wsSend({ type: 'join', code: c, name: setNameOfInput() });
      }
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      onServerMsg(m);
    };
    ws.onclose = function () {
      netTip('未能连接到服务器。可以先玩“本地练习”；启动联机请运行 node server.js', 'err');
      if (mode === 'online') backToMenu(true);
      ws = null;
    };
    return ws;
  }

  function wsSend(obj) {
    var str = JSON.stringify(obj);
    if (ws && ws.readyState === 1) { ws.send(str); return true; }
    if (ws && ws.readyState === 0) {
      // 连接中：先缓存，onopen 后自动补发
      pendingSend.push(str);
      return true;
    }
    return false;
  }

  // 构造本机输入消息；boost 是一次性边沿（发出即复位）
  function makeInputMsg() {
    var mv = updateMoveFromKeys();
    var b = boostRequest;
    var sn = snipeRequest;
    boostRequest = false;
    snipeRequest = false;
    return {
      type: 'input',
      k: { w: keys.w, a: keys.a, s: keys.s, d: keys.d },
      aim: aimAngle(),
      fire: fireDown,
      boost: b,
      snipe: sn
    };
  }

  // 练习模式取走一次冲刺/秒杀箭请求（边沿）
  function consumeBoost() {
    var v = boostRequest;
    boostRequest = false;
    return v;
  }
  function consumeSnipe() {
    var v = snipeRequest;
    snipeRequest = false;
    return v;
  }

  // 立即上报一次本机输入（鼠标按下/抬起/冲刺时立刻调用，降低首箭/首冲延迟）
  function pushInputNow() {
    if (mode !== 'online' || !inPlay) return;
    if (netKind !== 'mqtt' && (!ws || ws.readyState !== 1)) return;
    lastSendT = performance.now();
    netSend(makeInputMsg());
  }

  // 本地开火反馈：球按当前位置向前喷一小撮火光，箭飞行本体仍以服务器权威为准
  // 仅用于联机模式（练习模式引擎本机即时，无需补偿）
  function localShotFeedback() {
    if (mode !== 'online') return;
    var base = lastSnap;
    if (!base || !inPlay) return;
    if (base.phase !== 'playing') return; // 开局倒计时阶段不开火
    var me = base.players[role];
    if (!me || me.quiver <= 0) return;    // 没箭不冒火
    var aim = aimAngle();
    var ox = me.x + Math.cos(aim) * (C.BALL_R + 26);
    var oy = me.y + Math.sin(aim) * (C.BALL_R + 26);
    R.localMuzzle(ox, oy, aim, role);
  }

  // 本地冲刺反馈：短促音效 + 预测冲刺视觉，让联机下冲刺"即按即冲"
  function localBoostFeedback() {
    if (!inPlay) return;
    var base = lastSnap;
    if (base && base.players[role] && base.players[role].boostCd > 0) return; // 冷却中不生效
    SFX.boost();
    if (mode === 'online') localBoostRemain = C.BOOST_TIME;
  }

  // 右键秒杀箭：立即给一个"破空"反馈（弹体/致死仍以服务器权威为准）
  function localSnipeFeedback() {
    if (!inPlay) return;
    var base = lastSnap;
    if (base && base.players[role] && base.players[role].snipeCd > 0) {
      showToast('必杀箭冷却中', 1000);
      return;
    }
    SFX.snipe();
    if (mode === 'online') {
      // 本地画一道极快的蓝色破空线（视觉）
      var me = base.players[role];
      if (me) {
        var aim = aimAngle();
        var sx = me.x + Math.cos(aim) * (C.BALL_R + 12);
        var sy = me.y + Math.sin(aim) * (C.BALL_R + 12);
        R.localSnipeLine(sx, sy, aim);
      }
    }
  }

  function onServerMsg(m) {
    switch (m.t) {
      case 'error':
        showToast(m.message || '操作失败', 3600);
        break;
      case 'lobby':
        mode = 'online';
        role = m.role;
        if (netKind === 'mqtt' && window.MQTTNet) window.MQTTNet.onLobbyReceived();
        renderLobby(m);
        break;
      case 'begin':
        if (m.names) names = m.names.slice();
        break;
      case 'state':
        if (mode !== 'online') return;
        if (!inPlay && lastSnap === null) {
          showScreen('none');
          showHud(true);
          setNames(names);
          showBanner(false);
          showBig(false);
          updateSndBtn();
        }
        acceptSnapshot(m.s);
        break;
      case 'peerLeft':
        lastSnap = null;
        prevSnapObj = null;
        hist.length = 0;
        lastPhase = '';
        showBig(false);
        showBanner(false);
        showHud(false);
        setScores(0, 0, 1);
        showToast(m.message || '对手已离开', 3000);
        break;
    }
  }

  function renderLobby(m) {
    mode = 'online';
    role = m.role;
    if (m.code) setText('roomCode', m.code);

    var box = $('roster');
    var html = '';
    for (var i = 0; i < 2; i++) {
      var p = null;
      for (var j = 0; j < m.players.length; j++) {
        if (m.players[j].role === i) { p = m.players[j]; break; }
      }
      var color = i === 0 ? '#ef4444' : '#3b82f6';
      var nm = p ? p.name : '等待加入…';
      var st;
      if (!p) st = '<span class="rstate wait">空位</span>';
      else if (p.role === m.role) st = '<span class="rstate tag-you">' + (p.ready ? '已准备' : '未准备') + '</span>';
      else st = '<span class="rstate ' + (p.ready ? 'ready' : 'not') + '">' + (p.ready ? '已准备' : '未准备') + '</span>';

      html += '<div class="rrow">' +
        '<span class="ballIcon" style="background:' + color + '"></span>' +
        '<span class="rinfo"><span class="rname">' + esc(nm) + (p && p.role === m.role ? '（我）' : '') + '</span>' +
        '<div class="rsub">' + (i === 0 ? '左场 · 红队' : '右场 · 蓝队') + '</div></span>' + st +
        '</div>';
    }
    box.innerHTML = html;

    var readyBtn = $('btnReady');
    var two = m.players.length === 2;
    if (two) {
      readyBtn.disabled = false;
      var me = null;
      for (var k = 0; k < m.players.length; k++) if (m.players[k].role === m.role) me = m.players[k];
      readyBtn.textContent = me && me.ready ? '取消准备' : '准备';
    } else {
      readyBtn.disabled = true;
      readyBtn.textContent = '等待另一名玩家…';
    }

    var hint = $('lobbyHint');
    if (two) {
      hint.innerHTML = m.onceStarted
        ? '上一局曾被打断。两人到齐后将自动开始新对局。'
        : '房间号 <b style="letter-spacing:2px">' + m.code + '</b> 已生成。双方都点「准备」即可开战。';
    } else {
      hint.innerHTML = '将房间号 <b style="letter-spacing:2px">' + m.code + '</b> 或邀请链接发给朋友。<br/>对方加入后，双方点「准备」即可开战。';
    }
    showScreen('lobby');
  }

  function createRoom() {
    var name = setNameOfInput();
    // 公网静态部署（如 GitHub Pages）用公共中继；本地/局域网用自建服务器
    if (!isLocalHost() && window.MQTTNet) {
      netKind = 'mqtt';
      netTip('正在连接公共中继…', '');
      window.MQTTNet.create(name, onServerMsg, onNetStatus);
      return;
    }
    netKind = 'ws';
    var c = connect();
    if (!c) { showToast('无法连接服务器'); return; }
    wsSend({ type: 'create', name: name });
  }
  function joinRoom() {
    var code = $('roomIn').value.trim().toUpperCase();
    if (!code) { showToast('请输入房间号'); return; }
    var name = setNameOfInput();
    if (!isLocalHost() && window.MQTTNet) {
      netKind = 'mqtt';
      netTip('正在连接公共中继…', '');
      window.MQTTNet.join(code, name, onServerMsg, onNetStatus);
      return;
    }
    netKind = 'ws';
    var c = connect();
    if (!c) { showToast('无法连接服务器'); return; }
    wsSend({ type: 'join', code: code, name: name });
  }
  function leaveOnline(sendMsg) {
    if (netKind === 'mqtt' && window.MQTTNet) {
      if (sendMsg) window.MQTTNet.send({ type: 'leave' });
      window.MQTTNet.close();
      netKind = null;
      return;
    }
    if (sendMsg) wsSend({ type: 'leave' });
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    netKind = null;
  }

  /* =========================================================
   *                  快照接入 / HUD / 覆盖
   * ========================================================= */
  function acceptSnapshot(snap) {
    var fresh = snap !== prevSnapObj;
    prevSnapObj = snap;
    if (fresh) {
      R.processEvents(snap.events);
      for (var i = 0; i < snap.events.length; i++) playEvent(snap.events[i]);
    }
    // 在线模式：压入历史用于插值；练习模式直接用最新
    if (mode === 'online') {
      hist.push({ s: snap, t: performance.now() });
      if (hist.length > histMax) hist.shift();
    } else {
      hist.length = 0;
    }
    lastSnap = snap;
    updateOverlays(snap);
    updateHud(snap);
  }

  // 在最近历史快照之间插值：对手与箭矢平滑；自己另用本地预测覆盖。
  function buildRenderSnap() {
    if (!lastSnap) return null;
    if (hist.length < 2) return lastSnap;
    // 渲染时刻留一点缓冲，保证能落在历史区间内
    var INTERP_MS = 90;
    var targetT = performance.now() - INTERP_MS;
    // 找 targetT 落在哪两个快照之间（hist 内 t 递增）
    var a = null, b = null;
    for (var i = hist.length - 1; i >= 0; i--) {
      if (hist[i].t <= targetT) { a = hist[i]; break; }
    }
    if (!a) { a = hist[0]; b = hist[1]; }
    else {
      // 找 a 之后离 targetT 最近的那个快照
      for (var j = 0; j < hist.length; j++) {
        if (hist[j].t > a.t) { b = hist[j]; break; }
      }
    }
    if (!b) return a.s;
    if (b.t === a.t) return b.s;
    if (targetT <= a.t) return a.s;
    if (targetT >= b.t) return b.s;
    var t = (targetT - a.t) / (b.t - a.t);
    var s0 = a.s, s1 = b.s; // 两个原始快照
    var out = {
      w: s1.w, h: s1.h, phase: s1.phase, phaseT: s1.phaseT,
      round: s1.round, winner: s1.winner, scores: s1.scores,
      players: [], arrows: [], events: []
    };
    for (var i = 0; i < 2; i++) {
      var pa = s0.players[i], pbn = s1.players[i];
      out.players.push({
        x: pa.x + (pbn.x - pa.x) * t,
        y: pa.y + (pbn.y - pa.y) * t,
        vx: pa.vx + (pbn.vx - pa.vx) * t,
        vy: pa.vy + (pbn.vy - pa.vy) * t,
        hp: pbn.hp,
        aim: pa.aim + (angLerp(pa.aim, pbn.aim) - pa.aim) * t,
        quiver: pbn.quiver, fireCd: pbn.fireCd,
        reloading: pbn.reloading, reloadT: pbn.reloadT,
        boostT: pbn.boostT, boostCd: pbn.boostCd,
        snipeCd: pbn.snipeCd
      });
    }
    // 箭矢按 id 匹配，找不到的（新生）用较新快照的位置
    for (var ai = 0; ai < s1.arrows.length; ai++) {
      var ab = s1.arrows[ai];
      var found = null;
      for (var aj = 0; aj < s0.arrows.length; aj++) {
        if (s0.arrows[aj].id === ab.id) { found = s0.arrows[aj]; break; }
      }
      if (found) {
        out.arrows.push({
          x: found.x + (ab.x - found.x) * t,
          y: found.y + (ab.y - found.y) * t,
          vx: found.vx + (ab.vx - found.vx) * t,
          vy: found.vy + (ab.vy - found.vy) * t,
          owner: ab.owner, id: ab.id, kill: !!ab.kill
        });
      } else {
        out.arrows.push({ x: ab.x, y: ab.y, vx: ab.vx, vy: ab.vy, owner: ab.owner, id: ab.id, kill: !!ab.kill });
      }
    }
    return out;
  }
  // 角度线性插值（处理 -π / π 环绕）
  function angLerp(a, b) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d;
  }

  // 自身预测：基于最新服务端快照 + 本地输入，预测 dt 秒后的状态
  // optBoost: 本地即时冲刺剩余时间（在服务器确认前先表现为冲刺，随后由快照校准）
  function predictLocalPlayer(snap, mv, aim, dt, optBoost) {
    if (!snap || dt <= 0) return snap ? snap.players[role] : null;
    var src = snap.players[role];
    var bt = (optBoost !== undefined && optBoost > 0) ? optBoost : (src.boostT || 0);
    var p = {
      x: src.x, y: src.y, vx: src.vx, vy: src.vy,
      hp: src.hp, aim: aim, quiver: src.quiver, fireCd: src.fireCd,
      reloading: src.reloading, reloadT: src.reloadT,
      boostT: bt, boostCd: src.boostCd || 0,
      snipeCd: src.snipeCd || 0
    };
    // 与引擎一致的 approach(...)
    function approach(cur, target, maxDelta) {
      if (cur < target) return Math.min(cur + maxDelta, target);
      return Math.max(cur - maxDelta, target);
    }
    // 本地冲刺刚触发时，也瞬间提速，与引擎保持一致手感
    if (optBoost !== undefined && optBoost > 0) {
      var bdx = mv.dx, bdy = mv.dy;
      var blen = Math.hypot(bdx, bdy);
      if (blen < 0.01) {
        var s0 = Math.hypot(src.vx, src.vy);
        if (s0 > 20) { bdx = src.vx / s0; bdy = src.vy / s0; }
        else { bdx = Math.cos(aim); bdy = Math.sin(aim); }
      }
      var bm = C.SPEED * C.BOOST_MULT;
      p.vx = bdx * bm;
      p.vy = bdy * bm;
    } else {
      var mult = bt > 0 ? C.BOOST_MULT : 1; // 冲刺剩余期间速度倍率
      p.vx = approach(p.vx, mv.dx * C.SPEED * mult, C.ACCEL * dt);
      p.vy = approach(p.vy, mv.dy * C.SPEED * mult, C.ACCEL * dt);
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    var r = C.BALL_R;
    if (p.x < r) p.x = r;
    if (p.x > C.W - r) p.x = C.W - r;
    if (p.y < r) p.y = r;
    if (p.y > C.H - r) p.y = C.H - r;
    return p;
  }

  function updateOverlays(snap) {
    var ph = snap.phase;
    if (ph !== lastPhase) {
      lastPhase = ph;
      lastPhaseT = -1;
      if (ph === 'countdown') {
        showBig(true); showBanner(false);
      } else if (ph === 'playing') {
        showBig(false); showBanner(false);
      } else if (ph === 'roundEnd') {
        showBig(false);
        var w = snap.winner;
        if (w < 0) {
          showBanner(true, '<div class="b-title">双方同时空血 · 平局</div><div class="b-sub">比分 ' + fmtScore(snap.scores) + '</div>');
        } else {
          var cls = w === 0 ? 'red' : 'blue';
          showBanner(true, '<div class="b-title ' + cls + '">' + esc(shortName(w)) + ' 得分！</div>' +
            '<div class="b-sub">比分 ' + fmtScore(snap.scores) + '</div>' +
            '<div class="b-scores">先到 5 分赢得比赛</div>');
        }
      } else if (ph === 'matchEnd') {
        showBig(false);
        var mw = snap.winner;
        var mcls = mw === 0 ? 'red' : 'blue';
        showBanner(true, '<div class="b-title ' + mcls + '">' + esc(shortName(mw)) + ' 赢得比赛！</div>' +
          '<div class="b-sub">最终比分 ' + fmtScore(snap.scores) + '</div>' +
          '<div class="b-scores">新对局即将自动开始…</div>');
      }
    }
    if (ph === 'countdown') {
      var t = Math.max(1, Math.ceil(snap.phaseT));
      if (t !== lastPhaseT) {
        lastPhaseT = t;
        setText('countdown', String(t));
        SFX.tick();
      }
    }
  }

  function fmtScore(s) { return s[0] + ' : ' + s[1]; }
  function shortName(i) { return (names && names[i]) || '球手'; }

  function updateHud(snap) {
    if (!snap) return;
    // 回合结束后快照中的 round 已指向下一局，结算画面按“上一局”显示
    var dispRound = (snap.phase === 'roundEnd' || snap.phase === 'matchEnd')
      ? Math.max(1, snap.round - 1)
      : snap.round;
    setScores(snap.scores[0], snap.scores[1], dispRound);
    for (var i = 0; i < 2; i++) {
      var p = snap.players[i];
      if (p) {
        $('hpfill' + i).style.width = Math.max(0, Math.min(100, p.hp / (C.HP || 100) * 100)) + '%';
        renderQuiver(i, p);
        renderBoostTag(i, p);
        renderSnipeTag(i, p);
      }
    }
  }

  // 右键必杀箭状态
  function renderSnipeTag(i, p) {
    var el = $('snipe' + i);
    var txt, cls;
    if (C.SNIPE.enabled === false) { el.textContent = ''; el.className = 'snipetag'; return; }
    if (p.snipeCd > 0) {
      txt = '必杀 ' + (Math.ceil(p.snipeCd * 10) / 10).toFixed(1) + 's';
      cls = 'cd';
    } else {
      txt = '右键必杀 · 就绪';
      cls = 'ok';
    }
    var key = txt + '|' + cls;
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    el.textContent = txt;
    el.className = 'snipetag ' + cls;
  }

  // 冲刺状态小标签：冲刺中 / 冷却中(倒计时) / 就绪
  function renderBoostTag(i, p) {
    var el = $('boost' + i);
    var txt, cls;
    if (p.boostT && p.boostT > 0) {
      txt = '冲刺中';
      cls = 'on';
    } else if (p.boostCd > 0) {
      txt = '冲刺冷却 ' + (Math.ceil(p.boostCd * 10) / 10).toFixed(1) + 's';
      cls = 'cd';
    } else {
      txt = (i === role ? 'Shift 冲刺 就绪' : '冲刺 就绪');
      cls = 'ok';
    }
    var key = txt + '|' + cls;
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    el.textContent = txt;
    el.className = 'boosttag ' + cls;
  }

  // i: 玩家槽位；p: 快照玩家（含 quiver / reloading / reloadT）
  function renderQuiver(i, p) {
    var box = $('quiver' + i);
    var n = p.quiver;
    var rel = p.reloading;
    var rt = rel ? Math.ceil(p.reloadT * 10) / 10 : 0;
    var key = i + ':' + n + ':' + (rel ? rt : 0);
    if (box.dataset.k === key) return;
    box.dataset.k = key;

    var html;
    if (rel) {
      // 一次性装弹中：显示倒计时
      html = '<span class="qtitle">装弹中</span>';
      var fullSeg = Math.min(n, C.QUIVER);
      for (var a = 0; a < C.QUIVER; a++) html += '<span class="qpip' + (a < fullSeg ? ' full' : ' reload') + '"></span>';
      html += '<span class="qcount">' + rt.toFixed(1) + 's</span>';
    } else {
      html = '<span class="qtitle">弓箭</span>';
      for (var q = 0; q < C.QUIVER; q++) html += '<span class="qpip' + (q < n ? ' full' : '') + '"></span>';
    }
    box.innerHTML = html;
  }

  function setScores(a, b, round) {
    var el = $('roundEl');
    var key = a + ':' + b + ':' + round;
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    setText('scoreRed', String(a));
    setText('scoreBlue', String(b));
    setText('roundEl', '第 ' + (round || 1) + ' 局');
  }
  function setNames(ns) {
    for (var i = 0; i < 2; i++) setText('pname' + i, ns[i] || ('球手' + (i + 1)));
  }

  /* =========================================================
   *                      主循环
   * ========================================================= */
  var lastT = 0;
  var acc = 0;
  var FIXED = 1 / 60;

  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0);
    lastT = now;

    if (mode === 'online' && inPlay && netKind === 'mqtt' && now - lastSendT > 50) {
      lastSendT = now;
      netSend(makeInputMsg());
    } else if (mode === 'online' && inPlay && ws && ws.readyState === 1 && now - lastSendT > 50) {
      lastSendT = now;
      wsSend(makeInputMsg());
    }

    if (mode === 'practice' && practiceGame) {
      acc += dt;
      if (acc > 0.25) acc = 0.25;
      var guard = 0;
      while (acc >= FIXED && guard < 5) {
        acc -= FIXED;
        guard++;
        var mvp = updateMoveFromKeys();
        var bEdge = guard === 1 ? consumeBoost() : false; // 冲刺/秒杀只喂给第一个物理步
        var sEdge = guard === 1 ? consumeSnipe() : false;
        Eng.setCtrl(practiceGame, 0, { dx: mvp.dx, dy: mvp.dy, aim: aimAngle(), fire: fireDown, boost: bEdge, snipe: sEdge });
        aiThink(FIXED);
        Eng.update(practiceGame, FIXED);
      }
      var snap = Eng.snapshot(practiceGame);
      acceptSnapshot(snap);
    }

    if (lastSnap && inPlay) {
      var w = mouseCss.has ? R.toWorld(mouseCss.x, mouseCss.y) : null;
      // 联机模式：渲染插值后的快照；自身用本地预测覆盖
      var renderSnap = (mode === 'online') ? buildRenderSnap() : lastSnap;
      if (renderSnap && mode === 'online' && role != null && renderSnap.players[role]) {
        var mv = updateMoveFromKeys();
        var aim = aimAngle();
        // 本地预测基于最新到达快照，预测到"现在"所需的推进时间
        var latestArr = hist.length ? hist[hist.length - 1].t : performance.now();
        var dtPred = Math.min(0.2, (performance.now() - latestArr) / 1000);
        // 本地冲刺预测补偿：按下后还没等到服务器确认，先用本地剩余时间表现出冲刺
        var optBoost = localBoostRemain > 0 ? localBoostRemain : undefined;
        if (localBoostRemain > 0) localBoostRemain = Math.max(0, localBoostRemain - dt);
        var pred = predictLocalPlayer(lastSnap, mv, aim, dtPred, optBoost);
        if (pred) {
          renderSnap = {
            w: renderSnap.w, h: renderSnap.h,
            phase: renderSnap.phase, phaseT: renderSnap.phaseT,
            round: renderSnap.round, winner: renderSnap.winner,
            scores: renderSnap.scores,
            players: renderSnap.players.slice(),
            arrows: renderSnap.arrows, events: renderSnap.events
          };
          renderSnap.players[role] = pred;
        }
      }
      R.frame(renderSnap, { role: role, aimWorld: w }, dt);
    }
  }

  function resetAllFx() {
    prevSnapObj = null;
    lastSnap = null;
    hist.length = 0;
    lastPhase = '';
    lastPhaseT = -1;
    practiceGame = null;
    try {
      var cv = $('game');
      var ctx = cv.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
    } catch (e) {}
  }

  function backToMenu(force) {
    if (mode === 'online') leaveOnline(true);
    resetAllFx();
    mode = null;
    showHud(false);
    showScreen('menu');
    showBig(false);
    showBanner(false);
  }

  /* =========================================================
   *                    按钮绑定
   * ========================================================= */
  function bindUI() {
    $('btnPractice').addEventListener('click', startPractice);

    $('btnCreate').addEventListener('click', createRoom);
    $('btnJoin').addEventListener('click', joinRoom);
    $('roomIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') joinRoom(); });
    $('nameIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') startPractice(); });

    $('btnReady').addEventListener('click', function () {
      if (mode === 'online') netSend({ type: 'ready' });
    });
    $('btnLeaveLobby').addEventListener('click', function () { backToMenu(true); });
    $('btnCopyLink').addEventListener('click', copyInvite);
    $('btnQuit').addEventListener('click', function () { backToMenu(true); });
    $('btnSnd').addEventListener('click', function () {
      audioEnabled = !audioEnabled;
      updateSndBtn();
    });
  }

  function copyInvite() {
    var code = $('roomCode').textContent.trim();
    var url = location.origin + location.pathname + '?room=' + encodeURIComponent(code);
    function done(ok) {
      showToast(ok ? '邀请链接已复制，朋友打开即可直接进入房间 ' + code : '复制失败，请手动发送房间号 ' + code, 3600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { fallbackCopy(url, done); });
    } else fallbackCopy(url, done);
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    done(ok);
  }

  /* =========================================================
   *                      初始化
   * ========================================================= */
  // 防止对局中被浏览器后退手势/快捷键退回上一页
  function installBackGuard() {
    // 压入一层占位历史，让"后退"先回到占位页，再在此拦截
    try { history.pushState({ g: 'guard' }, '', location.href); } catch (e) {}
    window.addEventListener('popstate', function (e) {
      // 对局中（进行中或正玩练习/联机）禁止真正后退
      if (inPlay) {
        showToast('对局中请勿使用浏览器后退，以免退出游戏', 2200);
        // 压回一层占位，使再次后退仍先回到这里被拦截
        try { history.pushState({ g: 'guard' }, '', location.href); } catch (e2) {}
      }
    });
  }

  function init() {
    R.attach($('game'));
    bindInput();
    bindUI();
    updateSndBtn();
    installBackGuard();
    showScreen('menu');

    try { $('nameIn').value = localStorage.getItem('qyj_name') || ''; } catch (e) {}

    var qs = new URLSearchParams(location.search);
    var roomParam = qs.get('room');
    if (roomParam) $('roomIn').value = roomParam.toUpperCase();

    if (isLocalHost()) {
      // 本地/局域网：连自建服务器
      connect();
    } else {
      netTip('公共中继模式（公网静态版）：创建/加入房间走公共中继，无需自建服务器', 'ok');
      // 通过邀请链接进入：自动加入房间
      if (roomParam && window.MQTTNet) {
        setTimeout(function () {
          netKind = 'mqtt';
          window.MQTTNet.join(roomParam.trim().toUpperCase(), setNameOfInput(), onServerMsg, onNetStatus);
        }, 300);
      }
    }

    requestAnimationFrame(function (t) { lastT = t; requestAnimationFrame(frame); });
  }

  init();
})();
