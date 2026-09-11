/*
 * 球影对决 - 联机服务器（Node.js，零第三方依赖）
 * - 提供静态页面
 * - WebSocket 房间联机：创建房间号 / 输入房间号加入 / 房间邀请链接
 * - 服务端权威模拟，广播游戏快照
 *
 * 启动: node server.js   (默认端口 3000，可用 PORT 环境变量修改)
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var engine = require(path.join(__dirname, 'public', 'engine.js'));

var PORT = process.env.PORT || 3000;
var PUBLIC_DIR = path.join(__dirname, 'public');
// 广播节拍：31Hz（32ms）。比以前 20Hz 更跟手，客户端插值缓冲也能更小。
var TICK = 32;

/* ---------------- HTTP 静态文件 ---------------- */
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function sendFile(res, file, fallback) {
  fs.readFile(file, function (err, data) {
    if (err) {
      if (fallback) return sendFile(res, fallback);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    var ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

var server = http.createServer(function (req, res) {
  var urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // 防止路径穿越
  var filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  sendFile(res, filePath, path.join(PUBLIC_DIR, 'index.html'));
});

/* ---------------- WebSocket（极简实现，用于文本 JSON 消息） ---------------- */
function wsAccept(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function wsSend(socket, obj) {
  if (!socket || socket.destroyed) return;
  var payload = Buffer.from(JSON.stringify(obj), 'utf8');
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

// 发送已序列化好的 JSON 文本（避免对同一对象多次 JSON.stringify，降低 CPU）
function wsSendText(socket, text) {
  if (!socket || socket.destroyed) return;
  var payload = Buffer.from(text, 'utf8');
  var len = payload.length;
  var header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  socket.write(Buffer.concat([header, payload]));
}

var WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', function (req, socket) {
  var key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  var accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  onSocket(socket);
});

function onSocket(socket) {
  var buffer = Buffer.alloc(0);
  var peer = {
    socket: socket,
    role: -1,
    name: '',
    room: null,
    alive: true,
    lastSeen: Date.now()
  };

  socket.on('data', function (chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      var msg = tryParseFrame(buffer);
      if (!msg) break;
      buffer = msg.rest;
      peer.lastSeen = Date.now();
      handleFrame(peer, msg.opcode, msg.payload);
      if (!peer.alive) return;
    }
  });

  socket.on('error', function () {});
  socket.on('close', function () { onLeave(peer); });
  socket.on('end', function () { onLeave(peer); });
}

function tryParseFrame(buf) {
  if (buf.length < 2) return null;
  var b0 = buf[0];
  var opcode = b0 & 0x0f;
  var fin = (b0 & 0x80) !== 0;
  var b1 = buf[1];
  var masked = (b1 & 0x80) !== 0;
  var len = b1 & 0x7f;
  var offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  var maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  var maskKey = masked ? buf.slice(offset, offset + 4) : null;
  var payload = Buffer.from(buf.slice(offset + maskLen, offset + maskLen + len));
  if (masked) {
    for (var i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
  }
  return { fin: fin, opcode: opcode, payload: payload, rest: buf.slice(offset + maskLen + len) };
}

/* ---------------- 房间与连接管理 ---------------- */
var rooms = new Map(); // code -> room

function genCode() {
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var code = '';
  for (var i = 0; i < 5; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

function cleanName(raw) {
  var n = String(raw || '').trim().slice(0, 10);
  return n || '神秘球手';
}

function makeRoom() {
  var code;
  do { code = genCode(); } while (rooms.has(code));
  var room = {
    code: code,
    sockets: [null, null], // role 0 / role 1
    names: ['', ''],
    ready: [false, false],
    game: null,
    running: false,
    onceStarted: false, // 是否曾经开局（用于断线重连后自动续赛）
    inputs: [{ k: { w: false, a: false, s: false, d: false }, aim: 0, fire: false },
             { k: { w: false, a: false, s: false, d: false }, aim: 0, fire: false }],
    lastSeen: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function sendToPeer(peer, obj) { wsSend(peer.socket, obj); }

function roster(room, role) {
  var players = [];
  for (var i = 0; i < 2; i++) {
    if (room.sockets[i]) {
      players.push({ role: i, name: room.names[i], ready: room.ready[i] });
    }
  }
  return {
    t: 'lobby',
    code: room.code,
    players: players,
    role: role,
    onceStarted: room.onceStarted
  };
}

function broadcastLobby(room) {
  for (var i = 0; i < 2; i++) {
    if (room.sockets[i]) wsSend(room.sockets[i].socket, roster(room, i));
  }
}

function startGame(room) {
  room.game = engine.createGame();
  room.running = true;
  room.onceStarted = true;
  room.inputs = [
    { k: { w: false, a: false, s: false, d: false }, aim: 0, fire: false, boost: false, snipe: false },
    { k: { w: false, a: false, s: false, d: false }, aim: Math.PI, fire: false, boost: false, snipe: false }
  ];
  for (var i = 0; i < 2; i++) {
    if (room.sockets[i]) {
      wsSend(room.sockets[i].socket, { t: 'begin', names: room.names.slice() });
    }
  }
}

function tryAutoStart(room) {
  if (room.running) return;
  if (!room.sockets[0] || !room.sockets[1]) return;
  if (room.onceStarted) {
    // 断线续赛：人齐即自动开新对局
    startGame(room);
    return;
  }
  if (room.ready[0] && room.ready[1]) startGame(room);
}

function handleFrame(peer, opcode, payload) {
  if (opcode === 0x8) { peer.alive = false; peer.socket.destroy(); return; }
  if (opcode !== 0x1 && opcode !== 0x2) return; // 只处理文本/二进制(忽略)
  if (payload.length > 8192) { peer.socket.destroy(); return; }
  var data;
  try { data = JSON.parse(payload.toString('utf8')); } catch (e) { return; }
  if (!data || typeof data !== 'object') return;

  var room = peer.room;

  switch (data.type) {
    case 'ping':
      sendToPeer(peer, { t: 'pong' });
      break;

    case 'create': {
      if (room) return;
      var r1 = makeRoom();
      var code = r1.code;
      r1.sockets[0] = peer;
      r1.names[0] = cleanName(data.name);
      peer.room = r1;
      peer.role = 0;
      peer.name = r1.names[0];
      sendToPeer(peer, roster(r1, 0));
      break;
    }

    case 'join': {
      if (room) return;
      var targetCode = String(data.code || '').trim().toUpperCase();
      var r2 = rooms.get(targetCode);
      if (!r2) {
        sendToPeer(peer, { t: 'error', message: '房间不存在，请检查房间号' });
        return;
      }
      var slot = r2.sockets[0] ? (r2.sockets[1] ? -1 : 1) : 0;
      if (slot < 0) {
        sendToPeer(peer, { t: 'error', message: '房间已满（每房限 2 人）' });
        return;
      }
      r2.sockets[slot] = peer;
      r2.names[slot] = cleanName(data.name);
      peer.room = r2;
      peer.role = slot;
      peer.name = r2.names[slot];
      r2.lastSeen = Date.now();
      if (r2.game && !r2.running) {
        // 对方等待中，重置为全新对局
        r2.game = null;
      }
      broadcastLobby(r2);
      tryAutoStart(r2);
      break;
    }

    case 'ready': {
      if (!room || peer.role < 0) return;
      if (room.running) return;
      room.ready[peer.role] = !room.ready[peer.role];
      broadcastLobby(room);
      tryAutoStart(room);
      break;
    }

    case 'input': {
      if (!room || peer.role < 0 || !room.running || !room.game) return;
      var k = data.k || {};
      var inp = room.inputs[peer.role];
      inp.k.w = !!k.w; inp.k.a = !!k.a; inp.k.s = !!k.s; inp.k.d = !!k.d;
      inp.aim = typeof data.aim === 'number' ? data.aim : inp.aim;
      inp.fire = !!data.fire;
      inp.boost = !!data.boost; // 客户端按键边沿上报；主循环消费后复位
      inp.snipe = !!data.snipe; // 右键秒杀箭（边沿）
      break;
    }

    case 'leave': {
      peer.socket.destroy();
      break;
    }
  }
}

function onLeave(peer) {
  if (!peer.alive) return;
  peer.alive = false;
  var room = peer.room;
  if (!room) return;
  var role = peer.role;
  if (role >= 0 && room.sockets[role] === peer) {
    room.sockets[role] = null;
  }
  var remaining = null;
  var otherRole = role === 0 ? 1 : 0;
  if (room.sockets[otherRole]) remaining = room.sockets[otherRole];
  else if (room.sockets[role]) remaining = room.sockets[role];

  if (remaining) {
    if (room.running) {
      room.running = false;
      room.game = null;
      var wasRunning = true;
      var msg = {
        t: 'peerLeft',
        message: wasRunning ? '对手已离开，正在等待新对手加入房间…' : '',
        code: room.code
      };
      wsSend(remaining.socket, msg);
      room.ready = [false, false];
      wsSend(remaining.socket, roster(room, remaining.role));
    } else {
      room.ready = [false, false];
      broadcastLobby(room);
    }
  } else {
    // 房间空置
    rooms.delete(room.code);
  }
  peer.room = null;
}

/* ---------------- 主循环：权威模拟 + 广播 ---------------- */
var STEP = 1 / 30;
var lastTickAt = 0;
setInterval(function () {
  var now = Date.now();
  // 用"真实经过时间"驱动模拟：定时器被拖慢时，游戏时间也不会落后于现实
  var dt = lastTickAt ? (now - lastTickAt) / 1000 : STEP;
  lastTickAt = now;
  if (!(dt > 0)) dt = STEP;
  if (dt > 0.1) dt = 0.1;
  rooms.forEach(function (room, code) {
    if (!room.running || !room.game) return;
    var s0 = room.sockets[0], s1 = room.sockets[1];
    if (!s0 || !s1) return;

    // 根据最新按键计算移动方向
    for (var i = 0; i < 2; i++) {
      var k = room.inputs[i].k;
      var dx = (k.d ? 1 : 0) - (k.a ? 1 : 0);
      var dy = (k.s ? 1 : 0) - (k.w ? 1 : 0);
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1) { dx /= len; dy /= len; }
      engine.setCtrl(room.game, i, {
        dx: dx,
        dy: dy,
        aim: room.inputs[i].aim,
        fire: room.inputs[i].fire,
        boost: room.inputs[i].boost,
        snipe: room.inputs[i].snipe
      });
      room.inputs[i].boost = false; // 边沿触发：置给引擎后立即复位
      room.inputs[i].snipe = false;
    }

    engine.update(room.game, dt);
    var snap = engine.snapshot(room.game);
    // 两个客户端收到的内容一致：只 JSON.stringify 一次，两端复用同一文本。
    // ht = 服务器的"发送时刻"，客户端据此建立无抖动时间轴做插值（关键）。
    var text = JSON.stringify({ t: 'state', s: snap, ht: now });
    for (var j = 0; j < 2; j++) {
      if (room.sockets[j]) wsSendText(room.sockets[j].socket, text);
    }
    room.lastSeen = now;
  });

  // 清理空房间
  rooms.forEach(function (room, code) {
    var has = room.sockets[0] || room.sockets[1];
    var idleFor = now - room.lastSeen;
    if (!has || idleFor > 2 * 60 * 60 * 1000) rooms.delete(code);
  });
}, TICK);

server.listen(PORT, function () {
  console.log('');
  console.log('  球影对决 服务器已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  console.log('  局域网:     http://' + lanIP() + ':' + PORT);
  console.log('  同一局域网/公网下的朋友通过该地址即可进入，并用房间号联机。');
  console.log('');
});

function lanIP() {
  try {
    var ifaces = require('os').networkInterfaces();
    for (var name in ifaces) {
      var arr = ifaces[name];
      for (var i = 0; i < arr.length; i++) {
        var a = arr[i];
        if (a.family === 'IPv4' && !a.internal) return a.address;
      }
    }
  } catch (e) {}
  return '127.0.0.1';
}
