/*
 * 球影对决 - 浏览器直连（WebRTC 点对点）
 *
 * 目的：两个人之间**不经过任何服务器**直接传游戏数据。
 *   · 延迟从"绕公共中继"的 200~400ms 降到 20~60ms，且几乎没有抖动；
 *   · 不花钱、不用买服务器、不用注册任何账号；
 *   · 只有"牵线"（交换一次地址）的几条小消息借用现有免费中继，几秒钟后就不再需要它。
 *
 * 设计要点：
 *   1) 非 trickle：等 ICE 收集完（最多 6 秒）再一次性发出去，
 *      只靠一条消息就能牵上线，不怕中继抖动/丢包导致候选地址缺失。
 *   2) 数据通道用"不可靠 + 不保序"（ordered:false, maxRetransmits:0）：
 *      游戏快照本来就"最新的才有用"，丢一条直接忽略即可，
 *      避免为了重传旧包堵住通道（这正是中继模式延迟忽高忽低的原因之一）。
 *   3) 失败自动重试 1 次（房主负责重新发起），并把"候选地址数量 / 连接状态"
 *      一起报出来 —— 便于一眼判断是"打洞失败"还是"牵线没到"。
 *   4) 任何一步失败都会明确上报 failed，由上层自动切回公共中继 —— 绝不比原来更差。
 *   5) 网址加 ?p2p=off 可强制关闭直连（排错用）。
 */
(function () {
  'use strict';

  // 国内可用的公共 STUN（只用来"问出自己的公网地址"，不转发任何数据）。
  // 多填几个，谁能用就用谁。
  var ICE = [
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.chat.bilibili.com:3478' },
    { urls: 'stun:stun.hitv.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  var MAX_TRY = 2;      // 最多尝试次数（含首次）
  var GATHER_MS = 6000; // 等 ICE 收集的上限
  var TRY_MS = 12000;   // 单次尝试的总超时

  var pc = null, dc = null, host = false;
  var sigSend = null, peerCb = null, stCb = null;
  var state = 'idle';   // idle | trying | open | failed | closed
  var timeoutTimer = null, retryTimer = null;
  var started = false, attempt = 0, cand = 0;
  // 最近一次"定论"（成功/失败原因），常驻显示在左上角状态条里，
  // 这样不抓瞬时提示也能看出直连为什么没成（候选 0 = STUN 被挡；有候选 = 打洞失败）
  var lastInfo = '';

  function disabled() {
    return (typeof location !== 'undefined') && /[?&]p2p=(off|0)/i.test(location.search);
  }
  function supported() {
    return typeof window !== 'undefined' && !!window.RTCPeerConnection;
  }
  function status(s, extra) {
    state = s;
    // 只有"成功/失败/关闭"才算定论；'trying' 时保留上一次的原因，便于排查
    if (s === 'failed' || s === 'open' || s === 'closed') {
      lastInfo = extra || (s === 'open' ? '已直连' : '');
    }
    if (stCb) { try { stCb(s, extra); } catch (e) {} }
  }

  // 等 ICE 收集完成（"非 trickle"打法：一次把地址发全）
  function waitIce(cb) {
    if (!pc) { cb(); return; }
    if (pc.iceGatheringState === 'complete') { cb(); return; }
    var done = false;
    var t = setTimeout(function () { finish(); }, GATHER_MS);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(t);
      cb();
    }
    pc.onicegatheringstatechange = function () {
      if (pc && pc.iceGatheringState === 'complete') finish();
    };
  }

  function wire(channel) {
    dc = channel;
    dc.onopen = function () {
      clearTimeout(timeoutTimer); timeoutTimer = null;
      clearTimeout(retryTimer); retryTimer = null;
      status('open');
    };
    dc.onmessage = function (ev) {
      if (!peerCb) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      peerCb(m);
    };
    dc.onclose = function () { if (state !== 'closed') fail('直连断开'); };
    dc.onerror = function () { if (state !== 'open') fail('通道出错'); };
  }

  // 失败处理：房主负责自动重试一次；重试还失败才真正认输（切回中继）
  function fail(reason) {
    if (state === 'open' || state === 'failed') return;
    var info = reason + '（候选 ' + cand + '）';
    if (host && attempt < MAX_TRY) {
      attempt++;
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      status('trying', '重试');
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(function () { if (host && state !== 'open') begin(); }, 1500);
      return;
    }
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    status('failed', info);
  }

  function begin() {
    if (!supported()) { status('failed', '浏览器不支持直连'); return; }
    if (disabled()) { status('failed', '已手动关闭直连'); return; }
    // 重建连接对象（重试时也走这里）
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    dc = null; cand = 0;
    try {
      pc = new window.RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 2 });
    } catch (e) {
      status('failed', '直连初始化失败');
      return;
    }
    pc.onicecandidate = function (e) { if (e && e.candidate) cand++; };
    pc.onconnectionstatechange = function () {
      var s = pc && pc.connectionState;
      if (s === 'failed') fail('连接失败');
      else if (s === 'disconnected' && state === 'open') fail('连接中断');
    };
    status('trying');
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(function () { fail('超时'); }, TRY_MS);

    if (host) {
      try {
        wire(pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 }));
      } catch (e) { fail('通道创建失败'); return; }
      pc.createOffer()
        .then(function (o) { return pc.setLocalDescription(o); })
        .then(function () {
          waitIce(function () {
            if (pc && pc.localDescription && sigSend) sigSend({ t: 'rtcOff', sdp: pc.localDescription.sdp });
          });
        })
        .catch(function () { fail('发起失败'); });
    } else {
      pc.ondatachannel = function (e) { wire(e.channel); };
    }
  }

  // isHost：房主负责"发起"（出 offer）；房员负责"应答"
  function init(isHost, sigSendFn, onPeer, onStatus) {
    if (started) return state === 'open' || state === 'trying';
    host = isHost; sigSend = sigSendFn; peerCb = onPeer; stCb = onStatus;
    started = true;
    if (!supported()) { status('failed', '浏览器不支持直连'); return false; }
    if (disabled()) { status('failed', '已手动关闭直连'); return false; }
    begin();
    return true;
  }

  // 处理牵线消息；返回 true 表示"这条消息是牵线用的，已经吃掉了"
  function handleSignal(m) {
    if (!m || (m.t !== 'rtcOff' && m.t !== 'rtcAns')) return false;
    if (m.t === 'rtcOff') {
      if (host) return true;
      if (!supported()) { status('failed', '浏览器不支持直连'); return true; }
      // 房主重试会再发一次 offer：这时必须重建连接对象
      if (state === 'failed' || state === 'closed' || (pc && pc.remoteDescription)) begin();
      if (!pc) return true;
      pc.setRemoteDescription({ type: 'offer', sdp: m.sdp })
        .then(function () { return pc.createAnswer(); })
        .then(function (a) { return pc.setLocalDescription(a); })
        .then(function () {
          waitIce(function () {
            if (pc && pc.localDescription && sigSend) sigSend({ t: 'rtcAns', sdp: pc.localDescription.sdp });
          });
        })
        .catch(function () { fail('协商失败'); });
      return true;
    }
    // rtcAns
    if (!host || !pc) return true;
    pc.setRemoteDescription({ type: 'answer', sdp: m.sdp })
      .catch(function () { fail('协商失败'); });
    return true;
  }

  // 直连可用时发出去；否则返回 false，由上层走中继
  function send(obj) {
    if (!dc || dc.readyState !== 'open') return false;
    try { dc.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function close() {
    started = false;
    clearTimeout(timeoutTimer); timeoutTimer = null;
    clearTimeout(retryTimer); retryTimer = null;
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    dc = null; pc = null;
    if (state !== 'idle') state = 'closed';
  }

  window.P2PNet = {
    init: init,
    handleSignal: handleSignal,
    send: send,
    close: close,
    state: function () { return state; },
    info: function () { return { state: state, detail: lastInfo }; },
    available: function () { return supported() && !disabled(); }
  };
})();
