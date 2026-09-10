/*
 * 球影对决 - 权威游戏引擎（无依赖）
 * 同时被 Node 服务端(require) 与 浏览器(<script>) 加载，
 * 保证联机时两台电脑上的物理/回合逻辑完全一致。
 */
(function () {
  'use strict';

  var C = {
    W: 1800,             // 场地宽（比之前 1500 更宽，给玩家更多横向空间）
    H: 1000,             // 场地高
    BALL_R: 21,          // 球体半径（体型减半）
    SPEED: 480,          // 玩家移动速度
    ACCEL: 3000,         // 加速度（越灵敏）
    BOOST_MULT: 2.2,     // 冲刺速度倍率（漂移感）
    BOOST_TIME: 0.45,    // 冲刺持续时间（秒，短暂）
    BOOST_CD: 3,         // 冲刺冷却（秒）
    HP: 90,              // 满血 = 5 发箭伤害（18×5，五箭即死）
    DMG: 18,             // 每支箭伤害
    ARROW_SPEED: 840,    // 普通箭速
    ARROW_R: 6,          // 普通箭命中半径
    FIRE_CD: 0.11,       // 连续射击间隔（射速加快，开局抢射更跟手）
    QUIVER: 5,           // 箭壶容量：5 发
    RELOAD_DELAY: 2,     // 一次性装弹耗时（秒）
    RELOAD: 0.55,        // 每 0.55s 补充一支箭（旧逻辑，保留但不再使用）
    // —— 右键秒杀箭（一发致死）——
    SNIPE: {
      enabled: true,     // 是否启用右键秒杀箭
      SPEED: 1500,       // 极快箭速
      R: 7,              // 命中半径
      CD: 3              // 秒杀箭冷却（秒），防止滥用
    },
    WIN_SCORE: 5,        // 先得 5 分获胜
    COUNTDOWN: 3,        // 开局倒计时
    ROUND_END: 2.6,      // 回合结束展示时间
    MATCH_END: 7,        // 比赛结束展示时间
    OBSTACLES: []        // 已移除障碍物
  };

  function newPlayer() {
    return {
      x: 0, y: 0, vx: 0, vy: 0,
      hp: C.HP,
      aim: 0,
      quiver: C.QUIVER,
      fireCd: 0,
      reload: 0,        // 装弹进度（秒）
      reloading: false, // 是否正在一次性装弹
      boostT: 0,        // 冲刺剩余时间
      boostCd: 0,       // 冲刺冷却剩余
      snipeCd: 0,       // 秒杀箭冷却剩余
      flash: 0, // 受击闪烁计时
      ctrl: { dx: 0, dy: 0, aim: 0, fire: false, boost: false, snipe: false }
    };
  }

  function createGame() {
    var g = {
      phase: 'countdown',
      phaseT: C.COUNTDOWN,
      round: 1,
      players: [newPlayer(), newPlayer()],
      arrows: [],
      arrowId: 1,
      scores: [0, 0],
      winner: -1,          // 回合/比赛胜者 0|1，平局 -1
      events: []
    };
    placeRound(g);
    return g;
  }

  function placeRound(g) {
    var off = (Math.random() - 0.5) * 160;
    g.phase = 'countdown';
    g.phaseT = C.COUNTDOWN;
    g.winner = -1;
    g.arrows.length = 0;
    var p1 = g.players[0], p2 = g.players[1];

    p1.x = C.W * 0.18; p1.y = C.H * 0.5 + off; p1.vx = 0; p1.vy = 0;
    p1.hp = C.HP; p1.aim = 0; p1.quiver = C.QUIVER; p1.fireCd = 0; p1.reload = 0; p1.flash = 0;
    p1.reloading = false; // 关键：清掉上一局遗留的装弹状态
    p1.boostT = 0; p1.boostCd = 0; p1.snipeCd = 0;
    p2.x = C.W * 0.82; p2.y = C.H * 0.5 - off; p2.vx = 0; p2.vy = 0;
    p2.hp = C.HP; p2.aim = Math.PI; p2.quiver = C.QUIVER; p2.fireCd = 0; p2.reload = 0; p2.flash = 0;
    p2.reloading = false;
    p2.boostT = 0; p2.boostCd = 0; p2.snipeCd = 0;

    g.events.push({ t: 'roundStart', round: g.round });
  }

  // —— 基础向量辅助 ——
  function approach(cur, target, maxDelta) {
    if (cur < target) return Math.min(cur + maxDelta, target);
    return Math.max(cur - maxDelta, target);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // —— 更新 ——
  function update(g, rawDt) {
    var dt = Math.min(rawDt || 0, 0.05);
    if (dt <= 0) return;

    if (g.phase === 'countdown') {
      g.phaseT -= dt;
      for (var i = 0; i < 2; i++) {
        var p = g.players[i];
        p.aim = p.ctrl.aim; // 倒计时可以调整瞄准
        p.flash = Math.max(0, p.flash - dt);
      }
      var pre = Math.ceil(g.phaseT);
      if (pre <= 0) {
        g.phase = 'playing';
        g.events.push({ t: 'go' });
      }
      return;
    }

    if (g.phase === 'playing') {
      simulate(g, dt);

      // 检查回合结束
      var dead = [];
      if (g.players[0].hp <= 0) dead.push(0);
      if (g.players[1].hp <= 0) dead.push(1);
      if (dead.length > 0) {
        var wi = -1;
        if (dead.length === 1) wi = dead[0] === 0 ? 1 : 0;
        else {
          // 同时阵亡 -> 判平
          wi = -1;
        }
        g.winner = wi;
        if (wi >= 0) g.scores[wi] += 1;
        g.events.push({ t: 'roundOver', winner: wi, scores: g.scores.slice() });
        g.phase = 'roundEnd';
        g.phaseT = C.ROUND_END;
        g.round += 1;
      }
      return;
    }

    if (g.phase === 'roundEnd') {
      g.phaseT -= dt;
      var need = Math.ceil(g.phaseT);
      if (need <= 0) {
        var mw = g.scores[0] >= C.WIN_SCORE ? 0 : (g.scores[1] >= C.WIN_SCORE ? 1 : -1);
        if (mw >= 0) {
          g.winner = mw;
          g.phase = 'matchEnd';
          g.phaseT = C.MATCH_END;
          g.events.push({ t: 'matchOver', winner: mw, scores: g.scores.slice() });
        } else {
          placeRound(g);
        }
      }
      return;
    }

    if (g.phase === 'matchEnd') {
      g.phaseT -= dt;
      if (Math.ceil(g.phaseT) <= 0) {
        g.scores = [0, 0];
        g.round = 1;
        placeRound(g);
      }
      return;
    }
  }

  function simulate(g, dt) {
    var players = g.players;
    var i, j;

    // 1) 射击冷却 / 一次性装弹 / 冲刺 / 开火
    for (i = 0; i < 2; i++) {
      var p = players[i];
      p.fireCd = Math.max(0, p.fireCd - dt);
      p.flash = Math.max(0, p.flash - dt);
      p.aim = p.ctrl.aim;
      p.snipeCd = Math.max(0, p.snipeCd - dt);

      // 右键秒杀箭：一发即死（独立于箭壶/装弹），单次触发 + 冷却
      if (p.ctrl.snipe) {
        p.ctrl.snipe = false; // 单次触发
        if (C.SNIPE.enabled && p.snipeCd <= 0) {
          fireSnipe(g, i);
          p.snipeCd = C.SNIPE.CD;
        }
      }

      // 冲刺：冷却递减、加速持续计时；按下且可用时触发并瞬间提速（漂移感）
      p.boostCd = Math.max(0, p.boostCd - dt);
      p.boostT = Math.max(0, p.boostT - dt);
      if (p.ctrl.boost) {
        p.ctrl.boost = false; // 单次触发，防止长按无限冲刺
        if (p.boostCd <= 0 && p.boostT <= 0) {
          p.boostT = C.BOOST_TIME;
          p.boostCd = C.BOOST_CD;
          // 沿输入方向/当前速度方向/瞄准方向瞬间提速
          var bdx = p.ctrl.dx, bdy = p.ctrl.dy;
          var blen = Math.hypot(bdx, bdy);
          if (blen < 0.01) {
            var s0 = Math.hypot(p.vx, p.vy);
            if (s0 > 20) { bdx = p.vx / s0; bdy = p.vy / s0; }
            else { bdx = Math.cos(p.aim); bdy = Math.sin(p.aim); }
          }
          var bm = C.SPEED * C.BOOST_MULT;
          p.vx = bdx * bm;
          p.vy = bdy * bm;
          g.events.push({ t: 'boost', i: i });
        }
      }

      // 箭头打空后进入装弹；装弹期间不能射击，2 秒后一次性补满
      if (p.reloading) {
        p.reload += dt;
        if (p.reload >= C.RELOAD_DELAY) {
          p.quiver = C.QUIVER;
          p.reload = 0;
          p.reloading = false;
        }
      } else if (p.quiver <= 0) {
        p.reloading = true;
        p.reload = 0;
      }

      if (!p.reloading && p.ctrl.fire && p.fireCd <= 0 && p.quiver > 0) {
        fireArrow(g, i);
      }
    }

    // 2) 玩家移动（带惯性；冲刺期间速度乘倍率）
    for (i = 0; i < 2; i++) {
      var pl = players[i];
      var mult = pl.boostT > 0 ? C.BOOST_MULT : 1;
      var targetVX = pl.ctrl.dx * C.SPEED * mult;
      var targetVY = pl.ctrl.dy * C.SPEED * mult;
      pl.vx = approach(pl.vx, targetVX, C.ACCEL * dt);
      pl.vy = approach(pl.vy, targetVY, C.ACCEL * dt);
      pl.x += pl.vx * dt;
      pl.y += pl.vy * dt;
      boundPlayer(pl);
    }

    // 3) 玩家之间 / 玩家与遮挡物的碰撞（推开）
    resolveBodyCollisions(g);

    // 4) 箭移动 + 命中检测
    updateArrows(g, dt);
  }

  function fireArrow(g, ownerIdx) {
    var p = g.players[ownerIdx];
    var a = p.aim;
    var off = C.BALL_R + 14; // 球小，箭从贴近球缘发出
    var sx = p.x + Math.cos(a) * off;
    var sy = p.y + Math.sin(a) * off;
    g.arrows.push({
      id: g.arrowId++,
      x: sx, y: sy,
      vx: Math.cos(a) * C.ARROW_SPEED,
      vy: Math.sin(a) * C.ARROW_SPEED,
      owner: ownerIdx,
      r: C.ARROW_R,
      kill: false
    });
    p.quiver -= 1;
    p.fireCd = C.FIRE_CD;
    p.reload = 0;
    g.events.push({ t: 'shot', i: ownerIdx, x: sx, y: sy, a: a });
  }

  // 右键秒杀箭：极快、冷却长、一发命中即击倒
  function fireSnipe(g, ownerIdx) {
    var p = g.players[ownerIdx];
    var a = p.aim;
    var off = C.BALL_R + 14;
    var sx = p.x + Math.cos(a) * off;
    var sy = p.y + Math.sin(a) * off;
    g.arrows.push({
      id: g.arrowId++,
      x: sx, y: sy,
      vx: Math.cos(a) * C.SNIPE.SPEED,
      vy: Math.sin(a) * C.SNIPE.SPEED,
      owner: ownerIdx,
      r: C.SNIPE.R,
      kill: true, // 命中直接致死
      snipe: true
    });
    p.fireCd = Math.max(p.fireCd, 0.25);
    g.events.push({ t: 'snipe', i: ownerIdx, x: sx, y: sy, a: a });
  }

  function boundPlayer(p) {
    var r = C.BALL_R;
    if (p.x < r) { p.x = r; p.vx = Math.abs(p.vx) * 0.3; }
    if (p.x > C.W - r) { p.x = C.W - r; p.vx = -Math.abs(p.vx) * 0.3; }
    if (p.y < r) { p.y = r; p.vy = Math.abs(p.vy) * 0.3; }
    if (p.y > C.H - r) { p.y = C.H - r; p.vy = -Math.abs(p.vy) * 0.3; }
  }

  function resolveBodyCollisions(g) {
    var i;
    // 玩家 vs 玩家
    var a = g.players[0], b = g.players[1];
    var dx = b.x - a.x, dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var minD = C.BALL_R * 2;
    if (dist > 0 && dist < minD) {
      var nx = dx / dist, ny = dy / dist;
      var overlap = minD - dist;
      a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
      b.x += nx * overlap / 2; b.y += ny * overlap / 2;
      // 沿法向的相对速度做柔软反弹
      var rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel < 0) {
        var imp = -rel * 0.4;
        a.vx -= nx * imp; a.vy -= ny * imp;
        b.vx += nx * imp; b.vy += ny * imp;
      }
    }
    // （无障碍物，不再检测）
  }

  function updateArrows(g, dt) {
    var out = [];
    for (var i = 0; i < g.arrows.length; i++) {
      var ar = g.arrows[i];
      ar.x += ar.vx * dt;
      ar.y += ar.vy * dt;

      var removed = false;

      // 场地边界
      if (ar.x < 0 || ar.x > C.W || ar.y < 0 || ar.y > C.H) {
        g.events.push({ t: 'hitWall', x: ar.x, y: ar.y, owner: ar.owner });
        removed = true;
      }

      // （无障碍物）

      // 命中玩家（不能命中自己）
      if (!removed) {
        for (var j = 0; j < 2; j++) {
          if (j === ar.owner) continue;
          var p = g.players[j];
          var pdx = ar.x - p.x, pdy = ar.y - p.y;
          var pr = C.BALL_R + ar.r;
          if (pdx * pdx + pdy * pdy < pr * pr) {
            if (ar.kill) {
              p.hp = 0; // 秒杀箭：一发致死
              g.events.push({ t: 'snipeHit', j: j, x: ar.x, y: ar.y, sniper: ar.owner });
            } else {
              p.hp = Math.max(0, p.hp - C.DMG);
              g.events.push({ t: 'hit', j: j, x: ar.x, y: ar.y, dmg: C.DMG, hp: p.hp });
            }
            p.flash = 0.35;
            removed = true;
            break;
          }
        }
      }

      if (!removed) out.push(ar);
    }
    g.arrows = out;
  }

  // —— 每 tick 生成给客户端的快照（并取走事件） ——
  function snapshot(g) {
    return {
      w: C.W, h: C.H,
      phase: g.phase,
      phaseT: g.phaseT,
      round: g.round,
      winner: g.winner,
      scores: g.scores.slice(),
      players: g.players.map(function (p) {
        return {
          x: p.x, y: p.y, vx: p.vx, vy: p.vy,
          hp: p.hp, aim: p.aim, quiver: p.quiver, fireCd: p.fireCd,
          reloading: p.reloading,
          reloadT: p.reloading ? Math.max(0, C.RELOAD_DELAY - p.reload) : 0,
          boostT: p.boostT, boostCd: p.boostCd,
          snipeCd: p.snipeCd
        };
      }),
      arrows: g.arrows.map(function (ar) {
        return { x: ar.x, y: ar.y, vx: ar.vx, vy: ar.vy, owner: ar.owner, id: ar.id, kill: !!ar.kill };
      }),
      events: g.events.splice(0, g.events.length)
    };
  }

  function setCtrl(g, idx, ctrl) {
    g.players[idx].ctrl = ctrl;
  }

  var api = { C: C, createGame: createGame, update: update, snapshot: snapshot, setCtrl: setCtrl };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DuelEngine = api;
})();
