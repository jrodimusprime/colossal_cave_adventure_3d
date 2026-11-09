'use strict';
// ---------------------------------------------------------------------------
// Infinite cave generation.
//
// The world is an endless grid of 32x32-cell chunks on an endless stack of
// levels. Every chunk is generated purely from (seed, cx, cz, level), so the
// cave never runs out and is identical every time you return.
//  * Rooms are carved inside each chunk; tunnels join them with a spanning tree.
//  * Every chunk edge has a "portal" cell whose position is hashed from the
//    edge itself, so neighbouring chunks always agree and the cave is connected.
//  * Rope shafts in level L line up with "landing" rooms carved in level L+1.
// ---------------------------------------------------------------------------

const F_TUNNEL = 1, F_LIQUID = 2, F_LAVA = 4, F_SKY = 8, F_SHAFTUP = 16, F_SHAFTDOWN = 32, F_OCC = 64, F_TALL = 128;
const WORLD = { seed: 1, solved: new Set() };
const CAMP = { x: 16, z: 16, shaftX: 13, shaftZ: 19, spawnX: 17, spawnZ: 19 };

const REGIONS = [
  { from: 0, name: 'the Upper Galleries', wall: T.ROCK, floor: T.DIRT, ceil: T.ROCK, amb: [0.05, 0.042, 0.034],
    flavor: ['The air is cool and smells of wet earth.', 'Thin roots from the world above poke through cracks in the ceiling.', 'Old soot marks on the wall suggest someone camped here, long ago.'] },
  { from: 2, name: 'the Limestone Deeps', wall: T.FLOWSTONE, floor: T.ROCK2, ceil: T.ROCK2, amb: [0.038, 0.043, 0.05],
    flavor: ['Pale flowstone drapes the walls like melted candle wax.', 'Every surface is slick with mineral-laden water.', 'The rock here is banded in creams and greys.'] },
  { from: 4, name: 'the Crystal Reaches', wall: T.ROCK2, floor: T.ROCK2, ceil: T.BASALT, amb: [0.032, 0.042, 0.065],
    flavor: ['Tiny crystals in the walls wink back at your lamp.', 'The air tastes of metal and cold.', 'A faint, high ringing seems to come from the stone itself.'] },
  { from: 6, name: 'the Fungal Abyss', wall: T.BASALT, floor: T.FUNGUS, ceil: T.BASALT, amb: [0.045, 0.032, 0.055],
    flavor: ['The air is thick and warm, heavy with spores.', 'Something soft squelches underfoot.', 'Pale threads of mycelium web the walls.'] },
  { from: 8, name: 'the Ember Depths', wall: T.OBSIDIAN, floor: T.BASALT, ceil: T.OBSIDIAN, amb: [0.07, 0.032, 0.02],
    flavor: ['The rock is warm to the touch.', 'A smell of sulphur hangs in the air.', 'Glassy black stone reflects your lamp in long smears.'] },
  { from: 11, name: 'the Nameless Dark', wall: T.BASALT, floor: T.OBSIDIAN, ceil: T.BLACK, amb: [0.025, 0.02, 0.035],
    flavor: ['The silence here has weight.', 'You have the distinct feeling that nobody has ever been this deep.', 'Your lamp seems smaller here, somehow.'] },
];
function regionFor(L) { let r = REGIONS[0]; for (const g of REGIONS) if (L >= g.from) r = g; return r; }

function floorBase(wx, wz, L) {
  const s = WORLD.seed + L * 1013;
  return fbm(wx / 110, wz / 110, s, 3) * 8 + fbm(wx / 23, wz / 23, s + 77, 2) * 0.9;
}

const ROOM_R = { cavern: [6, 8.5], grotto: [3, 4.5], hall: [4, 6], lake: [5, 7], chasm: [5, 7], crystal: [4, 6], fungus: [4.5, 7],
  lava: [5, 7], shrine: [3.8, 5], columns: [5, 7], landing: [2.8, 2.8], camp: [7, 7], lair: [7.5, 8.5] };
const ROOM_H = { cavern: [11, 17], grotto: [4.5, 6], hall: [7, 10], lake: [6, 10], chasm: [9, 14], crystal: [6, 9], fungus: [6, 10],
  lava: [8, 12], shrine: [6, 8], columns: [8, 12], landing: [4.5, 4.5], camp: [30, 30], lair: [14, 18] };

function pickRoomType(rng, L) {
  const w = {
    cavern: 3, grotto: 3, hall: 2, lake: 1.5, chasm: L > 0 ? 1.2 : 0.3, columns: 1.2, shrine: L > 0 ? 0.8 : 0.2,
    lair: L >= 4 ? 0.4 : 0,
    crystal: L >= 4 ? 3 : L >= 2 ? 0.8 : 0.15, fungus: L >= 6 ? 3 : L >= 3 ? 0.6 : 0, lava: L >= 8 ? 2.5 : L >= 6 ? 0.5 : 0,
  };
  let tot = 0; for (const k in w) tot += w[k];
  let r = rng.next() * tot;
  for (const k in w) { r -= w[k]; if (r <= 0) return k; }
  return 'grotto';
}

function mkRoom(type, x, z, r, h, rng) {
  return { type, x, z, r, h, k1: rng.int(2, 4), ph1: rng.range(0, 6.283), ph2: rng.range(0, 6.283),
    ang: rng.range(0, Math.PI), seed: Math.floor(rng.next() * 1e9), wob: type === 'camp' ? 0.25 : 1 };
}

// ---- chunk plans (cheap: no carving) --------------------------------------
const planCache = new Map();
function planBase(cx, cz, L) {
  const key = cx + ',' + cz + ',' + L;
  let p = planCache.get(key);
  if (p) return p;
  if (planCache.size > 3000) planCache.clear();
  const camp = L === 0 && cx === 0 && cz === 0;
  if (!camp && L >= 1 && hash4(cx, cz, L, WORLD.seed ^ 0x3A2E) % 100 < 7) {
    p = { rooms: [], shafts: [], maze: true };
    planCache.set(key, p);
    return p;
  }
  const rng = new RNG(hash4(cx, cz, L, WORLD.seed));
  const rooms = [];
  if (camp) rooms.push(mkRoom('camp', CAMP.x, CAMP.z, 7, 30, rng));
  const target = rng.int(3, 5);
  for (let tries = 0; rooms.length < target && tries < 50; tries++) {
    const type = pickRoomType(rng, L);
    const r = rng.range(ROOM_R[type][0], ROOM_R[type][1]);
    const x = rng.range(r + 1.5, CHUNK - r - 1.5), z = rng.range(r + 1.5, CHUNK - r - 1.5);
    let ok = true;
    for (const o of rooms) if (Math.hypot(o.x - x, o.z - z) < (o.r + r) * 0.9 + 2) { ok = false; break; }
    if (!ok) continue;
    rooms.push(mkRoom(type, x, z, r, rng.range(ROOM_H[type][0], ROOM_H[type][1]), rng));
  }
  const shafts = [];
  const addShaft = (ri) => {
    const room = rooms[ri];
    let sx, sz;
    if (room.type === 'camp') { sx = CAMP.shaftX; sz = CAMP.shaftZ; }
    else {
      const a = rng.range(0, Math.PI * 2), d = Math.min(2, room.r * 0.45);
      sx = Math.floor(room.x + Math.cos(a) * d); sz = Math.floor(room.z + Math.sin(a) * d);
    }
    shafts.push({ x: sx, z: sz, ri, chute: room.type !== 'camp' && rng.chance(0.3) });
  };
  const eligible = [];
  rooms.forEach((r, i) => { if (!['lake', 'lava', 'chasm', 'lair'].includes(r.type)) eligible.push(i); });
  for (const ri of eligible) if (rooms[ri].type === 'camp' || rng.chance(0.28)) addShaft(ri);
  if (!shafts.length && eligible.length) addShaft(eligible[0]);
  p = { rooms, shafts };
  planCache.set(key, p);
  return p;
}
function portalE(cx, cz, L) { return 3 + hash4(cx, cz, L, WORLD.seed ^ 0x0E0E0E) % 26; }
function portalS(cx, cz, L) { return 3 + hash4(cx, cz, L, WORLD.seed ^ 0x050505) % 26; }

// ---- chunk generation -----------------------------------------------------
const chunkCache = new Map();
let lastChunkKey = null, lastChunk = null;
function clearWorldCaches() { planCache.clear(); chunkCache.clear(); lastChunkKey = null; lastChunk = null; }

function getChunk(cx, cz, L) {
  const key = cx + ',' + cz + ',' + L;
  if (key === lastChunkKey) return lastChunk;
  let ch = chunkCache.get(key);
  if (!ch) {
    if (chunkCache.size > 400) {
      let n = 0;
      for (const k of chunkCache.keys()) { chunkCache.delete(k); if (++n > 120) break; }
    }
    ch = genChunk(cx, cz, L);
    chunkCache.set(key, ch);
  }
  lastChunkKey = key; lastChunk = ch;
  return ch;
}
function chunkAtGrid(L, gx, gz) { return getChunk(Math.floor(gx / CHUNK), Math.floor(gz / CHUNK), L); }
function localIdx(ch, gx, gz) { return (gz - ch.cz * CHUNK) * CHUNK + (gx - ch.cx * CHUNK); }
function kindAtG(L, gx, gz) { const ch = chunkAtGrid(L, gx, gz); return ch.kind[localIdx(ch, gx, gz)]; }

function genChunk(cx, cz, L) {
  const plan = planBase(cx, cz, L);
  const rng = new RNG(hash4(cx, cz, L, WORLD.seed ^ 0x2545F491));
  const N = CHUNK * CHUNK;
  const ch = {
    cx, cz, L, kind: new Uint8Array(N), floor: new Float32Array(N), ceil: new Float32Array(N),
    room: new Int8Array(N).fill(-1), flags: new Uint8Array(N), liquid: new Float32Array(N), tval: new Float32Array(N).fill(9),
    rooms: [], items: [], features: [], props: [], lights: [], colliders: [],
    puzzles: [], pblock: null, pbridge: null, maze: !!plan.maze,
  };
  const rooms = plan.rooms.map(r => Object.assign({}, r, { cells: [], exits: 0 }));
  if (L > 0) {
    for (const s of planBase(cx, cz, L - 1).shafts) {
      const lr = mkRoom('landing', s.x + 0.5, s.z + 0.5, 2.8, 4.5, rng);
      rooms.push(Object.assign(lr, { cells: [], exits: 0, landing: { x: s.x, z: s.z, chute: s.chute } }));
    }
  }
  ch.rooms = rooms;
  if (plan.maze) carveMaze(ch, rng);
  rooms.forEach((room, ri) => {
    room.baseY = floorBase((cx * CHUNK + room.x) * CELL, (cz * CHUNK + room.z) * CELL, L);
    carveRoom(ch, room, ri);
  });
  dilateLiquid(ch);

  // --- tunnels: spanning tree over rooms + the four edge portals
  const nodes = rooms.map((r, i) => ({ x: r.x, z: r.z, room: i }));
  nodes.push({ x: CHUNK - 0.5, z: portalE(cx, cz, L) + 0.5, room: -1 });
  nodes.push({ x: 0.5, z: portalE(cx - 1, cz, L) + 0.5, room: -1 });
  nodes.push({ x: portalS(cx, cz, L) + 0.5, z: CHUNK - 0.5, room: -1 });
  nodes.push({ x: portalS(cx, cz - 1, L) + 0.5, z: 0.5, room: -1 });
  const inTree = [0], out = [];
  for (let i = 1; i < nodes.length; i++) out.push(i);
  const edges = [];
  while (out.length && !plan.maze) {
    let best = 1e9, bi = -1, bo = -1;
    for (const a of inTree) for (let k = 0; k < out.length; k++) {
      const b = out[k], d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
      if (d < best) { best = d; bi = a; bo = k; }
    }
    edges.push([bi, out[bo]]); inTree.push(out[bo]); out.splice(bo, 1);
  }
  if (!plan.maze && rng.chance(0.75)) {
    const a = rng.int(0, nodes.length - 1), b = rng.int(0, nodes.length - 1);
    if (a !== b) edges.push([a, b]);
  }
  for (const [a, b] of edges) {
    carveTunnel(ch, nodes[a], nodes[b], rng);
    if (nodes[a].room >= 0) rooms[nodes[a].room].exits++;
    if (nodes[b].room >= 0) rooms[nodes[b].room].exits++;
  }

  // --- landings (rope up to level above)
  rooms.forEach((room) => {
    if (!room.landing) return;
    const s = room.landing, idx = s.z * CHUNK + s.x;
    forceOpenAround(ch, s.x, s.z);
    ch.kind[idx] = 1;
    ch.flags[idx] = (ch.flags[idx] & ~(F_LIQUID | F_LAVA)) | F_SHAFTUP | F_TALL | F_OCC;
    ch.ceil[idx] = ch.floor[idx] + 24;
    const wx = (cx * CHUNK + s.x + 0.5) * CELL, wz = (cz * CHUNK + s.z + 0.5) * CELL;
    if (!s.chute) {
      ch.features.push({ type: 'ropeUp', x: wx, z: wz, y: ch.floor[idx], gx: cx * CHUNK + s.x, gz: cz * CHUNK + s.z });
      ch.props.push({ t: 'rope', x: wx, z: wz, y0: ch.floor[idx] - 0.2, y1: ch.floor[idx] + 24 });
    } else ch.props.push({ t: 'rock', x: wx + 0.6, z: wz - 0.4, y: ch.floor[idx], s: 0.45, seed: s.x * 7 + s.z, layer: T.ROCK2 });
  });
  // --- shafts down
  for (const s of plan.shafts) {
    const idx = s.z * CHUNK + s.x;
    forceOpenAround(ch, s.x, s.z);
    const top = ch.floor[idx];
    ch.kind[idx] = 2;
    ch.floor[idx] = top - 45;
    ch.flags[idx] = (ch.flags[idx] & ~(F_LIQUID | F_LAVA)) | F_SHAFTDOWN | F_OCC;
    const wx = (cx * CHUNK + s.x + 0.5) * CELL, wz = (cz * CHUNK + s.z + 0.5) * CELL;
    if (s.chute) {
      ch.features.push({ type: 'chuteDown', x: wx, z: wz, y: top, gx: cx * CHUNK + s.x, gz: cz * CHUNK + s.z, ri: s.ri });
      ch.props.push({ t: 'chute', x: wx, z: wz, y: top });
      rooms[s.ri].chuteDown = true;
    } else {
      ch.features.push({ type: 'ropeDown', x: wx, z: wz, y: top, gx: cx * CHUNK + s.x, gz: cz * CHUNK + s.z, ri: s.ri });
      ch.props.push({ t: 'frame', x: wx, z: wz, y: top });
      ch.props.push({ t: 'rope', x: wx, z: wz, y0: top - 40, y1: top + 2.5 });
      rooms[s.ri].ropeDown = true;
    }
  }

  populate(ch, rng);
  if (plan.maze) mazeHoard(ch, rng);
  else maybeAddPuzzle(ch, rng);
  return ch;
}

function forceOpenAround(ch, x, z) {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const i = x + dx, j = z + dz;
    if (i < 0 || j < 0 || i >= CHUNK || j >= CHUNK) continue;
    const idx = j * CHUNK + i, k = ch.kind[idx];
    if (k === 1 && !(ch.flags[idx] & (F_LIQUID | F_LAVA))) continue;
    if (k === 2 && (ch.flags[idx] & F_SHAFTDOWN)) continue;
    const base = floorBase((ch.cx * CHUNK + i + 0.5) * CELL, (ch.cz * CHUNK + j + 0.5) * CELL, ch.L);
    if (k !== 1) ch.floor[idx] = base;
    else ch.floor[idx] = Math.max(ch.floor[idx], ch.liquid[idx] + 0.1);
    ch.kind[idx] = 1;
    ch.ceil[idx] = Math.max(ch.ceil[idx], ch.floor[idx] + 4);
    ch.flags[idx] &= ~(F_LIQUID | F_LAVA);
  }
}

function carveRoom(ch, room, ri) {
  const L = ch.L, R = room.r * 1.35;
  const i0 = Math.max(0, Math.floor(room.x - R)), i1 = Math.min(CHUNK - 1, Math.ceil(room.x + R));
  const j0 = Math.max(0, Math.floor(room.z - R)), j1 = Math.min(CHUNK - 1, Math.ceil(room.z + R));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const dx = i + 0.5 - room.x, dz = j + 0.5 - room.z, d = Math.hypot(dx, dz), a = Math.atan2(dz, dx);
    const rr = room.r * (1 + room.wob * (0.18 * Math.sin(a * room.k1 + room.ph1) + 0.1 * Math.sin(a * (room.k1 + 2) + room.ph2)));
    if (d >= rr) continue;
    const t = d / rr, idx = j * CHUNK + i;
    if (ch.kind[idx] !== 0 && ch.tval[idx] <= t) continue;
    const wx = (ch.cx * CHUNK + i + 0.5) * CELL, wz = (ch.cz * CHUNK + j + 0.5) * CELL;
    const base = floorBase(wx, wz, L);
    const nz = vnoise(wx * 0.35, wz * 0.35, room.seed) - 0.5;
    const dome = h => Math.max(3.8, h * Math.sqrt(Math.max(0, 1 - 0.82 * t * t)));
    let kind = 1, fl = base, ce, flags = 0, liq = 0;
    switch (room.type) {
      case 'cavern': case 'lair': fl = base + nz * 0.8; ce = base + dome(room.h) + nz * 1.5; break;
      case 'hall': fl = room.baseY * 0.6 + base * 0.4; ce = fl + room.h - t * t * 2.5 + nz; break;
      case 'lake': {
        const wy = room.baseY - 0.35;
        fl = room.baseY - 1.5 * (1 - t) + nz * 0.2; ce = room.baseY + dome(room.h);
        if (fl < wy + 0.3) { flags |= F_LIQUID; liq = wy; }
        break;
      }
      case 'lava': {
        const ly = room.baseY - 0.5;
        fl = room.baseY - 1.3 * (1 - t) + nz * 0.15; ce = room.baseY + dome(room.h);
        if (fl < ly + 0.1) { flags |= F_LAVA; liq = ly; }
        break;
      }
      case 'chasm': {
        fl = base + nz * 0.4; ce = base + dome(room.h);
        const ca = Math.cos(room.ang), sa = Math.sin(room.ang);
        const along = dx * ca + dz * sa, perp = Math.abs(-dx * sa + dz * ca);
        if (perp < 1.5 && t < 0.97 && Math.abs(along) > 0.9) { kind = 2; fl = base - 40; }
        break;
      }
      case 'camp':
        fl = room.baseY + t * t * 1.6 + nz * 0.2;
        if (t < 0.55) { flags |= F_SKY | F_TALL; ce = room.baseY + 32; } else ce = fl + 5 + (1 - t) * 8;
        break;
      case 'shrine': fl = room.baseY + nz * 0.1; ce = fl + room.h * (t < 0.85 ? 1 : 0.8); break;
      case 'landing': fl = base; ce = fl + room.h; break;
      default: fl = base + nz * 0.5; ce = base + dome(room.h) + nz * 1.2;
    }
    ch.kind[idx] = kind; ch.floor[idx] = fl;
    ch.ceil[idx] = Math.max(ce, (kind === 2 ? base : fl) + 3.8);
    ch.room[idx] = ri; ch.flags[idx] = flags; ch.liquid[idx] = liq; ch.tval[idx] = t;
  }
}

// make shoreline cells next to water also carry the water plane so dips are filled
function dilateLiquid(ch) {
  const add = [];
  for (let j = 0; j < CHUNK; j++) for (let i = 0; i < CHUNK; i++) {
    const idx = j * CHUNK + i;
    if (!(ch.flags[idx] & F_LIQUID)) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + dx, b = j + dz;
      if (a < 0 || b < 0 || a >= CHUNK || b >= CHUNK) continue;
      const n = b * CHUNK + a;
      if (ch.kind[n] === 1 && !(ch.flags[n] & (F_LIQUID | F_LAVA)) && ch.floor[n] < ch.liquid[idx] + 1.0) add.push([n, ch.liquid[idx]]);
    }
  }
  for (const [n, y] of add) { ch.flags[n] |= F_LIQUID; ch.liquid[n] = y; }
}

function carveTunnel(ch, a, b, rng) {
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  const off = rng.range(-0.3, 0.3) * len;
  const mx = clamp((a.x + b.x) / 2 - dz / len * off, 2, CHUNK - 2), mz = clamp((a.z + b.z) / 2 + dx / len * off, 2, CHUNK - 2);
  const w = rng.range(0.85, 1.3), wig = rng.range(0, 6.28), wigA = rng.range(0.2, 0.7);
  const steps = Math.ceil(len * 3) + 2;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, u = 1 - t;
    let px = u * u * a.x + 2 * u * t * mx + t * t * b.x, pz = u * u * a.z + 2 * u * t * mz + t * t * b.z;
    const wob = Math.sin(t * len * 0.5 + wig) * wigA * Math.sin(t * Math.PI);
    px = clamp(px - dz / len * wob, 0.5, CHUNK - 0.5); pz = clamp(pz + dx / len * wob, 0.5, CHUNK - 0.5);
    carveDisc(ch, px, pz, Math.max(0.75, w * (0.9 + 0.3 * Math.sin(t * 9 + wig))));
  }
}
function carveDisc(ch, px, pz, r) {
  const L = ch.L;
  for (let j = Math.floor(pz - r); j <= Math.floor(pz + r); j++) for (let i = Math.floor(px - r); i <= Math.floor(px + r); i++) {
    if (i < 0 || j < 0 || i >= CHUNK || j >= CHUNK) continue;
    if ((i + 0.5 - px) ** 2 + (j + 0.5 - pz) ** 2 > r * r) continue;
    const idx = j * CHUNK + i, k = ch.kind[idx];
    const wx = (ch.cx * CHUNK + i + 0.5) * CELL, wz = (ch.cz * CHUNK + j + 0.5) * CELL;
    if (k === 0) {
      const base = floorBase(wx, wz, L);
      ch.kind[idx] = 1; ch.floor[idx] = base;
      ch.ceil[idx] = base + 3.7 + vnoise(wx * 0.4, wz * 0.4, WORLD.seed + L + 5) * 1.6;
      ch.room[idx] = -1;
    } else if (k === 2 && !(ch.flags[idx] & F_SHAFTDOWN)) {
      ch.kind[idx] = 1; ch.floor[idx] = floorBase(wx, wz, L);   // natural bridge over a chasm
    }
    ch.flags[idx] |= F_TUNNEL;
  }
}

// ---- treasures & items ----------------------------------------------------
const TREASURES = [
  { n: 'gold nugget', mesh: 'nugget', mat: 'GOLD', v: 8, d: 0 },
  { n: 'bar of silver', mesh: 'bars', mat: 'SILVER', v: 10, d: 0 },
  { n: 'pile of old coins', mesh: 'coins', mat: 'GOLD', v: 10, d: 0 },
  { n: 'ruby', mesh: 'gem', mat: 'RUBY', v: 14, d: 1 },
  { n: 'emerald', mesh: 'gem', mat: 'EMERALD', v: 14, d: 1 },
  { n: 'golden chalice', mesh: 'chalice', mat: 'GOLD', v: 16, d: 1 },
  { n: 'sapphire', mesh: 'gem', mat: 'SAPPHIRE', v: 15, d: 2 },
  { n: 'jade idol', mesh: 'idol', mat: 'JADE', v: 20, d: 2 },
  { n: 'porcelain urn', mesh: 'urn', mat: 'BONE', v: 18, d: 2, fragile: true },
  { n: 'pearl as big as a plum', mesh: 'orb', mat: 'PALE', v: 18, d: 2 },
  { n: 'silver idol', mesh: 'idol', mat: 'SILVER', v: 24, d: 3 },
  { n: 'obsidian mask', mesh: 'mask', mat: 'OBSIDIAN', v: 22, d: 3 },
  { n: 'jewelled crown', mesh: 'crown', mat: 'GOLD', v: 30, d: 4 },
  { n: 'crystal egg', mesh: 'egg', mat: 'CRYSTAL', v: 28, d: 4, fragile: true },
  { n: 'amethyst skull', mesh: 'skull', mat: 'AMETHYST', v: 35, d: 6 },
  { n: 'ember opal', mesh: 'gem', mat: 'LAVA', v: 40, d: 8 },
];
const TREASURE_ADJ = ['tarnished', 'gleaming', 'ancient', 'heavy', 'dusty', 'flawless', 'chipped', 'exquisite', 'strange', 'beautiful', 'cold', 'curious'];
function mkTreasure(rng, L) {
  const cands = TREASURES.filter(t => t.d <= L);
  let tot = 0; for (const t of cands) tot += 1 + t.d * 0.6;
  let r = rng.next() * tot, pick = cands[0];
  for (const t of cands) { r -= 1 + t.d * 0.6; if (r <= 0) { pick = t; break; } }
  return { kind: 'treasure', name: rng.pick(TREASURE_ADJ) + ' ' + pick.n, mesh: pick.mesh, mat: pick.mat,
    value: Math.round(pick.v * (1 + L * 0.3) * rng.range(0.85, 1.25)), fragile: !!pick.fragile };
}
const FOODS = ['bundle of dried mushrooms', 'packet of stale biscuits', 'wedge of hard cheese', 'strip of smoked eel', 'twist of salted nuts'];
function mkOil() { return { kind: 'oil', name: 'flask of lamp oil', mesh: 'flask', mat: 'METAL' }; }
function mkFood(rng) { return { kind: 'food', name: rng.pick(FOODS), mesh: 'food', mat: 'CLOTH' }; }
function mkAxe() { return { kind: 'axe', name: 'throwing axe', mesh: 'axe', mat: 'METAL' }; }

const RUNE_SYL = ['ka', 'zu', 'mor', 'thal', 'vy', 'rex', 'ul', 'dra', 'nim', 'os', 'qua', 'bel', 'ith', 'gor', 'sel', 'vax', 'ym', 'lo', 'fen', 'zor', 'ash', 'ek', 'tu', 'brim'];
function runeWord(rng) {
  let w = '';
  const n = rng.int(2, 3);
  for (let i = 0; i < n; i++) w += rng.pick(RUNE_SYL);
  return w.toUpperCase();
}
const CRYSTAL_LIGHT = { [T.CRYSTAL]: [0.35, 0.85, 1.0], [T.CRYSTAL2]: [0.75, 0.45, 1.0], [T.CRYSTAL3]: [0.45, 1.0, 0.6] };

function populate(ch, rng) {
  const L = ch.L, reg = regionFor(L), rooms = ch.rooms;
  const ox = ch.cx * CHUNK, oz = ch.cz * CHUNK, N = CHUNK * CHUNK;
  const passage = [];
  for (let idx = 0; idx < N; idx++) {
    if (ch.kind[idx] !== 1 || (ch.flags[idx] & (F_LIQUID | F_LAVA | F_SHAFTUP | F_SHAFTDOWN | F_OCC))) continue;
    const ri = ch.room[idx];
    if (ri < 0) passage.push(idx); else rooms[ri].cells.push(idx);
  }
  const cellPos = (idx, jit) => {
    const i = idx % CHUNK, j = (idx / CHUNK) | 0;
    return { x: (ox + i + 0.5 + rng.range(-jit, jit)) * CELL, z: (oz + j + 0.5 + rng.range(-jit, jit)) * CELL,
      y: ch.floor[idx], ceil: ch.ceil[idx], idx };
  };
  const take = (cells, pred, jit = 0.25) => {
    for (let tries = 0; tries < 24; tries++) {
      const idx = rng.pick(cells);
      if (idx === undefined) return null;
      if (ch.flags[idx] & F_OCC) continue;
      if (pred && !pred(idx)) continue;
      ch.flags[idx] |= F_OCC;
      return cellPos(idx, jit);
    }
    return null;
  };
  let itemN = 0;
  const addItem = (it, p, ri) => {
    if (!p) return;
    it.id = L + ':' + ch.cx + ':' + ch.cz + ':' + (itemN++);
    it.x = p.x; it.z = p.z; it.y = p.y; it.ri = ri;
    ch.items.push(it);
  };
  const light = (x, y, z, c, rad, i) => ch.lights.push({ x, y, z, r: c[0], g: c[1], b: c[2], rad, i });
  const notTun = idx => !(ch.flags[idx] & F_TUNNEL);
  const addRune = (p, ri) => {
    if (!p) return;
    const word = runeWord(rng);
    ch.props.push({ t: 'rune', x: p.x, z: p.z, y: p.y, rot: rng.range(0, 6.28) });
    ch.features.push({ type: 'rune', x: p.x, z: p.z, y: p.y, word, ri });
    ch.colliders.push({ x: p.x, z: p.z, r: 0.6 });
    light(p.x, p.y + 1.6, p.z, [0.6, 0.4, 0.95], 6, 0.6);
  };
  const addCrystal = (p, lay, big) => {
    if (!p) return;
    ch.props.push({ t: 'crys', x: p.x, z: p.z, y: p.y, n: rng.int(3, 6), layer: lay, seed: rng.int(0, 1e6), s: big ? rng.range(0.8, 1.7) : rng.range(0.4, 0.8) });
    const c = CRYSTAL_LIGHT[lay];
    light(p.x, p.y + 1.2, p.z, c, big ? 9 : 6, big ? 0.9 : 0.6);
  };
  const addMush = (p, s) => {
    if (!p) return;
    ch.props.push({ t: 'mush', x: p.x, z: p.z, y: p.y, s });
    if (s > 1.1) ch.colliders.push({ x: p.x, z: p.z, r: 0.22 * s });
    light(p.x, p.y + s * 1.5, p.z, [0.3, 0.9, 0.8], 4 + s * 2.5, 0.7);
  };

  rooms.forEach((room, ri) => {
    room.name = roomName(room, rng);
    room.descIdx = rng.int(0, 999);
    const cells = room.cells;
    if (room.type === 'camp') { campSetup(ch, room, light); return; }
    const edge = idx => ch.tval[idx] > 0.5 && notTun(idx);
    // holes in the floor: easy to see by lamplight, deadly in the dark. Never on a
    // tunnel's path through the room, so every route stays walkable.
    if (L >= 1 && !['landing', 'lair', 'shrine', 'lake', 'lava', 'chasm'].includes(room.type)) {
      const nearShaft = idx => {
        const i = idx % CHUNK, j = (idx / CHUNK) | 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const a = i + dx, b = j + dz;
          if (a >= 0 && b >= 0 && a < CHUNK && b < CHUNK && (ch.flags[b * CHUNK + a] & (F_SHAFTDOWN | F_SHAFTUP))) return true;
        }
        return false;
      };
      const ok = idx => ch.kind[idx] === 1 && notTun(idx) && !(ch.flags[idx] & F_OCC) && ch.tval[idx] > 0.25 && ch.tval[idx] < 0.85 && !nearShaft(idx);
      // a hole must never cut part of the room off from the rest
      const connected = () => {
        const open = cells.filter(c => ch.kind[c] === 1);
        if (!open.length) return true;
        const seen = new Set([open[0]]), q = [open[0]];
        while (q.length) {
          const c = q.pop(), i = c % CHUNK, j = (c / CHUNK) | 0;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const a = i + dx, b = j + dz, k = b * CHUNK + a;
            if (a < 0 || b < 0 || a >= CHUNK || b >= CHUNK || seen.has(k) || ch.kind[k] !== 1) continue;
            seen.add(k); q.push(k);
          }
        }
        return open.every(c => seen.has(c));
      };
      const hole = idx => {
        const f = ch.floor[idx];
        ch.kind[idx] = 2; ch.floor[idx] = f - 40;
        if (!connected()) { ch.kind[idx] = 1; ch.floor[idx] = f; return false; }
        ch.flags[idx] |= F_OCC; return true;
      };
      const nh = Math.min(4, rng.int(0, 1 + Math.floor(L / 2)));
      for (let h = 0; h < nh; h++) {
        const p = take(cells, ok, 0);
        if (!p) continue;
        if (!hole(p.idx)) continue;
        room.holes = true;
        const i = p.idx % CHUNK, j = (p.idx / CHUNK) | 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = i + dx, b = j + dz, k = b * CHUNK + a;
          if (a >= 0 && b >= 0 && a < CHUNK && b < CHUNK && ch.room[k] === ri && ok(k) && rng.chance(0.35)) hole(k);
        }
      }
      for (let k = cells.length - 1; k >= 0; k--) if (ch.kind[cells[k]] !== 1) cells.splice(k, 1);
    }
    const n = cells.length;

    // stalactites hang over anything
    const nT = Math.floor(n * (room.type === 'grotto' ? 0.12 : 0.08));
    for (let k = 0; k < nT; k++) {
      const idx = rng.pick(cells); if (idx === undefined) break;
      const p = cellPos(idx, 0.4);
      const len = Math.min(rng.range(0.8, 3.4), p.ceil - p.y - 2.7);
      if (len > 0.5) ch.props.push({ t: 'tite', x: p.x, z: p.z, y: p.ceil + 0.4, r: rng.range(0.2, 0.55), h: len + 0.4, layer: reg.wall });
    }
    if (!['shrine', 'landing', 'lake', 'lava', 'lair'].includes(room.type)) {
      const nM = Math.floor(n * 0.05);
      for (let k = 0; k < nM; k++) {
        const p = take(cells, idx => ch.tval[idx] > 0.35 && notTun(idx), 0.35);
        if (!p) continue;
        const h = rng.range(0.7, Math.min(3.2, p.ceil - p.y - 1)), r = rng.range(0.25, 0.6);
        ch.props.push({ t: 'mite', x: p.x, z: p.z, y: p.y, r, h, layer: reg.wall });
        if (r > 0.35) ch.colliders.push({ x: p.x, z: p.z, r: r * 0.8 });
      }
    }
    const nRock = rng.int(0, room.type === 'cavern' ? 4 : 2);
    for (let k = 0; k < nRock; k++) {
      const p = take(cells, notTun, 0.3);
      if (!p) continue;
      const s = rng.range(0.3, 1.0);
      ch.props.push({ t: 'rock', x: p.x, z: p.z, y: p.y, s, seed: rng.int(0, 1e6), layer: reg.wall });
      if (s > 0.6) ch.colliders.push({ x: p.x, z: p.z, r: s * 0.85 });
    }
    switch (room.type) {
      case 'columns': case 'cavern': {
        const nc = room.type === 'columns' ? rng.int(4, 8) : rng.int(0, 2);
        for (let k = 0; k < nc; k++) {
          const p = take(cells, idx => notTun(idx) && ch.tval[idx] > 0.2, 0.2);
          if (!p) continue;
          const r = rng.range(0.6, 1.1);
          ch.props.push({ t: 'col', x: p.x, z: p.z, y0: p.y - 0.5, y1: p.ceil + 0.6, r, layer: reg.wall });
          ch.colliders.push({ x: p.x, z: p.z, r: r * 1.05 });
        }
        break;
      }
      case 'crystal': {
        const lay = rng.pick([T.CRYSTAL, T.CRYSTAL2, T.CRYSTAL3]);
        const nC = rng.int(6, 12);
        for (let k = 0; k < nC; k++) addCrystal(take(cells, edge, 0.3), lay, true);
        break;
      }
      case 'fungus': {
        const nF = rng.int(6, 14);
        for (let k = 0; k < nF; k++) addMush(take(cells, notTun, 0.3), rng.range(0.6, 2.2));
        break;
      }
      case 'lair': {
        // a hoard of treasure, and something asleep on it
        const cx0 = (ox + room.x) * CELL, cz0 = (oz + room.z) * CELL;
        const ci = Math.floor(room.x), cj = Math.floor(room.z), cidx = cj * CHUNK + ci;
        ch.features.push({ type: 'wyrm', id: L + ':' + ch.cx + ':' + ch.cz + ':w' + ri, x: cx0, z: cz0, y: ch.floor[cidx], r: room.r * CELL, face: rng.range(0, 6.28), ri });
        light(cx0, ch.floor[cidx] + 1.5, cz0, [1.0, 0.5, 0.2], 16, 0.7);
        for (let k = 0; k < 4; k++) {
          const p = take(cells, idx => ch.tval[idx] < 0.5, 0.4);
          if (!p) continue;
          const t = mkTreasure(rng, L + 2);
          t.value = Math.round(t.value * 2);
          addItem(t, p, ri);
        }
        for (let k = 0; k < 5; k++) { const p = take(cells, idx => ch.tval[idx] < 0.8, 0.4); if (p) ch.props.push({ t: 'bones', x: p.x, z: p.z, y: p.y, seed: rng.int(0, 1e6) }); }
        break;
      }
      case 'lava':
        light((ox + room.x) * CELL, room.baseY + 1, (oz + room.z) * CELL, [1.0, 0.45, 0.15], room.r * CELL * 1.2, 1.5);
        break;
      case 'lake':
        light((ox + room.x) * CELL, room.baseY + 2, (oz + room.z) * CELL, [0.25, 0.45, 0.6], room.r * CELL, 0.25);
        break;
      case 'shrine': {
        for (let k = 0; k < 6; k++) {
          const a = k / 6 * Math.PI * 2 + room.ph1, rr = room.r * 0.62;
          const i = Math.floor(room.x + Math.cos(a) * rr), j = Math.floor(room.z + Math.sin(a) * rr);
          if (i < 0 || j < 0 || i >= CHUNK || j >= CHUNK) continue;
          const idx = j * CHUNK + i;
          if (ch.kind[idx] !== 1 || (ch.flags[idx] & (F_OCC | F_TUNNEL))) continue;
          ch.flags[idx] |= F_OCC;
          const x = (ox + i + 0.5) * CELL, z = (oz + j + 0.5) * CELL;
          ch.props.push({ t: 'col', x, z, y0: ch.floor[idx] - 0.5, y1: ch.ceil[idx] + 0.6, r: 0.55, layer: T.STONE, square: true });
          ch.colliders.push({ x, z, r: 0.6 });
        }
        const ci = Math.floor(room.x), cj = Math.floor(room.z), cidx = cj * CHUNK + ci;
        if (ch.kind[cidx] === 1) { ch.flags[cidx] |= F_OCC; addRune({ x: (ox + room.x) * CELL, z: (oz + room.z) * CELL, y: ch.floor[cidx] }, ri); }
        break;
      }
    }
    if (L >= 4 && room.type !== 'crystal' && rng.chance(0.35)) addCrystal(take(cells, edge, 0.3), rng.pick([T.CRYSTAL, T.CRYSTAL2, T.CRYSTAL3]), false);
    if (L >= 3 && room.type !== 'fungus' && rng.chance(0.3)) for (let k = rng.int(1, 3); k > 0; k--) addMush(take(cells, notTun, 0.3), rng.range(0.4, 0.9));
    if (L >= 1 && room.type !== 'shrine' && room.type !== 'landing' && rng.chance(0.07)) addRune(take(cells, idx => notTun(idx) && ch.tval[idx] < 0.6, 0.1), ri);
    if (rng.chance(0.18)) { const p = take(cells, notTun, 0.3); if (p) ch.props.push({ t: 'bones', x: p.x, z: p.z, y: p.y, seed: rng.int(0, 1e6) }); }

    // items
    let tc = { crystal: 0.7, shrine: 0.8, cavern: 0.55, grotto: 0.6, hall: 0.45, lake: 0.5, chasm: 0.6, fungus: 0.55, lava: 0.75, columns: 0.5, landing: 0.2 }[room.type] || 0.5;
    if (L === 0) tc *= 0.55;
    if (rng.chance(tc)) addItem(mkTreasure(rng, L), take(cells), ri);
    if (rng.chance(tc * 0.25)) addItem(mkTreasure(rng, L), take(cells), ri);
    if (rng.chance(0.2)) addItem(mkOil(), take(cells), ri);
    if (rng.chance(0.12)) addItem(mkFood(rng), take(cells), ri);
    if (rng.chance(L === 0 ? 0.12 : 0.05)) addItem(mkAxe(), take(cells), ri);
  });
  if (rng.chance(0.3)) addItem(mkTreasure(rng, L), take(passage, null, 0.15), -1);
  if (rng.chance(0.1)) addItem(mkOil(), take(passage, null, 0.15), -1);
}

function campSetup(ch, room, light) {
  const ox = ch.cx * CHUNK, oz = ch.cz * CHUNK;
  const at = (i, j) => {
    const idx = j * CHUNK + i;
    ch.flags[idx] |= F_OCC;
    return { x: (ox + i + 0.5) * CELL, z: (oz + j + 0.5) * CELL, y: ch.floor[idx] };
  };
  const fire = at(16, 16);
  ch.props.push({ t: 'fire', x: fire.x, z: fire.z, y: fire.y });
  ch.features.push({ type: 'fire', x: fire.x, z: fire.z, y: fire.y });
  ch.colliders.push({ x: fire.x, z: fire.z, r: 0.7 });
  light(fire.x, fire.y + 1.2, fire.z, [1.0, 0.55, 0.22], 11, 1.4);
  const trunk = at(18, 14);
  ch.props.push({ t: 'trunk', x: trunk.x, z: trunk.z, y: trunk.y, rot: 0.4 });
  ch.features.push({ type: 'trunk', x: trunk.x, z: trunk.z, y: trunk.y });
  ch.colliders.push({ x: trunk.x, z: trunk.z, r: 0.85 });
  const barrel = at(14, 14);
  ch.props.push({ t: 'barrel', x: barrel.x, z: barrel.z, y: barrel.y });
  ch.features.push({ type: 'barrel', x: barrel.x, z: barrel.z, y: barrel.y });
  ch.colliders.push({ x: barrel.x, z: barrel.z, r: 0.6 });
  light((ox + CAMP.x) * CELL, room.baseY + 14, (oz + CAMP.z) * CELL, [0.95, 0.95, 0.85], 58, 2.6);
  const items = [[mkOil(), 15, 18], [{ kind: 'food', name: 'packet of stale biscuits', mesh: 'food', mat: 'CLOTH' }, 18, 17]];
  let n = 900;
  for (const [it, i, j] of items) {
    const p = at(i, j);
    it.id = '0:0:0:camp' + (n++); it.x = p.x; it.z = p.z; it.y = p.y; it.ri = 0;
    ch.items.push(it);
  }
  for (const [i, j] of [[12, 13], [20, 18], [19, 12], [11, 16]]) {
    const idx = j * CHUNK + i;
    if (ch.kind[idx] !== 1 || (ch.flags[idx] & F_OCC)) continue;
    const p = at(i, j);
    ch.props.push({ t: 'rock', x: p.x, z: p.z, y: p.y, s: 0.5, seed: i * 31 + j, layer: T.ROCK });
  }
}
function campSpawnPos() { return { x: (CAMP.spawnX + 0.5) * CELL, z: (CAMP.spawnZ + 0.5) * CELL }; }
function campCenterPos() { return { x: CAMP.x * CELL, z: CAMP.z * CELL }; }

// ---- geometry queries -----------------------------------------------------
// A corner sits at grid point (gx,gz) and touches cells (gx-1..gx, gz-1..gz).
// Corners are shared by everything that touches them, which keeps the mesh
// watertight while letting walls be jittered into an organic, low-poly shape.
function cornerData(L, gx, gz) {
  let nLedge = 0, sumL = 0, nOpen = 0, sumF = 0, nPit = 0, sumP = 0, nNS = 0, sumC = 0, maxC = -1e9, tall = false, sx = 0, sz = 0, nSolid = 0;
  for (let k = 0; k < 4; k++) {
    const ix = gx - 1 + (k & 1), iz = gz - 1 + (k >> 1);
    const ch = chunkAtGrid(L, ix, iz), idx = localIdx(ch, ix, iz), kind = ch.kind[idx];
    if (kind === 0) { nSolid++; sx += ix + 0.5 - gx; sz += iz + 0.5 - gz; continue; }
    nNS++; const c = ch.ceil[idx]; sumC += c; if (c > maxC) maxC = c;
    if (ch.flags[idx] & F_TALL) tall = true;
    if (kind === 1) { nOpen++; sumF += ch.floor[idx]; } else if (kind === 3) { nLedge++; sumL += ch.floor[idx]; } else { nPit++; sumP += ch.floor[idx]; }
  }
  const fl = nLedge ? sumL / nLedge : 0;
  const fo = nOpen ? sumF / nOpen : (nPit ? sumP / nPit : fl);
  const fp = nPit ? sumP / nPit : fo;
  const h = hrand(gx, gz, L, WORLD.seed);
  let c = nNS ? (tall ? maxC : sumC / nNS + (h - 0.5) * 0.6) : 0;
  let jx = 0, jz = 0;
  if (nSolid > 0 && nSolid < 4) { const l = Math.hypot(sx, sz); if (l > 0.01) { jx = sx / l; jz = sz / l; } }
  const amt = (0.12 + 0.3 * h) * CELL;
  return { gx, gz, x: gx * CELL + jx * amt, z: gz * CELL + jz * amt, fo, fp, fl: nLedge ? fl : fo, c, jx, jz,
    bul: (0.1 + 0.35 * hrand(gx, gz, L, 99)) * CELL };
}

// floor / ceiling / cell info under a world-space point
function groundInfo(L, x, z) {
  const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
  const ch = chunkAtGrid(L, gx, gz), idx = localIdx(ch, gx, gz), kind = puzzleKind(ch, idx);
  const info = { kind, ch, idx, gx, gz, flags: ch.flags[idx], liquid: ch.liquid[idx], room: ch.room[idx], floor: 0, ceil: 0 };
  if (kind === 0) { info.floor = 1e9; info.ceil = -1e9; return info; }
  const br = ch.pbridge && kind !== ch.kind[idx] ? ch.pbridge.get(idx) : null;
  const fx = x / CELL - gx, fz = z / CELL - gz;
  const c00 = cornerData(L, gx, gz), c10 = cornerData(L, gx + 1, gz), c01 = cornerData(L, gx, gz + 1), c11 = cornerData(L, gx + 1, gz + 1);
  const f = kind === 2 ? 'fp' : kind === 3 ? 'fl' : 'fo';
  const bil = (a, b, c, d) => (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  info.floor = br ? br.y : bil(c00[f], c10[f], c01[f], c11[f]);
  info.ceil = bil(c00.c, c10.c, c01.c, c11.c);
  return info;
}

// ---- names & descriptions -------------------------------------------------
const NAME_ADJ = ['Dripping', 'Echoing', 'Crooked', 'Hollow', 'Sunken', 'Whispering', 'Shattered', 'Forgotten', 'Weeping', 'Pale',
  'Twisted', 'Silent', 'Broken', 'Drowned', 'Gloomy', 'Restless', 'Hungry', 'Lonely', 'Ancient', 'Breathing', 'Bleak', 'Velvet',
  'Rusted', 'Starless', 'Murmuring', 'Glistening', 'Lost', 'Sleeping'];
const NAME_NOUN = {
  cavern: ['Cavern', 'Vault', 'Dome', 'Great Chamber', 'Cathedral'], grotto: ['Grotto', 'Nook', 'Hollow', 'Pocket', 'Cell'],
  hall: ['Hall', 'Gallery', 'Corridor', 'Promenade'], lake: ['Lake', 'Mere', 'Pool', 'Cistern', 'Lagoon'],
  chasm: ['Chasm', 'Rift', 'Gulf', 'Fissure'], crystal: ['Geode', 'Crystal Hall', 'Prism Vault', 'Glimmerhall'],
  fungus: ['Mushroom Garden', 'Spore Hall', 'Mycelium Grove', 'Fungal Wood'], lava: ['Furnace', 'Forge', 'Cinder Hall', 'Magma Vault'],
  shrine: ['Shrine', 'Sanctum', 'Chapel', 'Altar Room'], columns: ['Pillared Hall', 'Column Forest', 'Colonnade'],
  landing: ['Shaft Bottom', 'Rope Landing', 'Well Bottom'],
  lair: ['Lair', 'Smoking Cavern', 'Hoard Hall', 'Scorched Vault'],
};
const NAME_OF = ['of Echoes', 'of Bones', 'of the Lost Miner', 'of a Thousand Drips', 'of Whispers', 'of the Pale King',
  'of Broken Lanterns', 'of Old Teeth', 'of the Sleeper', 'of Rust', 'of Small Mercies', 'of Regret', 'of the Blind Fish',
  'of Glass', 'of Long Shadows', 'of the Patient Dark', 'of Forgotten Names', 'of Cold Breath'];
function roomName(room, rng) {
  if (room.type === 'camp') return 'the Sunlit Sinkhole';
  const noun = rng.pick(NAME_NOUN[room.type] || NAME_NOUN.grotto);
  return rng.chance(0.5) ? 'the ' + rng.pick(NAME_ADJ) + ' ' + noun : 'the ' + noun + ' ' + rng.pick(NAME_OF);
}
const DESC = {
  cavern: ['You are standing in an immense cavern. The light of your lamp is swallowed long before it reaches the far walls.',
    'You are in a vast, echoing chamber. Somewhere high above, water drips onto stone with the patience of centuries.',
    'The passage opens into a cathedral-sized cavern whose roof is lost in shadow. Great teeth of rock jut from floor and ceiling.'],
  grotto: ['You are in a small, damp grotto. The walls glisten with moisture.',
    'You have squeezed into a cramped hollow barely larger than a cottage kitchen.',
    'This is a low, snug chamber whose walls are rippled like frozen curtains.'],
  hall: ['You are in a long hall with a surprisingly level floor, as though something once smoothed it on purpose.',
    'You stand in a broad gallery. Faint scratches on the walls might be tally marks, or claw marks.',
    'You are in a wide, high-roofed hall. Your footsteps come back to you a moment too late.'],
  lake: ['You are on the shore of a still underground lake. The black water is so clear it seems to be holding its breath.',
    'A cold subterranean pool fills the middle of this chamber. Ripples spread from somewhere you cannot see.',
    'The floor slopes down into a shallow, glassy mere. It looks cold, but wadeable.'],
  chasm: ['A yawning chasm splits this chamber in two. Pebbles you kick over the edge make no sound at all.',
    'You stand at the lip of a fissure that drops into absolute darkness. A natural span of rock crosses it.',
    'A deep rift cuts across the floor here. Cold air breathes up out of it, smelling of nothing at all.'],
  crystal: ['You are in a geode the size of a ballroom. Crystals jut from every surface, humming with their own cold light.',
    'Glittering crystal formations line this chamber, throwing your shadow in a dozen directions at once.',
    'Luminous crystals cluster along the walls like frozen fireworks.'],
  fungus: ['Giant mushrooms crowd this cavern, their caps pulsing with a soft, sickly glow. The air smells of wet bread.',
    'You are in a fungal garden. Spores drift lazily through the light like snow falling the wrong way.',
    'Glowing toadstools as tall as a man stand about like silent guests at a party nobody invited you to.'],
  lava: ['Heat slams into you. A pool of molten rock seethes in the middle of this chamber, painting the walls a furious orange.',
    'You are in a sweltering cavern around a glowing pit of lava. The air shimmers and your eyebrows feel endangered.',
    'A lake of fire churns slowly here. Stay well back from the edge.'],
  shrine: ['You are in a small, carefully shaped chamber. Pillars stand in a ring as if guarding something.',
    'This chamber was made, not found. Worked pillars surround a weathered standing stone.',
    'You have found a forgotten shrine. Whoever carved these pillars took great care, and then left in a great hurry.'],
  columns: ['You are in a forest of stone. Thick columns, where stalactites have met stalagmites over aeons, hold up the roof.',
    'Pillars of dripstone rise all around you, some as thick as old oaks.'],
  lair: ['The air here is hot and reeks of sulphur and old smoke. Bones crunch underfoot. In the middle of the cavern, curled on a glittering heap of treasure, something enormous is asleep.',
    'Scorch marks streak the walls of this vast cavern. Something huge breathes slowly in the dark, each breath a low rumble, and treasure glints all around it.'],
  landing: ['You are at the bottom of a narrow shaft.', 'You are in a small chamber at the foot of a vertical shaft.'],
  vault: ['You are in a small strongroom hewn from the living rock. Someone went to a great deal of trouble to keep people out of here.',
    'This is a squat, square vault behind the iron gate. The walls bear chisel marks and, here and there, a scratched warning in no language you know.'],
  den: ['You are in a snug burrow that smells of earth and old dinners. Shiny things have been carefully hoarded in a corner.',
    'This is the mole\'s larder: a round, warm chamber lined with bedding, beetle shells and, oddly, treasure.'],
  far: ['You are on the far side of the gap, in a little grotto that nobody has set foot in for a very long time.',
    'You have crossed to a lonely chamber beyond the gap. The dust lies thick and undisturbed.'],
  cellar: ['You are in a low storeroom behind the rusted door. Mouldering shelves line the walls, and something glints on the floor.',
    'This is an old workshop, abandoned long ago. Rusted tools hang from pegs, untouched since the door last closed.'],
  shelf: ['You are on a high, narrow shelf in the rock. The cavern floor is a long way down.',
    'This is a hidden shelf high in the cavern wall, reachable only by something that grows.'],
  camp: ['You are in a great sinkhole open to the sky. Daylight spills down the mossy walls onto your camp: a battered trunk for treasure, a barrel of lamp oil and a smouldering fire. Dark passages lead off into the hillside.'],
};
const NUMW = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
function describeRoom(ch, ri) {
  const room = ch.rooms[ri], reg = regionFor(ch.L), parts = [];
  const list = DESC[room.type] || DESC.grotto;
  parts.push(list[room.descIdx % list.length]);
  if (room.type !== 'camp' && room.descIdx % 3 === 0) parts.push(reg.flavor[room.descIdx % reg.flavor.length]);
  if (room.ropeDown && room.type !== 'camp') parts.push('A knotted rope, tied off on a crude wooden frame, hangs down into a black shaft in the floor.');
  if (room.holes) parts.push(['Black holes gape in the floor here and there. Mind your step.', 'The floor is pocked with sudden, bottomless holes.', 'Several dark pits break the floor. Pebbles you nudge into them never land.'][room.descIdx % 3]);
  if (room.chuteDown) parts.push('A smooth, steep chute plunges down through the floor, polished by who knows what. You could slide down it, but you would never climb back up.');
  if (room.type === 'camp') parts.push('Beside the fire, a knotted rope hangs down a black shaft into the deeper cave.');
  if (room.landing) parts.push(room.landing.chute ? 'High above, a chute opens in the ceiling, far too steep and slick to climb. There is no going back that way.'
    : 'A rope dangles from a dark shaft in the ceiling: the way back up.');
  const rune = ch.features.find(f => f.type === 'rune' && f.ri === ri);
  if (rune) parts.push('A weathered standing stone bears a single carved word: "' + rune.word + '".');
  if (room.type !== 'camp') {
    const ex = room.exits;
    if (ex === 1) parts.push('A single passage leads away.');
    else if (ex > 1) parts.push('Passages lead off in ' + (NUMW[ex] || 'many') + ' directions.');
  }
  return parts.join(' ');
}
const PASSAGE_DESC = ['You are in a low, twisting passage.', 'You are in a narrow, winding tunnel.',
  'You are in a damp passage. Water trickles along the floor.', 'You are in a crooked passage whose walls press close on either side.',
  'You are in a passage that zigzags as if it could not make up its mind.', 'You are in a rough tunnel scored with ancient tool marks.'];

// ---- puzzles: sealed pockets behind obstacles ------------------------------
// After a chunk is carved, we may dig a small sealed chamber off one of its
// rooms, joined by a one-cell-wide corridor, and put an obstacle in the way.
// The thing that gets you past it is placed elsewhere in the same chunk.
const POCKET_NAMES = {
  vault: ['the Iron-Barred Vault', 'the Forgotten Strongroom', 'the Locked Treasury', 'the Miser\'s Cell'],
  den: ['the Mole\'s Larder', 'the Burrow Hoard', 'the Warm Den'],
  far: ['the Far Grotto', 'the Stranded Chamber', 'the Other Side'],
  shelf: ['the High Shelf', 'the Overhang', 'the Hidden Ledge'],
  cellar: ['the Rusted Cellar', 'the Old Storeroom', 'the Forgotten Workshop'],
};
function mkKey() { return { kind: 'key', name: 'brass key', mesh: 'key', mat: 'GOLD' }; }
function mkPlanks() { return { kind: 'planks', name: 'bundle of planks', mesh: 'planks', mat: 'WOOD' }; }
function mkSkin() { return { kind: 'skin', name: 'empty waterskin', mesh: 'skin', mat: 'CLOTH', full: false }; }
function puzzleKind(ch, idx) {
  const k = ch.kind[idx];
  if (k === 2 && ch.pbridge) { const b = ch.pbridge.get(idx); if (b && WORLD.solved.has(b.id)) return 1; }
  return k;
}
function puzzleBlocked(ch, idx) {
  if (!ch.pblock) return false;
  const id = ch.pblock.get(idx);
  return !!id && !WORLD.solved.has(id);
}
function maybeAddPuzzle(ch, rng) {
  const L = ch.L;
  if (!rng.chance(L === 0 ? 0.25 : 0.42)) return;
  let type = rng.pick(L === 0 ? ['gate', 'mole', 'gap', 'door'] : ['gate', 'mole', 'gap', 'door', 'vine', 'vine']);
  const hasLake = ch.rooms.some(r => r.type === 'lake');
  if (type === 'vine' && !hasLake) type = rng.pick(['gate', 'gap', 'mole']);
  else if (hasLake && L >= 1 && rng.chance(0.5)) type = 'vine';
  for (let tries = 0; tries < 40; tries++) if (tryPuzzle(ch, rng, type)) return;
}
function tryPuzzle(ch, rng, type) {
  const L = ch.L, rooms = ch.rooms;
  const ri = rng.int(0, rooms.length - 1), room = rooms[ri];
  if (!room || room.pocket || ['camp', 'landing', 'lava', 'chasm', 'lake', 'lair'].includes(room.type) || !room.cells.length) return false;
  const dir = rng.pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
  let x = clamp(Math.floor(room.x), 0, CHUNK - 1), z = clamp(Math.floor(room.z), 0, CHUNK - 1);
  if (ch.kind[z * CHUNK + x] !== 1) return false;
  for (let s = 0; ; s++) {
    const nx = x + dir[0], nz = z + dir[1];
    if (s > 20 || nx < 1 || nz < 1 || nx > CHUNK - 2 || nz > CHUNK - 2) return false;
    if (ch.kind[nz * CHUNK + nx] === 0) break;
    x = nx; z = nz;
  }
  const B = z * CHUNK + x;
  if (ch.room[B] !== ri || ch.kind[B] !== 1 || (ch.flags[B] & (F_LIQUID | F_LAVA | F_SHAFTDOWN | F_SHAFTUP | F_OCC))) return false;
  const vine = type === 'vine';
  const LC = vine ? 2 : 4, PR = 2.2;
  const ex = x + dir[0], ez = z + dir[1];
  const pcx = ex + dir[0] * (LC + 2) + 0.5, pcz = ez + dir[1] * (LC + 2) + 0.5;
  const solid = (i, j) => i >= 1 && j >= 1 && i <= CHUNK - 2 && j <= CHUNK - 2 && ch.kind[j * CHUNK + i] === 0;
  const px = dir[1], pz = dir[0];
  for (let k = 0; k < LC; k++) {
    const i = ex + dir[0] * k, j = ez + dir[1] * k;
    if (!solid(i, j) || !solid(i + px, j + pz) || !solid(i - px, j - pz)) return false;
  }
  const R2 = PR + 1.3;
  for (let j = Math.floor(pcz - R2); j <= Math.floor(pcz + R2); j++) for (let i = Math.floor(pcx - R2); i <= Math.floor(pcx + R2); i++) {
    if (Math.hypot(i + 0.5 - pcx, j + 0.5 - pcz) <= R2 && !solid(i, j)) return false;
  }
  // --- carve it
  const base = ch.floor[B];
  const pType = { gate: 'vault', mole: 'den', gap: 'far', vine: 'shelf', door: 'cellar' }[type];
  const pri = rooms.length;
  const proom = { type: pType, x: pcx, z: pcz, r: PR, h: 4.5, pocket: true, exits: 1, cells: [], seed: rng.int(0, 1e9),
    descIdx: rng.int(0, 999), name: rng.pick(POCKET_NAMES[pType]), baseY: base };
  rooms.push(proom);
  const floorY = vine ? base + 3.4 : base, kind = vine ? 3 : 1;
  const setCell = (i, j, r2, ceilH) => {
    const idx = j * CHUNK + i;
    ch.kind[idx] = kind; ch.floor[idx] = floorY; ch.ceil[idx] = floorY + ceilH;
    ch.room[idx] = r2; ch.flags[idx] = F_OCC; ch.tval[idx] = 9;
    return idx;
  };
  for (let k = 0; k < LC; k++) setCell(ex + dir[0] * k, ez + dir[1] * k, vine ? pri : -1, 3.4);
  for (let j = Math.floor(pcz - PR); j <= Math.floor(pcz + PR); j++) for (let i = Math.floor(pcx - PR); i <= Math.floor(pcx + PR); i++) {
    if (Math.hypot(i + 0.5 - pcx, j + 0.5 - pcz) > PR) continue;
    proom.cells.push(setCell(i, j, pri, 4.4));
  }
  const W = (i, j) => [(ch.cx * CHUNK + i + 0.5) * CELL, (ch.cz * CHUNK + j + 0.5) * CELL];
  const id = L + ':' + ch.cx + ':' + ch.cz + ':pz';
  const [fx, fz] = W(ex, ez);
  const pz0 = { id, type, dir, y: base, fx, fz, ri: pri };
  if (type === 'gate' || type === 'mole' || type === 'door') {
    const oi = ex + dir[0], oj = ez + dir[1];
    ch.pblock = new Map([[oj * CHUNK + oi, id]]);
    [pz0.ox, pz0.oz] = W(oi, oj);
    [pz0.rx, pz0.rz] = [pcx * CELL + ch.cx * CHUNK * CELL + px * 1.2, pcz * CELL + ch.cz * CHUNK * CELL + pz * 1.2];
  } else if (type === 'gap') {
    ch.pbridge = new Map();
    for (const k of [1, 2]) {
      const idx = (ez + dir[1] * k) * CHUNK + ex + dir[0] * k;
      ch.kind[idx] = 2; ch.floor[idx] = base - 40;
      ch.pbridge.set(idx, { id, y: base });
    }
    const a = W(ex + dir[0], ez + dir[1]), b = W(ex + dir[0] * 2, ez + dir[1] * 2);
    pz0.ox = (a[0] + b[0]) / 2; pz0.oz = (a[1] + b[1]) / 2;
  } else {
    ch.flags[B] |= F_OCC;
    // open up a tall alcove above the bulb so the shelf mouth has headroom
    ch.ceil[B] = Math.max(ch.ceil[B], ch.floor[B] + 8);
    for (const [ax, az] of [[px, pz], [-px, -pz], [-dir[0], -dir[1]]]) {
      const j = (z + az) * CHUNK + x + ax;
      if (ch.kind[j] === 1) ch.ceil[j] = Math.max(ch.ceil[j], ch.floor[j] + 6.5);
    }
    [pz0.bx, pz0.bz] = W(x, z);
    pz0.ledgeY = floorY;
  }
  ch.puzzles.push(pz0);
  // the reward
  for (let k = 0; k < 2; k++) {
    const idx = proom.cells[rng.int(0, proom.cells.length - 1)];
    const t = mkTreasure(rng, L + 1);
    t.value = Math.round(t.value * 1.5);
    t.id = L + ':' + ch.cx + ':' + ch.cz + ':pt' + k;
    t.x = (ch.cx * CHUNK + idx % CHUNK + 0.5 + rng.range(-0.3, 0.3)) * CELL; t.z = (ch.cz * CHUNK + Math.floor(idx / CHUNK) + 0.5 + rng.range(-0.3, 0.3)) * CELL;
    t.y = floorY; t.ri = pri;
    ch.items.push(t);
  }
  // the thing that solves it, somewhere else in this chunk
  const sol = type === 'gate' ? mkKey() : type === 'mole' ? mkFood(rng) : type === 'gap' ? mkPlanks() : type === 'door' ? mkOil() : mkSkin();
  const cands = rooms.filter(r => !r.pocket && r.cells.length);
  for (let tries = 0; tries < 30 && cands.length; tries++) {
    const r = rng.pick(cands), idx = rng.pick(r.cells);
    if (ch.flags[idx] & F_OCC) continue;
    ch.flags[idx] |= F_OCC;
    sol.id = L + ':' + ch.cx + ':' + ch.cz + ':ps';
    sol.x = (ch.cx * CHUNK + idx % CHUNK + 0.5) * CELL; sol.z = (ch.cz * CHUNK + Math.floor(idx / CHUNK) + 0.5) * CELL;
    sol.y = ch.floor[idx]; sol.ri = rooms.indexOf(r);
    ch.items.push(sol);
    break;
  }
  return true;
}

// ---- the Tangle: maze chunks -------------------------------------------------
function carveMaze(ch, rng) {
  const L = ch.L, M = 15;
  const open = (i, j) => {
    if (i < 0 || j < 0 || i >= CHUNK || j >= CHUNK) return;
    const idx = j * CHUNK + i;
    if (ch.kind[idx]) return;
    const wx = (ch.cx * CHUNK + i + 0.5) * CELL, wz = (ch.cz * CHUNK + j + 0.5) * CELL;
    const base = floorBase(wx, wz, L);
    ch.kind[idx] = 1; ch.floor[idx] = base;
    ch.ceil[idx] = base + 3.3 + vnoise(wx * 0.5, wz * 0.5, WORLD.seed + 9) * 0.8;
    ch.room[idx] = -1; ch.flags[idx] |= F_TUNNEL;
  };
  const seen = new Uint8Array(M * M);
  const s0 = [rng.int(0, M - 1), rng.int(0, M - 1)], stack = [s0];
  seen[s0[1] * M + s0[0]] = 1; open(s0[0] * 2 + 1, s0[1] * 2 + 1);
  while (stack.length) {
    const [i, j] = stack[stack.length - 1];
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => {
      const a = i + dx, b = j + dz;
      return a >= 0 && b >= 0 && a < M && b < M && !seen[b * M + a];
    });
    if (!nb.length) { stack.pop(); continue; }
    const [dx, dz] = rng.pick(nb), a = i + dx, b = j + dz;
    seen[b * M + a] = 1;
    open(i * 2 + 1 + dx, j * 2 + 1 + dz); open(a * 2 + 1, b * 2 + 1);
    stack.push([a, b]);
  }
  for (let k = 0; k < 8; k++) {
    const i = rng.int(0, M - 2), j = rng.int(0, M - 1);
    if (rng.chance(0.5)) open(i * 2 + 2, j * 2 + 1); else open(j * 2 + 1, i * 2 + 2);
  }
  const pE = portalE(ch.cx, ch.cz, L), pW = portalE(ch.cx - 1, ch.cz, L), pS = portalS(ch.cx, ch.cz, L), pN = portalS(ch.cx, ch.cz - 1, L);
  for (let i = 29; i < CHUNK; i++) open(i, pE);
  for (let i = 0; i <= 1; i++) open(i, pW);
  for (let j = 29; j < CHUNK; j++) open(pS, j);
  for (let j = 0; j <= 1; j++) open(pN, j);
}
function mazeHoard(ch, rng) {
  const ends = [];
  for (let j = 1; j < CHUNK - 1; j++) for (let i = 1; i < CHUNK - 1; i++) {
    const idx = j * CHUNK + i;
    if (ch.kind[idx] !== 1 || ch.room[idx] >= 0 || (ch.flags[idx] & F_OCC)) continue;
    let n = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (ch.kind[(j + dz) * CHUNK + i + dx]) n++;
    if (n === 1) ends.push(idx);
  }
  const put = (it, tag) => {
    if (!ends.length) return;
    const idx = ends.splice(rng.int(0, ends.length - 1), 1)[0];
    it.id = ch.L + ':' + ch.cx + ':' + ch.cz + ':' + tag;
    it.x = (ch.cx * CHUNK + idx % CHUNK + 0.5) * CELL; it.z = (ch.cz * CHUNK + Math.floor(idx / CHUNK) + 0.5) * CELL;
    it.y = ch.floor[idx]; it.ri = -1;
    ch.items.push(it);
  };
  for (let k = 0; k < 3; k++) { const t = mkTreasure(rng, ch.L + 1); t.value = Math.round(t.value * 1.4); put(t, 'm' + k); }
  put(mkOil(), 'mo');
}
const MAZE_DESC = 'You are in a tangle of cramped tunnels, each one indistinguishable from the last.';
