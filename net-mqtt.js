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

  // 多个公共 broker，按顺序尝试（实测延迟远低于云沙箱）
  var BROKERS = [
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
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

  // 连接 broker：三个候选中继"同时抢跑"，谁先连上就用谁，其余立即关掉。
  // 比原来"逐个等超时"快得多（原来最坏要等 3×7 秒，这就是"加入时间很长"的原因）。
  // will 为掉线遗嘱消息。
  function connectBroker(done, will) {
    if (typeof mqtt === 'undefined' || !mqtt || !mqtt.connect) {
      status('fail', '中继组件未加载（页面可能没加载完），请刷新后重试');
      return;
    }
    var settled = false;
    var failed = 0;
    var clients = [];

    function allFailed() {
      failed++;
      if (!settled && failed >= BROKERS.length) {
        settled = true;
        status('fail', '所有公共中继都连不上，请检查网络后重试');
      }
    }
    function win(c, url) {
      if (settled) return;
      settled = true;
      for (var k = 0; k < clients.length; k++) {
        if (clients[k] === c) continue;
        // 用优雅断开：避免触发已注册的遗嘱消息，把对方误判成"已离开"
        try { clients[k].end(false); } catch (e) {}
      }
      client = c;
      status('ok', url);
      done(c);
    }

    for (var i = 0; i < BROKERS.length; i++) {
      (function (url) {
        var opts = {
          clientId: 'qy_' + Math.random().toString(16).slice(2, 12),
          clean: true,
          reconnectPeriod: 0,
          connectTimeout: 5000,
          keepalive: 30
        };
        if (will) opts.will = will;
        var c;
        try { c = mqtt.connect(url, opts); } catch (e) { allFailed(); return; }
        clients.push(c);
        var doneFlag = false;
        var timer = setTimeout(function () {
          if (doneFlag) return;
          doneFlag = true;
          try { c.end(true); } catch (e) {} // 未连上过 → 没有遗嘱，可强制关
          allFailed();
        }, 6000);
        c.on('connect', function () {
          if (doneFlag) return;
          doneFlag = true; clearTimeout(timer);
          win(c, url);
        });
        c.on('error', function () {
          if (doneFlag) return;
          doneFlag = true; clearTimeout(timer);
          try { c.end(true); } catch (e) {}
          allFailed();
        });
        c.on('message', function (topic, payload) {
          if (c !== client) return; // 落选的连接不处理消息，避免重复
          var m;
          try { m = JSON.parse(payload.toString()); } catch (e) { return; }
          if (isHost && hostRoom) hostRoom.onGuestMsg(m);
          else if (!isHost && onMessageCb) onMessageCb(m);
        });
      })(BROKERS[i]);
    }
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
  // 某一端如果 450ms 没有任何输入上报（切后台、掉线、卡住、鼠标状态残留），
  // 就把它清零。否则 fire=true 会一直挂着，表现成"没人按键却一直射"。
  HostRoom.prototype.expireInputs = function (now) {
    for (var i = 0; i < 2; i++) {
      var inp = this.inputs[i];
      if (!inp.t || now - inp.t <= 450) continue;
      inp.fire = false;
      inp.boost = false;
      inp.snipe = false;
      inp.k.w = inp.k.a = inp.k.s = inp.k.d = false;
      if (i === 1) this.mq.length = 0; // 远端输入抖动缓冲也一并作废
    }
  };

  // 从抖动缓冲里取出"延迟 REMOTE_INPUT_DELAY 之前那一格"的移动键
  HostRoom.prototype.pickRemoteKeys = function (now) {
    if (!this.mq.length) return;
    var want = now - REMOTE_INPUT_DELAY;
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
    pub(topicOut, msg);
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

    create: function (name, onMessage, onStatus) {
      onMessageCb = onMessage; onStatusCb = onStatus;
      isHost = true;
      roomCode = randomCode();
      topicIn = PREFIX + roomCode + '/c2h';
      topicOut = PREFIX + roomCode + '/h2c';
      var will = { topic: topicOut, payload: JSON.stringify({ t: 'peerLeft', message: '房主已离开房间' }), qos: 0 };
      connectBroker(function (c) {
        c.subscribe(topicIn, function () {});
        hostRoom = new HostRoom(roomCode, name, onMessage);
        hostRoom.run();
        hostRoom.pushLobby();
        onStatus('ready', roomCode);
      }, will);
    },

    join: function (code, name, onMessage, onStatus) {
      onMessageCb = onMessage; onStatusCb = onStatus;
      isHost = false;
      roomCode = String(code || '').toUpperCase();
      topicIn = PREFIX + roomCode + '/c2h';
      topicOut = PREFIX + roomCode + '/h2c';
      var will = { topic: topicIn, payload: JSON.stringify({ type: 'leave' }), qos: 0 };
      connectBroker(function (c) {
        onStatus('ready', roomCode);
        // 关键：等订阅成功后再上报 join，否则会错过房主回的房间信息
        c.subscribe(topicOut, function () {
          joinTries = 0;
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
      if (obj.type === 'input') { pub(topicIn, obj); return; }
      if (obj.type === 'ready') { pub(topicIn, { type: 'ready' }); return; }
      if (obj.type === 'leave') {
        pub(topicIn, { type: 'leave' });
        try { if (client) client.end(true); } catch (e) {}
        client = null;
        return;
      }
    },

    close: function () {
      if (joinTimer) { clearInterval(joinTimer); joinTimer = null; }
      if (hostRoom) { hostRoom.stop(); hostRoom = null; }
      try { if (client) client.end(true); } catch (e) {}
      client = null;
      isHost = false;
    }
  };

  window.MQTTNet = api;
})();
