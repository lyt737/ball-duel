/**
 * 球影对决 - 专用中继（Deno Deploy 版）
 *
 * 作用只有一件事：把同一个房间里两个人的消息**互相转发**。
 * 它不看游戏内容、不存数据、不做判断。所以：
 *   · 两个人用同一个房间号连上来，消息就互通；
 *   · 这台服务**只服务你们两个人**，不像公共中继那样跟几百个陌生人抢带宽
 *     —— 这就是"稳"的来源（延迟、抖动都是你们自己的）。
 *
 * 客户端连接方式（游戏里我会接好，你不需要手填）：
 *   wss://<你的项目名>.deno.dev/?room=房间号&role=host|guest
 *
 * 自检：浏览器直接打开 https://<你的项目名>.deno.dev/ 看到 "relay alive" 即为正常。
 */

const rooms = new Map(); // 房间号 -> { host, guest }

function send(ws, obj) {
  if (!ws) return;
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {}
}

Deno.serve((req) => {
  const url = new URL(req.url);

  // 普通 HTTP 访问：给个明确反馈，便于判断"服务到底有没有在跑"
  if (req.headers.get('upgrade') !== 'websocket') {
    return new Response('relay alive\n', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }

  const code = (url.searchParams.get('room') || '').trim().toUpperCase().slice(0, 8);
  const asGuest = url.searchParams.get('role') === 'guest';
  if (!code) return new Response('missing room', { status: 400 });

  const { socket, response } = Deno.upgradeWebSocket(req);

  let room = rooms.get(code);
  if (!room) { room = { host: null, guest: null }; rooms.set(code, room); }
  const slot = asGuest ? 'guest' : 'host';
  const peerSlot = asGuest ? 'host' : 'guest';

  // 位置已被占用（例如房员重复加入）：明确告知，避免两个人抢同一个位置
  if (room[slot]) {
    socket.onopen = () => {
      send(socket, { t: 'error', message: '这个位置已被占用，请换一个房间号重试' });
      try { socket.close(); } catch (_) {}
    };
    return response;
  }
  room[slot] = socket;

  // 收到什么就原样转给对方（游戏本身负责理解内容）
  socket.onmessage = (ev) => {
    const r = rooms.get(code);
    if (!r) return;
    const peer = r[peerSlot];
    if (peer && peer.readyState === 1) {
      try { peer.send(ev.data); } catch (_) {}
    }
  };

  function cleanup() {
    const r = rooms.get(code);
    if (!r) return;
    if (r[slot] === socket) r[slot] = null;
    const peer = r[peerSlot];
    if (peer) send(peer, { t: 'peerLeft', message: '对手已离开房间' });
    if (!r.host && !r.guest) rooms.delete(code);
  }
  socket.onclose = cleanup;
  socket.onerror = cleanup;

  socket.onopen = () => {
    const peer = room[peerSlot];
    if (peer) send(peer, { t: 'peerHere' });
  };

  return response;
});
