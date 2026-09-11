/*
 * 球影对决 - MQTT 中继联机（无需自建服务器）
 * host(创建者)：本机运行权威引擎，20Hz 广播快照，并同步驱动本机画面
 * guest(加入者)：上报输入，接收快照渲染
 */
(function () {
  'use strict';

  var Eng = window.DuelEngine;
  var C = Eng.C;

  var PREFIX = 'qiuyingduel2026/';

  // 房主端"远端输入抖动缓冲"的播放延迟（ms）：
  // 用略大于网络抖动的固定延迟播放房员的输入，把"忽快忽慢的到达"变成平稳输入流。
  var REMOTE_INPUT_DELAY = 80;
  // 房主广播快照的节拍（ms）：31Hz 左右，比 20Hz 更跟手、插值缓冲也能更小
  var TICK_MS = 32;

  // 公共 broker 候选。注意：它们之间【互不相通】，
  // 所以必须由房间号"确定性地"决定用哪一个（见 brokerOrder），保证双方连同一个。
  // 实测握手耗时（≈网络往返，越小越好）：
  //   broker.emqx.io       0.57s  ← 最快
  //   broker-cn.emqx.io    0.85s  ← EMQX 国内节点
  //   broker.hivemq.com    2.09s  ← 慢 4 倍，只作备选
  //   test.mosquitto.org   2.34s（常连不上），最后备选
  var BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker-cn.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/'
  ];

  var client = null;
  var isHost = false;
  var roomCode = null;
  var onMessageCb = null;
  var onStatusCb = null;
  var topicIn = '';   // guest -> host
  var topicOut = '';  // host -> guest
  var hostRoom = null;
  var joinTimer = null;
  var joinTries = 0;
  var lobbyAt = 0;    // 最近一次收到"房间信息"的时刻（用于判断加入是否真的成功）

  function status(s, extra) { if (onStatusCb) onStatusCb(s, extra); }

  function randomCode() {
    var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var s = '';
    for (var i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function newInput() {
    // t：这条输入最后一次刷新的时间，用于"输入超时保护"
    return { t: 0, k: { w: false, a: false, s: false, d: false }, aim: 0, fire: false, boost: false, snipe: false };
  }

  function pub(topic, obj, qos) {
    if (!client) return;
    try { client.publish(topic, JSON.stringify(obj), { qos: qos || 0, retain: false }); } catch (e) {}
  }

  /* ---------- 浏览器直连（WebRTC 点对点）----------
   * 中继只被用来"牵线"（交换一次地址），牵上之后游戏数据全部点对点直达：
   * 延迟从绕中继的 200~400ms 降到 20~60ms，而且几乎没有抖动。
   * 不花钱、不用服务器、不用注册账号；任何一步失败都自动退回中继。 */
  function p2pSend(obj) {
    return !!(window.P2PNet && window.P2PNet.send(obj));
  }
  function p2pStart(isHostPeer, sigTopic) {
    if (!window.P2PNet || !window.P2PNet.available()) {
      status('p2p-fail', window.P2PNet ? '本窗口未启用直连' : '直连模块未加载');
      return;
    }
    window.P2PNet.init(
      isHostPeer,
      function (m) { pub(sigTopic, m); },        // 牵线消息仍走中继
      function (m) {                             // 对方经由直连发来的游戏消息
        if (isHostPeer) { if (hostRoom) hostRoom.onGuestMsg(m); }
        else if (onMessageCb) onMessageCb(m);
      },
      function (s, extra) {
        if (s === 'trying') status('p2p-try', null);
        else if (s === 'open') status('p2p-ok', null);
        else status('p2p-fail', extra);
      }
    );
  }

  var lastJoinName = ''; // 房员名字：断线重连后要补发一次 join

  // 断线后自动重连成功：把房间状态补回来，双方可继续对局
  function onReconnected() {
    status('back', null);
    if (isHost) {
      if (hostRoom) hostRoom.pushLobby();
    } else {
      pub(topicIn, { type: 'join', name: lastJoinName || '球手' });
    }
  }

  // 依据房间号"确定性地"决定中继先后顺序。
  // 为什么必须确定：公共中继之间【不互通】——房主连 emqx、房员连 emqx-cn 的话，
  // 消息根本传不过去，就会出现"他能看到我、我却看不到他"。
  // 双方用同一个房间号算出同一个顺序，就能保证连到同一个中继。
  function brokerOrder(code) {
    var h = 0, s = String(code || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    var fast = [BROKERS[0], BROKERS[1]];
    var start = h % fast.length;
    var out = [fast[start], fast[1 - start]];
    for (var k = 2; k < BROKERS.length; k++) out.push(BROKERS[k]);
    return out;
  }

  // 连接 broker：按房间号推导的顺序【逐个尝试】，第一个连上的就用它。
  // will 为掉线遗嘱消息。
  function connectBroker(code, done, will) {
    if (typeof mqtt === 'undefined' || !mqtt || !mqtt.connect) {
      status('fail', '中继组件未加载（页面可能没加载完），请刷新后重试');
      return;
    }
    var order = brokerOrder(code);
    var i = 0;

    function attempt() {
      if (i >= order.length) {
        status('fail', '所有公共中继都连不上，请检查网络后重试');
        return;
      }
      var url = order[i++];
      var opts = {
        clientId: 'qy_' + Math.random().toString(16).slice(2, 12),
        clean: true,
        reconnectPeriod: 2500,   // 断线自动重连（原来 0 = 永不重连，一掉线就彻底死了）
        resubscribe: true,       // 重连后自动恢复订阅
        connectTimeout: 6000,
        keepalive: 20            // 更快发现掉线
      };
      if (will) opts.will = will;
      var c;
      try { c = mqtt.connect(url, opts); } catch (e) { attempt(); return; }
      var connected = false;
      var timer = setTimeout(function () {
        if (connected) return;
        connected = true;
        try { c.end(true); } catch (e) {} // 未连上过 → 没有遗嘱，可强制关
        attempt();
      }, 6000);
      c.on('connect', function () {
        if (connected) {
          if (c === client) onReconnected(); // 断线后自动重连成功
          return;
        }
        connected = true; clearTimeout(timer);
        client = c;
        status('ok', url);
        done(c);
      });
      c.on('close', function () { if (c === client) status('lost', url); });
      c.on('offline', function () { if (c === client) status('lost', url); });
      c.on('reconnect', function () { if (c === client) status('retry', url); });
      c.on('error', function () {
        if (connected) return;
        connected = true; clearTimeout(timer);
        try { c.end(true); } catch (e) {}
        attempt();
      });
      c.on('message', function (topic, payload) {
        if (c !== client) return;
        var m;
        try { m = JSON.parse(payload.toString()); } catch (e) { return; }
        // 先看是不是"直连牵线"消息（交换地址）；是的话就在这里吃掉
        if (window.P2PNet && window.P2PNet.handleSignal(m)) return;
        if (isHost && hostRoom) hostRoom.onGuestMsg(m);
        else if (!isHost && onMessageCb) onMessageCb(m);
      });
    }
    attempt();
  }

  /* ===================== HOST ===================== */
  function HostRoom(code, hostName, onMessage) {
    this.code = code;
    this.names = [hostName, ''];
    this.onMessage = onMessage;
    this.game = null;
    this.running = false;
    this.onceStarted = false;
    this.hostReady = false;
    this.guestReady = false;
    this.guestPresent = false;
    this.inputs = [newInput(), newInput()];
    this.timer = null;
    this.mq = []; // 远端移动键的"抖动缓冲"：按到达时间排队，播放时用固定延迟的那一格
    this.p2pStarted = false; // 是否已经发起了浏览器直连
    // 对端输入到达间隔统计（用于给房主显示"对方网络抖不抖"）
    this.inGapAvg = 33;
    this.inGapPeak = 33;
    this.playDelay = 0; // 当前的"远端输入播放延迟"（自适应，用于左上角显示）
  }

  HostRoom.prototype.roster = function (forRole) {
    var players = [{ role: 0, name: this.names[0], ready: this.hostReady }];
    if (this.guestPresent) players.push({ role: 1, name: this.names[1], ready: this.guestReady });
    return { t: 'lobby', code: this.code, players: players, role: forRole, onceStarted: this.onceStarted };
  };

  HostRoom.prototype.pushLobby = function () {
    this.onMessage(this.roster(0));               // 本机
    if (this.guestPresent) pub(topicOut, this.roster(1)); // 对方
  };

  HostRoom.prototype.startGame = function () {
    this.game = Eng.createGame();
    this.running = true;
    this.onceStarted = true;
    this.inputs = [newInput(), newInput()];
    this.mq = [];
    this.inGapAvg = 33;
    this.inGapPeak = 33;
    this.playDelay = 0; // 当前的"远端输入播放延迟"（自适应，用于左上角显示）
    var begin = { t: 'begin', names: this.names.slice() };
    this.onMessage(begin); // 本机也要进入对局
    pub(topicOut, begin);
  };

  HostRoom.prototype.onGuestMsg = function (m) {
    if (m.type === 'join') {
      // 已有客人：视为重试，重发一次房间信息（解决加入方错过首次 lobby 的问题）
      if (this.guestPresent && m.name && this.names[1] && m.name !== this.names[1]) {
        pub(topicOut, { t: 'error', message: '房间已满（每房限 2 人）' });
        return;
      }
      this.names[1] = String(m.name || '球手').slice(0, 10);
      this.guestPresent = true;
      // 对方已就位 → 立刻发起浏览器直连（牵线消息走中继，几条而已）
      if (!this.p2pStarted) { this.p2pStarted = true; p2pStart(true, topicOut); }
      if (!this.running) this.pushLobby(); // 对局中不再打扰
      return;
    }
    if (!this.guestPresent) return;
    if (m.type === 'ready') {
      if (this.running) return;
      this.guestReady = !this.guestReady;
      this.pushLobby();
      this.tryStart();
      return;
    }
    if (m.type === 'input' && this.running && this.game) {
      var inp = this.inputs[1];
      var k = m.k || {};
      inp.k.w = !!k.w; inp.k.a = !!k.a; inp.k.s = !!k.s; inp.k.d = !!k.d;
      if (typeof m.aim === 'number') inp.aim = m.aim;
      inp.fire = !!m.fire;
      inp.boost = !!m.boost;
      inp.snipe = !!m.snipe;
      inp.t = performance.now();
      // 移动键额外进入抖动缓冲：网络抖动会让消息"忽快忽慢地到"，
      // 直接照单全收就会变成房员球的急停急走；缓冲后按固定延迟播放，
      // 输入流变平稳，房主看房员才不会一顿一顿。
      var mqNow = performance.now();
      var prev = this.mq.length ? this.mq[this.mq.length - 1].t : 0;
      if (prev) {
        var ig = mqNow - prev;
        if (ig > 4 && ig < 800) {
          this.inGapAvg += (ig - this.inGapAvg) * 0.15;
          this.inGapPeak = Math.max(ig, this.inGapPeak * 0.94);
        }
      }
      this.mq.push({ t: mqNow, w: !!k.w, a: !!k.a, s: !!k.s, d: !!k.d });
      while (this.mq.length > 2 && mqNow - this.mq[0].t > 600) this.mq.shift();
      if (this.mq.length > 80) this.mq.splice(0, this.mq.length - 80);
      return;
    }
    if (m.type === 'leave') {
      this.guestPresent = false;
      this.guestReady = false;
      if (this.running) {
        this.running = false;
        this.game = null;
        this.onMessage({ t: 'peerLeft', message: '对手已离开，等待新对手加入房间…', code: this.code });
      }
      this.pushLobby();
    }
  };

  HostRoom.prototype.tryStart = function () {
    if (this.running) return;
    if (!this.guestPresent) return;
    if (this.onceStarted) { this.startGame(); return; }
    if (this.hostReady && this.guestReady) this.startGame();
  };

  HostRoom.prototype.localReady = function () {
    if (this.running) return;
    this.hostReady = !this.hostReady;
    this.pushLobby();
    this.tryStart();
  };

  HostRoom.prototype.localInput = function (m) {
    var inp = this.inputs[0];
    var k = m.k || {};
    inp.k.w = !!k.w; inp.k.a = !!k.a; inp.k.s = !!k.s; inp.k.d = !!k.d;
    if (typeof m.aim === 'number') inp.aim = m.aim;
    inp.fire = !!m.fire;
    inp.boost = !!m.boost;
    inp.snipe = !!m.snipe;
    inp.t = performance.now();
  };

  // 【防自动攻击】输入超时保护：
  // 某一端如果长时间没有任何输入上报（切后台、掉线、卡住、鼠标状态残留），
  // 就把它清零。否则 fire=true 会一直挂着，表现成"没人按键却一直射"。
  // 阈值放宽到 1200ms：公共中继偶发 400ms 级别的停顿很常见，
  // 阈值太小会把正常抖动当成掉线，把房员的球"一刀切停"（这也是一卡一跳的来源）。
  HostRoom.prototype.expireInputs = function (now) {
    for (var i = 0; i < 2; i++) {
      var inp = this.inputs[i];
      if (!inp.t || now - inp.t <= 1200) continue;
      inp.fire = false;
      inp.boost = false;
      inp.snipe = false;
      inp.k.w = inp.k.a = inp.k.s = inp.k.d = false;
      if (i === 1) {
        this.mq.length = 0; // 远端输入抖动缓冲也一并作废
        this.inGapPeak = Math.max(this.inGapPeak, 400); // 状态条标红：对方卡住/掉线了
      }
    }
  };

  // 从抖动缓冲里取出"延迟 delay 之前那一格"的移动键。
  // delay 按实测抖动自适应：网络越抖 → 延迟越大（用延迟换平滑），
  // 上限 300ms，避免房员的操作变得太迟钝。
  HostRoom.prototype.pickRemoteKeys = function (now) {
    if (!this.mq.length) return;
    // 上限 420ms：中继抖动很大时，宁可让对方的动作慢一点，也不要"忽停忽走"
    var delay = Math.max(REMOTE_INPUT_DELAY, Math.min(420, this.inGapPeak * 0.8));
    this.playDelay = delay;
    var want = now - delay;
    var chosen = null, idx = -1;
    for (var i = this.mq.length - 1; i >= 0; i--) {
      if (this.mq[i].t <= want) { chosen = this.mq[i]; idx = i; break; }
    }
    if (!chosen) { chosen = this.mq[0]; idx = 0; }
    if (idx > 0) this.mq.splice(0, idx); // 丢弃已播放的，选中的那格留在队首继续用
    var k = this.inputs[1].k;
    k.w = chosen.w; k.a = chosen.a; k.s = chosen.s; k.d = chosen.d;
  };

  HostRoom.prototype.tick = function () {
    if (!this.running || !this.game) return;
    if (!this.guestPresent) return;
    // 用"真实经过时间"驱动引擎：定时器被降频/卡顿时，模拟时间仍与真实时间一致，
    // 不会出现"引擎时间落后于现实"导致的双方状态漂移。
    var tickNow = performance.now();
    var tickDt = this.lastTick ? (tickNow - this.lastTick) / 1000 : 1 / 30;
    this.lastTick = tickNow;
    if (!(tickDt > 0)) tickDt = 1 / 30;
    if (tickDt > 0.05) tickDt = 0.05;
    this.expireInputs(tickNow);
    this.pickRemoteKeys(tickNow);
    for (var i = 0; i < 2; i++) {
      var k = this.inputs[i].k;
      var dx = (k.d ? 1 : 0) - (k.a ? 1 : 0);
      var dy = (k.s ? 1 : 0) - (k.w ? 1 : 0);
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1) { dx /= len; dy /= len; }
      Eng.setCtrl(this.game, i, {
        dx: dx, dy: dy,
        aim: this.inputs[i].aim,
        fire: this.inputs[i].fire,
        boost: this.inputs[i].boost,
        snipe: this.inputs[i].snipe
      });
      this.inputs[i].boost = false;
      this.inputs[i].snipe = false;
    }
    Eng.update(this.game, tickDt);
    var snap = Eng.snapshot(this.game);
    // 关键：带上"主机时间戳"。主机时间戳是等间隔产出的，
    // 房员据此可以建立一条无抖动的时间线来插值，才不会看房主"一卡一跳"。
    var msg = { t: 'state', s: snap, ht: tickNow };
    // 本机渲染（关键：房主自己也要收到快照）
    this.onMessage(msg);
    // 直连通了就走点对点（延迟最低），否则走中继
    if (!p2pSend(msg)) pub(topicOut, msg);
  };

  HostRoom.prototype.run = function () {
    var self = this;
    if (this.timer) clearInterval(this.timer);
    this.lastTick = 0;
    this.nextTick = 0;
    // 漂移补偿调度：按 TICK_MS 节拍推进（16ms 轮询对齐 32ms 节拍），
    // 避免 setInterval 累积误差越来越大导致广播忽快忽慢。
    this.timer = setInterval(function () {
      if (!self.running || !self.game) return;
      var now = performance.now();
      if (!self.nextTick) self.nextTick = now;
      if (now < self.nextTick - 6) return;
      if (now - self.nextTick > 250) self.nextTick = now; // 落后太多则重新对齐，不爆发补帧
      self.nextTick += TICK_MS;
      self.tick();
    }, 16);
  };

  HostRoom.prototype.stop = function () {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  };

  /* ===================== 对外接口 ===================== */
  var api = {
    isHost: function () { return isHost; },
    code: function () { return roomCode; },
    // 房主用：对端输入到达间隔统计（峰值越大 = 对方网络越抖）
    stats: function () {
      if (!isHost || !hostRoom) return null;
      return { inGapAvg: hostRoom.inGapAvg, inGapPeak: hostRoom.inGapPeak, playDelay: hostRoom.playDelay || 0 };
    },

    create: function (name, onMessage, onStatus) {
      onMessageCb = onMessage; onStatusCb = onStatus;
      isHost = true;
      roomCode = randomCode();
      topicIn = PREFIX + roomCode + '/c2h';
      topicOut = PREFIX + roomCode + '/h2c';
      var will = { topic: topicOut, payload: JSON.stringify({ t: 'peerLeft', message: '房主已离开房间' }), qos: 0 };
      connectBroker(roomCode, function (c) {
        c.subscribe(topicIn, function () {});
        hostRoom = new HostRoom(roomCode, name, onMessage);
        hostRoom.run();
        hostRoom.pushLobby();
        onStatus('ready', roomCode);
      }, will);
    },

    join: function (code, name, onMessage, onStatus) {
      onMessageCb = onMessage; onStatusCb = onStatus;
      lastJoinName = name || '';
      isHost = false;
      roomCode = String(code || '').toUpperCase();
      topicIn = PREFIX + roomCode + '/c2h';
      topicOut = PREFIX + roomCode + '/h2c';
      var will = { topic: topicIn, payload: JSON.stringify({ type: 'leave' }), qos: 0 };
      connectBroker(roomCode, function (c) {
        onStatus('ready', roomCode);
        // 8 秒还没收到房主的房间信息 → 明确提示，便于区分"没连上"和"对方没响应"
        var t0 = performance.now();
        setTimeout(function () {
          if (!lobbyAt || lobbyAt < t0) status('waitjoin', roomCode);
        }, 8000);
        // 关键：等订阅成功后再上报 join，否则会错过房主回的房间信息
        c.subscribe(topicOut, function () {
          joinTries = 0;
          // 先把直连准备好（此刻还没收到 offer，先建好连接对象等着应答）
          p2pStart(false, topicIn);
          var doJoin = function () {
            pub(topicIn, { type: 'join', name: name });
            joinTries++;
            if (joinTries > 15 && joinTimer) { clearInterval(joinTimer); joinTimer = null; }
          };
          doJoin();
          if (joinTimer) clearInterval(joinTimer);
          joinTimer = setInterval(doJoin, 1000);
        });
      }, will);
    },

    onLobbyReceived: function () {
      lobbyAt = performance.now();
      if (joinTimer) { clearInterval(joinTimer); joinTimer = null; }
    },

    send: function (obj) {
      if (isHost) {
        if (!hostRoom) return;
        if (obj.type === 'ready') { hostRoom.localReady(); return; }
        if (obj.type === 'input') { hostRoom.localInput(obj); return; }
        if (obj.type === 'leave') {
          pub(topicOut, { t: 'peerLeft', message: '房主已离开房间' });
          hostRoom.stop();
          try { if (client) client.end(true); } catch (e) {}
          client = null;
          return;
        }
        return;
      }
      // 直连通了就走点对点（延迟最低），否则走中继
      if (obj.type === 'input') { if (!p2pSend(obj)) pub(topicIn, obj); return; }
      if (obj.type === 'ready') { if (!p2pSend({ type: 'ready' })) pub(topicIn, { type: 'ready' }); return; }
      if (obj.type === 'leave') {
        pub(topicIn, { type: 'leave' });
        try { if (client) client.end(true); } catch (e) {}
        client = null;
        return;
      }
    },

    close: function () {
      if (joinTimer) { clearInterval(joinTimer); joinTimer = null; }
      if (window.P2PNet) window.P2PNet.close(); // 断开直连
      if (hostRoom) { hostRoom.stop(); hostRoom = null; }
      try { if (client) client.end(true); } catch (e) {}
      client = null;
      isHost = false;
    }
  };

  window.MQTTNet = api;
})();
