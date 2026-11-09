'use strict';
// ---------------------------------------------------------------------------
// The game: player, text parser, items, creatures, lamp, map, save, HUD.
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);
const canvas = $('gl'), hud = $('hud'), logEl = $('log'), promptEl = $('prompt'), cmdEl = $('cmd'), consoleEl = $('console');
const overlay = $('overlay'), mini = $('minimap'), miniCtx = mini.getContext('2d'), big = $('bigmap'), bigCtx = big.getContext('2d');
const MAX_INV = 7, SAVE_KEY = 'endless-cave-save-v1', SENS_KEY = 'endless-cave-sens', BASE_SENS = 0.0022, EYE = 1.6, RADIUS = 0.42;
const RES_STEPS = [180, 240, 300, 400, 540];
let resIdx = 2;
let R = null;
let sensMul = 1;
try { const v = parseFloat(localStorage.getItem(SENS_KEY)); if (v >= 0.1 && v <= 4) sensMul = v; } catch (e) { /* ignore */ }

const modelCache = new Map();
function getModel(name, mat) {
  const key = name + ':' + mat;
  let m = modelCache.get(key);
  if (!m) { m = R.createMesh(buildModel(name, typeof mat === 'string' ? T[mat] : mat)); modelCache.set(key, m); }
  return m;
}

let S = null;                      // persistent game state
let mode = 'loading';              // loading | title | play | paused | dead | over
let worldItems = [];               // items spawned from loaded chunks
const loaded = new Map();          // chunk meshes on the current level
let loadedLevel = -1;
let creatures = [], projectiles = [], particles = [];
let consoleOpen = false, mapOpen = false;
const keys = {};
let mouseDX = 0, mouseDY = 0;
let fade = 1, fadeTarget = 0, flash = 0;
const flashCol = [0.75, 0.06, 0.02];
let gameTime = 0, lastFrame = 0;
let spawnTimer = 25, darkTimer = 0, darkWarned = false, lavaT = 0, knifeMsgT = 0, healMsgT = 0;
let interactTarget = null, hudT = 0, mapT = 0, bobPhase = 0, bobAmt = 0, stepAcc = 0, throwAnim = 0, wasWet = false;
let pending = null;
const cmdHistory = [];
let histIdx = 0;

// ---------------------------------------------------------------- text log
function log(text, cls = '') {
  if (!text) return;
  const el = document.createElement('div');
  el.className = 'line ' + cls;
  el.textContent = text;
  logEl.appendChild(el);
  while (logEl.children.length > 60) logEl.removeChild(logEl.firstChild);
}
function art(name) { return (/^[aeiou]/i.test(name) ? 'an ' : 'a ') + name; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------------------------------------------------------------- state
function newState(seed) {
  return {
    seed, level: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, onGround: true,
    health: 100, lives: 3, lampOn: true, fuel: 100, inv: [],
    score: { rooms: 0, finds: 0, banked: 0, depth: 0, deaths: 0, hints: 0, escape: 0, slain: 0 },
    solved: new Set(), hintsBought: new Set(), closing: false, closeT: 0, endDone: false, slain: new Set(), metWyrm: false,
    banked: [], removed: new Set(), dropped: [], visited: new Set(), found: new Set(), runes: {},
    deepest: 0, time: 0, map: {}, kills: 0, verbose: false, curRoom: '', lastSafe: null, knives: 0, metGloom: false,
  };
}
function totalScore() { const s = S.score; return s.rooms + s.finds + s.banked + s.depth - s.deaths * 10 - (s.hints || 0) + (s.escape || 0) + (s.slain || 0); }
const RANKS = [[0, 'Lost Tourist'], [20, 'Weekend Spelunker'], [60, 'Cave Wanderer'], [120, 'Lamp-Bearer'], [220, 'Seasoned Delver'],
  [400, 'Deep Explorer'], [700, 'Master Spelunker'], [1100, 'Hollow-Walker'], [1600, 'Keeper of the Endless Cave']];
function rankFor(sc) { let r = RANKS[0][1]; for (const [n, t] of RANKS) if (sc >= n) r = t; return r; }

function setupWorld(seed) {
  WORLD.seed = seed >>> 0;
  clearWorldCaches();
  unloadAll();
}
function startNewGame(seed) {
  setupWorld(seed);
  S = newState(WORLD.seed);
  WORLD.solved = S.solved;
  const sp = campSpawnPos();
  S.x = sp.x; S.z = sp.z; S.yaw = 0;
  creatures = []; projectiles = []; particles = [];
  streamChunks(true);
  S.y = groundInfo(0, S.x, S.z).floor;
  logEl.innerHTML = '';
}

// ---------------------------------------------------------------- streaming
function rectDist(x, z, cx, cz) {
  const CW = CELL * CHUNK;
  const dx = Math.max(cx * CW - x, 0, x - (cx + 1) * CW), dz = Math.max(cz * CW - z, 0, z - (cz + 1) * CW);
  return Math.hypot(dx, dz);
}
function streamChunks(sync) {
  if (loadedLevel !== S.level) { unloadAll(); loadedLevel = S.level; }
  const CW = CELL * CHUNK, pcx = Math.floor(S.x / CW), pcz = Math.floor(S.z / CW);
  const want = [];
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const d = rectDist(S.x, S.z, pcx + dx, pcz + dz);
    if (d < 50) want.push({ cx: pcx + dx, cz: pcz + dz, d });
  }
  want.sort((a, b) => a.d - b.d);
  let built = 0;
  for (const w of want) {
    if (loaded.has(w.cx + ',' + w.cz)) continue;
    if (!sync && built >= 1) break;
    loadChunk(w.cx, w.cz); built++;
  }
  for (const [k, e] of loaded) if (rectDist(S.x, S.z, e.cx, e.cz) > 85) unloadChunk(k, e);
}
function loadChunk(cx, cz) {
  const L = S.level, data = buildChunkMesh(cx, cz, L), ch = getChunk(cx, cz, L), key = cx + ',' + cz;
  loaded.set(key, { cx, cz, ch, mesh: R.createMesh(data.opaque), water: data.water.length ? R.createMesh(data.water) : null });
  spawnWyrmsFor(ch);
  for (const it of ch.items) {
    if (S.removed.has(it.id)) continue;
    worldItems.push(Object.assign({}, it, { ck: key, y: groundInfo(L, it.x, it.z).floor, ph: Math.random() * 6,
      rk: it.ri >= 0 ? L + ':' + cx + ':' + cz + ':' + it.ri : '' }));
  }
}
function unloadChunk(key, e) {
  R.deleteMesh(e.mesh); R.deleteMesh(e.water); loaded.delete(key);
  worldItems = worldItems.filter(it => it.ck !== key);
  const pre = S.level + ':' + e.cx + ':' + e.cz + ':w';
  creatures = creatures.filter(c => !(c.type === 'wyrm' && c.id.startsWith(pre)));
}
function unloadAll() {
  for (const [k, e] of loaded) { R.deleteMesh(e.mesh); R.deleteMesh(e.water); }
  loaded.clear(); worldItems = []; loadedLevel = -1;
}
function itemsHere() { return worldItems.concat(S.dropped.filter(d => d.L === S.level)); }
function roomKeyAt(L, x, z) {
  const g = groundInfo(L, x, z);
  return g.room >= 0 ? L + ':' + g.ch.cx + ':' + g.ch.cz + ':' + g.room : '';
}

// ---------------------------------------------------------------- light
function sampleLight(x, y, z) {
  const amb = regionFor(S.level).amb;
  let r = amb[0], g = amb[1], b = amb[2];
  for (const e of loaded.values()) for (const l of e.ch.lights) {
    const dx = l.x - x, dy = l.y - y, dz = l.z - z, d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > l.rad * l.rad) continue;
    let a = 1 - Math.sqrt(d2) / l.rad; a = a * a * l.i * 0.7;
    r += l.r * a; g += l.g * a; b += l.b * a;
  }
  return [r, g, b];
}
function lampLevel() {
  if (!S.lampOn || S.fuel <= 0) return 0;
  let p = S.fuel < 15 ? 0.45 + 0.55 * S.fuel / 15 : 1;
  p *= 1 + Math.sin(gameTime * 23) * 0.025 + Math.sin(gameTime * 7.3) * 0.035 + (S.fuel < 8 ? (Math.random() - 0.5) * 0.3 : 0);
  return p;
}
function ambientLum(x, y, z) { const l = sampleLight(x, y, z); return (l[0] + l[1] + l[2]) / 3; }
function isLit() { return lampLevel() > 0 || ambientLum(S.x, S.y + 1, S.z) > 0.15; }

// ---------------------------------------------------------------- physics
function blockedCell(L, gx, gz, feet) {
  const ch = chunkAtGrid(L, gx, gz), idx = localIdx(ch, gx, gz), k = puzzleKind(ch, idx);
  if (k === 0 || puzzleBlocked(ch, idx)) return true;
  return (k === 1 || k === 3) && ch.kind[idx] !== 2 && ch.floor[idx] > feet + 1.25;
}
function collide(L, x, z, r, feet) {
  for (let it = 0; it < 3; it++) {
    for (const e of loaded.values()) for (const c of e.ch.colliders) {
      const dx = x - c.x, dz = z - c.z, rr = r + c.r, d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-8) continue;
      const d = Math.sqrt(d2); x += dx / d * (rr - d); z += dz / d * (rr - d);
    }
    const gx0 = Math.floor((x - r) / CELL), gx1 = Math.floor((x + r) / CELL), gz0 = Math.floor((z - r) / CELL), gz1 = Math.floor((z + r) / CELL);
    for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
      if (!blockedCell(L, gx, gz, feet)) continue;
      const minx = gx * CELL, maxx = minx + CELL, minz = gz * CELL, maxz = minz + CELL;
      const px = clamp(x, minx, maxx), pz = clamp(z, minz, maxz);
      const dx = x - px, dz = z - pz, d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) { const d = Math.sqrt(d2); x += dx / d * (r - d); z += dz / d * (r - d); }
      else {
        const dl = x - minx, dr = maxx - x, dn = z - minz, ds = maxz - z, m = Math.min(dl, dr, dn, ds);
        if (m === dl) x = minx - r; else if (m === dr) x = maxx + r; else if (m === dn) z = minz - r; else z = maxz + r;
      }
    }
  }
  return [x, z];
}
function los(L, ax, ay, az, bx, by, bz) {
  const d = Math.hypot(bx - ax, by - ay, bz - az), n = Math.ceil(d / 0.6);
  for (let i = 1; i < n; i++) {
    const t = i / n, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    const ch = chunkAtGrid(L, gx, gz), idx = localIdx(ch, gx, gz);
    if (ch.kind[idx] === 0) return false;
    if ((ch.kind[idx] === 1 || ch.kind[idx] === 3) && (y < ch.floor[idx] - 0.4 || y > ch.ceil[idx] + 0.6)) return false;
  }
  return true;
}
function findOpenNear(L, x, z) {
  const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
  for (let r = 0; r < 8; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const ch = chunkAtGrid(L, gx + dx, gz + dz), idx = localIdx(ch, gx + dx, gz + dz);
    if (ch.kind[idx] !== 1 || (ch.flags[idx] & F_LAVA)) continue;
    return r === 0 ? [x, z] : [(gx + dx + 0.5) * CELL, (gz + dz + 0.5) * CELL];
  }
  return [x, z];
}
function camFwd() { const cp = Math.cos(S.pitch); return [-Math.sin(S.yaw) * cp, Math.sin(S.pitch), -Math.cos(S.yaw) * cp]; }

function updatePlayer(dt) {
  const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw), rx = Math.cos(S.yaw), rz = -Math.sin(S.yaw);
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.ArrowUp) { ix += fx; iz += fz; }
  if (keys.KeyS || keys.ArrowDown) { ix -= fx; iz -= fz; }
  if (keys.KeyD || keys.ArrowRight) { ix += rx; iz += rz; }
  if (keys.KeyA || keys.ArrowLeft) { ix -= rx; iz -= rz; }
  const il = Math.hypot(ix, iz);
  let g = groundInfo(S.level, S.x, S.z);
  const wet = !!(g.flags & F_LIQUID) && S.y < g.liquid - 0.15;
  if (wet && !wasWet) Sfx.splash();
  wasWet = wet;
  let speed = (keys.ShiftLeft || keys.ShiftRight) ? 7.4 : 4.6;
  if (wet) speed *= 0.55;
  const wx = il ? ix / il * speed : 0, wz = il ? iz / il * speed : 0;
  const k = Math.min(1, (S.onGround ? 14 : 2.5) * dt);
  S.vx += (wx - S.vx) * k; S.vz += (wz - S.vz) * k;
  const sp = Math.hypot(S.vx, S.vz);
  const ox = S.x, oz = S.z;
  const steps = Math.max(1, Math.ceil(sp * dt / 0.3));
  for (let i = 0; i < steps; i++) {
    const r = collide(S.level, S.x + S.vx * dt / steps, S.z + S.vz * dt / steps, RADIUS, S.y);
    S.x = r[0]; S.z = r[1];
  }
  g = groundInfo(S.level, S.x, S.z);
  if (g.kind === 0) { S.x = ox; S.z = oz; g = groundInfo(S.level, S.x, S.z); }
  if (g.kind === 0) { const p = findOpenNear(S.level, S.x, S.z); S.x = p[0]; S.z = p[1]; S.y = groundInfo(S.level, S.x, S.z).floor; g = groundInfo(S.level, S.x, S.z); }
  if (keys.Space && S.onGround) { S.vy = 7.2; S.onGround = false; }
  if (S.onGround && S.vy <= 0 && S.y - g.floor < 0.8) { S.y = g.floor; S.vy = 0; }
  else { S.vy -= 24 * dt; S.y += S.vy * dt; }
  if (S.y <= g.floor) {
    if (S.vy < -15) { Sfx.thud(); const dmg = Math.round((-S.vy - 15) * 6); if (dmg > 2) hurt(dmg, 'fall'); if (dmg > 8) breakFragile('You land hard, and hear a horrible tinkling from your pack.'); }
    S.y = g.floor; S.vy = 0;
  }
  S.onGround = S.y - g.floor < 0.02;
  if (g.kind && S.y + 1.8 > g.ceil) { S.y = Math.max(g.floor, g.ceil - 1.8); if (S.vy > 0) S.vy = 0; }
  if (S.onGround && sp > 0.5) {
    stepAcc += sp * dt; bobPhase += sp * dt * 2.2;
    if (stepAcc > 2.1) { stepAcc = 0; Sfx.step(wet); }
  }
  bobAmt += ((S.onGround && sp > 0.5 ? Math.min(1, sp / 5) : 0) - bobAmt) * Math.min(1, dt * 8);
  return { g, moving: sp > 0.8 };
}

// ---------------------------------------------------------------- environment
function updateEnvironment(dt, g, moving) {
  if ((g.kind === 1 || g.kind === 3) && S.onGround && !(g.flags & F_LAVA)) S.lastSafe = { L: S.level, x: S.x, y: S.y, z: S.z };
  if (g.kind === 2) {
    const drop = (S.lastSafe ? S.lastSafe.y : S.y) - S.y;
    if (g.flags & F_SHAFTDOWN) { if (drop > 6) { shaftFall(g); return; } }
    else if (drop > 14) { die('You plunge into the chasm. The fall goes on for a very long time, and then, abruptly, it doesn\'t.'); return; }
  }
  if ((g.flags & F_LAVA) && S.y < g.liquid + 0.3) {
    hurt(40 * dt, 'lava');
    lavaT -= dt;
    if (lavaT <= 0) { lavaT = 1.2; Sfx.sizzle(); log('Your boots are on fire! Get out of the lava!', 'bad'); }
    if (mode !== 'play') return;
  }
  if (S.level === 0) {
    for (const e of loaded.values()) for (const f of e.ch.features) {
      if (f.type !== 'fire' || Math.hypot(f.x - S.x, f.z - S.z) > 4) continue;
      if (S.health < 100) {
        S.health = Math.min(100, S.health + 12 * dt);
        healMsgT -= dt;
        if (healMsgT <= 0) { healMsgT = 30; log('The warmth of the fire soaks into your bones. You feel better.', 'good'); }
      }
    }
  }
  // room entry
  if (g.kind === 1 || g.kind === 3) {
    const key = g.room >= 0 ? S.level + ':' + g.ch.cx + ':' + g.ch.cz + ':' + g.room : 'passage';
    if (key !== S.curRoom) { S.curRoom = key; enterRoom(g); }
  }
  // discovery for the map
  mapT -= dt;
  if (mapT <= 0) { mapT = 0.25; markDiscovered(isLit() ? 5 : 1); }
  // darkness: the classic way to die
  const dark = lampLevel() === 0 && ambientLum(S.x, S.y + 1, S.z) < 0.12;
  if (dark) {
    if (!darkWarned) { darkWarned = true; log('It is pitch dark. Every step you take could be your last.', 'bad'); }
    if (moving) {
      darkTimer += dt;
      if (darkTimer > 4 && Math.random() < 0.05 * dt) {
        die('You stumble blindly in the dark and pitch headlong into an unseen hole. That was careless.'); return;
      }
    }
  } else { darkWarned = false; darkTimer = 0; }
}
function markDiscovered(r) {
  const gx = Math.floor(S.x / CELL), gz = Math.floor(S.z / CELL);
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dz * dz > r * r + 1) continue;
    markCell(gx + dx, gz + dz);
  }
}
function markCell(gx, gz) {
  const cx = Math.floor(gx / CHUNK), cz = Math.floor(gz / CHUNK), key = S.level + ':' + cx + ':' + cz;
  if (getChunk(cx, cz, S.level).maze) return;   // your map is no use in the Tangle
  let arr = S.map[key];
  if (!arr) arr = S.map[key] = new Uint8Array(CHUNK * CHUNK);
  arr[(gz - cz * CHUNK) * CHUNK + (gx - cx * CHUNK)] = 1;
}
function markRoom(ch, ri) {
  for (let j = 0; j < CHUNK; j++) for (let i = 0; i < CHUNK; i++) {
    if (ch.room[j * CHUNK + i] !== ri) continue;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) markCell(ch.cx * CHUNK + i + dx, ch.cz * CHUNK + j + dz);
  }
}

function enterRoom(g) {
  if (g.room < 0) {
    if (g.ch.maze) {
      $('locName').textContent = 'The Tangle';
      const mk = 'maze:' + S.level + ':' + g.ch.cx + ':' + g.ch.cz;
      if (S.lastMaze !== mk) {
        S.lastMaze = mk;
        log('The Tangle', 'title');
        log(MAZE_DESC + (S.metMaze ? '' : ' Your sense of direction deserts you entirely: your map is no use in here. Dropping things as markers might help.'));
        S.metMaze = true;
      }
    } else { $('locName').textContent = 'a passage'; S.lastMaze = ''; }
    return;
  }
  S.lastMaze = '';
  const ch = g.ch, room = ch.rooms[g.room], key = S.curRoom;
  $('locName').textContent = cap(room.name);
  if (!isLit()) { log('It is too dark to see anything.', 'dim'); return; }
  const first = !S.visited.has(key);
  if (first) { S.visited.add(key); S.score.rooms += 1; markRoom(ch, g.room); }
  log(cap(room.name), 'title');
  if (first || S.verbose) describeHere(ch, g.room, key);
}
function describeHere(ch, ri, key) {
  log(describeRoom(ch, ri));
  const rune = ch.features.find(f => f.type === 'rune' && f.ri === ri);
  if (rune) learnRune(rune, false);
  if (ch.rooms[ri].type === 'lair' && ch.features.some(f => f.type === 'wyrm' && f.ri === ri && S.slain.has(f.id))) log('The great wyrm lies dead upon its hoard, its fires gone out at last.', 'dim');
  const here = itemsHere().filter(it => it.rk === key);
  for (const it of here) log('There is ' + art(it.name) + ' here.', it.kind === 'treasure' ? 'good' : '');
}
function look() {
  const g = groundInfo(S.level, S.x, S.z);
  if (!isLit()) { log('It is pitch dark. You can see nothing at all.', 'bad'); return; }
  if (g.room >= 0) {
    const room = g.ch.rooms[g.room];
    log(cap(room.name), 'title');
    describeHere(g.ch, g.room, S.curRoom);
  } else if (g.ch.maze) {
    log(MAZE_DESC);
    for (const it of itemsHere()) if (Math.hypot(it.x - S.x, it.z - S.z) < 4) log('There is ' + art(it.name) + ' here.', it.kind === 'treasure' ? 'good' : '');
  } else {
    log(PASSAGE_DESC[hash4(g.gx >> 2, g.gz >> 2, S.level, 1) % PASSAGE_DESC.length]);
    if (hash4(g.gx >> 3, g.gz >> 3, S.level, 2) % 3 === 0) { const f = regionFor(S.level).flavor; log(f[hash4(g.gx, g.gz, 3, 3) % f.length]); }
    for (const it of itemsHere()) if (Math.hypot(it.x - S.x, it.z - S.z) < 6) log('There is ' + art(it.name) + ' here.', it.kind === 'treasure' ? 'good' : '');
  }
}

// ---------------------------------------------------------------- interaction
function findTarget() {
  const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
  let best = null, bestS = 1e9;
  const consider = (obj, x, y, z, range) => {
    const dx = x - S.x, dz = z - S.z, d = Math.hypot(dx, dz);
    if (d > range || Math.abs(y - S.y) > 2.5) return;
    const dot = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
    if (dot < -0.1 && d > 1.3) return;
    const s = d - dot * 1.2;
    if (s < bestS) { bestS = s; best = obj; }
  };
  for (const it of itemsHere()) consider({ type: 'item', it }, it.x, it.y, it.z, 2.6);
  for (const e of loaded.values()) for (const f of e.ch.features) consider({ type: f.type, f }, f.x, f.y, f.z, 3.3);
  for (const e of loaded.values()) for (const p of e.ch.puzzles) {
    const done = S.solved.has(p.id);
    if (p.type === 'vine') {
      const vx = p.bx + p.dir[0] * 0.9, vz = p.bz + p.dir[1] * 0.9;
      const dx = vx - S.x, dz = vz - S.z, d = Math.hypot(dx, dz);
      if (d < 3 && Math.abs(S.y - p.y) < 6 && (bestS > d - 0.5)) { bestS = d - 0.5; best = { type: done ? 'vine' : 'bulb', p }; }
    } else if (!done || p.type === 'mole') {
      if (done) continue;
      const dx = p.fx - S.x, dz = p.fz - S.z, d = Math.hypot(dx, dz);
      if (d < 2.8 && Math.abs(S.y - p.y) < 2.5 && bestS > d - 0.6) { bestS = d - 0.6; best = { type: p.type, p }; }
    }
  }
  if (!best) {
    const g = groundInfo(S.level, S.x, S.z);
    if ((g.flags & F_LIQUID) && S.inv.some(i => i.kind === 'skin' && !i.full)) best = { type: 'water' };
  }
  return best;
}
function promptText(t) {
  if (!t) return '';
  switch (t.type) {
    case 'item': return '[E] take the ' + t.it.name;
    case 'trunk': return S.inv.some(i => i.kind === 'treasure') ? '[E] put your treasures in the trunk' : '[E] look in the trunk';
    case 'barrel': return '[E] refill your lamp';
    case 'fire': return '[E] warm yourself by the fire';
    case 'rune': return '[E] read the standing stone';
    case 'ropeDown': return '[E] climb down the rope';
    case 'ropeUp': return '[E] climb up the rope';
    case 'chuteDown': return '[E] slide down the chute (one way!)';
    case 'door': return S.inv.some(i => i.kind === 'oil') ? '[E] oil the rusted hinges' : 'A door, rusted solid';
    case 'gate': return S.inv.some(i => i.kind === 'key') ? '[E] unlock the gate with your brass key' : 'An iron gate, locked tight';
    case 'mole': return S.inv.some(i => i.kind === 'food') ? '[E] offer the mole some food' : 'A giant mole blocks the way. It looks hungry.';
    case 'gap': return S.inv.some(i => i.kind === 'planks') ? '[E] lay your planks across the gap' : 'A gap too wide to jump';
    case 'bulb': return S.inv.some(i => i.kind === 'skin' && i.full) ? '[E] water the thirsty bulb' : 'A dry, shrivelled bulb';
    case 'vine': return S.y > t.p.y + 2 ? '[E] climb down the vine' : '[E] climb up the vine';
    case 'water': return '[E] fill your waterskin';
  }
  return '';
}
function interact() {
  const t = interactTarget;
  if (!t) { log('There is nothing here to use.', 'dim'); return; }
  switch (t.type) {
    case 'item': takeItem(t.it); break;
    case 'trunk': depositAll(); break;
    case 'barrel': refillBarrel(); break;
    case 'fire': log(S.health < 100 ? 'You hold your hands to the flames. Stay close and your wounds will mend.' : 'You warm your hands. The fire crackles contentedly.'); break;
    case 'rune': learnRune(t.f, true); break;
    case 'ropeDown': climbDown(t.f, false); break;
    case 'ropeUp': climbUp(t.f); break;
    case 'chuteDown': slideDown(t.f, false); break;
    case 'door': oilDoor(t.p); break;
    case 'gate': unlockGate(t.p); break;
    case 'mole': feedMole(t.p); break;
    case 'gap': bridgeGap(t.p); break;
    case 'bulb': waterBulb(t.p); break;
    case 'vine': climbVine(t.p); break;
    case 'water': fillSkin(); break;
  }
}
// ---- puzzle actions
function nearPuzzle(type, range = 4) {
  let best = null, bd = range;
  for (const e of loaded.values()) for (const p of e.ch.puzzles) {
    if (p.type !== type) continue;
    const x = p.type === 'vine' ? p.bx : p.fx, z = p.type === 'vine' ? p.bz : p.fz;
    const d = Math.hypot(x - S.x, z - S.z);
    if (d < bd && Math.abs(S.y - p.y) < 6) { bd = d; best = p; }
  }
  return best;
}
function solve(p, msg) {
  S.solved.add(p.id);
  log(msg, 'good');
  Sfx.deposit();
  saveGame(true);
}
function unlockGate(p) {
  if (!p) { log('There is no gate here.', 'dim'); return; }
  if (S.solved.has(p.id)) { log('The gate already stands open.', 'dim'); return; }
  if (!S.inv.some(i => i.kind === 'key')) { log('The gate is locked. There is a keyhole the shape of a fat brass key.', 'dim'); return; }
  solve(p, 'The brass key turns with a gritty clunk, and the iron gate swings open on screaming hinges.');
}
function feedMole(p) {
  if (!p) { log('There is no mole here.', 'dim'); return; }
  if (S.solved.has(p.id)) { log('The mole is already your friend. It snuffles at you happily.', 'dim'); return; }
  const f = S.inv.find(i => i.kind === 'food');
  if (!f) { log('You have nothing to offer it. The mole sniffs at your empty hands and looks wounded.', 'dim'); return; }
  S.inv.splice(S.inv.indexOf(f), 1);
  solve(p, 'You hold out the ' + f.name + '. The giant mole snuffles, gobbles it down in one gulp, gives a contented rumble and waddles aside.');
}
function bridgeGap(p) {
  if (!p) { log('There is no gap here to bridge.', 'dim'); return; }
  if (S.solved.has(p.id)) { log('Your plank bridge is already in place.', 'dim'); return; }
  const pl = S.inv.find(i => i.kind === 'planks');
  if (!pl) { log('The gap is far too wide to jump. Something long and sturdy might span it.', 'dim'); return; }
  S.inv.splice(S.inv.indexOf(pl), 1);
  solve(p, 'You lay the planks across the gap and lash them together. It is not pretty, but it will hold.');
}
function oilDoor(p) {
  if (!p) { log('There is no door here.', 'dim'); return; }
  if (S.solved.has(p.id)) { log('The door already stands open.', 'dim'); return; }
  const o = S.inv.find(i => i.kind === 'oil');
  if (!o) { log('The door is rusted solid. Its hinges are crusted thick with orange scale. A drop of oil might do wonders.', 'dim'); return; }
  S.inv.splice(S.inv.indexOf(o), 1);
  solve(p, 'You pour the lamp oil over the hinges and wait. Then you heave. With a shriek of tortured iron, the rusted door grinds open.');
}
function fillSkin() {
  const sk = S.inv.find(i => i.kind === 'skin' && !i.full);
  if (!sk) { log(S.inv.some(i => i.kind === 'skin') ? 'Your waterskin is already full.' : 'You have nothing to carry water in.', 'dim'); return; }
  if (!(groundInfo(S.level, S.x, S.z).flags & F_LIQUID)) { log('There is no water here. Find an underground lake.', 'dim'); return; }
  sk.full = true; sk.name = 'waterskin full of water';
  Sfx.splash();
  log('You fill the waterskin with icy lake water. It sloshes reassuringly.', 'good');
}
function waterBulb(p) {
  if (!p) { log('There is nothing here to water.', 'dim'); return; }
  if (S.solved.has(p.id)) { log('The vine is already fully grown.', 'dim'); return; }
  const sk = S.inv.find(i => i.kind === 'skin' && i.full);
  if (!sk) { log('The bulb is bone dry. ' + (S.inv.some(i => i.kind === 'skin') ? 'Your waterskin is empty, though.' : 'If only you had some water.'), 'dim'); return; }
  sk.full = false; sk.name = 'empty waterskin';
  solve(p, 'You pour the water over the bulb. It drinks greedily, then cracks open, and a fat green vine corkscrews up the wall to a shelf high above!');
}
function climbVine(p) {
  if (!S.solved.has(p.id)) { log('There is nothing to climb yet.', 'dim'); return; }
  Sfx.rope();
  if (S.y > p.y + 2) {
    S.x = p.bx - p.dir[0] * 0.6; S.z = p.bz - p.dir[1] * 0.6; S.y = groundInfo(S.level, S.x, S.z).floor;
    log('You clamber back down the vine.');
  } else {
    S.x = p.fx + p.dir[0] * 0.3; S.z = p.fz + p.dir[1] * 0.3; S.y = p.ledgeY;
    log('You climb the vine, leaf over leaf, and haul yourself onto the shelf.');
  }
  S.vx = S.vz = S.vy = 0; S.curRoom = '';
}
function takeItem(it, quiet) {
  if (S.inv.length >= MAX_INV) { log('You can\'t carry any more. You\'ll have to drop something first.', 'warn'); return false; }
  if (it.dropped) { const i = S.dropped.indexOf(it); if (i >= 0) S.dropped.splice(i, 1); }
  else { S.removed.add(it.id); const i = worldItems.indexOf(it); if (i >= 0) worldItems.splice(i, 1); }
  S.inv.push({ id: it.id, kind: it.kind, name: it.name, value: it.value || 0, mesh: it.mesh, mat: it.mat, full: !!it.full, fragile: !!it.fragile });
  if (it.kind === 'treasure' && !S.found.has(it.id)) {
    S.found.add(it.id); S.score.finds += 2;
    log('Taken: ' + art(it.name) + '. Treasure! (+2)', 'good');
  } else if (!quiet) log('Taken: ' + art(it.name) + '.');
  Sfx.pickup(it.kind === 'treasure');
  return true;
}
function nearTrunk() {
  for (const e of loaded.values()) for (const f of e.ch.features) if (f.type === 'trunk' && Math.hypot(f.x - S.x, f.z - S.z) < 4) return true;
  return false;
}
function dropItem(inv) {
  if (inv.kind === 'treasure' && nearTrunk()) { bank(inv); return; }
  S.inv.splice(S.inv.indexOf(inv), 1);
  const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
  if (inv.fragile && !softGround()) { shatter(inv, S.x + fx * 0.9, S.z + fz * 0.9, 'You set the ' + inv.name + ' down on the bare rock a little too briskly.'); return; }
  placeDropped(inv, S.x + fx * 0.9, S.z + fz * 0.9);
  log('Dropped: ' + art(inv.name) + '.' + (inv.fragile ? ' You set it down very gently.' : ''));
}
// moss, mushroom beds and water are kind to fragile things; bare rock is not
function softGround() {
  const g = groundInfo(S.level, S.x, S.z);
  if (g.flags & F_LIQUID) return true;
  const room = g.room >= 0 ? g.ch.rooms[g.room] : null;
  return !!room && (room.type === 'camp' || room.type === 'fungus');
}
function shatter(inv, x, z, why) {
  const i = S.inv.indexOf(inv);
  if (i >= 0) S.inv.splice(i, 1);
  for (let k = 0; k < 8; k++) particles.push({ x, y: S.y + 0.3, z, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 2.5, vz: (Math.random() - 0.5) * 3, life: 0.6, max: 0.6, s: 0.6, mat: inv.mat });
  Sfx.clink(); setTimeout(() => Sfx.clink(), 90);
  S.broken = (S.broken || 0) + 1;
  log(why + ' The ' + inv.name + ' shatters into a hundred worthless pieces.', 'bad');
}
function breakFragile(why) {
  for (const it of S.inv.filter(i => i.fragile)) shatter(it, S.x, S.z, why);
}
function placeDropped(inv, x, z) {
  let g = groundInfo(S.level, x, z);
  if (g.kind !== 1 && g.kind !== 3) { x = S.lastSafe && S.lastSafe.L === S.level ? S.lastSafe.x : S.x; z = S.lastSafe && S.lastSafe.L === S.level ? S.lastSafe.z : S.z; g = groundInfo(S.level, x, z); }
  S.dropped.push(Object.assign({}, inv, { L: S.level, x, z, y: g.floor, dropped: true, ph: Math.random() * 6, rk: roomKeyAt(S.level, x, z) }));
}
function bank(inv) {
  S.inv.splice(S.inv.indexOf(inv), 1);
  const v = S.closing ? inv.value * 2 : inv.value;
  S.score.banked += v;
  S.banked.push({ name: inv.name, value: v });
  log('You lay the ' + inv.name + ' in the trunk. (+' + v + ')', 'good');
  if (!S.closing && !S.endDone && S.banked.length >= CLOSE_AFTER) setTimeout(() => { if (S && !S.closing && !S.endDone && mode === 'play') startClosing(); }, 1500);
}
function depositAll() {
  const ts = S.inv.filter(i => i.kind === 'treasure');
  if (!ts.length) {
    log(S.banked.length ? 'The trunk holds ' + S.banked.length + ' treasure' + (S.banked.length > 1 ? 's' : '') + ', worth ' + S.score.banked + ' points. You have nothing new to add.'
      : 'The trunk yawns at you, empty. Treasures put here count towards your score.', 'dim');
    return;
  }
  for (const t of ts) bank(t);
  Sfx.deposit();
  log('Score: ' + totalScore() + '. Your treasures are safe.', 'good');
  saveGame(true);
}
function refillBarrel() {
  S.fuel = 100;
  if (!S.lampOn) { S.lampOn = true; Sfx.lamp(true); }
  log('You top up your lamp from the barrel. It burns bright and steady.', 'good');
}
function toggleLamp(want) {
  const on = want === undefined ? !S.lampOn : want;
  if (on && S.fuel <= 0) { log('Your lamp is out of oil. It won\'t light.', 'bad'); return; }
  if (on === S.lampOn) { log(on ? 'Your lamp is already lit.' : 'Your lamp is already off.', 'dim'); return; }
  S.lampOn = on; Sfx.lamp(on);
  log(on ? 'Your lamp is now on.' : 'Your lamp is now off.');
  if (on) S.curRoom = '';
}
function refuel() {
  const f = S.inv.find(i => i.kind === 'oil');
  if (!f) { log('You have no lamp oil.' + (S.level === 0 ? ' There is a barrel at camp.' : ''), 'dim'); return; }
  S.inv.splice(S.inv.indexOf(f), 1);
  S.fuel = Math.min(100, S.fuel + 55);
  if (!S.lampOn) { S.lampOn = true; S.curRoom = ''; }
  Sfx.lamp(true);
  log('You pour the oil into your lamp. The flame steadies and brightens.', 'good');
}
function eat(word) {
  const f = S.inv.find(i => i.kind === 'food' && (!word || i.name.includes(word))) || S.inv.find(i => i.kind === 'food');
  if (!f) { log(word ? 'You have nothing like that to eat.' : 'You have nothing to eat.', 'dim'); return; }
  S.inv.splice(S.inv.indexOf(f), 1);
  S.health = Math.min(100, S.health + 35);
  log('You eat the ' + f.name + '. Delicious, in a cave sort of way. You feel stronger.', 'good');
}
function learnRune(f, read) {
  const known = !!S.runes[f.word];
  S.runes[f.word] = { L: S.level, x: f.x, z: f.z };
  if (read) log('The standing stone bears a single carved word: ' + f.word + '. The letters seem to glow faintly. Perhaps you should SAY it.');
  if (!known) log('(You commit the word ' + f.word + ' to memory.)', 'warn');
}
function atCamp() { const c = campCenterPos(); return S.level === 0 && Math.hypot(S.x - c.x, S.z - c.z) < 20; }
function recallStolen() {
  const stolen = S.dropped.filter(d => d.stolen);
  Sfx.magic();
  if (!stolen.length) { log('"' + S.recallWord + '!" Somewhere far away, something grumbles. The shade has nothing of yours right now.', 'dim'); return; }
  const t = getChunk(0, 0, 0).features.find(f => f.type === 'trunk');
  for (const d of stolen) {
    const a = Math.random() * Math.PI * 2, x = t.x + Math.cos(a) * 1.8, z = t.z + Math.sin(a) * 1.8;
    Object.assign(d, { L: 0, x, z, y: groundInfo(0, x, z).floor, stolen: false, rk: roomKeyAt(0, x, z) });
  }
  log('"' + S.recallWord + '!" The word rings out like a bell. Far away, a furious wail is cut short, and something clatters.', 'good');
  log('(' + stolen.length + ' stolen treasure' + (stolen.length > 1 ? 's have' : ' has') + ' returned to camp, beside the trunk.)', 'good');
}
function sayWord(w) {
  const W = w.toUpperCase();
  if (S.recallWord && W === S.recallWord) { recallStolen(); return true; }
  let stone = null;
  for (const e of loaded.values()) for (const f of e.ch.features) if (f.type === 'rune' && f.word === W && Math.hypot(f.x - S.x, f.z - S.z) < 7) stone = f;
  if (stone) {
    S.runes[W] = { L: S.level, x: stone.x, z: stone.z };
    const sp = campSpawnPos();
    Sfx.magic();
    changeLevel(0, sp.x, sp.z, ['"' + W + '!" The word rolls through the rock like thunder. The world folds in on itself...', 'You are back at camp, blinking in the daylight.']);
    return true;
  }
  const r = S.runes[W];
  if (r && atCamp()) {
    Sfx.magic();
    const a = Math.random() * Math.PI * 2;
    changeLevel(r.L, r.x + Math.cos(a) * 1.6, r.z + Math.sin(a) * 1.6, ['"' + W + '!" The daylight peels away like wet paper...', 'You stand beside the carved stone, deep in the cave.']);
    return true;
  }
  if (r) { log('You say "' + W + '". The word echoes, but nothing happens. It only works beside its stone, or back at camp.', 'dim'); return true; }
  return false;
}

// ---------------------------------------------------------------- levels
function changeLevel(L, x, z, msgs, damage = 0, why = 'fall') {
  mode = 'transition'; fadeTarget = 1;
  pending = { t: 0.5, fn: () => {
    const oldReg = regionFor(S.level);
    S.level = L;
    const op = findOpenNear(L, x, z); S.x = op[0]; S.z = op[1];
    creatures = []; projectiles = []; particles = [];
    streamChunks(true);
    const g = groundInfo(L, S.x, S.z);
    S.y = g.floor; S.vx = S.vz = S.vy = 0; S.onGround = true;
    S.lastSafe = { L, x: S.x, y: S.y, z: S.z };
    mode = 'play'; fadeTarget = 0; S.curRoom = ''; spawnTimer = 12 + Math.random() * 10;
    for (const m of msgs) log(m);
    const reg = regionFor(L);
    if (reg !== oldReg) log('You have entered ' + reg.name + '.', 'warn');
    if (L > S.deepest) { S.deepest = L; S.score.depth += 10; log('A new depth record: level ' + L + '. (+10)', 'good'); }
    if (damage) hurt(damage, why);
    saveGame(true);
  } };
}
function climbDown(f, fell) {
  Sfx.rope();
  changeLevel(S.level + 1, f.x + 1.3, f.z, fell ? [] : ['You climb down the rope, hand over hand, for what feels like an age...']);
}
function shaftFall(g) {
  const x = (g.gx + 0.5) * CELL, z = (g.gz + 0.5) * CELL;
  if (g.ch.features.some(f => f.type === 'chuteDown' && f.gx === g.gx && f.gz === g.gz)) { slideDown({ x, z }, true); return; }
  Sfx.fall();
  breakFragile('Something in your pack goes crunch on the way down.');
  changeLevel(S.level + 1, x + 1.3, z, ['You tumble down the shaft, bouncing painfully off the walls, and land in a heap.'], 30, 'fall');
}
function slideDown(f, fell) {
  Sfx.fall();
  breakFragile('You bounce off the walls of the chute, and something in your pack goes crunch.');
  changeLevel(S.level + 1, f.x + 1.3, f.z, [fell ? 'Whoa! Your feet go out from under you and you whizz down a polished stone chute...' : 'You sit on the lip of the chute and push off. Down, down, round and down...',
    'You shoot out of the ceiling and land in a heap. The chute above is far too steep and slick to climb. There is no going back that way.']);
}
function climbUp(f) {
  const L = S.level - 1;
  let best = null;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const ch = chunkAtGrid(L, f.gx + dx, f.gz + dz), idx = localIdx(ch, f.gx + dx, f.gz + dz);
    if (ch.kind[idx] === 1 && !(ch.flags[idx] & (F_LAVA | F_SHAFTDOWN))) { best = [f.gx + dx, f.gz + dz]; break; }
  }
  if (!best) best = [f.gx + 1, f.gz];
  Sfx.rope();
  changeLevel(L, (best[0] + 0.5) * CELL, (best[1] + 0.5) * CELL, ['You haul yourself up the rope, arms burning, and clamber over the lip of the shaft.']);
}

// ---------------------------------------------------------------- damage & death
const DEATHS = {
  knife: 'A knife takes you squarely in the chest. The last thing you hear is a delighted gloomkin cackle.',
  claw: 'The gloomkins swarm over you, all elbows and teeth.',
  lava: 'You wade a little too far into the lava. It does not go well.',
  fall: 'You hit the ground very hard indeed.',
  fire: 'The wyrm\'s breath washes over you. For a brief moment you are the brightest thing in the whole cave.',
  wyrm: 'The wyrm\'s jaws close on you with a sound like a dropped portcullis.',
  tail: 'The wyrm\'s tail sends you flying into the wall. You do not get up.',
};
function hurt(n, why) {
  if (mode !== 'play' && mode !== 'transition') return;
  S.health -= n;
  flash = Math.min(0.55, flash + n / 70);
  shake = Math.min(0.7, shake + n / 45);
  if (n >= 5) Sfx.hurt();
  if (S.health <= 0) { S.health = 0; die(DEATHS[why] || 'You have died.'); }
}
const OBITS = [
  'Oh dear, you seem to have got yourself killed. The cave spirits, who find you mildly amusing, offer to put you back together.',
  'Dead again! The cave spirits sigh, roll up their sleeves, and offer to reassemble you once more.',
  'You are making rather a habit of this. The spirits warn you: they are running low on glue. One last time?',
];
function die(msg) {
  if (mode === 'dead' || mode === 'over') return;
  log(msg, 'bad');
  Sfx.die();
  S.score.deaths++;
  const p = S.lastSafe || { L: S.level, x: S.x, y: S.y, z: S.z };
  for (const it of S.inv.filter(i => i.fragile)) { S.broken = (S.broken || 0) + 1; log('(The ' + it.name + ' did not survive your fall.)', 'dim'); }
  S.inv = S.inv.filter(i => !i.fragile);
  for (const it of S.inv) {
    S.dropped.push(Object.assign({}, it, { L: p.L, x: p.x + (Math.random() - 0.5) * 1.2, z: p.z + (Math.random() - 0.5) * 1.2, y: p.y,
      dropped: true, ph: Math.random() * 6, rk: '' }));
  }
  S.inv = [];
  closeConsole(); setMap(false);
  fadeTarget = 0.8;
  document.exitPointerLock && document.exitPointerLock();
  if (S.lives <= 0) {
    mode = 'over';
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    showOver(msg);
  } else {
    mode = 'dead';
    showDead(msg, OBITS[3 - S.lives] || OBITS[2]);
  }
}
function reincarnate() {
  S.lives--;
  S.health = 100; S.fuel = Math.max(S.fuel, 40); S.lampOn = true;
  hideOverlay();
  const sp = campSpawnPos();
  changeLevel(0, sp.x, sp.z, ['There is a flash of orange smoke. You wake beside the campfire, coughing, oddly unharmed.',
    'Your belongings lie wherever you fell.']);
  if (!AI.on) lockPointer();
}

// ---------------------------------------------------------------- creatures
function panFor(x, z) {
  const dx = x - S.x, dz = z - S.z, rx = Math.cos(S.yaw), rz = -Math.sin(S.yaw), d = Math.hypot(dx, dz) || 1;
  return (dx * rx + dz * rz) / d;
}
function dropAxeAt(p, x, z) {
  let g = groundInfo(S.level, x, z);
  if (g.kind !== 1 && g.kind !== 3) { x = p.lx; z = p.lz; g = groundInfo(S.level, x, z); }
  if (g.kind !== 1 && g.kind !== 3) { x = S.x; z = S.z; g = groundInfo(S.level, x, z); }
  S.dropped.push(Object.assign({}, p.item, { L: S.level, x, z, y: g.floor, dropped: true, ph: 0, rk: roomKeyAt(S.level, x, z) }));
}
function steal(c) {
  const ts = S.inv.filter(i => i.kind === 'treasure');
  for (let k = 0; k < 10; k++) particles.push({ x: c.x, y: c.y + 1 + Math.random(), z: c.z, vx: (Math.random() - 0.5) * 2, vy: Math.random() * 2, vz: (Math.random() - 0.5) * 2, life: 0.8, max: 0.8, s: 1.5 });
  if (!ts.length) { log('A pale shape brushes past you, finds nothing worth having, and dissolves with a disappointed sigh.', 'dim'); return; }
  const it = ts[Math.floor(Math.random() * ts.length)];
  S.inv.splice(S.inv.indexOf(it), 1);
  const nest = nestLocation();
  S.dropped.push(Object.assign({}, it, { L: S.level, x: nest.x, z: nest.z, y: nest.y, dropped: true, ph: 0, rk: nest.rk, stolen: true }));
  Sfx.shade();
  log('A pale, grinning shape glides out of the dark and plucks the ' + it.name + ' from your pack! "Mine, mine, all mine!" it whispers, and is gone.', 'bad');
  log('(It fled to the ' + dirWord(nest.x - S.x, nest.z - S.z) + '. Its nest must lie somewhere that way.)', 'warn');
  if (!S.recallWord) {
    S.recallWord = runeWord(new RNG(hash4(S.seed, 0x5ade, 1, 2)));
    log('As it vanishes, a scrap of grey cloth flutters down from its robes. Scrawled on it in shaky letters is a single word: ' + S.recallWord + '.', 'warn');
    log('(You commit the word ' + S.recallWord + ' to memory.)', 'warn');
  }
}
function nestLocation() {
  const CW = CELL * CHUNK, pcx = Math.floor(S.x / CW), pcz = Math.floor(S.z / CW);
  for (let tries = 0; tries < 20; tries++) {
    const dcx = Math.floor(Math.random() * 5) - 2, dcz = Math.floor(Math.random() * 5) - 2;
    if (!dcx && !dcz) continue;
    const ch = getChunk(pcx + dcx, pcz + dcz, S.level);
    const rooms = ch.rooms.map((r, i) => [r, i]).filter(([r]) => r.cells.length && r.type !== 'lava');
    if (!rooms.length) continue;
    const [room, ri] = rooms[Math.floor(Math.random() * rooms.length)];
    const idx = room.cells[Math.floor(Math.random() * room.cells.length)];
    const x = (ch.cx * CHUNK + idx % CHUNK + 0.5) * CELL, z = (ch.cz * CHUNK + Math.floor(idx / CHUNK) + 0.5) * CELL;
    return { x, z, y: groundInfo(S.level, x, z).floor, rk: S.level + ':' + ch.cx + ':' + ch.cz + ':' + ri };
  }
  return { x: S.x, z: S.z, y: S.y, rk: '' };
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt; if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.nograv) { const k = Math.exp(-2.5 * dt); p.vx *= k; p.vy = p.vy * k + 1.5 * dt; p.vz *= k; } else p.vy += 0.5 * dt;
  }
}

// ---------------------------------------------------------------- parser
const HELP_LINES_EXTRA = 'Puzzles: UNLOCK GATE, OIL DOOR, FEED MOLE, BRIDGE GAP, FILL WATERSKIN, POUR WATER, CLIMB VINE. Some shafts are one-way chutes (DOWN to slide). Fragile treasures break if dropped on hard rock. Stuck? Type HINT (it costs 5 points).';
const HELP_LINES = [
  'Explore the endless cave. Find treasure. Carry it back to the trunk at camp to score.',
  'Move W A S D, look with the mouse, Shift to run, Space to jump.',
  'E take / use   F lamp   R refuel   X eat   Click swing axe   Q / right-click throw axe   M map   I inventory   L look   Esc pause',
  'Press Enter to type commands: TAKE <thing>, TAKE ALL, DROP <thing>, DROP ALL, INVENTORY, LOOK, SCORE, LAMP ON/OFF, FILL, EAT, THROW AXE, DOWN, UP, SAY <word>, WORDS, BRIEF, VERBOSE, SAVE, RESTORE, MAP, QUIT.',
  'Rope shafts lead deeper. Deeper treasures are worth more. Watch your lamp oil: it does not last forever.',
  HELP_LINES_EXTRA,
];
const ARTICLES = new Set(['the', 'a', 'an', 'some', 'my']);
function matchInv(words) {
  if (!words.length) return null;
  return S.inv.find(i => words.every(w => i.name.includes(w) || (w === 'oil' && i.kind === 'oil') || (w === 'food' && i.kind === 'food') || (w === 'treasure' && i.kind === 'treasure')));
}
function matchNear(words, range = 3.2) {
  const near = itemsHere().filter(it => Math.hypot(it.x - S.x, it.z - S.z) < range && Math.abs(it.y - S.y) < 2.5);
  if (!words.length) return near;
  return near.filter(it => words.every(w => it.name.includes(w) || (w === 'oil' && it.kind === 'oil') || (w === 'food' && it.kind === 'food')));
}
function featureNear(type, range) {
  for (const e of loaded.values()) for (const f of e.ch.features) if (f.type === type && Math.hypot(f.x - S.x, f.z - S.z) < range) return f;
  return null;
}
function showInventory() {
  log('You are carrying:');
  log('  a brass lantern (' + (S.lampOn && S.fuel > 0 ? 'lit' : 'dark') + ', ' + Math.ceil(S.fuel) + '% oil)', 'dim');
  if (!S.inv.length) log('  ...and nothing else.', 'dim');
  for (const i of S.inv) log('  ' + art(i.name) + (i.kind === 'treasure' ? '  (treasure)' : ''), i.kind === 'treasure' ? 'good' : 'dim');
  log('(' + S.inv.length + ' of ' + MAX_INV + ' slots used.)', 'dim');
}
function showScore() {
  const s = S.score, t = totalScore();
  log('You have scored ' + t + ' points in ' + Math.floor(S.time / 60) + ' minutes:');
  log('  places discovered ' + s.rooms + ' · treasures found ' + s.finds + ' · treasures banked ' + s.banked + ' · depth ' + s.depth + (s.deaths ? ' · deaths -' + s.deaths * 10 : ''), 'dim');
  log('That makes you a ' + rankFor(t) + '.', 'good');
}
function runCommand(raw) {
  const line = raw.trim();
  if (!line) return;
  log('> ' + line.toUpperCase(), 'cmd');
  cmdHistory.push(line); histIdx = cmdHistory.length;
  const all = line.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const verb = all[0];
  let rest = all.slice(1).filter(w => !ARTICLES.has(w));
  const nearOrHeld = () => matchInv(rest) || matchNear(rest)[0];
  switch (verb) {
    case 'l': case 'look': case 'examine': case 'x': case 'inspect': case 'read':
      if (rest.length && verb !== 'look' && verb !== 'l') {
        if (rest.includes('stone') || rest.includes('rune')) { const f = featureNear('rune', 4); if (f) { learnRune(f, true); return; } }
        const it = nearOrHeld();
        if (!it) { log('You see no such thing here.', 'dim'); return; }
        if (it.kind === 'treasure') log('It\'s ' + art(it.name) + '. Back in the trunk at camp it would be worth about ' + it.value + ' points.' + (it.fragile ? ' It looks terribly fragile: don\'t drop it anywhere hard.' : ''));
        else if (it.kind === 'oil') log('A dented tin flask of lamp oil. Pour it into your lamp with FILL (or press R).');
        else if (it.kind === 'food') log('It looks... edible, probably. EAT it (or press X) to restore health.');
        else if (it.kind === 'axe') log('A small, well-balanced throwing axe. Click to throw it, then go and fetch it.');
        else if (it.kind === 'key') log('A heavy brass key, green with age. Somewhere nearby there is a gate it fits.');
        else if (it.kind === 'planks') log('A bundle of stout planks, lashed with twine. Good for bridging a gap.');
        else if (it.kind === 'skin') log(it.full ? 'A leather waterskin, full of cold water.' : 'An empty leather waterskin. Fill it in an underground lake.');
        return;
      }
      look(); return;
    case 'i': case 'inv': case 'inventory': showInventory(); return;
    case 'take': case 'get': case 'grab': case 'pick': case 'carry': case 'catch': {
      rest = rest.filter(w => w !== 'up');
      if (rest[0] === 'all' || rest[0] === 'everything') {
        const near = matchNear([]);
        if (!near.length) { log('There is nothing here to take.', 'dim'); return; }
        for (const it of near) if (!takeItem(it)) break;
        return;
      }
      if (!rest.length) { if (interactTarget && interactTarget.type === 'item') takeItem(interactTarget.it); else log('Take what?', 'dim'); return; }
      const m = matchNear(rest);
      if (!m.length) { log(matchInv(rest) ? 'You are already carrying it.' : 'I see no ' + rest.join(' ') + ' here.', 'dim'); return; }
      takeItem(m[0]); return;
    }
    case 'drop': case 'put': case 'leave': case 'discard': case 'release': case 'deposit': case 'stash': case 'store': {
      if (verb === 'deposit' || verb === 'stash' || verb === 'store') { if (nearTrunk()) depositAll(); else log('The trunk is back at camp.', 'dim'); return; }
      rest = rest.filter(w => !['in', 'into', 'down', 'trunk', 'chest'].includes(w));
      if (!rest.length || rest[0] === 'all' || rest[0] === 'everything' || rest[0] === 'treasures') {
        if (!S.inv.length) { log('You aren\'t carrying anything.', 'dim'); return; }
        const list = rest[0] === 'treasures' ? S.inv.filter(i => i.kind === 'treasure') : S.inv.slice();
        if (nearTrunk() && list.some(i => i.kind === 'treasure')) Sfx.deposit();
        for (const i of list) dropItem(i);
        return;
      }
      const it = matchInv(rest);
      if (!it) { log('You aren\'t carrying ' + (rest.length ? 'any ' + rest.join(' ') : 'that') + '.', 'dim'); return; }
      dropItem(it); if (it.kind === 'treasure' && nearTrunk()) { Sfx.deposit(); saveGame(true); }
      return;
    }
    case 'lamp': case 'lantern': case 'light': case 'on': case 'off': case 'extinguish': case 'douse': case 'unlight': case 'turn': case 'switch': {
      const ws = all;
      if (verb === 'extinguish' || verb === 'douse' || verb === 'unlight' || ws.includes('off') || ws.includes('out')) toggleLamp(false);
      else if (verb === 'light' || ws.includes('on')) toggleLamp(true);
      else toggleLamp();
      return;
    }
    case 'fill': case 'refuel': case 'refill': case 'oil': {
      if ((verb === 'oil' || rest.includes('door') || rest.includes('hinges') || rest.includes('hinge')) && nearPuzzle('door') && !S.solved.has(nearPuzzle('door').id)) { oilDoor(nearPuzzle('door')); return; }
      const wantsSkin = rest.some(w => ['skin', 'waterskin', 'water', 'bottle'].includes(w));
      const inWater = groundInfo(S.level, S.x, S.z).flags & F_LIQUID;
      if (wantsSkin || (inWater && !rest.includes('lamp') && S.inv.some(i => i.kind === 'skin' && !i.full) && verb === 'fill')) { fillSkin(); return; }
      if (featureNear('barrel', 4)) refillBarrel(); else refuel();
      return;
    }
    case 'pour': case 'water':
      if (rest.includes('oil')) { const d = nearPuzzle('door'); if (d && !S.solved.has(d.id) && !rest.includes('lamp')) oilDoor(d); else refuel(); return; }
      waterBulb(nearPuzzle('vine'));
      return;
    case 'unlock': case 'open':
      if (rest.includes('trunk') || rest.includes('chest')) { if (nearTrunk()) depositAll(); else log('The trunk is back at camp.', 'dim'); return; }
      if (!nearPuzzle('gate') && nearPuzzle('door')) { const d = nearPuzzle('door'); log(S.solved.has(d.id) ? 'It is already open.' : 'You heave at the door. It is rusted solid and won\'t budge an inch. Perhaps some oil on the hinges?', 'dim'); return; }
      unlockGate(nearPuzzle('gate'));
      return;
    case 'feed': case 'give': case 'offer':
      feedMole(nearPuzzle('mole'));
      return;
    case 'bridge': case 'lay': case 'place': case 'span':
      bridgeGap(nearPuzzle('gap'));
      return;
    case 'hint': case 'hints': case 'clue':
      giveHint();
      return;
    case 'eat': case 'consume': case 'devour': eat(rest[0]); return;
    case 'drink': log(groundInfo(S.level, S.x, S.z).flags & F_LIQUID ? 'You scoop up a handful of the icy water. It tastes of stone.' : 'There is nothing here to drink.', 'dim'); return;
    case 'throw': case 'hurl': case 'toss': throwAxe(); return;
    case 'attack': case 'kill': case 'fight': case 'hit': case 'swing': case 'strike': case 'chop': case 'slay': meleeSwing(); return;
    case 'down': case 'd': case 'descend': case 'climb': case 'up': case 'u': case 'ascend': {
      const goUp = verb === 'up' || verb === 'u' || verb === 'ascend' || rest.includes('up');
      const vp = nearPuzzle('vine', 4);
      if (vp && S.solved.has(vp.id) && (rest.includes('vine') || (goUp ? S.y < vp.y + 2 : S.y > vp.y + 2))) { climbVine(vp); return; }
      if (goUp) { const f = featureNear('ropeUp', 4); if (f) climbUp(f); else log(atCamp() ? 'Above you is only sky, and you are not a bird.' : 'There is nothing to climb up here.', 'dim'); }
      else {
        const f = featureNear('ropeDown', 4), ch = featureNear('chuteDown', 4);
        if (f) climbDown(f, false); else if (ch) slideDown(ch, false); else log('There is no way down here. Look for a rope over a shaft.', 'dim');
      }
      return;
    }
    case 'score': showScore(); return;
    case 'help': case 'h': case 'info': for (const h of HELP_LINES) log(h, 'dim'); return;
    case 'map': case 'm': setMap(!mapOpen); return;
    case 'save': saveGame(false); return;
    case 'restore': case 'load': if (!loadGame()) log('There is no saved game.', 'dim'); return;
    case 'quit': case 'q': case 'restart': case 'new': saveGame(true); showTitle(); return;
    case 'words': case 'runes': case 'journal': case 'notes': case 'memory': {
      const ws = Object.keys(S.runes);
      if (S.recallWord) log('  ' + S.recallWord + ' (from the shade\'s scrap: brings stolen treasure home)', 'warn');
      if (!ws.length && S.recallWord) return;
      if (!ws.length) { log('You have not learned any magic words yet. Look for carved standing stones.', 'dim'); return; }
      log('Words you remember:');
      for (const w of ws) log('  ' + w + ' (level ' + S.runes[w].L + ')', 'warn');
      log('Say a word beside its stone to return to camp. Say it at camp to return to the stone.', 'dim');
      return;
    }
    case 'say': case 'shout': case 'chant': case 'yell': case 'speak':
      if (!rest.length) { log('Say what?', 'dim'); return; }
      if (!sayWord(rest[0])) log('You say "' + rest.join(' ').toUpperCase() + '". The cave swallows the sound. Nothing happens.', 'dim');
      return;
    case 'xyzzy': case 'plugh': case 'plover': case 'abracadabra': case 'shazam':
      log('Nothing happens. You have the strangest feeling you\'re in the wrong cave.', 'dim'); return;
    case 'n': case 's': case 'e': case 'w': case 'ne': case 'nw': case 'se': case 'sw': case 'north': case 'south': case 'east': case 'west': case 'go': case 'walk': case 'run': case 'enter': {
      const deg = ((-S.yaw * 180 / Math.PI) % 360 + 360) % 360;
      log('This cave is walked, not typed! Use W A S D. You are facing ' + COMPASS[Math.round(deg / 45) % 8] + '.', 'dim');
      return;
    }
    case 'brief': S.verbose = false; log('Brief descriptions: full descriptions only on your first visit.', 'dim'); return;
    case 'verbose': case 'long': S.verbose = true; log('Verbose descriptions: full descriptions every time.', 'dim'); return;
    case 'wait': case 'z': case 'rest': log('Time passes.', 'dim'); return;
    case 'swim': log('The water here is shallow enough to wade. Just walk.', 'dim'); return;
    case 'jump': log('You jump. Nothing else happens. (Space jumps, by the way.)', 'dim'); return;
    case 'seed': log('This cave grows from seed ' + S.seed + '.', 'dim'); return;
    case 'sound': case 'mute': log(Sfx.toggleMute() ? 'Sound off.' : 'Sound on.', 'dim'); return;
    case 'pixels': case 'res': cycleRes(); return;
    case 'sing': case 'dance': log('Your voice echoes eerily off the rock. Somewhere far off, something echoes back. You stop.', 'dim'); return;
    case 'curse': case 'damn': case 'fuck': case 'shit': log('Such language! The cave has heard worse, though not often.', 'dim'); return;
  }
  if (rest.length === 0 && sayWord(verb)) return;
  log(['I don\'t understand that.', 'I don\'t know how to do that.', 'That\'s not a verb I recognise.', 'Hmm? Try HELP.'][Math.floor(Math.random() * 4)], 'dim');
}

// ---------------------------------------------------------------- hints
const GENERAL_HINTS = [
  'Treasure only counts in full once it is in the trunk at camp. Don\'t get greedy: a full pack is a dropped pack if you die.',
  'Standing stones bear magic words. Say one beside its stone to go home; say it at camp to go back.',
  'Deeper levels have richer treasure, but more gloomkins. An axe is your best friend.',
  'Iron gates, hungry moles and wide gaps guard hidden rooms. The thing you need is usually in the same part of the level.',
  'Rest by the campfire to heal. The oil barrel at camp never runs dry.',
];
let hintPending = null;
function hintTopic() {
  const has = k => S.inv.some(i => i.kind === k);
  if (S.closing) return ['closing', 'The cave is closing! Get back to camp, the sunlit sinkhole on level 0, before the last bell. Climb ropes up, or SAY a magic word beside its stone.'];
  const gate = nearPuzzle('gate', 8), mole = nearPuzzle('mole', 8), gap = nearPuzzle('gap', 8), vine = nearPuzzle('vine', 8);
  const door = nearPuzzle('door', 8);
  if (door && !S.solved.has(door.id)) return has('oil') ? ['door2', 'Pour your lamp oil on the hinges: OIL DOOR. (You will have to find more oil for your lamp, mind.)'] : ['door', 'Rust has the door stuck fast. Oil would loosen it. Lamp oil is oil, and there are flasks lying about.'];
  if (gate && !S.solved.has(gate.id)) return has('key') ? ['gate2', 'You have a key. Try UNLOCK GATE.'] : ['gate', 'Gates like this are always locked, but a key is usually lying somewhere in the same stretch of cave. Search the nearby rooms.'];
  if (mole && !S.solved.has(mole.id)) return has('food') ? ['mole2', 'Try FEED MOLE.'] : ['mole', 'The mole isn\'t vicious, just hungry. Bring it something to eat. Food turns up all over the cave.'];
  if (gap && !S.solved.has(gap.id)) return has('planks') ? ['gap2', 'Try BRIDGE GAP.'] : ['gap', 'Too far to jump. Something long and flat could span it. Look for planks in the nearby rooms.'];
  if (vine && !S.solved.has(vine.id)) {
    if (!has('skin')) return ['vine', 'The bulb is dying of thirst. You need something to carry water in. Look for a waterskin nearby.'];
    if (!S.inv.some(i => i.kind === 'skin' && i.full)) return ['vine2', 'Stand in an underground lake and FILL your waterskin, then come back and POUR WATER on the bulb.'];
    return ['vine3', 'POUR WATER on the bulb.'];
  }
  if (groundInfo(S.level, S.x, S.z).ch.maze) return ['maze', 'Every tunnel in the Tangle looks the same and your map won\'t help. Drop things you don\'t need as markers, so you can tell where you have already been.'];
  if (S.fuel < 25) return ['lamp', 'Your lamp is low. Pour in a flask of oil (R), or get back to the barrel at camp.'];
  return ['gen' + (S.hintsBought.size % GENERAL_HINTS.length), GENERAL_HINTS[S.hintsBought.size % GENERAL_HINTS.length]];
}
function giveHint() {
  const [topic, text] = hintTopic();
  if (S.hintsBought.has(topic)) { log(text, 'warn'); return; }
  if (!hintPending || hintPending.topic !== topic || S.time - hintPending.t > 30) {
    hintPending = { topic, t: S.time };
    log('I can give you a hint, but it will cost you 5 points. Type HINT again to accept.', 'dim');
    return;
  }
  hintPending = null;
  S.hintsBought.add(topic); S.score.hints = (S.score.hints || 0) + 5;
  log(text + ' (-5)', 'warn');
}
const stuckT = new Map();
function updateStuck(dt) {
  for (const e of loaded.values()) for (const p of e.ch.puzzles) {
    if (S.solved.has(p.id)) continue;
    const x = p.type === 'vine' ? p.bx : p.fx, z = p.type === 'vine' ? p.bz : p.fz;
    if (Math.hypot(x - S.x, z - S.z) > 7) continue;
    const t = (stuckT.get(p.id) || 0) + dt;
    stuckT.set(p.id, t);
    if (t > 40 && t - dt <= 40) log('(Stuck? Type HINT.)', 'dim');
  }
  // the mole swipes at anyone who gets too close without food
  for (const e of loaded.values()) for (const p of e.ch.puzzles) {
    if (p.type !== 'mole' || S.solved.has(p.id)) continue;
    if (Math.hypot(p.ox - S.x, p.oz - S.z) < 2.1) {
      p.swipe = (p.swipe || 0) - dt;
      if (p.swipe <= 0) {
        p.swipe = 1.5;
        S.x -= p.dir[0] * 0.8; S.z -= p.dir[1] * 0.8;
        log('The mole rears up and swipes at you with a claw like a shovel!', 'bad');
        hurt(6, 'claw');
      }
    }
  }
}

// ---------------------------------------------------------------- the cave closes
const CLOSE_AFTER = 12, CLOSE_TIME = 480;
function startClosing() {
  S.closing = true; S.closeT = CLOSE_TIME;
  Sfx.die();
  flash = 0.3;
  log('Far below, a great bell tolls. A voice like grinding stone rolls up out of the earth:', 'bad');
  log('"ENOUGH. THE CAVE CLOSES AT THE LAST BELL. WHOEVER IS INSIDE, STAYS INSIDE."', 'title');
  log('Get back to camp before the bells stop. Treasure banked from now on counts double.', 'warn');
  if (creatures.length) log('The gloomkins have all fled into the deep.', 'dim');
  creatures = [];
}
function updateClosing(dt) {
  if (!S.closing) return;
  const before = S.closeT;
  S.closeT -= dt;
  if (Math.ceil(before / 60) !== Math.ceil(S.closeT / 60) && S.closeT > 0) {
    const left = Math.ceil(S.closeT / 60);
    Sfx.thud(); flash = Math.max(flash, 0.12);
    log('The bell tolls again. ' + left + ' bell' + (left === 1 ? '' : 's') + ' left.', left <= 2 ? 'bad' : 'warn');
  }
  if (S.closeT <= 0) {
    S.closing = false;
    if (S.level === 0 && atCamp()) escaped(); else trapped();
  }
}
function escaped() {
  S.score.escape = 100; S.endDone = true;
  mode = 'won'; stopAutopilot(); closeConsole(); setMap(false);
  document.exitPointerLock && document.exitPointerLock();
  Sfx.magic();
  saveGame(true);
  const t = totalScore();
  overlay.classList.remove('hidden');
  overlay.innerHTML = '<div class="panel"><h2>You escaped!</h2><p>The last bell booms. You scramble up the mossy walls of the sinkhole as the hillside groans and grinds shut behind you. The Endless Cave has closed, and you are alive, and rather rich. (+100)</p>' +
    '<p>You scored <b>' + t + '</b> points, which makes you a <b>' + rankFor(t) + '</b>.</p>' +
    '<p class="sub">Places discovered: ' + S.visited.size + ' · Treasures banked: ' + S.banked.length + ' · Deepest level: ' + S.deepest + ' · Puzzles solved: ' + S.solved.size + '</p>' +
    '<div class="btns"><button id="bKeep">Keep exploring</button><button id="bAgain">New expedition</button></div></div>';
  $('bKeep').onclick = () => {
    hideOverlay(); mode = 'play'; lockPointer();
    log('By morning the sinkhole has yawned open again. The cave, it seems, is not finished with you.', 'warn');
  };
  $('bAgain').onclick = showTitle;
}
function trapped() {
  mode = 'over'; stopAutopilot(); closeConsole(); setMap(false);
  document.exitPointerLock && document.exitPointerLock();
  Sfx.die();
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  showOver('The last bell booms. With a sound like the world\'s slowest door, every passage grinds shut. You are sealed inside the Endless Cave forever, with the gloomkins and your thoughts.');
}

// ---------------------------------------------------------------- console / map / overlays
function openConsole() {
  consoleOpen = true; consoleEl.classList.add('open'); logEl.classList.add('open');
  cmdEl.value = ''; cmdEl.focus();
  for (const k in keys) keys[k] = false;
}
function closeConsole() {
  consoleOpen = false; consoleEl.classList.remove('open'); logEl.classList.remove('open'); cmdEl.blur();
}
function setMap(on) { mapOpen = on; big.classList.toggle('open', on); if (on) drawMap(bigCtx, big.width, big.height, 6, true); }
function cycleRes() {
  resIdx = (resIdx + 1) % RES_STEPS.length; onResize();
  log('Render resolution: ' + RES_STEPS[resIdx] + ' lines.', 'dim');
}
function lockPointer() { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } }
function hideOverlay() { overlay.classList.add('hidden'); overlay.innerHTML = ''; }
const KEYS_HTML = '<div class="keys"><b>W A S D</b><span>move · mouse to look · Shift run · Space jump</span>' +
  '<b>E</b><span>take / use (ropes, trunk, barrel, standing stones)</span>' +
  '<b>F · R · X</b><span>lamp on/off · refuel lamp · eat</span>' +
  '<b>Click · Q</b><span>swing your axe · throw it (or right-click)</span>' +
  '<b>M · I · L</b><span>map · inventory · look around</span>' +
  '<b>Enter</b><span>type a command: TAKE ALL, DROP IDOL, SCORE, SAY &lt;word&gt;, HELP...</span>' +
  '<b>B · G</b><span>AI plays at 5× · autopilot home to camp (any key takes back control)</span>' +
  '<b>P · K · Esc</b><span>pixel size · sound · pause</span></div>';
function hasSave() { try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; } }
function showTitle() {
  stopAutopilot();
  mode = 'title'; closeConsole(); setMap(false);
  hud.classList.add('hidden');
  document.exitPointerLock && document.exitPointerLock();
  overlay.classList.remove('hidden');
  overlay.innerHTML = '<div class="panel"><h1>THE ENDLESS CAVE</h1><div class="sub">a 3D adventure in the old text-adventure tradition</div>' +
    '<p>Somewhere beneath the hills lies a cave that, according to every drunk in the valley, never ends. It is said to be stuffed with treasure. It is said to be haunted by things that hate the light. They say a lot of things.</p>' +
    '<p>Explore as far and as deep as you dare. Carry what you find back to the trunk at your camp. Keep your lamp burning.</p>' + KEYS_HTML +
    '<div class="btns"><button id="bNew">New expedition</button><button id="bCont"' + (hasSave() ? '' : ' disabled') + '>Continue</button>' +
    '<button id="bAI">Watch the AI play (' + AI_SPEED + '×)</button>' +
    '<span class="sub">seed</span><input class="seed" id="seedIn" value="' + (Math.floor(Math.random() * 1e6)) + '"></div></div>';
  $('bNew').onclick = () => {
    Sfx.init();
    const v = parseInt($('seedIn').value, 10);
    startNewGame(isNaN(v) ? Math.floor(Math.random() * 1e9) : v);
    beginPlay(true);
  };
  $('bCont').onclick = () => { Sfx.init(); if (loadGame()) beginPlay(false); };
  $('bAI').onclick = () => {
    Sfx.init();
    const v = parseInt($('seedIn').value, 10);
    startNewGame(isNaN(v) ? Math.floor(Math.random() * 1e9) : v);
    beginPlay(true, true);
    startAutopilot(false);
  };
}
function beginPlay(intro, noLock) {
  hideOverlay(); hud.classList.remove('hidden');
  mode = 'play'; fade = 1; fadeTarget = 0;
  if (intro) {
    log('THE ENDLESS CAVE', 'title');
    log('You are standing in a sunlit sinkhole at the mouth of a cave that, so they say, never ends. Somewhere below lie riches beyond counting.');
    log('Your camp is here: a trunk for treasure, a barrel of lamp oil and a fire. Bring treasure back and put it in the trunk.');
    log('Press Enter to type commands (try HELP). Press E to pick things up. Good luck.', 'dim');
    S.curRoom = 'intro';
    const c = getChunk(0, 0, 0); S.visited.add('0:0:0:0'); markRoom(c, 0);
  }
  if (!noLock) lockPointer();
}
function showPause() {
  mode = 'paused'; closeConsole();
  overlay.classList.remove('hidden');
  overlay.innerHTML = '<div class="panel"><h2>Paused</h2><p>Score ' + totalScore() + ' · ' + rankFor(totalScore()) + ' · level ' + S.level + ' (' + regionFor(S.level).name + ')</p>' + KEYS_HTML +
    '<div class="setting"><label for="sensIn">Mouse sensitivity</label><input type="range" id="sensIn" min="0.1" max="4" step="0.05" value="' + sensMul + '">' +
    '<span id="sensVal">' + sensMul.toFixed(2) + '×</span></div>' +
    '<div class="btns"><button id="bRes">Resume</button><button id="bAI">Let the AI play (' + AI_SPEED + '×)</button><button id="bHome">Autopilot: go home</button><button id="bSave">Save</button><button id="bQuit">Quit to title</button></div></div>';
  $('sensIn').oninput = e => {
    sensMul = parseFloat(e.target.value);
    $('sensVal').textContent = sensMul.toFixed(2) + '×';
    try { localStorage.setItem(SENS_KEY, String(sensMul)); } catch (err) { /* ignore */ }
  };
  $('bRes').onclick = () => { hideOverlay(); mode = 'play'; lockPointer(); };
  $('bAI').onclick = () => { hideOverlay(); mode = 'play'; startAutopilot(false); };
  $('bHome').onclick = () => { hideOverlay(); mode = 'play'; startAutopilot(true); };
  $('bSave').onclick = () => { saveGame(false); $('bSave').textContent = 'Saved'; };
  $('bQuit').onclick = () => { saveGame(true); showTitle(); };
}
function showDead(msg, obit) {
  overlay.classList.remove('hidden');
  overlay.innerHTML = '<div class="panel"><h2>You have died.</h2><p>' + msg + '</p><p>' + obit + '</p><p class="sub">' + S.lives + ' reincarnation' + (S.lives === 1 ? '' : 's') + ' left.</p>' +
    '<div class="btns"><button id="bRe">Yes, reincarnate me</button><button id="bNo">No, I\'ve had enough</button></div></div>';
  $('bRe').onclick = reincarnate;
  $('bNo').onclick = () => { S.lives = 0; mode = 'over'; try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ } showOver('You decline. Very sensible.'); };
}
function showOver(msg) {
  const t = totalScore();
  overlay.classList.remove('hidden');
  overlay.innerHTML = '<div class="panel"><h2>Your expedition is over.</h2><p>' + msg + '</p>' +
    '<p>You scored <b>' + t + '</b> points, which makes you a <b>' + rankFor(t) + '</b>.</p>' +
    '<p class="sub">Places discovered: ' + S.visited.size + ' · Treasures banked: ' + S.banked.length + ' · Deepest level: ' + S.deepest + ' · Gloomkins dusted: ' + S.kills + '</p>' +
    '<div class="btns"><button id="bAgain">New expedition</button></div></div>';
  $('bAgain').onclick = showTitle;
}

// ---------------------------------------------------------------- save / load
function encodeMap(m) {
  const o = {};
  for (const k in m) { let s = ''; const a = m[k]; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); o[k] = btoa(s); }
  return o;
}
function decodeMap(o) {
  const m = {};
  for (const k in o) { const s = atob(o[k]), a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); m[k] = a; }
  return m;
}
function saveGame(silent) {
  if (!S || mode === 'over') return;
  try {
    const o = Object.assign({}, S, { removed: [...S.removed], visited: [...S.visited], found: [...S.found], map: encodeMap(S.map),
      solved: [...S.solved], hintsBought: [...S.hintsBought], slain: [...S.slain] });
    localStorage.setItem(SAVE_KEY, JSON.stringify(o));
    if (!silent) log('Game saved.', 'dim');
  } catch (e) { if (!silent) log('Could not save: ' + e.message, 'bad'); }
}
function loadGame() {
  let o;
  try { const raw = localStorage.getItem(SAVE_KEY); if (!raw) return false; o = JSON.parse(raw); } catch (e) { return false; }
  setupWorld(o.seed);
  const fresh = newState(o.seed);
  S = Object.assign(fresh, o, { removed: new Set(o.removed), visited: new Set(o.visited), found: new Set(o.found), map: decodeMap(o.map || {}),
    solved: new Set(o.solved || []), hintsBought: new Set(o.hintsBought || []), slain: new Set(o.slain || []), score: Object.assign(fresh.score, o.score) });
  WORLD.solved = S.solved;
  creatures = []; projectiles = []; particles = [];
  streamChunks(true);
  S.vx = S.vz = S.vy = 0; S.curRoom = '';
  logEl.innerHTML = '';
  log('Game restored. You are on level ' + S.level + ', in ' + regionFor(S.level).name + '.', 'dim');
  if (mode === 'play') { fade = 1; fadeTarget = 0; }
  return true;
}

// ---------------------------------------------------------------- HUD & map
function updateHUD() {
  $('hpFill').style.width = Math.max(0, S.health) + '%';
  $('fuelFill').style.width = S.fuel + '%';
  $('lives').textContent = '· ' + S.lives + ' ' + (S.lives === 1 ? 'life' : 'lives') + ' left';
  $('lampState').textContent = S.fuel <= 0 ? '· EMPTY' : '· ' + (S.lampOn ? 'lit' : 'off') + ' ' + Math.ceil(S.fuel) + '%';
  $('scorebox').innerHTML = (S.closing ? '<span style="color:#ff7a5c">CAVE CLOSES IN ' + Math.floor(S.closeT / 60) + ':' + String(Math.floor(S.closeT % 60)).padStart(2, '0') + '</span><br>' : '') + 'SCORE ' + totalScore() + '<br>' + rankFor(totalScore()).toUpperCase() + '<br>BANKED ' + S.banked.length + ' · DEEPEST ' + S.deepest;
  $('locSub').textContent = 'level ' + S.level + ' · ' + regionFor(S.level).name;
  const deg = ((-S.yaw * 180 / Math.PI) % 360 + 360) % 360;
  $('compass').textContent = '< ' + ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8] + ' ' + String(Math.round(deg)).padStart(3, '0') + ' >';
  let h = '';
  for (const i of S.inv) h += '<div class="' + (i.kind === 'treasure' ? 't' : '') + '">' + i.name + '</div>';
  $('inv').innerHTML = h + '<div style="opacity:.6">' + S.inv.length + '/' + MAX_INV + ' carried</div>';
  promptEl.textContent = AI.on ? '' : promptText(interactTarget);
  updateBossBar();
  const ban = $('aiBanner');
  ban.classList.toggle('on', AI.on);
  if (AI.on) ban.textContent = (AI.homeOnly ? 'AUTOPILOT HOME ' : 'AUTOPILOT ') + AI_SPEED + '× · ' + AI.status + ' · any key to take over';
}
function drawMap(ctx, w, h, scale, full) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = full ? 'rgba(8,6,4,0.9)' : 'rgba(8,6,4,0.65)';
  ctx.fillRect(0, 0, w, h);
  const pgx = S.x / CELL, pgz = S.z / CELL, hw = w / scale / 2, hh = h / scale / 2;
  const gx0 = Math.floor(pgx - hw), gx1 = Math.ceil(pgx + hw), gz0 = Math.floor(pgz - hh), gz1 = Math.ceil(pgz + hh);
  const L = S.level;
  const chunksSeen = new Set();
  for (let gz = gz0; gz <= gz1; gz++) {
    let lastKey = null, arr = null, ch = null, cx = 0, cz = 0;
    for (let gx = gx0; gx <= gx1; gx++) {
      cx = Math.floor(gx / CHUNK); cz = Math.floor(gz / CHUNK);
      const key = L + ':' + cx + ':' + cz;
      if (key !== lastKey) { lastKey = key; arr = S.map[key]; ch = arr ? getChunk(cx, cz, L) : null; if (arr) chunksSeen.add(key); }
      if (!arr) continue;
      const li = (gz - cz * CHUNK) * CHUNK + (gx - cx * CHUNK);
      if (!arr[li] || !ch.kind[li]) continue;
      if (ch.pbridge && ch.pbridge.has(li) && S.solved.has(ch.pbridge.get(li).id)) { ctx.fillStyle = '#7a5530'; ctx.fillRect(Math.floor((gx - pgx) * scale + w / 2), Math.floor((gz - pgz) * scale + h / 2), Math.ceil(scale), Math.ceil(scale)); continue; }
      const k = ch.kind[li], fl = ch.flags[li];
      ctx.fillStyle = k === 3 ? '#b49a70' : k === 2 ? '#2a0e0a' : fl & F_LAVA ? '#d0500e' : fl & F_LIQUID ? '#1f5670' : fl & F_SKY ? '#6b8a3e' : ch.room[li] >= 0 ? '#8e7756' : '#665640';
      ctx.fillRect(Math.floor((gx - pgx) * scale + w / 2), Math.floor((gz - pgz) * scale + h / 2), Math.ceil(scale), Math.ceil(scale));
    }
  }
  const mark = (x, z, col, txt) => {
    const sx = (x / CELL - pgx) * scale + w / 2, sy = (z / CELL - pgz) * scale + h / 2;
    if (sx < -10 || sy < -10 || sx > w + 10 || sy > h + 10) return;
    ctx.fillStyle = col; ctx.fillRect(sx - 3, sy - 3, 6, 6);
    if (txt && full) { ctx.fillStyle = col; ctx.font = '18px VT323, monospace'; ctx.fillText(txt, sx + 6, sy + 5); }
  };
  for (const key of chunksSeen) {
    const [, cx, cz] = key.split(':').map(Number);
    const ch = getChunk(cx, cz, L), arr = S.map[key];
    for (const f of ch.features) {
      const li = (Math.floor(f.z / CELL) - cz * CHUNK) * CHUNK + (Math.floor(f.x / CELL) - cx * CHUNK);
      if (!arr[li]) continue;
      if (f.type === 'ropeDown') mark(f.x, f.z, '#ffd24a', 'rope down');
      else if (f.type === 'chuteDown') mark(f.x, f.z, '#ff8a4a', 'chute (one way)');
      else if (f.type === 'ropeUp') mark(f.x, f.z, '#9fe0ff', 'rope up');
      else if (f.type === 'rune') mark(f.x, f.z, '#c58cff', f.word);
      else if (f.type === 'trunk') mark(f.x, f.z, '#7cff8a', 'camp');
    }
  }
  // player arrow
  const cx0 = w / 2, cy0 = h / 2, f = [-Math.sin(S.yaw), -Math.cos(S.yaw)], r = [Math.cos(S.yaw), -Math.sin(S.yaw)];
  const sz = full ? 10 : 6;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cx0 + f[0] * sz, cy0 + f[1] * sz);
  ctx.lineTo(cx0 - f[0] * sz * 0.6 + r[0] * sz * 0.6, cy0 - f[1] * sz * 0.6 + r[1] * sz * 0.6);
  ctx.lineTo(cx0 - f[0] * sz * 0.6 - r[0] * sz * 0.6, cy0 - f[1] * sz * 0.6 - r[1] * sz * 0.6);
  ctx.closePath(); ctx.fill();
  if (full) {
    ctx.fillStyle = '#ffcf6a'; ctx.font = '34px VT323, monospace';
    ctx.fillText('MAP · LEVEL ' + L + ' · ' + regionFor(L).name.toUpperCase(), 24, 44);
    ctx.font = '20px VT323, monospace'; ctx.fillStyle = '#a8875a';
    ctx.fillText('North is up. Only places you have seen are shown. Press M to close.', 24, 70);
  }
}

// ---------------------------------------------------------------- render
function render() {
  const lamp = S ? lampLevel() : 0;
  const bob = Math.sin(bobPhase * 2) * 0.05 * bobAmt;
  const sh = mode === 'play' ? shake * shake : 0;
  const eyeY = S.y + EYE + bob + (Math.random() - 0.5) * sh * 0.25;
  const camX = S.x + (Math.random() - 0.5) * sh * 0.25, camZ = S.z + (Math.random() - 0.5) * sh * 0.25;
  const proj = m4persp(72 * Math.PI / 180, R.aspect, 0.05, 220);
  const view = m4mul(m4rx(-S.pitch), m4mul(m4ry(-S.yaw), m4t(-camX, -eyeY, -camZ)));
  const vp = m4mul(proj, view);
  const f = camFwd(), rx = Math.cos(S.yaw), rz = -Math.sin(S.yaw);
  const lampPos = [S.x + f[0] * 0.4 - rx * 0.3, eyeY - 0.3, S.z + f[2] * 0.4 - rz * 0.3];
  const lc = [1.05 * lamp, 0.8 * lamp, 0.52 * lamp];
  const fog = S.level === 0 ? 0.03 : 0.045;
  R.beginScene(gameTime);
  R.setCamera(vp, [S.x, eyeY, S.z], lampPos, lc, 18, fog);
  for (const e of loaded.values()) R.drawWorld(e.mesh);
  // items
  for (const it of itemsHere()) {
    const dx = it.x - S.x, dz = it.z - S.z;
    if (dx * dx + dz * dz > 60 * 60) continue;
    const light = sampleLight(it.x, it.y + 0.5, it.z);
    let m;
    if (it.kind === 'axe') m = m4trs(it.x, it.y + 0.06, it.z, it.ph, Math.PI / 2, 0, 1.3);
    else m = m4trs(it.x, it.y + 0.1 + Math.sin(gameTime * 2 + it.ph) * 0.05, it.z, gameTime * 0.8 + it.ph, 0, 0, it.kind === 'treasure' ? 1.4 : 1.3);
    const glow = it.kind === 'treasure' ? 0.1 + 0.08 * Math.sin(gameTime * 3 + it.ph) : 0.02;
    R.drawEntity(getModel(it.mesh, it.mat), m, light, glow);
  }
  // puzzles
  for (const e of loaded.values()) for (const p of e.ch.puzzles) {
    const done = S.solved.has(p.id);
    const yaw = Math.atan2(p.dir[0], p.dir[1]);
    if (p.type === 'door') {
      const perp = [p.dir[1], -p.dir[0]], cx = p.ox - p.dir[0] * 1.1, cz = p.oz - p.dir[1] * 1.1;
      if (!done) R.drawEntity(getModel('door', 'WOOD'), m4trs(cx, p.y, cz, yaw, 0, 0, 1), sampleLight(cx, p.y + 1, cz));
      else {   // swung open against the corridor wall
        const hx = cx - perp[0] * 1.15, hz = cz - perp[1] * 1.15;
        R.drawEntity(getModel('door', 'WOOD'), m4trs(hx + p.dir[0] * 1.1, p.y, hz + p.dir[1] * 1.1, yaw + Math.PI / 2, 0, 0, 0.95), sampleLight(hx, p.y + 1, hz));
      }
    }
    else if (p.type === 'gate' && !done) R.drawEntity(getModel('gate', 'METAL'), m4trs(p.ox - p.dir[0] * 1.1, p.y, p.oz - p.dir[1] * 1.1, yaw, 0, 0, 1), sampleLight(p.ox, p.y + 1, p.oz));
    else if (p.type === 'mole') {
      const breathe = 1 + Math.sin(gameTime * (done ? 1.2 : 3)) * 0.03;
      if (!done) R.drawEntity(getModel('mole', 'DIRT'), m4trs(p.ox, p.y, p.oz, yaw + Math.PI, 0, 0, breathe), sampleLight(p.ox, p.y + 1, p.oz));
      else R.drawEntity(getModel('mole', 'DIRT'), m4trs(p.rx, p.y, p.rz, yaw + 2.3, 0, 0, 0.9 * breathe), sampleLight(p.rx, p.y + 1, p.rz));
    } else if (p.type === 'gap' && done) R.drawEntity(getModel('bridge', 'WOOD'), m4trs(p.ox, p.y, p.oz, yaw, 0, 0, 1), sampleLight(p.ox, p.y + 1, p.oz));
    else if (p.type === 'vine') {
      const vx = p.bx + p.dir[0] * 0.75, vz = p.bz + p.dir[1] * 0.75;
      R.drawEntity(getModel(done ? 'vine' : 'bulb', done ? 'MOSS' : 'SKIN'), m4trs(vx, p.y, vz, yaw, 0, 0, 1), sampleLight(vx, p.y + 1, vz), done ? 0.05 : 0);
    }
  }
  drawCreatures();
  for (const p of projectiles) {
    const light = sampleLight(p.x, p.y, p.z);
    const yaw = Math.atan2(p.vx, p.vz);
    if (p.type === 'axe' || p.type === 'gaxe') R.drawEntity(getModel('axe', 'METAL'), m4mul(m4trs(p.x, p.y, p.z, yaw, p.spin, 0, 1.3), m4t(0, -0.35, 0)), light);
    else R.drawEntity(getModel('knife', 'METAL'), m4mul(m4trs(p.x, p.y, p.z, yaw, Math.PI / 2, 0, 1.5), m4t(0, -0.15, 0)), light);
  }
  for (const p of particles) {
    const k = p.life / p.max, s = p.grow ? p.s * (1 + (1 - k) * p.grow) * Math.min(1, k * 3) : p.s * k;
    R.drawEntity(getModel(p.mat === 'FIRE' ? 'flame' : 'puff', p.mat || 'SMOKE'), m4trs(p.x, p.y, p.z, p.life * 3, p.life * 2, 0, s), [0.5, 0.5, 0.5], p.glow || 0.2);
  }
  // water
  R.blend(true);
  for (const e of loaded.values()) if (e.water) R.drawWorld(e.water, 0.72);
  R.blend(false);
  // view models (drawn in view space on top)
  if (mode !== 'title') {
    R.clearDepth();
    const vproj = m4persp(60 * Math.PI / 180, R.aspect, 0.01, 10);
    const sb = Math.sin(bobPhase) * 0.012 * bobAmt, cb = Math.abs(Math.cos(bobPhase)) * 0.012 * bobAmt;
    const vLamp = [-0.2 + sb, -0.12 - cb, -0.4];
    R.setCamera(vproj, [0, 0, 0], vLamp, lc, 4, 0.0);
    const amb = sampleLight(S.x, S.y + 1.2, S.z);
    const vlight = [amb[0] + 0.05, amb[1] + 0.05, amb[2] + 0.05];
    const lit = lamp > 0;
    R.drawEntity(getModel('lantern', lit ? 'GLASS' : 'BLACK'), m4trs(-0.25 + sb, -0.27 - cb, -0.5, 0.3, 0, Math.sin(bobPhase) * 0.04 * bobAmt, 0.55), vlight);
    drawViewAxe(vlight, sb, cb);
  }
  R.present(fade, flash, flashCol);
}

// ---------------------------------------------------------------- main loop
function update(dt, stream = true) {
  if (pending) { pending.t -= dt; if (pending.t <= 0) { const fn = pending.fn; pending = null; fn(); } return; }
  if (mode !== 'play' || consoleOpen) return;
  S.time += dt;
  const sens = BASE_SENS * sensMul;
  S.yaw -= mouseDX * sens; S.pitch = clamp(S.pitch - mouseDY * sens, -1.45, 1.45);
  mouseDX = mouseDY = 0;
  if (stream) streamChunks(false);
  const { g, moving } = updatePlayer(dt);
  if (mode !== 'play') return;
  if (S.lampOn && S.fuel > 0) {
    const before = S.fuel;
    S.fuel = Math.max(0, S.fuel - dt / 7);
    if (before > 25 && S.fuel <= 25) log('Your lamp is getting dim. You had better find some oil, or head back to camp.', 'warn');
    if (before > 10 && S.fuel <= 10) log('Your lamp flickers ominously. It will not last much longer!', 'bad');
    if (S.fuel <= 0) { S.lampOn = false; Sfx.lamp(false); log('Your lamp sputters and goes out. Darkness swallows you whole.', 'bad'); }
  }
  updateEnvironment(dt, g, moving);
  if (mode !== 'play') return;
  updateStuck(dt);
  updateClosing(dt);
  if (mode !== 'play') return;
  spawnLogic(dt);
  updateCreatures(dt);
  updateProjectiles(dt);
  updateParticles(dt);
  if (throwAnim > 0) throwAnim -= dt;
  interactTarget = findTarget();
}
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;
  gameTime += dt;
  if (S) {
    if (mode === 'title') { S.yaw += dt * 0.08; S.pitch = 0.12; mouseDX = mouseDY = 0; }
    else if (AI.on) { for (let k = 0; k < AI_SPEED; k++) { aiStep(dt); update(dt, k === 0); } }
    else update(dt);
    fade += (fadeTarget - fade) * Math.min(1, dt * (fadeTarget > fade ? 6 : 2.5));
    flash = Math.max(0, flash - dt * 1.2);
    shake = Math.max(0, shake - dt * 1.6);
    render();
    if (mode !== 'title') {
      hudT -= dt;
      if (hudT <= 0) {
        hudT = 0.1; updateHUD();
        drawMap(miniCtx, mini.width, mini.height, 3, false);
        if (mapOpen) drawMap(bigCtx, big.width, big.height, 6, true);
      }
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- input
function onResize() {
  R.resize(window.innerWidth, window.innerHeight, RES_STEPS[resIdx]);
  big.width = window.innerWidth; big.height = window.innerHeight;
}
addEventListener('keydown', e => {
  if (consoleOpen) {
    if (e.code === 'Enter') { e.preventDefault(); const v = cmdEl.value; closeConsole(); runCommand(v); }
    else if (e.code === 'Escape') { e.preventDefault(); closeConsole(); }
    else if (e.code === 'ArrowUp') { e.preventDefault(); if (histIdx > 0) cmdEl.value = cmdHistory[--histIdx]; }
    else if (e.code === 'ArrowDown') { e.preventDefault(); histIdx = Math.min(cmdHistory.length, histIdx + 1); cmdEl.value = cmdHistory[histIdx] || ''; }
    return;
  }
  if (AI.on) {
    // any key interrupts the autopilot; Esc also pauses
    e.preventDefault();
    stopAutopilot();
    log('[You take back control.]', 'cmd');
    if (mode === 'play') { if (e.code === 'Escape') showPause(); else lockPointer(); }
    return;
  }
  if (mode === 'dead' && e.code === 'Enter') { reincarnate(); return; }
  if (mode === 'paused' && e.code === 'Enter') { hideOverlay(); mode = 'play'; lockPointer(); return; }
  if (mode !== 'play') return;
  if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash'].includes(e.code)) e.preventDefault();
  if (e.repeat) { keys[e.code] = true; return; }
  keys[e.code] = true;
  switch (e.code) {
    case 'Enter': case 'KeyT': case 'Slash': e.preventDefault(); openConsole(); break;
    case 'KeyE': interact(); break;
    case 'KeyF': toggleLamp(); break;
    case 'KeyI': showInventory(); break;
    case 'KeyL': look(); break;
    case 'KeyM': case 'Tab': setMap(!mapOpen); break;
    case 'KeyR': if (featureNear('barrel', 4)) refillBarrel(); else refuel(); break;
    case 'KeyX': eat(); break;
    case 'KeyQ': throwAxe(); break;
    case 'KeyH': for (const h of HELP_LINES) log(h, 'dim'); break;
    case 'KeyP': cycleRes(); break;
    case 'KeyK': log(Sfx.toggleMute() ? 'Sound off.' : 'Sound on.', 'dim'); break;
    case 'KeyB': startAutopilot(false); break;
    case 'KeyG': startAutopilot(true); break;
  }
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
addEventListener('mousemove', e => {
  if (document.pointerLockElement === canvas && mode === 'play' && !consoleOpen) { mouseDX += e.movementX || 0; mouseDY += e.movementY || 0; }
});
canvas.addEventListener('mousedown', e => {
  Sfx.init();
  if (AI.on && mode === 'play') { stopAutopilot(); log('[You take back control.]', 'cmd'); lockPointer(); return; }
  if (mode !== 'play') return;
  if (document.pointerLockElement !== canvas) { lockPointer(); return; }
  if (consoleOpen) return;
  if (e.button === 0) meleeSwing();
  else if (e.button === 2) throwAxe();
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas && mode === 'play' && !consoleOpen && !AI.on) showPause();
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
cmdEl.addEventListener('blur', () => { if (consoleOpen) setTimeout(() => consoleOpen && cmdEl.focus(), 0); });

// ---------------------------------------------------------------- boot
function boot() {
  try { R = new Renderer(canvas); }
  catch (e) {
    overlay.innerHTML = '<div class="panel"><h2>No WebGL2</h2><p>This game needs a browser with WebGL2 enabled. (' + e.message + ')</p></div>';
    return;
  }
  onResize();
  addEventListener('resize', onResize);
  setTimeout(() => {
    R.uploadTextures(generateTextures());
    startNewGame(Math.floor(Math.random() * 1e9));
    showTitle();
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }, 30);
}
boot();
