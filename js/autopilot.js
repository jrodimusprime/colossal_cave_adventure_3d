'use strict';
// ---------------------------------------------------------------------------
// Autopilot: an AI that plays the game by itself at 5x speed.
//
// It walks with the same controls a player has (forward key + turning) and
// acts through the same typed commands (TAKE, DOWN, DEPOSIT, FILL, SAY...),
// which are echoed into the log just as if someone were at the keyboard.
//
// Each decision cycle it picks the most important goal:
//   survive (refuel / eat / fight)  >  fetch its axe  >  go home when the
//   pack is full or the lamp is low  >  pick up nearby items  >  go deeper
//   once a level has been explored a bit  >  explore unvisited rooms.
// Paths are found with A* over the cave grid.
// ---------------------------------------------------------------------------

const AI_SPEED = 5;
const AI = {
  on: false, goal: null, path: null, pi: 0, level: -1, stack: [], unreachable: new Set(),
  thinkT: 0, stuckT: 0, stuckN: 0, lastX: 0, lastZ: 0, deadT: 0, chatT: 40, aimT: 0, jumpT: 0,
  returning: false, wantDown: 4, status: '', waitT: 0, homeOnly: false, tempBlock: new Set(),
};

function startAutopilot(home) {
  AI.on = true;
  AI.homeOnly = !!home;
  AI.goal = null; AI.path = null; AI.stack = []; AI.unreachable.clear(); AI.level = -1; AI.returning = false;
  AI.returning = !!home;
  AI.chatT = 40; AI.status = home ? 'working out the way home' : 'looking around';
  for (const k in keys) keys[k] = false;
  closeConsole();
  document.exitPointerLock && document.pointerLockElement && document.exitPointerLock();
  log(home ? '[Autopilot: taking you home to camp at ' + AI_SPEED + 'x speed. Press any key to take back control.]'
    : '[The autopilot takes over at ' + AI_SPEED + 'x speed. Press any key to take back control.]', 'cmd');
}
function stopAutopilot() {
  if (!AI.on) return;
  AI.on = false; AI.homeOnly = false;
  for (const k in keys) keys[k] = false;
}

// ---- helpers ---------------------------------------------------------------
function aiSay(cmd) { runCommand(cmd); }
function wrapAng(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
function aiMove(on, run) { keys.KeyW = !!on; keys.ShiftLeft = !!run; }
function countInv(kind) { return S.inv.filter(i => i.kind === kind).length; }

// Cells a player-sized body can't stand in because of stalagmites, columns,
// rocks, mushrooms or standing stones (including ones from neighbouring
// chunks), plus a "near" set of cells that are passable but tight.
function colliderBlock(ch) {
  if (!ch._cblock) {
    ch._cblock = new Set(); ch._cnear = new Set();
    const x0 = ch.cx * CHUNK, z0 = ch.cz * CHUNK;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      for (const c of getChunk(ch.cx + dx, ch.cz + dz, ch.L).colliders) {
        const hard = c.r + RADIUS + 0.3, soft = c.r + 1.9;
        for (let gz = Math.floor((c.z - soft) / CELL); gz <= Math.floor((c.z + soft) / CELL); gz++) {
          for (let gx = Math.floor((c.x - soft) / CELL); gx <= Math.floor((c.x + soft) / CELL); gx++) {
            if (gx < x0 || gz < z0 || gx >= x0 + CHUNK || gz >= z0 + CHUNK) continue;
            const d = Math.hypot((gx + 0.5) * CELL - c.x, (gz + 0.5) * CELL - c.z);
            const idx = (gz - z0) * CHUNK + (gx - x0);
            if (d < hard) ch._cblock.add(idx); else if (d < soft) ch._cnear.add(idx);
          }
        }
      }
    }
  }
  return ch._cblock;
}
function nearCollider(ch, idx) { colliderBlock(ch); return ch._cnear.has(idx); }
let aiCols = [];
function gatherColliders() {
  aiCols = [];
  for (const e of loaded.values()) for (const c of e.ch.colliders) if (Math.hypot(c.x - S.x, c.z - S.z) < 40) aiCols.push(c);
}
// floor height if the cell can be walked on by the AI, otherwise null
function aiFloor(L, gx, gz) {
  const ch = chunkAtGrid(L, gx, gz), idx = localIdx(ch, gx, gz);
  if (puzzleKind(ch, idx) !== 1 || (ch.flags[idx] & F_LAVA) || puzzleBlocked(ch, idx)) return null;
  if (colliderBlock(ch).has(idx)) return null;
  if (AI.tempBlock.size && AI.tempBlock.has(gx + ',' + gz)) return null;
  if (ch.kind[idx] === 2) return ch.pbridge.get(idx).y;   // a bridged gap
  return ch.floor[idx];
}

// ---- A* over the cell grid ---------------------------------------------------
class MinHeap {
  constructor() { this.f = []; this.v = []; }
  get size() { return this.f.length; }
  push(f, v) {
    const F = this.f, V = this.v; let i = F.length; F.push(f); V.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (F[p] <= f) break; F[i] = F[p]; V[i] = V[p]; i = p; }
    F[i] = f; V[i] = v;
  }
  pop() {
    const F = this.f, V = this.v, top = V[0], lf = F.pop(), lv = V.pop(), n = F.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && F[c + 1] < F[c]) c++;
        if (F[c] >= lf) break;
        F[i] = F[c]; V[i] = V[c]; i = c;
      }
      F[i] = lf; V[i] = lv;
    }
    return top;
  }
}
const OFF = 1 << 20, KM = 1 << 21;
function findPath(L, sx, sz, tx, tz, arriveCells, maxNodes) {
  const sgx = Math.floor(sx / CELL), sgz = Math.floor(sz / CELL), tgx = Math.floor(tx / CELL), tgz = Math.floor(tz / CELL);
  const key = (x, z) => (x + OFF) * KM + (z + OFF);
  const h = (x, z) => { const dx = Math.abs(x - tgx), dz = Math.abs(z - tgz); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
  const g = new Map(), came = new Map(), closed = new Set(), heap = new MinHeap();
  const sk = key(sgx, sgz);
  g.set(sk, 0); heap.push(h(sgx, sgz), [sgx, sgz]);
  let n = 0;
  while (heap.size) {
    const [x, z] = heap.pop(), k = key(x, z);
    if (closed.has(k)) continue;
    closed.add(k);
    if (h(x, z) <= arriveCells) {
      const out = [];
      let ck = k, cx = x, cz = z;
      while (ck !== sk) { out.push([(cx + 0.5) * CELL, (cz + 0.5) * CELL]); const p = came.get(ck); cx = p[0]; cz = p[1]; ck = key(cx, cz); }
      return out.reverse();
    }
    if (++n > maxNodes) return null;
    const f0 = k === sk ? S.y : aiFloor(L, x, z);
    const gk = g.get(k);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = x + dx, nz = z + dz, nk = key(nx, nz);
      if (closed.has(nk)) continue;
      const f1 = aiFloor(L, nx, nz);
      if (f1 === null || f1 - f0 > 1.15) continue;
      if (dx && dz && (aiFloor(L, x + dx, z) === null || aiFloor(L, x, z + dz) === null)) continue;
      const ch = chunkAtGrid(L, nx, nz), li = localIdx(ch, nx, nz), wet = ch.flags[li] & F_LIQUID;
      const cost = gk + (dx && dz ? 1.414 : 1) + (wet ? 1.5 : 0) + (nearCollider(ch, li) ? 1.5 : 0);
      if (cost >= (g.get(nk) ?? 1e9)) continue;
      g.set(nk, cost); came.set(nk, [x, z]);
      heap.push(cost + h(nx, nz), [nx, nz]);
    }
  }
  return null;
}
// can the AI walk straight from a to b (used to smooth paths)?
function clearWalk(L, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz);
  if (d < 0.01) return true;
  for (const c of aiCols) {
    const t = clamp(((c.x - ax) * dx + (c.z - az) * dz) / (d * d), 0, 1);
    if (Math.hypot(ax + dx * t - c.x, az + dz * t - c.z) < c.r + RADIUS + 0.2) return false;
  }
  const px = -dz / d * 0.45, pz = dx / d * 0.45;
  const n = Math.ceil(d / 0.5);
  let prev = S.y;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    for (const s of [-1, 0, 1]) {
      const x = ax + dx * t + px * s, z = az + dz * t + pz * s;
      const f = aiFloor(L, Math.floor(x / CELL), Math.floor(z / CELL));
      if (f === null) return false;
      if (s === 0) { if (f - prev > 1.15) return false; prev = f; }
    }
  }
  return true;
}

// ---- goals -----------------------------------------------------------------
function itemWanted(it) {
  if (S.inv.length >= MAX_INV) return false;
  if (it.kind === 'treasure') return true;
  if (it.kind === 'oil') return countInv('oil') < 2;
  if (it.kind === 'food') return countInv('food') < 2;
  if (it.kind === 'axe') return countInv('axe') < 1;
  if (it.kind === 'key') return countInv('key') < 1;
  if (it.kind === 'planks') return countInv('planks') < 1;
  return false;
}
function nearestItem(pred, range) {
  let best = null, bd = range;
  for (const it of itemsHere()) {
    if (AI.unreachable.has('item:' + it.id + ':' + Math.round(it.x) + ':' + Math.round(it.z)) || !pred(it)) continue;
    if (Math.abs(it.y - S.y) > 6) continue;
    const d = Math.hypot(it.x - S.x, it.z - S.z);
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}
function itemGoal(it) {
  const word = it.name.split(' ').pop();
  return { id: 'item:' + it.id + ':' + Math.round(it.x) + ':' + Math.round(it.z), x: it.x, z: it.z, arrive: 2.0, cells: 1.0,
    label: 'fetching the ' + it.name, act: () => aiSay('take ' + word) };
}
function nearbyFeatures(type, radius = 2) {
  const CW = CELL * CHUNK, pcx = Math.floor(S.x / CW), pcz = Math.floor(S.z / CW), out = [];
  for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
    for (const f of getChunk(pcx + dx, pcz + dz, S.level).features) if (f.type === type) out.push(f);
  }
  return out.sort((a, b) => Math.hypot(a.x - S.x, a.z - S.z) - Math.hypot(b.x - S.x, b.z - S.z));
}
function ropeGoal(f, dir) {
  return { id: 'rope' + dir + ':' + Math.round(f.x) + ':' + Math.round(f.z), x: f.x, z: f.z, arrive: 2.7, cells: dir === 'down' ? 1.0 : 0.5,
    label: dir === 'down' ? 'heading for a rope down to level ' + (S.level + 1) : 'climbing back towards camp',
    act: () => {
      if (dir === 'down') AI.stack.push({ L: S.level, x: f.x, z: f.z });
      else AI.stack.pop();
      aiSay(dir);
    } };
}
function campFeature(type) { return getChunk(0, 0, 0).features.find(f => f.type === type); }
function campGoal() {
  if (S.level === 0) {
    const trunk = campFeature('trunk'), barrel = campFeature('barrel'), fire = campFeature('fire');
    if (S.inv.some(i => i.kind === 'treasure'))
      return { id: 'trunk', x: trunk.x, z: trunk.z, arrive: 2.4, cells: 1.5, label: 'taking the loot home to the trunk', act: () => aiSay('deposit') };
    if (S.fuel < (S.closing || AI.homeOnly ? 60 : 95))
      return { id: 'barrel', x: barrel.x, z: barrel.z, arrive: 2.4, cells: 1.5, label: 'refilling the lamp at camp', act: () => aiSay('fill') };
    if (S.health < 92)
      return { id: 'fire', x: fire.x, z: fire.z, arrive: 3.2, cells: 1.8, label: 'resting by the fire', act: () => { AI.waitT = 2; }, stay: true };
    if (!atCamp())
      return { id: 'camp', x: fire.x, z: fire.z, arrive: 6, cells: 2, label: 'walking back to camp', act: () => {} };
    AI.returning = false;
    return null;
  }
  for (const w in S.runes) {
    const r = S.runes[w];
    if (r.L === S.level && Math.hypot(r.x - S.x, r.z - S.z) < 90)
      return { id: 'rune:' + w, x: r.x, z: r.z, arrive: 4, cells: 1.6, label: 'heading for the ' + w + ' stone to magic home', act: () => { AI.stack = []; aiSay('say ' + w); } };
  }
  const top = AI.stack[AI.stack.length - 1];
  if (top && top.L === S.level - 1) return ropeGoal(top, 'up');
  const ups = nearbyFeatures('ropeUp');
  for (const f of ups) if (!AI.unreachable.has('ropeup:' + Math.round(f.x) + ':' + Math.round(f.z))) return ropeGoal(f, 'up');
  return null;
}
function puzzleGoal() {
  const need = { gate: 'key', mole: 'food', gap: 'planks' }, cmd = { gate: 'unlock gate', mole: 'feed mole', gap: 'bridge gap' };
  for (const e of loaded.values()) for (const p of e.ch.puzzles) {
    if (!need[p.type] || S.solved.has(p.id) || !countInv(need[p.type])) continue;
    const id = 'puzzle:' + p.id;
    if (AI.unreachable.has(id) || Math.hypot(p.fx - S.x, p.fz - S.z) > 45) continue;
    return { id, x: p.fx - p.dir[0] * 0.4, z: p.fz - p.dir[1] * 0.4, arrive: 1.4, cells: 0.5,
      label: { gate: 'unlocking an iron gate', mole: 'feeding a hungry mole', gap: 'bridging a gap' }[p.type], act: () => aiSay(cmd[p.type]) };
  }
  return null;
}
function visitedOnLevel() {
  const p = S.level + ':';
  let n = 0;
  for (const k of S.visited) if (k.startsWith(p)) n++;
  return n;
}
function roomGoal() {
  const CW = CELL * CHUNK, pcx = Math.floor(S.x / CW), pcz = Math.floor(S.z / CW);
  let best = null, bd = 1e9;
  for (let r = 0; r <= 3 && !best; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const ch = getChunk(pcx + dx, pcz + dz, S.level);
      ch.rooms.forEach((room, ri) => {
        const key = S.level + ':' + ch.cx + ':' + ch.cz + ':' + ri;
        if (S.visited.has(key) || AI.unreachable.has('room:' + key) || !room.cells.length) return;
        let cell = room.cells[0], cd = 1e9;
        for (const idx of room.cells) {
          const d = Math.hypot(idx % CHUNK + 0.5 - room.x, Math.floor(idx / CHUNK) + 0.5 - room.z);
          if (d < cd) { cd = d; cell = idx; }
        }
        const x = (ch.cx * CHUNK + cell % CHUNK + 0.5) * CELL, z = (ch.cz * CHUNK + Math.floor(cell / CHUNK) + 0.5) * CELL;
        const d = Math.hypot(x - S.x, z - S.z);
        if (d < bd) { bd = d; best = { id: 'room:' + key, x, z, arrive: 2.2, cells: 0.8, label: 'exploring ' + room.name, act: () => {} }; }
      });
    }
  }
  return best;
}
function wanderGoal() {
  const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 30;
  const p = findOpenNear(S.level, S.x + Math.cos(a) * d, S.z + Math.sin(a) * d);
  return { id: 'wander:' + Math.round(p[0]) + ':' + Math.round(p[1]), x: p[0], z: p[1], arrive: 2.5, cells: 1, label: 'wandering into the unknown', act: () => {} };
}

function chooseGoal() {
  if (S.closing) {
    AI.returning = true;
    const g = campGoal();
    if (g) { g.label = 'racing home before the cave closes: ' + g.label; return g; }
    return { id: 'wait', x: S.x, z: S.z, arrive: 99, cells: 0, label: 'waiting safely at camp for the last bell', act: () => { AI.waitT = 3; }, stay: true };
  }
  if (AI.homeOnly) {
    const g = campGoal();
    if (g) { g.label = 'going home: ' + g.label; return g; }
    stopAutopilot();
    log('[Autopilot: you are home safe at camp. Over to you.]', 'cmd');
    return null;
  }
  const treasures = countInv('treasure');
  const needHome = S.inv.length >= MAX_INV || treasures >= 4 || (S.fuel < 40 && !countInv('oil')) ||
    (S.health < 40 && !countInv('food'));
  if (!countInv('axe')) { const ax = nearestItem(it => it.kind === 'axe', 40); if (ax) return itemGoal(ax); }
  if (needHome) AI.returning = true;
  if (AI.returning) { const g = campGoal(); if (g) return g; }
  // at camp with nothing left to do: use a magic word to jump back deep down
  if (S.level === 0 && atCamp() && !AI.returning) {
    let deep = null;
    for (const w in S.runes) if (S.runes[w].L >= 1 && (!deep || S.runes[w].L > S.runes[deep].L)) deep = w;
    if (deep && S.fuel > 90) return { id: 'sayat:' + deep, x: S.x, z: S.z, arrive: 99, cells: 0, label: 'saying a magic word to return to level ' + S.runes[deep].L, act: () => { AI.stack = []; aiSay('say ' + deep); } };
  }
  const it = nearestItem(itemWanted, 30);
  if (it) return itemGoal(it);
  const pg = puzzleGoal();
  if (pg) return pg;
  if (visitedOnLevel() >= AI.wantDown && S.fuel > 50 && S.inv.length < MAX_INV - 1) {
    for (const f of nearbyFeatures('ropeDown')) if (!AI.unreachable.has('ropedown:' + Math.round(f.x) + ':' + Math.round(f.z))) return ropeGoal(f, 'down');
  }
  const rg = roomGoal();
  if (rg) return rg;
  for (const f of nearbyFeatures('ropeDown')) if (!AI.unreachable.has('ropedown:' + Math.round(f.x) + ':' + Math.round(f.z))) return ropeGoal(f, 'down');
  return wanderGoal();
}
function setGoal(g) { AI.goal = g; AI.path = null; AI.pi = 0; AI.stuckN = 0; AI.tempBlock.clear(); if (g) AI.status = g.label; }
function giveUp() {
  if (AI.goal) AI.unreachable.add(AI.goal.id);
  setGoal(null);
}

// ---- combat ----------------------------------------------------------------
function aiCombat(dt) {
  if (!countInv('axe')) return false;
  let best = null, bd = 19;
  for (const c of creatures) {
    const d = Math.hypot(c.x - S.x, c.z - S.z);
    if (d < bd && los(S.level, S.x, S.y + 1.5, S.z, c.x, c.y + 1, c.z)) { bd = d; best = c; }
  }
  if (!best) { AI.aimT = 0; return false; }
  aiMove(false);
  AI.status = 'fighting a ' + (best.type === 'shade' ? 'shade' : 'gloomkin');
  const want = Math.atan2(-(best.x - S.x), -(best.z - S.z)), da = wrapAng(want - S.yaw);
  S.yaw += clamp(da, -8 * dt, 8 * dt);
  const t = bd / 21, dy = (best.y + 0.8) - (S.y + 1.45) + 4.5 * t * t - 0.8 * t;
  S.pitch = Math.atan2(dy, bd);
  if (Math.abs(da) < 0.06) {
    AI.aimT += dt;
    if (AI.aimT > 0.2) { AI.aimT = 0; aiSay('throw axe'); setGoal(null); }
  }
  return true;
}

// ---- main step (called AI_SPEED times per frame) -----------------------------
function aiStep(dt) {
  if (!AI.on) return;
  if (mode === 'dead') {
    AI.deadT += dt;
    if (AI.deadT > 2.5) { AI.deadT = 0; AI.stack = []; AI.returning = false; setGoal(null); reincarnate(); }
    return;
  }
  if (mode === 'over') { stopAutopilot(); return; }
  if (mode !== 'play' || pending) { aiMove(false); return; }
  if (AI.level !== S.level) {
    AI.level = S.level; setGoal(null); AI.unreachable.clear();
    AI.wantDown = 3 + Math.floor(Math.random() * 4);
  }
  keys.Space = false;
  // housekeeping, like a careful player
  if (S.fuel < 30 && countInv('oil')) { aiSay('fill'); return; }
  if (!S.lampOn && S.fuel > 0) { aiSay('lamp on'); return; }
  if (S.health < 45 && countInv('food')) { aiSay('eat'); return; }
  AI.chatT -= dt;
  if (AI.chatT <= 0 && !AI.homeOnly) { AI.chatT = 60 + Math.random() * 60; aiSay(['score', 'inventory', 'look'][Math.floor(Math.random() * 3)]); }
  gatherColliders();
  if (aiCombat(dt)) return;
  if (AI.waitT > 0) { AI.waitT -= dt; aiMove(false); return; }

  AI.thinkT -= dt;
  if (!AI.goal || AI.thinkT <= 0) {
    AI.thinkT = 2;
    const g = chooseGoal();
    if (!AI.on) { aiMove(false); return; }
    if (!AI.goal || !g || g.id !== AI.goal.id) setGoal(g);
  }
  const g = AI.goal;
  if (!g) { aiMove(false); return; }
  const d = Math.hypot(g.x - S.x, g.z - S.z);
  if (d < g.arrive) {
    aiMove(false);
    g.act();
    if (!g.stay) { AI.unreachable.add(g.id); setGoal(null); }
    else AI.waitT = 1;
    AI.thinkT = 0;
    return;
  }
  if (!AI.path) {
    let path = findPath(S.level, S.x, S.z, g.x, g.z, g.cells, 9000);
    if (!path && d > 40) {
      // too far for one search: head for a point part of the way there
      for (const frac of [0.6, 0.35, 0.2]) {
        const p = findOpenNear(S.level, S.x + (g.x - S.x) * frac, S.z + (g.z - S.z) * frac);
        path = findPath(S.level, S.x, S.z, p[0], p[1], 1, 9000);
        if (path) break;
      }
    }
    if (!path) { giveUp(); return; }
    if (!path.length) path = [[g.x, g.z]];
    AI.path = path; AI.pi = 0;
  }
  // smooth: skip ahead to the furthest waypoint we can walk to in a straight line
  for (let k = Math.min(AI.pi + 5, AI.path.length - 1); k > AI.pi; k--) {
    if (clearWalk(S.level, S.x, S.z, AI.path[k][0], AI.path[k][1])) { AI.pi = k; break; }
  }
  const wp = AI.path[AI.pi];
  const wd = Math.hypot(wp[0] - S.x, wp[1] - S.z);
  if (wd < 0.7) {
    AI.pi++;
    if (AI.pi >= AI.path.length) { AI.path = null; return; }
  }
  const want = Math.atan2(-(wp[0] - S.x), -(wp[1] - S.z)), da = wrapAng(want - S.yaw);
  S.yaw += clamp(da, -5 * dt, 5 * dt);
  S.pitch += (-0.05 - S.pitch) * Math.min(1, dt * 3);
  aiMove(Math.abs(da) < 0.9, d > 8);
  // stuck detection
  AI.stuckT += dt;
  if (AI.stuckT > 1.2) {
    const moved = Math.hypot(S.x - AI.lastX, S.z - AI.lastZ);
    AI.lastX = S.x; AI.lastZ = S.z; AI.stuckT = 0;
    if (moved < 0.6 && keys.KeyW) {
      AI.stuckN++;
      const ahead = AI.path && AI.path[AI.pi] ? AI.path[AI.pi] : [S.x - Math.sin(S.yaw) * 1.5, S.z - Math.cos(S.yaw) * 1.5];
      const bgx = Math.floor(ahead[0] / CELL), bgz = Math.floor(ahead[1] / CELL);
      if (bgx !== Math.floor(S.x / CELL) || bgz !== Math.floor(S.z / CELL)) AI.tempBlock.add(bgx + ',' + bgz);
      if (AI.stuckN > 1) keys.Space = true;
      AI.path = null;
      if (AI.stuckN > 5) giveUp();
    }
  }
}
