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
  var hist = []; // [{s, t, ht?}] t=到达时间；ht=主机时间戳（有则优先，时间轴无抖动）
  var histMax = 20;
  var lastPhase = '';
  var lastPhaseT = -1;
  var inPlay = false;

  /* ---------- 房员端：主机时间戳 → 无抖动渲染时间线 ----------
   * 主机的快照是按固定节拍产出的，它的 ht 是"等间隔"的；
   * 而快照经过公共中继后到达时间是忽快忽慢的。
   * 用 ht 当时间轴 + 一个播放缓冲，就能重建出平滑的对手运动。
   */
  var clkSamples = [];   // [{t, obs}] 最近 3 秒的"本机时间 − 主机时间"观测
  var clkOff = 0;        // 两机时钟偏移（取窗口内最小值 = 最快到达的那条）
  var clkJitter = 0;     // 窗口内 90 分位的额外延迟
  var clkReady = false;
  var histClock = '';    // 'host' | 'arrival'：时间轴口径，切换时清空历史
  // 自适应播放缓冲（ms）：房员把对手"回放"到多久之前。
  // 太小 → 缓冲不够，只能靠外推 → 一卡一跳；太大 → 对手慢半拍。
  // 这里让它自己测：一旦发现缓冲不够就立刻加大，长期不紧张就慢慢减小。
  var playoutMs = 110;
  var extrapN = 0;       // 近段统计：有多少帧"缓冲不够、只能外推"（越少越顺，0 最理想）
  var frameN = 0;        // 近段统计：渲染了多少帧（配合外推数判断严重程度）
  var behindExtra = 0;   // 兜底自增缓冲：发生外推就抬高，长期平稳就缓慢收回

  /* ---------- 联机非权威端：自身球本地连续模拟（根治"走一步又弹回"） ----------
   * 原理：权威端与本地用同一套移动公式、同一份输入，只是相差一个网络延迟。
   * 所以本地可以逐帧自己推进（零延迟、绝对平滑），只在收到快照时：
   *   1) 先做"延迟对齐"——把服务端位置对到本地轨迹的过去某一时刻；
   *   2) 只对"真实漂移"做限速纠偏，绝不瞬移（只有传送/回合重置才硬对齐）。
   */
  var ownSim = null;              // {x,y,vx,vy,boostT,boostCd} 逐帧推进的自身球
  var ownHist = [];               // [{t,x,y,ax,ay}] 原始轨迹 + 记录当时的累计纠偏量
  var OWN_HIST_MS = 2600;         // 轨迹回溯窗口（要能覆盖慢中继的完整往返）
  var lagEst = 0.10;              // 服务端快照相对"本机此刻"的滞后估计（秒）
  var appliedX = 0, appliedY = 0; // 已施加的累计纠偏量
  var driftX = 0, driftY = 0;     // 待逐帧缓慢消化的漂移
  var snapArrLast = 0;            // 上一个快照到达时刻
  var snapGapMs = 50;             // 平滑后的快照到达间隔均值（ms）
  var snapGapPeak = 50;           // 到达间隔的"衰减峰值"（ms）——决定插值缓冲要多大
  var ghostArrows = [];           // 本地乐观箭矢（视觉，权威箭出现后退役）
  var ghostSeq = -1;
  var ghostFireCd = 0;            // 本地乐观箭的连发节奏
  var ghostLocalQuiver = C.QUIVER;// 本地弹药估计（不等一个往返才恢复出箭）
  var ghostReloadT = 0;           // 本地估计的装弹剩余（秒）
  var ownArrowSeen = {};          // 已见过的"自己的权威箭" id
  var ownArrowSeenN = 0;

  var keys = { w: false, a: false, s: false, d: false };
  var fireDown = false;
  var boostHeld = false;     // 冲刺键是否按住
  var boostRequest = false;  // 需要上报一次的冲刺（边沿，发给权威端）
  var boostLocalEdge = false;// 需要被本地自身模拟消费一次的冲刺（边沿）
  var snipeRequest = false;  // 需要上报一次的右键秒杀箭（边沿）
  var mouseCss = { x: 0, y: 0, has: false };

  // 是否为"权威端"：房主（MQTT 模式）本地跑引擎，画面零延迟，无需预测。
  // 自建服务器（WS）为服务端权威，两端都算非权威，都需要预测。
  function isAuthority() {
    if (netKind === 'mqtt') return !!(window.MQTTNet && window.MQTTNet.isHost());
    return false;
  }
  // 与引擎一致的 approach
  function approachN(cur, target, maxDelta) {
    if (cur < target) return Math.min(cur + maxDelta, target);
    return Math.max(cur - maxDelta, target);
  }

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

  /* =========================================================
   *   自测台（全部挂在网址参数上，正常游玩不受任何影响）
   *   ?lag=120,60,2   网络模拟：单程延迟 120ms、抖动 ±60ms、丢包 2%
   *   ?auto=1         自动代打：本机玩家交给程序操作，一个人开两个窗口就能对打
   *   ?net=mqtt       本地/局域网也强制走公共中继（复现与线上完全相同的代码路径）
   *   例：https://.../ball-duel/?lag=150,80&auto=1
   *   目的：不用再约同学，一个人就能复现"房员看房主卡"这类问题。
   * ========================================================= */
  var NET = { on: false, base: 0, jitter: 0, loss: 0 };
  var autoPlay = /[?&]auto=1/.test(location.search);
  var autoHost = /[?&]host=1/.test(location.search); // 自动建房（配合 ?auto=1 可做到"零点击"开一局）
  var autoReadySent = false;
  function forceMqtt() { return /[?&]net=mqtt/.test(location.search); }

  (function parseNetSim() {
    var m = /[?&]lag=([^&]*)/.exec(location.search);
    if (!m) return;
    var p = decodeURIComponent(m[1]).split(',');
    var b = parseFloat(p[0]);
    var j = parseFloat(p[1] || '0');
    var l = parseFloat(p[2] || '0');
    if (!(b >= 0)) return; // 没写延迟就不启用
    NET.on = true;
    NET.base = Math.min(2000, b);
    NET.jitter = Math.max(0, Math.min(2000, isFinite(j) ? j : 0));
    NET.loss = Math.max(0, Math.min(90, isFinite(l) ? l : 0));
  })();

  function netSimDesc() {
    return '单程 ' + Math.round(NET.base) + 'ms' +
      (NET.jitter ? ' ±' + Math.round(NET.jitter) + 'ms' : '') +
      (NET.loss ? ' 丢包 ' + NET.loss + '%' : '');
  }

  // 让这条消息"在路上走一会儿"（含抖动与丢包），用来模拟真实的公网中继
  function netDelay(fn) {
    if (!NET.on) { fn(); return; }
    if (NET.loss > 0 && Math.random() * 100 < NET.loss) return; // 模拟丢包
    setTimeout(fn, NET.base + Math.random() * NET.jitter);
  }

  // 收到的消息先"上路"，再交给正常处理（模拟下行延迟）
  function onMsgFromNet(m) {
    if (!NET.on) { onServerMsg(m); return; }
    netDelay(function () { onServerMsg(m); });
  }

  /* ---------- 自动代打（?auto=1）：由程序操作本机玩家 ----------
   * 走的是和人手完全相同的输入链路（方向键 + 准星 + 开火），
   * 所以两个窗口各自开一个，就能自动对打，用来观察"对手画面卡不卡"。 */
  function autoInput() {
    if (!lastSnap || role == null) return;
    var me = ownSim || lastSnap.players[role];
    var opp = lastSnap.players[role === 0 ? 1 : 0];
    if (!me || !opp) return;
    var dx = opp.x - me.x, dy = opp.y - me.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / dist, uy = dy / dist;
    var t = performance.now() / 1000;
    var radial = dist > 520 ? 1 : (dist < 300 ? -1 : 0);
    var ang = t * 1.1;                        // 持续旋转的绕行方向（画面一直在动）
    var mx = ux * radial + Math.cos(ang) * 0.9;
    var my = uy * radial + Math.sin(ang) * 0.9;
    // 映射成 8 个方向键之一（和人手一样），交给既有的输入链路处理。
    // 关键：一定会有至少一个键按下 —— 否则球会停下不走，
    // 自测时就出现"看不出卡顿"的死角。
    var oct = Math.round(Math.atan2(my, mx) / (Math.PI / 4));
    oct = ((oct % 8) + 8) % 8;
    var DIRX = [1, 1, 0, -1, -1, -1, 0, 1];
    var DIRY = [0, 1, 1, 1, 0, -1, -1, -1];
    keys.d = DIRX[oct] > 0; keys.a = DIRX[oct] < 0;
    keys.s = DIRY[oct] > 0; keys.w = DIRY[oct] < 0;
    // 瞄准：预判对手位置，再把"准星"换算成屏幕坐标喂给瞄准逻辑
    var lead = dist / C.ARROW_SPEED;
    var tx = opp.x + opp.vx * lead * 0.8;
    var ty = opp.y + opp.vy * lead * 0.8;
    var s = R.toScreen(tx, ty);
    mouseCss.x = s.x; mouseCss.y = s.y; mouseCss.has = true;
    fireDown = dist > 120 && dist < 1500;
  }

  // 统一发送入口：自动选择 WS 或 MQTT
  function netSend(obj) {
    if (netKind === 'mqtt' && window.MQTTNet) {
      // 上行也走网络模拟（输入消息延迟到达，正是"房主看房员急停急走"的成因）
      netDelay(function () { window.MQTTNet.send(obj); });
      return true;
    }
    return wsSend(obj);
  }

  // 公共中继状态回调
  var brokerName = '';   // 当前实际连上的中继（显示在对局左上角，方便判断走的是哪条线路）
  function onNetStatus(s, extra) {
    if (s === 'ok') {
      brokerName = String(extra || '').replace(/^wss?:\/\//i, '').split('/')[0].replace(/:\d+$/, '');
      // 把中继名字显示出来：双方若连到不同中继（互相收不到消息），一眼就能发现
      netTip('公共中继已连接（' + brokerName + '）…', 'ok');
    }
    else if (s === 'ready') netTip('房间已就绪（中继模式）', 'ok');
    else if (s === 'fail') { netTip(extra || '公共中继连接失败', 'err'); showToast(extra || '连接失败，请重试', 3600); }
    // 断线自动重连（原来 reconnectPeriod=0，一掉线就彻底死掉，只能刷新页面）
    else if (s === 'lost') { netTip('与中继的连接中断，正在自动重连…', 'err'); showToast('网络中断，正在自动重连…', 4000); }
    else if (s === 'retry') { netTip('正在重连中继…', ''); }
    else if (s === 'back') { netTip('已重新连接中继，可继续对战', 'ok'); showToast('已重新连接，对阵可以继续了', 3000); }
    else if (s === 'waitjoin') {
      netTip('已连上中继，但还没收到房间信息…', 'err');
      showToast('8 秒未收到房间信息：① 确认房间号是否正确 ② 让对方保持页面在前台 ③ 双方中继名字要一致', 6000);
    }
  }

  /* ---------- 网络状态小条：把"卡不卡"变成能看的数字 ----------
   * 抖动 = 快照/输入到达时间的忽快忽慢程度，是"一卡一跳"的直接原因。
   * 抖动越小越顺；一般 <50ms 很顺，50~120ms 能玩，>120ms 会明显飘。 */
  var netStatT = 0;
  function updateNetStat(now) {
    if (now - netStatT < 500) return;
    netStatT = now;
    var el = $('netStat');
    if (!el) return;
    // 注意：必须写成 'block'。写空字符串 '' 会清掉内联样式，
    // 于是回落到 CSS 里的 display:none，状态条就永远不显示了。
    if (!inPlay || (mode !== 'online' && mode !== 'practice')) { el.style.display = 'none'; return; }
    el.style.display = 'block';

    // 本窗口（0.5 秒）内的帧时统计
    var avgMs = frameMsN ? frameMsSum / frameMsN : 0;
    var maxMs = frameMsMax;
    frameMsSum = 0; frameMsN = 0; frameMsMax = 0;

    // 练习模式（人机对练）完全不涉及网络：只报"本机帧率"，
    // 这样一眼就能分清卡顿是本机的、还是网络的。
    if (mode === 'practice') {
      var fps = avgMs > 0 ? Math.round(1000 / avgMs) : 0;
      var pcls = maxMs < 24 ? 'ok' : (maxMs < 40 ? 'mid' : 'bad');
      el.className = 'netStat ' + pcls;
      el.textContent = '本机帧率 ' + fps + ' · 最慢帧 ' + Math.round(maxMs) + 'ms' +
        '\n判定：' + (pcls === 'ok' ? '本机流畅' : (pcls === 'mid' ? '偶尔顿一下（轻微）' : '本机卡顿明显'));
      return;
    }

    var head = (netKind === 'mqtt' && brokerName) ? '中继 ' + brokerName + '\n' : '';
    var ex = extrapN; extrapN = 0;   // 每 0.5 秒汇报一次，理想是 0
    var fr = frameN; frameN = 0;

    if (isAuthority()) {
      // 房主：衡量"对方输入到达的抖动"，越大说明对方网络越抖
      var st = (window.MQTTNet && window.MQTTNet.stats) ? window.MQTTNet.stats() : null;
      var j = st ? Math.round(st.inGapPeak) : 0;
      var vd = j < 60 ? '对方网络良好' : (j < 150 ? '对方网络一般' : '对方网络很差');
      el.className = 'netStat ' + (j < 60 ? 'ok' : (j < 150 ? 'mid' : 'bad'));
      el.textContent = head + '对方抖动 ' + j + 'ms · 我方间隔 ' + Math.round(snapGapMs) + 'ms\n判定：' + vd;
    } else if (!clkReady) {
      el.className = 'netStat mid';
      el.textContent = head + '正在测量网络…';
    } else {
      var jj = Math.round(clkJitter);
      var cls = (jj < 60 && ex === 0) ? 'ok' : ((jj < 150 && ex < 5) ? 'mid' : 'bad');
      var verdict = cls === 'ok' ? '网络良好' : (cls === 'mid' ? '网络一般（偶有顿挫）' : '网络很差（中继拥堵）');
      el.className = 'netStat ' + cls;
      el.textContent = head +
        '抖动 ' + jj + 'ms · 间隔 ' + Math.round(snapGapMs) + '/' + Math.round(snapGapPeak) + 'ms' +
        '\n外推 ' + ex + ' / ' + fr + ' 帧 · 缓冲 ' + Math.round(playoutMs) + 'ms' +
        '\n判定：' + verdict;
    }
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
    snipe: function () { tone(1400, 2000, 0.08, 0.09, 'square'); noise(0.06, 0.05, 6000); },
    // 装弹提示音：箭壶打空时响一下，避免玩家以为"突然打不出"是卡了
    reload: function (mine) {
      if (mine) { noise(0.14, 0.07, 1600); tone(240, 150, 0.13, 0.07, 'square'); }
      else { noise(0.09, 0.022, 1100); }
    }
  };

  // 房主防后台降频：播放一段极低音量持续音，让浏览器认为页面在发声，
  // 从而不在后台把定时器降频（否则房主切后台会让对方卡顿）
  var keepOsc = null, keepGain = null;
  function startHostKeepAlive() {
    ensureAudio();
    if (!AC || keepOsc) return;
    try {
      keepGain = AC.createGain();
      keepGain.gain.value = 0.002; // 极低，基本听不到
      keepOsc = AC.createOscillator();
      keepOsc.type = 'sine';
      keepOsc.frequency.value = 50;
      keepOsc.connect(keepGain);
      keepGain.connect(AC.destination);
      keepOsc.start();
    } catch (e) { keepOsc = null; }
  }
  function stopHostKeepAlive() {
    if (keepOsc) { try { keepOsc.stop(); } catch (e) {} try { keepOsc.disconnect(); } catch (e) {} keepOsc = null; }
    if (keepGain) { try { keepGain.disconnect(); } catch (e) {} keepGain = null; }
  }

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
    // 自测台：同一台电脑的两个窗口共用 localStorage 里的昵称，
    // 加个随机后缀，方便一眼分清哪个窗口是房主、哪个是房员（也不污染保存的昵称）
    if (autoPlay || autoHost) return (n || '测试球手') + '#' + Math.floor(100 + Math.random() * 900);
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
        boostRequest = true; // 单次触发：下一帧上报给权威端
        if (mode === 'online') boostLocalEdge = true; // 本地模拟立即消费一次
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
    // 【关键】用 e.buttons（浏览器上报的"当前真实按下的键"）来校准开火状态。
    // 鼠标每动一下都会自我纠正，因此即使 mouseup / mouseleave / 失焦 漏过一次，
    // 也只会短暂停一下，继续划动就自动恢复 —— 不会出现"长按突然打不出、必须松手重按"。
    // e.buttons 第 0 位 = 左键。
    function syncFireFromButtons(e) {
      mouseCss.x = e.clientX; mouseCss.y = e.clientY; mouseCss.has = true;
      var pressed = (e.buttons & 1) === 1;
      if (pressed !== fireDown) {
        fireDown = pressed;
        if (!pressed) pushInputNow(); // 松手立即上报，别等下一帧
      }
    }
    window.addEventListener('mousemove', syncFireFromButtons);
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'mouse') return; // 鼠标由 mousemove 处理，避免重复
      syncFireFromButtons(e);
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
      if (e.button === 0) releaseFire();
    });
    // 兜底：某些情况（指针在窗口外松开、触摸/触控笔、指针被系统抢走）收不到 mouseup，
    // 这里用 pointerup / pointercancel / 移出文档 再补几次"松手"，防止开火状态卡死。
    window.addEventListener('pointerup', function (e) { if (e.button === 0) releaseFire(); });
    window.addEventListener('pointercancel', releaseFire);
    document.addEventListener('mouseleave', releaseFire);
    window.addEventListener('blur', function () {
      keys.w = keys.a = keys.s = keys.d = false;
      resetInputState();
    });
    document.addEventListener('visibilitychange', function () {
      // 切到后台/切标签页：清掉一次性输入，回来后不会"自己一直射"
      if (document.hidden) resetInputState();
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
    // 瞄准起点优先用"本地实际显示位置"，否则鼠标方向会和自己看到的球错位
    var bx = ownSim ? ownSim.x : (p ? p.x : C.W * 0.2);
    var by = ownSim ? ownSim.y : (p ? p.y : C.H * 0.5);
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
    resetInputState();
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
      onMsgFromNet(m); // 经过网络模拟（下行延迟/抖动/丢包）
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
    if (!NET.on) return wsSendNow(str);
    // 上行也走网络模拟（本地自测时用）
    netDelay(function () { wsSendNow(str); });
    return true;
  }
  function wsSendNow(str) {
    if (ws && ws.readyState === 1) { ws.send(str); return true; }
    if (ws && ws.readyState === 0) {
      // 连接中：先缓存，onopen 后自动补发
      pendingSend.push(str);
      return true;
    }
    return false;
  }

  // 构造本机输入消息；boost/snipe 为一次性边沿，重复携带几次以防丢包
  var boostPulse = 0, snipePulse = 0;
  function makeInputMsg() {
    var mv = updateMoveFromKeys();
    if (boostRequest) { boostPulse = 3; boostRequest = false; }
    if (snipeRequest) { snipePulse = 3; snipeRequest = false; }
    var b = boostPulse > 0, sn = snipePulse > 0;
    if (boostPulse > 0) boostPulse--;
    if (snipePulse > 0) snipePulse--;
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

  // 【防自动攻击】清空所有"一次性输入状态"。
  // 场景：鼠标在窗口外松开时会漏掉 mouseup，导致 fireDown 一直挂着 →
  // 一进对局球就自己一直射。开局、失焦、切后台时统一清一次。
  function resetInputState() {
    fireDown = false;
    boostHeld = false;
    boostRequest = false;
    boostLocalEdge = false;
    snipeRequest = false;
    boostPulse = 0;
    snipePulse = 0;
  }

  // 松开开火（多个事件源共用：mouseup / pointerup / 指针取消 / 移出窗口）
  function releaseFire() {
    if (!fireDown) return;
    fireDown = false;
    pushInputNow();
  }

  // 本地开火反馈：枪口立刻冒火光（箭本体由 stepGhostArrows 的乐观箭负责）
  // 仅用于联机模式（练习模式由本机引擎即时处理，无需补偿）
  function localShotFeedback() {
    if (mode !== 'online' || isAuthority()) return;
    var base = lastSnap;
    if (!base || !inPlay) return;
    var me = base.players[role];
    if (!me) return;
    var src = ownSim || me;
    var aim = aimAngle();
    var ox = src.x + Math.cos(aim) * (C.BALL_R + 22);
    var oy = src.y + Math.sin(aim) * (C.BALL_R + 22);
    R.localMuzzle(ox, oy, aim, role);
  }

  // 本地乐观箭矢：按下的瞬间就能看到自己的箭飞出去，不必等一个网络往返
  // （是否还有箭由调用方的"本地弹药估计"决定，保证装弹完成后立刻恢复出箭）
  function spawnGhostArrow(bx, by, aim) {
    ghostArrows.push({
      id: ghostSeq--, // 负数 id，绝不会与权威箭冲突
      x: bx + Math.cos(aim) * (C.BALL_R + 22),
      y: by + Math.sin(aim) * (C.BALL_R + 22),
      vx: Math.cos(aim) * C.ARROW_SPEED,
      vy: Math.sin(aim) * C.ARROW_SPEED,
      owner: role, life: 1.1, kill: false
    });
    while (ghostArrows.length > 8) ghostArrows.shift();
  }

  // 推进本地乐观箭矢；按住连发时按本地射速持续补齐；
  // 权威箭一出现就退役一个虚影（retireGhosts），避免重影。
  function stepGhostArrows(dt) {
    // 两端都启用：房主的箭要等下一个 tick（~32ms）才由引擎产生，
    // 加虚影后"按下即见箭"，真箭出现后自动接管。
    if (mode !== 'online' || !inPlay) {
      ghostArrows.length = 0;
      ghostFireCd = 0;
      return;
    }
    ghostFireCd = Math.max(0, ghostFireCd - dt);
    ghostReloadT = Math.max(0, ghostReloadT - dt);

    var base = lastSnap;
    var me = base ? base.players[role] : null;
    // 本地弹药估计：快照要一个往返才更新，如果照它判断，
    // 装弹完成后会有约"一个往返"的时间射不出虚影 → 表现为"开火要过一会儿才出箭"。
    if (me) {
      if (me.reloading) {
        ghostLocalQuiver = 0;
        if (ghostReloadT <= 0) ghostReloadT = C.RELOAD_DELAY;
      } else if (me.quiver > ghostLocalQuiver) {
        ghostLocalQuiver = me.quiver;  // 权威说补满了
      }
    }
    if (ghostLocalQuiver <= 0 && ghostReloadT <= 0) ghostLocalQuiver = C.QUIVER;

    if (fireDown && base && me && base.phase === 'playing' && ghostFireCd <= 0 &&
      ghostLocalQuiver > 0 && ghostReloadT <= 0) {
      // 用"权威位置 + 权威朝向"生成虚影：这样它和稍后到达的真箭几乎重合，
      // 真箭一出现把虚影退役时不会"跳一下"。
      spawnGhostArrow(me.x, me.y, me.aim);
      ghostLocalQuiver--;
      ghostFireCd = C.FIRE_CD;
    }
    for (var i = ghostArrows.length - 1; i >= 0; i--) {
      var g = ghostArrows[i];
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.life -= dt;
      if (g.life <= 0 || g.x < -80 || g.x > C.W + 80 || g.y < -80 || g.y > C.H + 80) {
        ghostArrows.splice(i, 1);
      }
    }
  }

  // 本地冲刺反馈：短促音效 + 预测冲刺视觉，让联机下冲刺"即按即冲"
  function localBoostFeedback() {
    if (!inPlay) return;
    var base = lastSnap;
    if (base && base.players[role] && base.players[role].boostCd > 0) return; // 冷却中不生效
    SFX.boost();
    // 联机下"即按即冲"由本地自身模拟（ownSim）通过 boostLocalEdge 直接体现，无需额外补偿
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
        // 开局先把一次性输入清干净，避免上一局的按键状态残留成"自动攻击"
        resetInputState();
        if (netKind === 'mqtt' && window.MQTTNet) window.MQTTNet.onLobbyReceived();
        break;
      case 'state':
        if (mode !== 'online') return;
        if (netKind === 'mqtt' && window.MQTTNet) window.MQTTNet.onLobbyReceived();
        if (!inPlay && lastSnap === null) {
          showScreen('none');
          showHud(true);
          setNames(names);
          showBanner(false);
          showBig(false);
          updateSndBtn();
        }
        acceptSnapshot(m.s, m.ht);
        break;
      case 'peerLeft':
        lastSnap = null;
        prevSnapObj = null;
        hist.length = 0;
        resetNetPrediction();
        lastPhase = '';
        showBig(false);
        showHud(false);
        setScores(0, 0, 1);
        // 不直接判死刑：对方很可能只是短暂掉线。显示"等待重连"，
        // 对方网络恢复、快照重新到达时这里会自动继续对局。
        showBanner(true,
          '<div class="b-title">对手掉线了</div>' +
          '<div class="b-sub">正在等待对方重新连接…（对方网络恢复后会自动继续）</div>' +
          '<div class="b-scores">长时间无响应可点右上角「退出」返回菜单</div>');
        showToast(m.message || '对手已离开', 3600);
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

    // 自测台：两人到齐后自动点「准备」（?auto=1 或 ?host=1），免去人工点击
    if (two && (autoPlay || autoHost) && !autoReadySent) {
      var meP = null;
      for (var q = 0; q < m.players.length; q++) if (m.players[q].role === m.role) meP = m.players[q];
      if (meP && !meP.ready) {
        autoReadySent = true;
        setTimeout(function () { netSend({ type: 'ready' }); }, 500);
      }
    }

    var hint = $('lobbyHint');
    var hostNote = (netKind === 'mqtt' && window.MQTTNet && window.MQTTNet.isHost())
      ? '<div class="hostNote">房主模式：对局中请保持本页面在前台（切到其它标签页/最小化会让双方都变卡）</div>'
      : '';
    if (two) {
      hint.innerHTML = (m.onceStarted
        ? '上一局曾被打断。两人到齐后将自动开始新对局。'
        : '房间号 <b style="letter-spacing:2px">' + m.code + '</b> 已生成。双方都点「准备」即可开战。') + hostNote;
    } else {
      hint.innerHTML = '将房间号 <b style="letter-spacing:2px">' + m.code + '</b> 或邀请链接发给朋友。<br/>对方加入后，双方点「准备」即可开战。' + hostNote;
    }
    // 关键：对局进行中收到大厅刷新（如对方重试 join）时，绝不能把玩家踢回大厅界面。
    // 反过来，只要还没拿到对局数据（lastSnap 为空），就必须切到房间界面，
    // 否则会出现"房主看得到我、我却卡在菜单、准备不了"。
    if (!inPlay || lastSnap === null) showScreen('lobby');
  }

  function createRoom() {
    var name = setNameOfInput();
    // 公网静态部署（如 GitHub Pages）用公共中继；本地/局域网用自建服务器。
    // ?net=mqtt 可在本地也强制走公共中继（自测用，复现与线上完全相同的代码路径）
    if ((forceMqtt() || !isLocalHost()) && window.MQTTNet) {
      netKind = 'mqtt';
      netTip('正在连接公共中继…', '');
      startHostKeepAlive(); // 房主：防止切后台被浏览器降频
      window.MQTTNet.create(name, onMsgFromNet, onNetStatus);
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
    if ((forceMqtt() || !isLocalHost()) && window.MQTTNet) {
      netKind = 'mqtt';
      netTip('正在连接公共中继…', '');
      window.MQTTNet.join(code, name, onMsgFromNet, onNetStatus);
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
      stopHostKeepAlive();
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
  // 用主机时间戳估计：两机时钟偏移 + 网络抖动幅度
  function clockUpdate(now, hostT) {
    clkSamples.push({ t: now, obs: now - hostT });
    while (clkSamples.length > 2 && now - clkSamples[0].t > 3000) clkSamples.shift();
    var n = clkSamples.length;
    var arr = new Array(n);
    for (var i = 0; i < n; i++) arr[i] = clkSamples[i].obs;
    arr.sort(function (a, b) { return a - b; });
    clkOff = arr[0];
    var idx = Math.min(n - 1, Math.floor(n * 0.9));
    clkJitter = Math.max(0, arr[idx] - arr[0]);
    clkReady = n >= 6;
  }

  function acceptSnapshot(snap, hostT) {
    var fresh = snap !== prevSnapObj;
    prevSnapObj = snap;
    if (fresh) {
      R.processEvents(snap.events);
      for (var i = 0; i < snap.events.length; i++) playEvent(snap.events[i]);
    }
    var now = performance.now();

    // 时间轴口径：能拿到主机时间戳且自己是房员 → 用无抖动的 ht 时间线
    var useHost = (typeof hostT === 'number' && isFinite(hostT) && !isAuthority());
    var clockMode = useHost ? 'host' : 'arrival';
    if (clockMode !== histClock) {
      histClock = clockMode;
      hist.length = 0;
      clkSamples.length = 0;
      clkReady = false;
    }
    // 只用来显示"网络抖动"（渲染不再依赖它，见 buildRenderSnap）
    if (useHost) clockUpdate(now, hostT);
    // 统计快照到达间隔：用于自适应插值缓冲（网络越抖，缓冲越大）。
    // 同时跟踪"衰减峰值"——缓冲必须能盖住最坏的那次抖动，否则就会冻一帧再跳。
    if (snapArrLast) {
      var gap = now - snapArrLast;
      if (gap > 5 && gap < 600) {
        snapGapMs += (gap - snapGapMs) * 0.2;
        snapGapPeak = Math.max(gap, snapGapPeak * 0.97); // 衰减慢一点，抖动高峰能被覆盖住
      }
    }
    snapArrLast = now;

    // 在线模式：压入历史用于插值；练习模式直接用最新
    if (mode === 'online') {
      var entry = { s: snap, t: now };
      if (useHost) entry.ht = hostT;
      hist.push(entry);
      if (hist.length > histMax) hist.shift();
      // 非权威端：用权威快照校准本地自身模拟（延迟对齐 + 温和纠偏，绝不瞬移）
      reconcileOwn(snap);
      retireGhosts(snap);
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

    var useHost = (histClock === 'host') && clkReady;
    var key, targetT;
    if (useHost) {
      // —— 无抖动时间线（锚定在最新快照，绝不再比两台机器的绝对时钟）——
      // 渲染点 = 最新快照的主机时间戳 + 本机已经过去的时间 − 落后量
      //   ① 时间轴上只有等间隔的主机时间戳 → 天然平滑，完全不受网络抖动影响；
      //   ② 只要 behind ≥ 一次到达间隔，渲染点就永远落在两个已知快照之间，
      //      不会跌进"外推"（外推 = 一卡一跳的根源）；
      //   ③ 全程只用"本机时钟的差值"，不比较两机绝对时钟 → 不存在时钟原点不一致的问题。
      key = 'ht';
      var newestE = hist[hist.length - 1];
      // 1.55 倍是实测出来的折中；behindExtra 是"兜底自增"：
      // 一旦真的发生外推，就把缓冲永久抬高一点，保证同样的坑不会踩第二次。
      var behind = Math.max(45, snapGapPeak * 1.55) + behindExtra;
      behindExtra = Math.max(0, behindExtra - 0.15); // 缓慢回落，长期不紧张就收回去
      playoutMs = behind; // 仅用于左上角显示
      targetT = newestE.ht + (performance.now() - newestE.t) - behind;
    } else {
      // 拿不到主机时间戳（老协议/自建服务器）：退回按"到达时间"插值
      key = 't';
      var INTERP_MS = isAuthority()
        ? Math.min(40, snapGapMs * 0.75)
        : Math.max(90, Math.min(260, snapGapPeak * 1.4 + 25));
      targetT = performance.now() - INTERP_MS;
    }

    // 找 targetT 落在哪两个快照之间（hist 内该坐标轴单调递增）
    var a = null, b = null;
    for (var i = hist.length - 1; i >= 0; i--) {
      if (hist[i][key] <= targetT) { a = hist[i]; break; }
    }
    if (!a) { a = hist[0]; b = hist[1]; }
    else {
      // 找 a 之后离 targetT 最近的那个快照
      for (var j = 0; j < hist.length; j++) {
        if (hist[j][key] > a[key]) { b = hist[j]; break; }
      }
    }
    // 缓冲用尽（快照还没到）：沿最后已知速度做极短外推，而不是冻在上一帧。
    // 外推上限 80ms，既避免"冻结顿挫"，也不会飘得太远。
    if (!b) {
      // 真的没有更新的快照可用 → 记下超出量，把缓冲永久抬高一点，保证不反复踩坑
      var overMs = targetT - a[key];
      if (overMs > 0) behindExtra = Math.min(500, behindExtra + Math.min(overMs, 80));
      return extrapolateSnap(a.s, overMs);
    }
    if (b[key] === a[key]) return b.s;
    if (targetT <= a[key]) return a.s;
    if (targetT >= b[key]) {
      var overMs2 = targetT - b[key];
      if (overMs2 > 0) behindExtra = Math.min(500, behindExtra + Math.min(overMs2, 80));
      return extrapolateSnap(b.s, overMs2);
    }
    var t = (targetT - a[key]) / (b[key] - a[key]);
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
    // 箭矢：按 id 取"并集"插值
    // 旧快照里有、新快照里没有的箭（刚命中/出界被销毁）在本窗口内仍按旧位置续画，
    // 避免"刚射出的箭在插值窗口内提前消失"。
    var seen = {};
    for (var ai = 0; ai < s1.arrows.length; ai++) {
      var ab = s1.arrows[ai];
      seen[ab.id] = 1;
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
    for (var ao = 0; ao < s0.arrows.length; ao++) {
      var aa = s0.arrows[ao];
      if (seen[aa.id]) continue;
      out.arrows.push({ x: aa.x, y: aa.y, vx: aa.vx, vy: aa.vy, owner: aa.owner, id: aa.id, kill: !!aa.kill });
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

  // 插值缓冲用尽时，沿最后已知速度做极短外推（最多 80ms），
  // 目的只是"别冻住"，不是精确预测；下一个快照到达就会自动纠正回来。
  function extrapolateSnap(s, overMs) {
    var over = overMs / 1000;
    if (!(over > 0)) return s;
    if (over > 0.08) over = 0.08;
    extrapN++; // 记一次"缓冲不够"（用于左上角诊断：理想是 0）
    var r = C.BALL_R;
    var out = {
      w: s.w, h: s.h, phase: s.phase, phaseT: s.phaseT,
      round: s.round, winner: s.winner, scores: s.scores,
      players: [], arrows: [], events: []
    };
    for (var i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      var nx = p.x + p.vx * over, ny = p.y + p.vy * over;
      if (nx < r) nx = r; else if (nx > C.W - r) nx = C.W - r;
      if (ny < r) ny = r; else if (ny > C.H - r) ny = C.H - r;
      out.players.push({
        x: nx, y: ny, vx: p.vx, vy: p.vy,
        hp: p.hp, aim: p.aim, quiver: p.quiver, fireCd: p.fireCd,
        reloading: p.reloading, reloadT: p.reloadT,
        boostT: p.boostT, boostCd: p.boostCd, snipeCd: p.snipeCd
      });
    }
    for (var j = 0; j < s.arrows.length; j++) {
      var a = s.arrows[j];
      out.arrows.push({
        x: a.x + a.vx * over, y: a.y + a.vy * over,
        vx: a.vx, vy: a.vy, owner: a.owner, id: a.id, kill: a.kill
      });
    }
    return out;
  }

  /* =========================================================
   *    非权威端：自身球本地模拟 + 延迟对齐纠偏（根治"走一步又弹回"）
   * ========================================================= */

  // 在轨迹历史里按时间取位置（线性插值）
  function ownHistPos(tMs) {
    if (!ownHist.length) return null;
    if (tMs <= ownHist[0].t) return ownHist[0];
    var last = ownHist[ownHist.length - 1];
    if (tMs >= last.t) return last;
    for (var i = ownHist.length - 1; i >= 0; i--) {
      if (ownHist[i].t <= tMs) {
        var a = ownHist[i];
        var b = ownHist[i + 1] || last;
        var span = b.t - a.t;
        if (span <= 0) return a;
        var k = (tMs - a.t) / span;
        return {
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          ax: a.ax + (b.ax - a.ax) * k,
          ay: a.ay + (b.ay - a.ay) * k
        };
      }
    }
    return last;
  }

  // 每帧推进自身球：与引擎 simulate() 的移动部分 1:1 一致
  function stepOwnSim(dt) {
    // 注意：权威端（房主）也要走本地模拟。
    // 房主自己的球以前是走"快照插值"的，天然带 ~50ms 延迟 + 31Hz 台阶感，
    // 所以房主也会觉得"操作不跟手"。改成本地模拟后，两端都是零延迟、60fps 平滑。
    if (mode !== 'online' || !inPlay || role == null || !ownSim) return;
    if (dt <= 0) return;
    if (dt > 0.05) dt = 0.05;
    // 倒计时/结算阶段球不动（由 reconcileOwn 对齐到出生点），不参与积分
    if (lastSnap && lastSnap.phase !== 'playing') return;

    var mv = updateMoveFromKeys();
    var aim = aimAngle();

    // 冲刺：冷却/持续时间推进；本地边沿即时触发（与引擎规则一致）
    ownSim.boostCd = Math.max(0, ownSim.boostCd - dt);
    ownSim.boostT = Math.max(0, ownSim.boostT - dt);
    if (boostLocalEdge) {
      boostLocalEdge = false;
      if (ownSim.boostCd <= 0 && ownSim.boostT <= 0) {
        var bdx = mv.dx, bdy = mv.dy;
        var blen = Math.sqrt(bdx * bdx + bdy * bdy);
        if (blen < 0.01) {
          var sp0 = Math.sqrt(ownSim.vx * ownSim.vx + ownSim.vy * ownSim.vy);
          if (sp0 > 20) { bdx = ownSim.vx / sp0; bdy = ownSim.vy / sp0; }
          else { bdx = Math.cos(aim); bdy = Math.sin(aim); }
        }
        var bm = C.SPEED * C.BOOST_MULT;
        ownSim.vx = bdx * bm;
        ownSim.vy = bdy * bm;
        ownSim.boostT = C.BOOST_TIME;
        ownSim.boostCd = C.BOOST_CD;
      }
    }

    // 位移（带惯性；冲刺期间速度乘倍率）
    var mult = ownSim.boostT > 0 ? C.BOOST_MULT : 1;
    ownSim.vx = approachN(ownSim.vx, mv.dx * C.SPEED * mult, C.ACCEL * dt);
    ownSim.vy = approachN(ownSim.vy, mv.dy * C.SPEED * mult, C.ACCEL * dt);
    ownSim.x += ownSim.vx * dt;
    ownSim.y += ownSim.vy * dt;

    // 消化漂移：限速纠偏（每秒最多 320 世界单位）——只做"缓慢拉回"，绝不瞬移
    if (driftX || driftY) {
      var dm = Math.sqrt(driftX * driftX + driftY * driftY);
      if (dm <= 5) { driftX = 0; driftY = 0; }
      else {
        // 纠偏速度刻意压低（140 < 移动速度 480 的三分之一）：
        // 万一延迟估计不准，最多让球略微变慢，绝不会"把移动整个抵消掉"。
        var step = Math.min(dm, 140 * dt);
        var sx = driftX / dm * step, sy = driftY / dm * step;
        ownSim.x += sx; ownSim.y += sy;
        appliedX += sx; appliedY += sy;
        var keep = 1 - step / dm;
        driftX *= keep; driftY *= keep;
      }
    }

    // 边界（与引擎 boundPlayer 一致）
    var r = C.BALL_R;
    if (ownSim.x < r) ownSim.x = r;
    if (ownSim.x > C.W - r) ownSim.x = C.W - r;
    if (ownSim.y < r) ownSim.y = r;
    if (ownSim.y > C.H - r) ownSim.y = C.H - r;

    // 记录轨迹（供延迟对齐用）
    var now = performance.now();
    ownHist.push({ t: now, x: ownSim.x, y: ownSim.y, ax: appliedX, ay: appliedY });
    while (ownHist.length > 2 && now - ownHist[0].t > OWN_HIST_MS) ownHist.shift();
    if (ownHist.length > 400) ownHist.splice(0, ownHist.length - 400);
  }

  // 收到权威快照后校准：① 延迟对齐 ② 只对真实漂移做温和纠偏
  function reconcileOwn(snap) {
    if (mode !== 'online' || role == null) return;
    var sp = snap.players[role];
    if (!sp) return;
    var now = performance.now();

    function hardAlign(p) {
      ownSim = p;
      ownHist.length = 0;
      ownHist.push({ t: now, x: p.x, y: p.y, ax: 0, ay: 0 });
      appliedX = 0; appliedY = 0; driftX = 0; driftY = 0;
    }

    // 回合切换/结算/倒计时：球本来就是静止或刚被摆位，直接硬对齐最稳
    if (snap.phase !== 'playing') {
      hardAlign({
        x: sp.x, y: sp.y, vx: sp.vx, vy: sp.vy,
        boostT: sp.boostT || 0, boostCd: sp.boostCd || 0
      });
      return;
    }

    if (!ownSim) {
      hardAlign({
        x: sp.x, y: sp.y, vx: sp.vx, vy: sp.vy,
        boostT: sp.boostT || 0, boostCd: sp.boostCd || 0
      });
      return;
    }

    // 权威端（房主）：本地引擎就是"现在"，不存在网络延迟，无需延迟对齐。
    // 直接把"引擎位置 − 本地轨迹"当作漂移即可（几乎为 0）。
    if (isAuthority()) {
      var axx = sp.x - ownSim.x, ayy = sp.y - ownSim.y;
      var am = Math.sqrt(axx * axx + ayy * ayy);
      if (am > 220) {
        hardAlign({
          x: sp.x, y: sp.y, vx: sp.vx, vy: sp.vy,
          boostT: sp.boostT || 0, boostCd: sp.boostCd || 0
        });
        return;
      }
      // 同样做低通，避免 31Hz 快照让纠偏方向来回翻转
      driftX = driftX * 0.7 + axx * 0.3;
      driftY = driftY * 0.7 + ayy * 0.3;
      ownSim.boostCd = sp.boostCd || 0;
      return;
    }

    // ① 延迟对齐：找到"服务端位置对应于本地轨迹的哪一时刻"。
    //    【关键】只有"确实吻合"时才采信。球来回拐弯时，位置匹配可能凑巧对到错误的时刻，
    //    一旦采信就会算出一大截假漂移，然后纠偏把球来回拽 → 表现就是"即停即走、飘忽不定"。
    var confident = false;
    var n = ownHist.length;
    if (n >= 6) {
      var h0 = ownHist[n - 8 < 0 ? 0 : n - 8];
      var h1 = ownHist[n - 1];
      if (Math.abs(h1.x - h0.x) + Math.abs(h1.y - h0.y) > 10) {
        var bestLag = lagEst, bestD2 = Infinity;
        // 搜索范围要盖住"完整往返"：慢中继往返可到 1 秒以上
        for (var L = 0.02; L <= 2.00; L += 0.02) {
          var hp = ownHistPos(now - L * 1000);
          if (!hp) continue;
          var dx0 = (hp.x + (appliedX - hp.ax)) - sp.x;
          var dy0 = (hp.y + (appliedY - hp.ay)) - sp.y;
          var d2 = dx0 * dx0 + dy0 * dy0;
          if (d2 < bestD2) { bestD2 = d2; bestLag = L; }
        }
        // 吻合点必须足够贴合（80 世界单位内）才算可信
        if (bestD2 < 6400) {
          confident = true;
          var dl = bestLag - lagEst;
          if (dl > 0.04) dl = 0.04; else if (dl < -0.04) dl = -0.04;
          lagEst += dl;
          if (lagEst < 0) lagEst = 0; else if (lagEst > 2.00) lagEst = 2.00;
        }
      }
    }

    // ② 计算漂移（仅在"对齐可信"时）
    var ref = confident ? ownHistPos(now - lagEst * 1000) : null;
    var ex = 0, ey = 0;
    if (ref) {
      ex = sp.x - (ref.x + (appliedX - ref.ax));
      ey = sp.y - (ref.y + (appliedY - ref.ay));
    }
    var mag = Math.sqrt(ex * ex + ey * ey);

    // ③ 不可信、或漂移过大（多半是估计误差）：一律不纠偏。
    //    本地模拟与权威端跑的是同一套公式、同一份"绝对状态"输入，
    //    丢一次输入也会被下一次立刻纠正，所以短期不纠偏是安全的 —— 换来的是绝对平滑。
    if (!confident || mag > 120) {
      driftX = 0; driftY = 0;
      return;
    }

    // ④ 低通平滑后再交给 stepOwnSim 缓慢消化：
    //    避免 31Hz 的快照让漂移方向来回翻转，把球拽得一抖一抖。
    driftX = driftX * 0.75 + ex * 0.25;
    driftY = driftY * 0.75 + ey * 0.25;
  }

  // 权威箭一出现，就退役一个本地乐观箭（避免重影）
  function retireGhosts(snap) {
    if (!snap.arrows) return;
    var fresh = 0;
    for (var i = 0; i < snap.arrows.length; i++) {
      var a = snap.arrows[i];
      if (a.owner !== role) continue;
      if (ownArrowSeen[a.id]) continue;
      ownArrowSeen[a.id] = 1;
      ownArrowSeenN++;
      fresh++;
    }
    if (ownArrowSeenN > 400) { ownArrowSeen = {}; ownArrowSeenN = 0; }
    while (fresh > 0 && ghostArrows.length > 0) { ghostArrows.shift(); fresh--; }
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

  var lastReloadFlag = [false, false]; // 用于捕捉"进入装弹"的那一瞬间
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
        // 箭壶打空的瞬间响一声：让"打不出"变成可理解的"在装弹"，而不是以为卡了
        if (p.reloading && !lastReloadFlag[i]) SFX.reload(i === role);
        lastReloadFlag[i] = !!p.reloading;
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
  // 帧时统计：用于练习模式的"帧率"读数，把"卡不卡"变成能看的数字
  var frameMsSum = 0, frameMsN = 0, frameMsMax = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0);
    lastT = now;
    frameN++;
    if (dt > 0) {
      var fms = dt * 1000;
      frameMsSum += fms; frameMsN++;
      if (fms > frameMsMax) frameMsMax = fms;
    }

    updateNetStat(now);

    // 自测台：自动代打（?auto=1）。必须放在"上报输入"之前，
    // 这样上报给权威端的、以及本地预测用的，都是代打产生的输入。
    if (autoPlay && mode === 'online' && inPlay) autoInput();

    // 上报输入用 30Hz（33ms）：权威端更快知道你按了什么，对手看你才不"慢半拍"
    if (mode === 'online' && inPlay && netKind === 'mqtt' && now - lastSendT > 33) {
      lastSendT = now;
      netSend(makeInputMsg());
    } else if (mode === 'online' && inPlay && ws && ws.readyState === 1 && now - lastSendT > 33) {
      lastSendT = now;
      wsSend(makeInputMsg());
    }

    if (mode === 'practice' && practiceGame) {
      // 【练习模式"单点卡顿"的根因】
      // 原来用"固定 1/60 步长 + 累加器"推进物理，要求每帧恰好消费一个步长。
      // 但 rAF 的时间间隔本身是抖动的：会出现"这帧走两步、下帧一步没走"，
      // 那一步没走的帧画面完全没变 → 屏幕上一顿一顿；屏幕刷新率不是 60Hz
      // （90/120/144Hz 笔记本）时步进分布更不均匀，肉眼更明显。
      //
      // 现在改成：把这一帧的"真实时长"拆成若干个不超过 1/60 秒的子步。
      //   ① 一帧内总推进量 = 真实经过时间 → 任何刷新率下位移都与时间成正比，顺滑；
      //   ② 单个子步不超过 1/60 秒 → 箭每步最多走 14 单位，远小于命中半径
      //      （球 21 + 箭 6 = 27），不会出现"箭穿人而过"的漏判；
      //   ③ 倒计时/回合时间也与现实时间一致，不会因掉帧而变慢。
      var pdt = Math.min(dt, 0.05);
      if (pdt > 0) {
        var steps = Math.ceil(pdt * 60);
        if (steps < 1) steps = 1;
        var sdt = pdt / steps;
        var mvp = updateMoveFromKeys();
        var aimNow = aimAngle();
        var bEdge = consumeBoost();   // 冲刺/秒杀只在第一个子步生效（边沿）
        var sEdge = consumeSnipe();
        for (var k = 0; k < steps; k++) {
          Eng.setCtrl(practiceGame, 0, {
            dx: mvp.dx, dy: mvp.dy, aim: aimNow,
            fire: fireDown,
            boost: k === 0 ? bEdge : false,
            snipe: k === 0 ? sEdge : false
          });
          aiThink(sdt);
          Eng.update(practiceGame, sdt);
        }
      }
      var snap = Eng.snapshot(practiceGame);
      acceptSnapshot(snap);
    }

    // 非权威端：先推进自身球本地模拟（放在渲染前，保证"零延迟手感"）
    if (mode === 'online') stepOwnSim(dt);

    if (lastSnap && inPlay) {
      var w = mouseCss.has ? R.toWorld(mouseCss.x, mouseCss.y) : null;
      var renderSnap = (mode === 'online') ? buildRenderSnap() : lastSnap;

      if (renderSnap && mode === 'online') {
        // 本地乐观箭矢（自己刚射出的箭立刻可见）
        stepGhostArrows(dt);

        var needOwn = !!(ownSim && role != null && renderSnap.players[role]);
        if (needOwn || ghostArrows.length) {
          var rs = {
            w: renderSnap.w, h: renderSnap.h,
            phase: renderSnap.phase, phaseT: renderSnap.phaseT,
            round: renderSnap.round, winner: renderSnap.winner,
            scores: renderSnap.scores,
            players: renderSnap.players.slice(),
            arrows: ghostArrows.length ? renderSnap.arrows.concat(ghostArrows) : renderSnap.arrows,
            events: renderSnap.events
          };
          // 自身球：直接用本地模拟（零延迟、绝对平滑），血量/弹药仍取权威值
          if (needOwn) {
            var baseP = rs.players[role];
            rs.players[role] = {
              x: ownSim.x, y: ownSim.y, vx: ownSim.vx, vy: ownSim.vy,
              hp: baseP.hp,
              aim: aimAngle(),
              quiver: baseP.quiver, fireCd: baseP.fireCd,
              reloading: baseP.reloading, reloadT: baseP.reloadT,
              boostT: ownSim.boostT, boostCd: ownSim.boostCd,
              snipeCd: baseP.snipeCd || 0
            };
          }
          renderSnap = rs;
        }
      }
      R.frame(renderSnap, { role: role, aimWorld: w }, dt);
    }
  }

  // 清空"自身球本地模拟/插值/乐观箭"的全部状态（退出房间、重开一局时调用）
  function resetNetPrediction() {
    ownSim = null;
    ownHist.length = 0;
    appliedX = 0; appliedY = 0;
    driftX = 0; driftY = 0;
    lagEst = 0.10;
    snapArrLast = 0;
    snapGapMs = 50;
    snapGapPeak = 50;
    clkSamples.length = 0;
    clkOff = 0;
    clkJitter = 0;
    clkReady = false;
    histClock = '';
    playoutMs = 110;
    behindExtra = 0;
    extrapN = 0;
    frameN = 0;
    frameMsSum = 0; frameMsN = 0; frameMsMax = 0;
    ghostArrows.length = 0;
    ghostSeq = -1;
    ghostFireCd = 0;
    ghostLocalQuiver = C.QUIVER;
    ghostReloadT = 0;
    ownArrowSeen = {};
    ownArrowSeenN = 0;
    boostLocalEdge = false;
  }

  function resetAllFx() {
    prevSnapObj = null;
    lastSnap = null;
    hist.length = 0;
    resetNetPrediction();
    resetInputState();
    lastReloadFlag[0] = lastReloadFlag[1] = false;
    lastPhase = '';
    lastPhaseT = -1;
    practiceGame = null;
    autoReadySent = false;
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
    // 自测参数一并带上：把链接粘到"第二个窗口"时，两边条件完全一致
    var qs = new URLSearchParams(location.search);
    var extra = '';
    ['net', 'lag', 'auto'].forEach(function (k) {
      var v = qs.get(k);
      if (v) extra += '&' + k + '=' + encodeURIComponent(v);
    });
    var url = location.origin + location.pathname + '?room=' + encodeURIComponent(code) + extra;
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

    // 房主切后台会让双方卡：回到前台时提醒
    var hiddenDuringPlay = false;
    document.addEventListener('visibilitychange', function () {
      var isMqttHost = (netKind === 'mqtt' && window.MQTTNet && window.MQTTNet.isHost());
      if (document.hidden) {
        if (mode === 'online' && isMqttHost) hiddenDuringPlay = true;
      } else if (hiddenDuringPlay) {
        hiddenDuringPlay = false;
        showToast('检测到房主页面切到后台——这会让双方卡顿，请保持本页在前台', 4200);
      }
    });

    try { $('nameIn').value = localStorage.getItem('qyj_name') || ''; } catch (e) {}

    var qs = new URLSearchParams(location.search);
    var roomParam = qs.get('room');
    if (roomParam) $('roomIn').value = roomParam.toUpperCase();

    if (isLocalHost() && !forceMqtt()) {
      // 本地/局域网：连自建服务器
      connect();
    } else {
      netTip('公共中继模式（公网静态版）：创建/加入房间走公共中继，无需自建服务器', 'ok');
      // 通过邀请链接进入：自动加入房间
      if (roomParam && window.MQTTNet) {
        setTimeout(function () {
          netKind = 'mqtt';
          window.MQTTNet.join(roomParam.trim().toUpperCase(), setNameOfInput(), onMsgFromNet, onNetStatus);
        }, 300);
      }
    }

    // 自测台状态提示：明确区分"模拟环境"与"真实对局"，避免把模拟当故障
    var stTags = [];
    if (NET.on) stTags.push('网络模拟（' + netSimDesc() + '）');
    if (autoPlay) stTags.push('自动代打');
    if (forceMqtt()) stTags.push('强制走公共中继');
    if (stTags.length) {
      netTip('自测模式：' + stTags.join(' + ') + '（去掉网址里的这类参数即恢复真实对局）', 'ok');
      showToast('已开启自测模式：' + stTags.join(' + '), 5200);
    }
    // 自测台：自动建房（?host=1，用于"零点击"起一局）。
    // 注意：本地访问要连公共中继需再加 ?net=mqtt，否则会走自建服务器那条路。
    if (autoHost && !roomParam) {
      setTimeout(function () { createRoom(); }, 700);
    }

    requestAnimationFrame(function (t) { lastT = t; requestAnimationFrame(frame); });
  }

  init();
})();
