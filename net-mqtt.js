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
    return { k: { w: false, a: false, s: false, d: false }, aim: 0, fire: false, boost: false, snipe: false };
  }

  function pub(topic, obj, qos) {
    if (!client) return;
    try { client.publish(topic, JSON.stringify(obj), { qos: qos || 0, retain: false }); } catch (e) {}
  }

  // 连接 broker（依次尝试），will 为掉线遗嘱消息
  function connectBroker(done, will) {
    var i = 0;
    function attempt() {
      if (i >= BROKERS.length) { status('fail', '所有公共中继都连不上，请稍后重试'); return; }
      var url = BROKERS[i++];
      var opts = {
        clientId: 'qy_' + Math.random().toString(16).slice(2, 12),
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 6000,
        keepalive: 30
      };
      if (will) opts.will = will;
      var c;
      try { c = mqtt.connect(url, opts); } catch (e) { attempt(); return; }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { c.end(true); } catch (e) {}
        attempt();
      }, 7000);
      c.on('connect', function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        client = c;
        status('ok', url);
        done(c);
      });
      c.on('error', function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { c.end(true); } catch (e) {}
        attempt();
      });
      c.on('message', function (topic, payload) {
        var m;
        try { m = JSON.parse(payload.toString()); } catch (e) { return; }
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
      this.pushLobby();
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
  };

  HostRoom.prototype.tick = function () {
    if (!this.running || !this.game) return;
    if (!this.guestPresent) return;
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
    Eng.update(this.game, 1 / 20);
    var snap = Eng.snapshot(this.game);
    // 本机渲染（关键：房主自己也要收到快照）
    this.onMessage({ t: 'state', s: snap });
    pub(topicOut, { t: 'state', s: snap });
  };

  HostRoom.prototype.run = function () {
    var self = this;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(function () { self.tick(); }, 50);
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
