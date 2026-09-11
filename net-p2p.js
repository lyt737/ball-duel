/*
 * 球影对决 - 浏览器直连（WebRTC 点对点）
 *
 * 目的：两个人之间**不经过任何服务器**直接传游戏数据。
 *   · 延迟从"绕公共中继"的 200~400ms 降到 20~60ms，且几乎没有抖动；
 *   · 不花钱、不用买服务器、不用注册任何账号；
 *   · 只有"牵线"（交换地址）的几条小消息借用现有免费中继，几秒钟后就不再需要它。
 *
 * 实现要点：
 *   1) 非 trickle：等 ICE 收集完（最多 3.5 秒）再一次性发出去，
 *      这样只需要一条消息就能牵上线，不怕中继抖动/丢包导致候选地址缺失。
 *   2) 数据通道用"不可靠 + 不保序"（ordered:false, maxRetransmits:0）：
 *      游戏快照本来就是"最新的才有用"，丢一两条直接忽略即可，
 *      避免为了重传旧包堵住通道（这正是中继模式下延迟忽高忽低的原因之一）。
 *   3) 任何一步失败（浏览器不支持 / NAT 打不通 / 超时 12 秒）都会明确上报 failed，
 *      由上层自动切回公共中继 —— 绝不比原来更差。
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

  var pc = null, dc = null, host = false;
  var sigSend = null, peerCb = null, stCb = null;
  var state = 'idle';           // idle | trying | open | failed | closed
  var timeoutTimer = null;
  var started = false;

  function status(s, extra) {
    state = s;
    if (stCb) { try { stCb(s, extra); } catch (e) {} }
  }

  // 等 ICE 收集完成（"非 trickle"打法：一次把地址发全）
  function waitIce(cb) {
    if (!pc) { cb(); return; }
    if (pc.iceGatheringState === 'complete') { cb(); return; }
    var done = false;
    var t = setTimeout(function () { finish(); }, 3500);
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
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      status('open');
    };
    dc.onmessage = function (ev) {
      if (!peerCb) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      peerCb(m);
    };
    dc.onclose = function () { if (state !== 'closed') status('failed', '直连断开'); };
    dc.onerror = function () { if (state === 'trying') status('failed', '直连出错'); };
  }

  // isHost：房主负责"发起"（出 offer）；房员负责"应答"
  // sigSend(obj)：把牵线消息交给上层（走现有中继）
  // onPeer(obj)  ：收到对方发来的游戏消息
  // onStatus(s)  ：'trying' | 'open' | 'failed' | 'closed'
  function init(isHost, sigSendFn, onPeer, onStatus) {
    if (started) return state === 'open' || state === 'trying';
    if (typeof window === 'undefined' || !window.RTCPeerConnection) {
      host = isHost; sigSend = sigSendFn; peerCb = onPeer; stCb = onStatus;
      started = true;
      status('failed', '浏览器不支持直连');
      return false;
    }
    host = isHost; sigSend = sigSendFn; peerCb = onPeer; stCb = onStatus;
    started = true;
    try {
      pc = new window.RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 2 });
    } catch (e) {
      status('failed', '直连初始化失败');
      return false;
    }
    status('trying');
    // 兜底超时：12 秒还没连上就认输，切回中继（游戏照常玩）
    timeoutTimer = setTimeout(function () {
      if (state === 'trying') status('failed', '直连超时（已切回中继）');
    }, 12000);

    if (host) {
      try {
        wire(pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 }));
      } catch (e) {
        status('failed', '直连通道创建失败');
        return false;
      }
      pc.createOffer()
        .then(function (o) { return pc.setLocalDescription(o); })
        .then(function () {
          waitIce(function () {
            if (pc && pc.localDescription && sigSend) sigSend({ t: 'rtcOff', sdp: pc.localDescription.sdp });
          });
        })
        .catch(function () { status('failed', '直连发起失败'); });
    } else {
      pc.ondatachannel = function (e) { wire(e.channel); };
    }

    pc.onconnectionstatechange = function () {
      var s = pc && pc.connectionState;
      if (s === 'failed') status('failed', '直连失败（已切回中继）');
      else if (s === 'disconnected' && state === 'open') status('failed', '直连中断（已切回中继）');
    };
    return true;
  }

  // 处理牵线消息；返回 true 表示"这条消息是牵线用的，已经吃掉了"
  function handleSignal(m) {
    if (!m || (m.t !== 'rtcOff' && m.t !== 'rtcAns')) return false;
    if (!pc) return true;
    if (m.t === 'rtcOff') {
      if (host) return true; // 房主不会收到 offer
      pc.setRemoteDescription({ type: 'offer', sdp: m.sdp })
        .then(function () { return pc.createAnswer(); })
        .then(function (a) { return pc.setLocalDescription(a); })
        .then(function () {
          waitIce(function () {
            if (pc && pc.localDescription && sigSend) sigSend({ t: 'rtcAns', sdp: pc.localDescription.sdp });
          });
        })
        .catch(function () { status('failed', '直连协商失败（已切回中继）'); });
      return true;
    }
    // rtcAns
    if (!host) return true;
    pc.setRemoteDescription({ type: 'answer', sdp: m.sdp })
      .catch(function () { status('failed', '直连协商失败（已切回中继）'); });
    return true;
  }

  // 直连可用时发出去；否则返回 false，由上层走中继
  function send(obj) {
    if (!dc || dc.readyState !== 'open') return false;
    try { dc.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function close() {
    started = false;
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
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
    available: function () { return typeof window !== 'undefined' && !!window.RTCPeerConnection; }
  };
})();
