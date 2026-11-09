'use strict';
// ---------------------------------------------------------------------------
// Autopilot: an AI that plays the game by itself at 5x speed.
//
// It walks with the same controls a player has (forward key + turning) and
// acts through the same typed commands (TAKE, DOWN, FILL, POUR, SAY...), which
// are echoed into the log just as if someone were at the keyboard.
//
// Three layers:
//  1. MEMORY. The AI only knows what it has seen in its lamplight: items,
//     puzzles, lakes, ropes and standing stones, plus the cells it has looked
//     at. It does not read the level generator.
//  2. REACTIVE PRIORITIES for urgent things: fight, refuel, eat, fetch the
//     axe, go home when the pack is full or the cave is closing.
//  3. GOAP (goal-oriented action planning) for puzzles. Each command is an
//     action with preconditions and effects; a Dijkstra search over world
//     states finds the cheapest chain of actions that gets a remembered
//     puzzle's treasure, e.g.
//        take waterskin -> fill at lake -> pour water on bulb -> climb vine.
//     It replans from the real game state after every step.
// When there is nothing to plan for, it explores the nearest frontier: the
// edge between places it has seen and places it hasn't. Paths are A*.
// ---------------------------------------------------------------------------

const AI_SPEED = 5;
const AI = {
  on: false, goal: null, path: null, pi: 0, level: -1, stack: [], unreachable: new Set(),
  thinkT: 0, stuckT: 0, stuckN: 0, lastX: 0, lastZ: 0, deadT: 0, chatT: 40, aimT: 0, scanT: 0,
  returning: false, wantDown: 4, status: '', waitT: 0, homeOnly: false, tempBlock: new Set(),
  plan: null, looted: new Set(), failed: new Set(), entered: new Set(), lastPlanText: '', levelT: 0,
};
// what the AI has seen (reset for each new game)
const MEM = { owner: null, items: new Map(), puzzles: new Map(), feats: new Map(), lakes: new Map(), seen: new Set() };
function resetMemory() {
  MEM.owner = S; MEM.items.clear(); MEM.puzzles.clear(); MEM.feats.clear(); MEM.lakes.clear(); MEM.seen.clear();
  AI.looted.clear(); AI.failed.clear(); AI.entered.clear(); AI.stack = [];
}

function startAutopilot(home) {
  if (MEM.owner !== S) resetMemory();
  AI.on = true;
  AI.homeOnly = !!home;
  AI.goal = null; AI.path = null; AI.plan = null; AI.unreachable.clear(); AI.level = -1;
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
function dist2d(x, z) { return Math.hypot(x - S.x, z - S.z); }

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
  for (const e of loaded.values()) for (const c of e.ch.colliders) if (dist2d(c.x, c.z) < 40) aiCols.push(c);
}
// floor height if the cell can be walked on by the AI, otherwise null
function aiFloor(L, gx, gz) {
  const ch = chunkAtGrid(L, gx, gz), idx = localIdx(ch, gx, gz), k = puzzleKind(ch, idx);
  if ((k !== 1 && k !== 3) || (ch.flags[idx] & F_LAVA) || puzzleBlocked(ch, idx)) return null;
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
const STEP_UP = 2.2;   // max rise between neighbouring cell centres (ledges are 3.4)
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
      if (f1 === null || f1 - f0 > STEP_UP) continue;
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
      if (s === 0) { if (f - prev > STEP_UP) return false; prev = f; }
    }
  }
  return true;
}

// ---- 1. memory: what the AI has actually seen -------------------------------
function itemKey(it) { return it.id + ':' + Math.round(it.x) + ':' + Math.round(it.z); }
function canSee(x, y, z) { return los(S.level, S.x, S.y + 1.6, S.z, x, y, z); }
function aiScan() {
  const L = S.level, lit = isLit(), R = lit ? 22 : 4;
  const present = new Set();
  for (const it of itemsHere()) {
    const k = itemKey(it);
    present.add(k);
    if (MEM.items.has(k)) continue;
    if (dist2d(it.x, it.z) < R && canSee(it.x, it.y + 0.3, it.z))
      MEM.items.set(k, { key: k, id: it.id, kind: it.kind, name: it.name, x: it.x, y: it.y, z: it.z, L });
  }
  // forget things we can see are no longer there
  for (const [k, m] of MEM.items) {
    if (m.L === L && !present.has(k) && dist2d(m.x, m.z) < R * 0.6 && canSee(m.x, m.y + 0.3, m.z)) MEM.items.delete(k);
  }
  for (const e of loaded.values()) {
    for (const p of e.ch.puzzles) {
      if (MEM.puzzles.has(p.id)) continue;
      const x = p.type === 'vine' ? p.bx : p.fx, z = p.type === 'vine' ? p.bz : p.fz;
      if (dist2d(x, z) < R && canSee(x, p.y + 0.8, z)) {
        MEM.puzzles.set(p.id, { p, L });
        log('[AI notes: ' + { gate: 'a locked iron gate', mole: 'a giant mole guarding something', gap: 'a gap too wide to jump', vine: 'a dry bulb under a high shelf' }[p.type] + '.]', 'cmd');
      }
    }
    for (const f of e.ch.features) {
      if (f.type !== 'ropeDown' && f.type !== 'ropeUp') continue;
      const k = f.type + ':' + Math.round(f.x) + ':' + Math.round(f.z);
      if (!MEM.feats.has(k) && dist2d(f.x, f.z) < R && canSee(f.x, f.y + 1, f.z)) MEM.feats.set(k, { f, type: f.type, L });
    }
  }
  // water, and the cells we have looked at (for frontier exploration)
  const gx0 = Math.floor(S.x / CELL), gz0 = Math.floor(S.z / CELL), rs = lit ? 4 : 1;
  for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
    const gx = gx0 + dx, gz = gz0 + dz;
    if (Math.abs(dx) <= rs && Math.abs(dz) <= rs && dx * dx + dz * dz <= rs * rs + 1) MEM.seen.add(L + ':' + gx + ':' + gz);
    if (!lit) continue;
    const ch = chunkAtGrid(L, gx, gz), idx = localIdx(ch, gx, gz);
    if (!(ch.flags[idx] & F_LIQUID) || ch.kind[idx] !== 1) continue;
    const lk = L + ':' + Math.floor(gx / 3) + ':' + Math.floor(gz / 3);
    if (MEM.lakes.has(lk)) continue;
    const x = (gx + 0.5) * CELL, z = (gz + 0.5) * CELL;
    if (canSee(x, ch.liquid[idx] + 0.2, z)) MEM.lakes.set(lk, { L, x, z });
  }
}
function remembered(map, pred) {
  const out = [];
  for (const m of map.values()) if (m.L === S.level && pred(m)) out.push(m);
  return out.sort((a, b) => dist2d(a.x ?? a.f.x, a.z ?? a.f.z) - dist2d(b.x ?? b.f.x, b.z ?? b.f.z));
}

// ---- goals: plain movement targets with an action on arrival --------------
function itemWanted(m) {
  if (S.inv.length >= MAX_INV) return false;
  switch (m.kind) {
    case 'treasure': return true;
    case 'oil': return countInv('oil') < 2;
    case 'food': return countInv('food') < 2;
    case 'axe': case 'key': case 'planks': case 'skin': return countInv(m.kind) < 1;
  }
  return false;
}
function nearestItem(pred, range) {
  let best = null, bd = range;
  for (const m of MEM.items.values()) {
    if (m.L !== S.level || AI.unreachable.has('item:' + m.key) || !pred(m)) continue;
    const d = dist2d(m.x, m.z);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}
function itemGoal(m) {
  return { id: 'item:' + m.key, x: m.x, z: m.z, arrive: 2.0, cells: 1.0, label: 'fetching the ' + m.name,
    act: () => { aiSay('take ' + m.name); MEM.items.delete(m.key); } };
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
    if (r.L === S.level && dist2d(r.x, r.z) < 90)
      return { id: 'rune:' + w, x: r.x, z: r.z, arrive: 4, cells: 1.6, label: 'heading for the ' + w + ' stone to magic home', act: () => { AI.stack = []; aiSay('say ' + w); } };
  }
  const top = AI.stack[AI.stack.length - 1];
  if (top && top.L === S.level - 1 && !AI.unreachable.has('ropeup:' + Math.round(top.x) + ':' + Math.round(top.z))) return ropeGoal(top, 'up');
  for (const m of remembered(MEM.feats, m => m.type === 'ropeUp'))
    if (!AI.unreachable.has('ropeup:' + Math.round(m.f.x) + ':' + Math.round(m.f.z))) return ropeGoal(m.f, 'up');
  return null;
}
function visitedOnLevel() {
  const p = S.level + ':';
  let n = 0;
  for (const k of S.visited) if (k.startsWith(p)) n++;
  return n;
}
function ropeDownGoal() {
  for (const m of remembered(MEM.feats, m => m.type === 'ropeDown'))
    if (!AI.unreachable.has('ropedown:' + Math.round(m.f.x) + ':' + Math.round(m.f.z))) return ropeGoal(m.f, 'down');
  return null;
}

// ---- 2. frontier exploration ------------------------------------------------
function seenCell(L, gx, gz) { return MEM.seen.has(L + ':' + gx + ':' + gz); }
function isFrontier(L, x, z) {
  if (!seenCell(L, x, z) || aiFloor(L, x, z) === null || AI.unreachable.has('frontier:' + L + ':' + x + ':' + z)) return false;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (!seenCell(L, x + dx, z + dz) && aiFloor(L, x + dx, z + dz) !== null) return true;
  }
  return false;
}
function frontierGoal() {
  const L = S.level;
  if (AI.goal && AI.goal.frontier && isFrontier(L, AI.goal.gx, AI.goal.gz)) return AI.goal;
  const sgx = Math.floor(S.x / CELL), sgz = Math.floor(S.z / CELL);
  const seen = new Set([sgx + ',' + sgz]), q = [[sgx, sgz, S.y]];
  for (let head = 0; head < q.length && head < 12000; head++) {
    const [x, z, f] = q[head];
    if (head > 0 && isFrontier(L, x, z)) {
      return { id: 'frontier:' + L + ':' + x + ':' + z, frontier: true, gx: x, gz: z, x: (x + 0.5) * CELL, z: (z + 0.5) * CELL,
        arrive: 1.4, cells: 0.5, label: 'exploring the unknown', act: () => {} };
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, k = nx + ',' + nz;
      if (seen.has(k) || !seenCell(L, nx, nz)) continue;
      const f1 = aiFloor(L, nx, nz);
      if (f1 === null || f1 - f > STEP_UP) continue;
      seen.add(k); q.push([nx, nz, f1]);
    }
  }
  return null;
}
function wanderGoal() {
  const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 30;
  const p = findOpenNear(S.level, S.x + Math.cos(a) * d, S.z + Math.sin(a) * d);
  return { id: 'wander:' + Math.round(p[0]) + ':' + Math.round(p[1]), x: p[0], z: p[1], arrive: 2.5, cells: 1, label: 'wandering into the unknown', act: () => {} };
}

// ---- 3. GOAP: plan a chain of actions to reach a puzzle's treasure ----------
// World state for planning one target puzzle:
//   { at: index of the action last performed (-1 = where we stand now),
//     key, planks, food, skin, full, inv, solved, looted }
const PUZZLE_SOLVE = {
  gate: { cmd: 'unlock gate', label: 'unlock the gate', pre: s => s.key, eff: s => { s.solved = 1; } },
  mole: { cmd: 'feed mole', label: 'feed the mole', pre: s => s.food, eff: s => { s.food = 0; s.inv--; s.solved = 1; } },
  gap: { cmd: 'bridge gap', label: 'bridge the gap', pre: s => s.planks, eff: s => { s.planks = 0; s.inv--; s.solved = 1; } },
  vine: { cmd: 'pour water', label: 'water the bulb', pre: s => s.full, eff: s => { s.full = 0; s.solved = 1; } },
};
const PICKUP_KINDS = ['key', 'planks', 'food', 'skin'];
function pocketCenter(p) {
  const [, cx, cz] = p.id.split(':').map(Number);
  const room = getChunk(cx, cz, S.level).rooms[p.ri];
  return [(cx * CHUNK + room.x) * CELL, (cz * CHUNK + room.z) * CELL];
}
function pocketKey(p) { const [L, cx, cz] = p.id.split(':'); return L + ':' + cx + ':' + cz + ':' + p.ri; }
function pocketItems(p) {
  const rk = pocketKey(p);
  return [...MEM.items.values()].filter(m => m.L === S.level && roomKeyAt(S.level, m.x, m.z) === rk);
}
function goapActions(p) {
  const acts = [];
  for (const kind of PICKUP_KINDS) {
    const near = remembered(MEM.items, m => m.kind === kind && !AI.unreachable.has('item:' + m.key)).slice(0, 3);
    for (const m of near) acts.push({ name: 'take ' + m.name, label: 'take the ' + m.name, x: m.x, z: m.z, item: m,
      pre: s => !s[kind] && s.inv < MAX_INV, eff: s => { s[kind] = 1; s.inv++; } });
  }
  if (p.type === 'vine') {
    const lakes = remembered(MEM.lakes, m => !AI.unreachable.has('lake:' + Math.round(m.x) + ':' + Math.round(m.z))).slice(0, 3);
    for (const l of lakes) acts.push({ name: 'fill', label: 'fill the waterskin at the lake', x: l.x, z: l.z, lake: l,
      pre: s => s.skin && !s.full, eff: s => { s.full = 1; } });
  }
  const sv = PUZZLE_SOLVE[p.type];
  const sx = p.type === 'vine' ? p.bx : p.fx - p.dir[0] * 0.4, sz = p.type === 'vine' ? p.bz : p.fz - p.dir[1] * 0.4;
  acts.push({ name: sv.cmd, label: sv.label, x: sx, z: sz, solve: p, pre: s => !s.solved && sv.pre(s), eff: sv.eff });
  const [lx, lz] = p.type === 'vine' ? [p.bx, p.bz] : pocketCenter(p);
  acts.push({ name: 'loot', label: p.type === 'vine' ? 'climb the vine to the shelf' : 'go through to the hidden room', x: lx, z: lz, loot: p,
    pre: s => s.solved && !s.looted, eff: s => { s.looted = 1; } });
  return acts;
}
function goapPlan(p) {
  const acts = goapActions(p);
  const s0 = { at: -1, key: countInv('key') ? 1 : 0, planks: countInv('planks') ? 1 : 0, food: countInv('food') ? 1 : 0,
    skin: countInv('skin') ? 1 : 0, full: S.inv.some(i => i.kind === 'skin' && i.full) ? 1 : 0, inv: S.inv.length,
    solved: S.solved.has(p.id) ? 1 : 0, looted: 0 };
  const skey = s => [s.at, s.key, s.planks, s.food, s.skin, s.full, s.inv, s.solved, s.looted].join(',');
  const pos = s => s.at < 0 ? [S.x, S.z] : [acts[s.at].x, acts[s.at].z];
  const heap = new MinHeap(), best = new Map();
  heap.push(0, { s: s0, cost: 0, prev: null, act: -1 });
  best.set(skey(s0), 0);
  for (let n = 0; heap.size && n < 4000; n++) {
    const node = heap.pop();
    if (node.s.looted) {
      const steps = [];
      for (let x = node; x.prev; x = x.prev) steps.push(acts[x.act]);
      return { target: p, steps: steps.reverse(), cost: node.cost };
    }
    if (node.cost > (best.get(skey(node.s)) ?? 1e9)) continue;
    const [px, pz] = pos(node.s);
    acts.forEach((a, i) => {
      if (!a.pre(node.s)) return;
      const s = Object.assign({}, node.s);
      a.eff(s); s.at = i;
      const cost = node.cost + Math.hypot(a.x - px, a.z - pz) * 1.3 + 3;
      const k = skey(s);
      if (cost >= (best.get(k) ?? 1e9)) return;
      best.set(k, cost);
      heap.push(cost, { s, cost, prev: node, act: i });
    });
  }
  return null;
}
function choosePlan() {
  let best = null;
  for (const m of MEM.puzzles.values()) {
    const p = m.p;
    if (m.L !== S.level || AI.looted.has(p.id) || AI.failed.has(p.id)) continue;
    if (AI.entered.has(p.id) && !pocketItems(p).length) { AI.looted.add(p.id); continue; }
    const x = p.type === 'vine' ? p.bx : p.fx, z = p.type === 'vine' ? p.bz : p.fz;
    if (dist2d(x, z) > 160) continue;
    const plan = goapPlan(p);
    if (plan && (!best || plan.cost < best.cost)) best = plan;
  }
  return best;
}
// turn the next step of a plan into a movement goal
function planStepGoal(plan) {
  const a = plan.steps[0], p = plan.target, n = plan.steps.length;
  const label = 'plan: ' + a.label + (n > 1 ? ' (then ' + plan.steps.slice(1).map(x => x.label).join(', then ') + ')' : '');
  const done = () => { AI.plan = null; };   // replan from the real state after every step
  if (a.item) {
    const g = itemGoal(a.item);
    const inner = g.act;
    g.label = label; g.act = () => { inner(); done(); };
    return g;
  }
  if (a.lake) {
    return { id: 'lake:' + Math.round(a.x) + ':' + Math.round(a.z), x: a.x, z: a.z, arrive: 0.8, cells: 0.3, label,
      act: () => { aiSay('fill waterskin'); done(); } };
  }
  if (a.solve) {
    return { id: 'solve:' + p.id, x: a.x, z: a.z, arrive: 1.3, cells: 0.5, label,
      act: () => { aiSay(PUZZLE_SOLVE[p.type].cmd); AI.unreachable.clear(); done(); } };
  }
  return { id: 'loot:' + p.id, x: a.x, z: a.z, arrive: p.type === 'vine' ? 1.3 : 2.0, cells: 0.6, label,
    act: () => {
      if (p.type === 'vine') aiSay('climb vine');
      AI.entered.add(p.id); AI.unreachable.clear(); done();
    } };
}
function goapGoal() {
  if (!AI.plan) {
    AI.plan = choosePlan();
    if (!AI.plan) return null;
    const text = AI.plan.steps.map(s => s.name).join(' -> ');
    if (text !== AI.lastPlanText) { AI.lastPlanText = text; log('[AI plan: ' + AI.plan.steps.map(s => s.label).join(' -> ') + ']', 'cmd'); }
  }
  return planStepGoal(AI.plan);
}

// ---- reactive priorities -----------------------------------------------------
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
  const gh = groundInfo(S.level, S.x, S.z);
  if (gh.kind === 3) {
    // up on a shelf: take what's here, and look around the hidden chamber before leaving
    const here = roomKeyAt(S.level, S.x, S.z);
    const up = S.inv.length < MAX_INV && nearestItem(m => itemWanted(m) && roomKeyAt(S.level, m.x, m.z) === here, 30);
    if (up) return itemGoal(up);
    if (gh.room >= 0 && !AI.unreachable.has('shelf:' + here)) {
      const room = gh.ch.rooms[gh.room];
      return { id: 'shelf:' + here, x: (gh.ch.cx * CHUNK + room.x) * CELL, z: (gh.ch.cz * CHUNK + room.z) * CELL, arrive: 1.2, cells: 0.4,
        label: 'looking around the hidden shelf', act: () => {} };
    }
  }
  const treasures = countInv('treasure');
  const needHome = S.inv.length >= MAX_INV || treasures >= 4 || (S.fuel < 40 && !countInv('oil')) ||
    (S.health < 40 && !countInv('food'));
  if (!countInv('axe')) { const ax = nearestItem(m => m.kind === 'axe', 40); if (ax) return itemGoal(ax); }
  if (needHome) AI.returning = true;
  if (AI.returning) { const g = campGoal(); if (g) return g; }
  if (S.level === 0 && atCamp() && !AI.returning) {
    let deep = null;
    for (const w in S.runes) if (S.runes[w].L >= 1 && (!deep || S.runes[w].L > S.runes[deep].L)) deep = w;
    if (deep && S.fuel > 90) return { id: 'sayat:' + deep, x: S.x, z: S.z, arrive: 99, cells: 0, label: 'saying a magic word to return to level ' + S.runes[deep].L, act: () => { AI.stack = []; aiSay('say ' + deep); } };
  }
  const it = nearestItem(itemWanted, 30);
  if (it) return itemGoal(it);
  const pg = goapGoal();
  if (pg) return pg;
  // a known puzzle we can't solve yet? the missing piece is usually nearby, so explore a while first
  const unsolved = [...MEM.puzzles.values()].some(m => m.L === S.level && !AI.looted.has(m.p.id) && !AI.failed.has(m.p.id));
  const keepLooking = unsolved && AI.levelT < 300;
  if (!keepLooking && visitedOnLevel() >= AI.wantDown && S.fuel > 50 && S.inv.length < MAX_INV - 1) {
    const rd = ropeDownGoal(); if (rd) return rd;
  }
  const fg = frontierGoal();
  if (fg) { if (keepLooking) fg.label = 'searching for something to solve a puzzle'; return fg; }
  return ropeDownGoal() || wanderGoal();
}
function setGoal(g) { AI.goal = g; AI.path = null; AI.pi = 0; AI.stuckN = 0; AI.tempBlock.clear(); if (g) AI.status = g.label; }
function giveUp() {
  const g = AI.goal;
  if (g) {
    AI.unreachable.add(g.id);
    if (g.id.startsWith('item:')) MEM.items.delete(g.id.slice(5));
    if (AI.plan) { AI.failed.add(AI.plan.target.id); AI.plan = null; }
  }
  setGoal(null);
}

// ---- combat ----------------------------------------------------------------
function aiCombat(dt) {
  if (!countInv('axe')) return false;
  let best = null, bd = 19;
  for (const c of creatures) {
    const d = dist2d(c.x, c.z);
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
  if (MEM.owner !== S) resetMemory();
  if (mode === 'dead') {
    AI.deadT += dt;
    if (AI.deadT > 2.5) { AI.deadT = 0; AI.stack = []; AI.returning = false; AI.plan = null; setGoal(null); reincarnate(); }
    return;
  }
  if (mode === 'over') { stopAutopilot(); return; }
  if (mode !== 'play' || pending) { aiMove(false); return; }
  if (AI.level !== S.level) {
    AI.level = S.level; setGoal(null); AI.plan = null; AI.unreachable.clear(); AI.failed.clear(); AI.levelT = 0;
    AI.wantDown = 3 + Math.floor(Math.random() * 4);
  }
  keys.Space = false;
  AI.levelT += dt;
  AI.scanT -= dt;
  if (AI.scanT <= 0) { AI.scanT = 0.3; aiScan(); }
  // housekeeping, like a careful player
  if (S.fuel < 30 && countInv('oil')) { aiSay('fill lamp'); return; }
  if (!S.lampOn && S.fuel > 0) { aiSay('lamp on'); return; }
  if (S.health < 45 && countInv('food') > (AI.plan && AI.plan.target.type === 'mole' ? 1 : 0)) { aiSay('eat'); return; }
  // drop puzzle tools nobody needs any more when the pack is nearly full
  if (S.inv.length >= MAX_INV - 1) {
    const needs = { key: 'gate', planks: 'gap', skin: 'vine' };
    for (const kind in needs) {
      if (!countInv(kind)) continue;
      const still = [...MEM.puzzles.values()].some(m => m.L === S.level && m.p.type === needs[kind] && !S.solved.has(m.p.id));
      if (!still) { aiSay('drop ' + { key: 'key', planks: 'planks', skin: 'waterskin' }[kind]); return; }
    }
  }
  AI.chatT -= dt;
  if (AI.chatT <= 0 && !AI.homeOnly) { AI.chatT = 60 + Math.random() * 60; aiSay(['score', 'inventory', 'look'][Math.floor(Math.random() * 3)]); }
  gatherColliders();
  if (aiCombat(dt)) return;
  if (AI.waitT > 0) { AI.waitT -= dt; aiMove(false); return; }

  AI.thinkT -= dt;
  if (!AI.goal || AI.thinkT <= 0) {
    AI.thinkT = 2;
    aiScan();                       // always look around before deciding
    const g = chooseGoal();
    if (!AI.on) { aiMove(false); return; }
    if (!AI.goal || !g || g.id !== AI.goal.id) setGoal(g);
  }
  const g = AI.goal;
  if (!g) { aiMove(false); return; }
  const d = dist2d(g.x, g.z);
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
  // stuck detection: block the spot ahead and re-plan around it
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
