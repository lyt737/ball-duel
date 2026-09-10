/*
 * 球影对决 - 渲染器（Canvas 2D）
 * 白底场地 + 球体 + 箭矢 + 特效。仅负责“画”，逻辑见 engine.js / game.js
 */
(function () {
  'use strict';

  var canvas, ctx;
  var cssW = 0, cssH = 0, dpr = 1;
  var view = { scale: 1, ox: 0, oy: 0 };
  var fx = [];      // 粒子特效（世界坐标）
  var vignette = 0; // 受击屏幕红光

  var BALL_R = (window.DuelEngine && window.DuelEngine.C && window.DuelEngine.C.BALL_R) || 42;
  var WORLD_W = 1500, WORLD_H = 1000;
  var WORLD_RATIO = WORLD_W / WORLD_H; // 1.5

  var PAL = [
    { light: '#fecaca', mid: '#ef4444', dark: '#7f1d1d', text: '#dc2626' },
    { light: '#bfdbfe', mid: '#3b82f6', dark: '#1e3a8a', text: '#2563eb' }
  ];
  window.__BALL_PAL = PAL; // 供 HUD 复用

  function attach(cv) {
    canvas = cv;
    ctx = cv.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    return api;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    // 渲染"可视世界"始终等于物理世界（engine.js 里的 1800×1000），且**保证完全在屏幕内**：
    // 这样地图整体不会超出全屏，球大小（BALL_R=42，世界单位）稳定，
    // 移动空间与物理世界 1:1 对应。
    // 取"能放下的最大缩放"（不裁切、不放大）：左右可能有少量留白（取决于窗口比例），
    // 但绝不会再出现"地图超出全屏、球被放大"的情况。
    var engineW = (window.DuelEngine && window.DuelEngine.C && window.DuelEngine.C.W) || 1800;
    var engineH = (window.DuelEngine && window.DuelEngine.C && window.DuelEngine.C.H) || 1000;
    WORLD_W = engineW;
    WORLD_H = engineH;
    view.scale = Math.min(cssW / WORLD_W, cssH / WORLD_H);
    // 等比缩放后居中显示；窗口更宽时左右各留一点白边，窗口更高时上下各留一点。
    view.ox = (cssW - WORLD_W * view.scale) / 2;
    view.oy = (cssH - WORLD_H * view.scale) / 2;
  }

  function toWorld(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var x = (clientX - rect.left) * (cssW / rect.width);
    var y = (clientY - rect.top) * (cssH / rect.height);
    return { x: (x - view.ox) / view.scale, y: (y - view.oy) / view.scale };
  }

  function toScreen(wx, wy) {
    return { x: wx * view.scale + view.ox, y: wy * view.scale + view.oy };
  }

  /* ============ 特效 ============ */
  function addParticle(p) { fx.push(p); }
  function capParticles() { if (fx.length > 420) fx.splice(0, fx.length - 420); }

  function spawnImpact(x, y, color) {
    for (var i = 0; i < 11; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 120 + Math.random() * 240;
      addParticle({
        kind: 'spark', x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.35 + Math.random() * 0.25, max: 0.6,
        color: color, size: 3 + Math.random() * 3
      });
    }
  }

  function spawnWallPuff(x, y) {
    for (var i = 0; i < 6; i++) {
      var a = Math.random() * Math.PI * 2;
      addParticle({
        kind: 'puff', x: x, y: y,
        vx: Math.cos(a) * 55, vy: Math.sin(a) * 55,
        life: 0.28 + Math.random() * 0.18, max: 0.46,
        color: '#94a3b8', size: 3 + Math.random() * 3
      });
    }
  }

  function spawnMuzzle(x, y, aim, color) {
    for (var i = 0; i < 4; i++) {
      var a = aim + (Math.random() - 0.5) * 0.8;
      var sp = 150 + Math.random() * 200;
      addParticle({
        kind: 'puff', x: x + Math.cos(aim) * 14, y: y + Math.sin(aim) * 14,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.14 + Math.random() * 0.1, max: 0.24,
        color: color, size: 3 + Math.random() * 2.5
      });
    }
  }

  // 处理快照携带的新事件
  function processEvents(events) {
    if (!events) return;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.t === 'shot') spawnMuzzle(e.x, e.y, e.a, PAL[e.i].mid);
      else if (e.t === 'hit') {
        spawnImpact(e.x, e.y, PAL[e.j].mid);
        if (e.j === local && local != null) vignette = Math.min(1, vignette + 0.25);
        addParticle({
          kind: 'dmg', x: e.x, y: e.y - 20, vx: 0, vy: -30,
          life: 0.8, max: 0.8, color: PAL[e.j].text, text: '-' + e.dmg
        });
      } else if (e.t === 'hitWall') spawnWallPuff(e.x, e.y);
      else if (e.t === 'snipe') {
        // 秒杀箭出膛：更猛的蓝白火光 + 一条破空线
        spawnMuzzle(e.x, e.y, e.a, '#38bdf8');
        for (var sp0 = 0; sp0 < 6; sp0++) {
          var sa = e.a + (Math.random() - 0.5) * 0.3;
          addParticle({
            kind: 'spark', x: e.x, y: e.y,
            vx: Math.cos(sa) * 600, vy: Math.sin(sa) * 600,
            life: 0.12 + Math.random() * 0.1, max: 0.22,
            color: '#e0f2fe', size: 3 + Math.random() * 2
          });
        }
      } else if (e.t === 'snipeHit') {
        // 被秒杀箭击中：大爆炸 + 全屏强红光
        spawnImpact(e.x, e.y, '#ef4444');
        for (var sp2 = 0; sp2 < 14; sp2++) {
          var s2 = Math.random() * Math.PI * 2;
          var v2 = 200 + Math.random() * 380;
          addParticle({
            kind: 'spark', x: e.x, y: e.y,
            vx: Math.cos(s2) * v2, vy: Math.sin(s2) * v2,
            life: 0.4 + Math.random() * 0.3, max: 0.7,
            color: (sp2 % 2 ? '#fecaca' : '#fca5a5'), size: 4 + Math.random() * 4
          });
        }
        addParticle({ kind: 'dmg', x: e.x, y: e.y - 16, vx: 0, vy: -40, life: 1.0, max: 1.0, color: '#b91c1c', text: '一击必杀' });
        vignette = Math.min(1, vignette + 0.7);
      }
      else if (e.t === 'go') {
        // 之前的 ring 粒子在世界坐标中心叠加成大片绿色干扰，已移除
        // "开始!" 视觉由 DOM 层处理
      }
    }
  }

  function updateFx(dt) {
    for (var i = fx.length - 1; i >= 0; i--) {
      var p = fx[i];
      p.life -= dt;
      if (p.life <= 0) { fx.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= (1 - 3 * dt);
      p.vy *= (1 - 3 * dt);
    }
    vignette = Math.max(0, vignette - dt * 1.8);
    capParticles();
  }

  /* ============ 场景绘制 ============ */
  function frame(snap, local, dt) {
    // 关键：用 canvas 实际像素清屏，并先重置变换。
    // 之前用 cssW/cssH 清屏在 dpr>1 屏幕上只清掉一半，会留下残影导致"球拖尾/绿带"。
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);

    drawField(ctx);
    // 已去掉障碍物，不再调用 drawObstacles
    drawArrows(ctx, snap);
    drawBalls(ctx, snap);
    updateFx(dt);
    drawFx(ctx);
    drawLocalAim(ctx, snap, local);

    ctx.restore();

    // 受击红光：仅在自己球周围柔和的红色光圈，不再覆盖整屏
    if (vignette > 0.01 && local && local.role != null && snap.players[local.role]) {
      var me = snap.players[local.role];
      var sc = toScreen(me.x, me.y);
      var radius = Math.min(cssW, cssH) * 0.45;
      var g = ctx.createRadialGradient(sc.x, sc.y, radius * 0.2, sc.x, sc.y, radius);
      g.addColorStop(0, 'rgba(220,38,38,' + (vignette * 0.30).toFixed(3) + ')');
      g.addColorStop(0.45, 'rgba(220,38,38,' + (vignette * 0.10).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(220,38,38,0)');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function drawField(ctx) {
    var W = WORLD_W, H = WORLD_H;
    ctx.strokeStyle = '#dadbe0';
    ctx.lineWidth = 5;
    ctx.strokeRect(2.5, 2.5, W - 5, H - 5);

    ctx.setLineDash([14, 18]);
    ctx.strokeStyle = '#e9e9ec';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 130, 0, Math.PI * 2);
    ctx.strokeStyle = '#efeff1';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = '#dedfe3';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('球影对决', 18, 26);
  }

  function drawObstacles(ctx) {
    var obs = window.DuelEngine.C.OBSTACLES;
    for (var i = 0; i < obs.length; i++) {
      var o = obs[i];
      ctx.fillStyle = 'rgba(15,23,42,0.08)';
      ctx.beginPath();
      ctx.ellipse(o.x + o.r * 0.18, o.y + o.r * 0.3, o.r * 0.92, o.r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();

      var g = ctx.createRadialGradient(o.x - o.r * 0.35, o.y - o.r * 0.4, o.r * 0.1, o.x, o.y, o.r * 1.15);
      g.addColorStop(0, '#f8fafc');
      g.addColorStop(0.7, '#d6dbe1');
      g.addColorStop(1, '#aab2bd');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(71,85,105,0.55)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  function drawArrows(ctx, snap) {
    var arrows = snap.arrows;
    for (var i = 0; i < arrows.length; i++) {
      var a = arrows[i];
      var sp = Math.max(1, Math.sqrt(a.vx * a.vx + a.vy * a.vy));
      var dirx = a.vx / sp, diry = a.vy / sp;
      var perx = -diry, pery = dirx;
      var bx = a.x, by = a.y;

      // 右键秒杀箭：极快、发金红光、更长的一支“必杀箭”
      if (a.kill) {
        ctx.save();
        ctx.shadowColor = '#fbbf24';
        ctx.shadowBlur = 18;
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(bx - dirx * 90, by - diry * 90);
        ctx.lineTo(bx + dirx * 14, by + diry * 14);
        ctx.stroke();
        ctx.shadowBlur = 0;
        // 金色箭头
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.moveTo(bx + dirx * 22, by + diry * 22);
        ctx.lineTo(bx - dirx * 8 + perx * 7, by - diry * 8 + pery * 7);
        ctx.lineTo(bx - dirx * 8 - perx * 7, by - diry * 8 - pery * 7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        continue;
      }

      // 一支完整而细长的箭（世界坐标单位，屏幕会按视口放大，视觉更长更清晰）
      var SHAFT = 44;     // 箭身长
      var HEAD = 9;       // 尖端额外突出
      var TAIL = 4;       // 尾端收拢
      var width = 4;      // 箭身粗

      // 尖端（世界箭头中心前 HEAD）
      var tipX = bx + dirx * (SHAFT / 2 + HEAD);
      var tipY = by + diry * (SHAFT / 2 + HEAD);
      // 尾端
      var tailX = bx - dirx * (SHAFT / 2);
      var tailY = by - diry * (SHAFT / 2);

      // 细长黑色箭身
      ctx.strokeStyle = '#14141c';
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tipX - dirx * 3, tipY - diry * 3);
      ctx.lineTo(tailX + dirx * TAIL, tailY + diry * TAIL);
      ctx.stroke();

      // 头部金属尖（小三角）
      ctx.fillStyle = '#0b0b0f';
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - dirx * 10 + perx * 5, tipY - diry * 10 + pery * 5);
      ctx.lineTo(tipX - dirx * 10 - perx * 5, tipY - diry * 10 - pery * 5);
      ctx.closePath();
      ctx.fill();

      // 尾部小尾羽（低存在感，只向后收拢一点点，避免杂乱）
      ctx.fillStyle = 'rgba(15,23,42,0.8)';
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(tailX + dirx * 6 + perx * 4, tailY + diry * 6 + pery * 4);
      ctx.lineTo(tailX + dirx * 4, tailY + diry * 4);
      ctx.lineTo(tailX + dirx * 6 - perx * 4, tailY + diry * 6 - pery * 4);
      ctx.closePath();
      ctx.fill();

      // 细拖尾
      ctx.strokeStyle = 'rgba(15,23,42,0.10)';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tailX - dirx * 12, tailY - diry * 12);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
    }
  }

  function drawBalls(ctx, snap) {
    for (var i = 0; i < 2; i++) drawBall(ctx, snap.players[i], PAL[i]);
  }

  function drawBall(ctx, p, pal) {
    var x = p.x, y = p.y, r = BALL_R;
    // 冲刺拖尾：boostT > 0 时沿运动方向拖出速度线
    if (p.boostT && p.boostT > 0) {
      var spd = Math.hypot(p.vx, p.vy);
      if (spd > 40) {
        var vx = p.vx / spd, vy = p.vy / spd;
        var px = -vy, py = vx;
        var segs = 5;
        for (var s = 0; s < segs; s++) {
          var d = (s + 1) * 22 + (1 - p.boostT / (window.DuelEngine.C.BOOST_TIME || 0.45)) * 20;
          var sx = x - vx * d, sy = y - vy * d;
          var len = 10 + (segs - s) * 3;
          var wob = (s % 2 === 0 ? 1 : -1) * 6;
          ctx.strokeStyle = 'rgba(56,189,248,' + (0.55 * (1 - s / segs)).toFixed(2) + ')';
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(sx + px * wob, sy + py * wob);
          ctx.lineTo(sx - vx * len + px * wob, sy - vy * len + py * wob);
          ctx.stroke();
          ctx.lineCap = 'butt';
        }
      }
    }

    ctx.fillStyle = 'rgba(15,23,42,0.12)';
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.95, r * 1.05, r * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    var g = ctx.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.12, x, y, r * 1.05);
    g.addColorStop(0, pal.light);
    g.addColorStop(0.5, pal.mid);
    g.addColorStop(1, pal.dark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = pal.dark;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(x - r * 0.35, y - r * 0.45, r * 0.3, r * 0.17, -0.6, 0, Math.PI * 2);
    ctx.fill();

    var a = p.aim;
    var fxp = Math.cos(a), fyp = Math.sin(a);
    var pxp = -fyp, pyp = fxp;
    var ed = r * 0.42;
    var er = r * 0.22;
    for (var side = -1; side <= 1; side += 2) {
      var ex = x + fxp * ed + pxp * ed * 0.66 * side;
      var ey = y + fyp * ed + pyp * ed * 0.66 * side;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, er, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.arc(ex + fxp * er * 0.45, ey + fyp * er * 0.45, er * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }

    var trackR = r + 10;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.beginPath();
    ctx.arc(x, y, trackR, -Math.PI / 2, Math.PI * 1.5);
    ctx.stroke();

    var ratio = Math.max(0, Math.min(1, p.hp / ((window.DuelEngine.C.HP) || 100)));
    var hpColor = ratio > 0.5 ? '#22c55e' : (ratio > 0.25 ? '#eab308' : '#ef4444');
    ctx.strokeStyle = hpColor;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(x, y, trackR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  function drawFx(ctx) {
    for (var i = 0; i < fx.length; i++) {
      var p = fx[i];
      var k = Math.max(0, p.life / p.max);
      if (p.kind === 'spark' || p.kind === 'puff') {
        ctx.globalAlpha = k;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * k), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.kind === 'dmg') {
        ctx.globalAlpha = k;
        ctx.font = 'bold 26px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
        ctx.globalAlpha = 1;
      } else if (p.kind === 'slash') {
        // 秒杀箭破空短划：沿粒子方向的一条渐淡蓝线
        ctx.globalAlpha = k;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        var ux = Math.cos(p.aim), uy = Math.sin(p.aim);
        var len = 40 + 30 * (1 - k);
        ctx.beginPath();
        ctx.moveTo(p.x - ux * len, p.y - uy * len);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.globalAlpha = 1;
      } else if (p.kind === 'ring') {
        // 临时禁用：rAF 60Hz 下波纹会与累积 1.02 缩放叠加成大片绿色干扰
        // 改为一次性"开始!"横幅
      }
    }
  }

  function drawLocalAim(ctx, snap, local) {
    if (!local || local.role == null || !snap.players[local.role]) return;
    var me = snap.players[local.role];
    var w = local.aimWorld;
    if (!w) return;

    var dx = w.x - me.x, dy = w.y - me.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / dist, uy = dy / dist;
    var reach = Math.min(dist, 900);
    var tx = me.x + ux * reach, ty = me.y + uy * reach;

    ctx.setLineDash([8, 10]);
    ctx.strokeStyle = 'rgba(15,23,42,0.28)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(me.x + ux * (BALL_R + 8), me.y + uy * (BALL_R + 8));
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.setLineDash([]);

    var sc = toScreen(w.x, w.y);
    var pal = PAL[local.role];
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = pal.mid;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sc.x, sc.y, 16, 0, Math.PI * 2);
    ctx.moveTo(sc.x - 26, sc.y); ctx.lineTo(sc.x - 10, sc.y);
    ctx.moveTo(sc.x + 10, sc.y); ctx.lineTo(sc.x + 26, sc.y);
    ctx.moveTo(sc.x, sc.y - 26); ctx.lineTo(sc.x, sc.y - 10);
    ctx.moveTo(sc.x, sc.y + 10); ctx.lineTo(sc.x, sc.y + 26);
    ctx.stroke();
    ctx.restore();
  }

  var api = {
    attach: attach,
    resize: resize,
    toWorld: toWorld,
    frame: frame,
    processEvents: processEvents,
    // 本地即时开火反馈：按下瞬间在枪口冒火光，不必等服务器快照
    localMuzzle: function (x, y, aim, roleIdx) {
      spawnMuzzle(x, y, aim, PAL[roleIdx].mid);
      addParticle({
        kind: 'puff', x: x + Math.cos(aim) * 16, y: y + Math.sin(aim) * 16,
        vx: Math.cos(aim) * 320, vy: Math.sin(aim) * 320,
        life: 0.1, max: 0.1, color: '#f59e0b', size: 4
      });
    },
    // 本地右键秒杀箭反馈：画一道向前的蓝色破空短划
    localSnipeLine: function (x, y, aim) {
      addParticle({
        kind: 'slash', x: x, y: y, vx: Math.cos(aim) * 900, vy: Math.sin(aim) * 900,
        aim: aim, life: 0.16, max: 0.16, color: '#38bdf8', size: 0
      });
    },
    pal: PAL
  };

  if (typeof window !== 'undefined') window.Renderer = api;
})();
