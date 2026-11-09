'use strict';
// ---------------------------------------------------------------------------
// Creatures, animation and combat.
//
// Creatures are drawn from jointed part models (torso, head, arms, legs...)
// posed every frame from a small state machine. Every attack is telegraphed:
// gloomkins wind up before throwing or lunging, the wyrm rears back with a
// glowing throat before it breathes fire. The player can swing the axe
// (click) or throw it (right-click / Q); hits knock enemies back and stagger
// them.
// ---------------------------------------------------------------------------

let swingT = 0, swingCool = 0, swingHitT = -1, shake = 0, fireAcc = 0;
const SWING_TIME = 0.32;

function ease(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
function progress(c, dur) { return clamp(1 - c.st / dur, 0, 1); }

// ---- spawning ----------------------------------------------------------------
function makeGloom(x, z, y) {
  const hp = S.level >= 7 ? 3 : S.level >= 4 ? 2 : 1;
  return { type: 'gloom', x, z, y, t: 0, hp, maxHp: hp, scale: 1.05 + 0.13 * (hp - 1), cool: 2 + Math.random() * 2, melee: 0,
    seen: false, strafe: Math.random() < 0.5 ? 1 : -1, life: 1e9, face: 0, ph: Math.random() * 6, state: 'move', st: 0,
    walk: 0, speed: 0, kx: 0, kz: 0, flashT: 0 };
}
function makeWyrm(f) {
  return { type: 'wyrm', id: f.id, home: { x: f.x, z: f.z }, x: f.x, z: f.z, y: f.y, face: f.face || 0, hp: 8, maxHp: 8,
    state: 'sleep', st: 0, t: 0, life: 1e9, walk: 0, speed: 0, flashT: 0, flinch: 0, cool: 2, snoreT: 2, awayT: 0,
    leash: Math.max(5, f.r * 0.5), scale: 2.0, aim: 0, dieT: 0, name: 'the Cinder Wyrm' };
}
function spawnWyrmsFor(ch) {
  for (const f of ch.features) {
    if (f.type !== 'wyrm' || S.slain.has(f.id) || creatures.some(c => c.id === f.id)) continue;
    creatures.push(makeWyrm(f));
  }
}
function spawnLogic(dt) {
  if (S.level < 1 || S.closing) return;
  spawnTimer -= dt;
  if (spawnTimer > 0) return;
  spawnTimer = 7 + Math.random() * 10;
  const glooms = creatures.filter(c => c.type === 'gloom').length;
  const maxG = Math.min(5, 1 + Math.floor(S.level / 2));
  if (glooms < maxG && Math.random() < Math.min(0.65, 0.2 + S.level * 0.05)) spawnCreature('gloom');
  if (S.level >= 2 && !creatures.some(c => c.type === 'shade') && S.inv.some(i => i.kind === 'treasure') && Math.random() < 0.12) spawnCreature('shade');
}
function spawnCreature(type) {
  for (let k = 0; k < 30; k++) {
    const a = Math.random() * Math.PI * 2, d = 14 + Math.random() * 16;
    const x = S.x + Math.cos(a) * d, z = S.z + Math.sin(a) * d;
    const g = groundInfo(S.level, x, z);
    if (g.kind !== 1 || (g.flags & (F_LAVA | F_LIQUID))) continue;
    if (type === 'gloom' && d < 22 && los(S.level, S.x, S.y + 1.5, S.z, x, g.floor + 1, z)) continue;
    if (creatures.some(c => c.type === 'wyrm' && Math.hypot(c.home.x - x, c.home.z - z) < 25)) continue;   // gloomkins avoid the lair
    if (type === 'gloom') creatures.push(makeGloom(x, z, g.floor));
    else {
      creatures.push({ type, x, z, y: g.floor, t: 0, life: 45, face: 0, ph: Math.random() * 6, state: 'move', st: 0, hp: 1, flashT: 0, kx: 0, kz: 0 });
      log('You hear soft, delighted laughter somewhere behind you...', 'warn'); Sfx.shade();
    }
    return;
  }
}

// ---- player attacks ------------------------------------------------------------
function hasAxe() { return S.inv.some(i => i.kind === 'axe'); }
function meleeSwing() {
  if (!hasAxe()) { log('You have nothing to fight with. (Find an axe.)', 'dim'); return; }
  if (swingCool > 0) return;
  swingCool = 0.55; swingT = SWING_TIME; swingHitT = 0.12;
  Sfx.swing();
}
function resolveSwing() {
  const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
  let best = null, bs = 1e9;
  for (const c of creatures) {
    if (c.state === 'dying') continue;
    const dx = c.x - S.x, dz = c.z - S.z, d = Math.hypot(dx, dz) || 0.01;
    const reach = c.type === 'wyrm' ? 2.6 * c.scale : 2.5;   // the wyrm is big: its head is well in front of its body
    if (d > reach || (dx * fx + dz * fz) / d < 0.4) continue;
    if (Math.abs(c.y - S.y) > 2.5) continue;
    if (d < bs) { bs = d; best = c; }
  }
  if (!best) return;
  const d = Math.hypot(best.x - S.x, best.z - S.z) || 0.01;
  damageCreature(best, 1, (best.x - S.x) / d, (best.z - S.z) / d, 'swing');
}
function throwAxe() {
  const idx = S.inv.findIndex(i => i.kind === 'axe');
  if (idx < 0) { log('You have nothing to throw. (Find an axe.)', 'dim'); return; }
  const it = S.inv.splice(idx, 1)[0], f = camFwd();
  projectiles.push({ type: 'axe', item: it, x: S.x + f[0] * 0.6, y: S.y + 1.45 + f[1] * 0.6, z: S.z + f[2] * 0.6,
    vx: f[0] * 21, vy: f[1] * 21 + 0.8, vz: f[2] * 21, life: 4, spin: 0, lx: S.x, lz: S.z });
  throwAnim = 0.35;
  Sfx.whoosh();
}
const HIT_LINES = ['Your axe bites deep! The gloomkin staggers back, snarling.', 'A solid hit! The gloomkin reels.', 'Thwack! It howls and stumbles away from you.'];
function damageCreature(c, n, dx, dz, how) {
  if (c.state === 'dying') return;
  c.hp -= n; c.flashT = 0.3;
  Sfx.thwack(panFor(c.x, c.z));
  if (c.type === 'wyrm') { hurtWyrm(c, how); return; }
  if (c.type === 'shade' || c.hp <= 0) { startDying(c, how); return; }
  c.state = 'hurt'; c.st = 0.45; c.kx = dx * 7; c.kz = dz * 7; c.cool = Math.max(c.cool, 1.2);
  log(HIT_LINES[Math.floor(Math.random() * HIT_LINES.length)], 'good');
}
function startDying(c, how) {
  c.state = 'dying'; c.st = 0; S.kills++;
  Sfx.poof(panFor(c.x, c.z));
  if (c.type === 'shade') {
    dustBurst(c.x, c.y + 1, c.z, 12);
    log('Your axe passes through the shade with a shriek. It unravels into tatters of smoke.', 'good');
    c.gone = true;
    return;
  }
  log(how === 'throw' ? 'Your axe finds its mark. The gloomkin topples over and crumbles into grey dust.'
    : 'With a final blow the gloomkin keels over, and crumbles into grey dust.', 'good');
}
function dustBurst(x, y, z, n, mat = 'SMOKE') {
  for (let k = 0; k < n; k++) particles.push({ x, y: y + Math.random() * 0.6, z, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 2, vz: (Math.random() - 0.5) * 3, life: 0.9, max: 0.9, s: 1 + Math.random() * 1.5, mat });
}

// ---- gloomkin behaviour --------------------------------------------------------
function throwKnife(c) {
  const ox = c.x + Math.sin(c.face) * 0.3, oy = c.y + 1.1 * c.scale, oz = c.z + Math.cos(c.face) * 0.3;
  if (!S.axeGift) {
    // like the original's first dwarf: it hurls its axe, misses, and you get a weapon out of it
    S.axeGift = true;
    const side = Math.random() < 0.5 ? 1 : -1, rx = Math.cos(S.yaw) * side * 1.6, rz = -Math.sin(S.yaw) * side * 1.6;
    const tx = S.x + rx, tz = S.z + rz, d = Math.hypot(tx - ox, tz - oz) || 1, t = d / 13;
    projectiles.push({ type: 'gaxe', item: mkAxe(), x: ox, y: oy, z: oz, vx: (tx - ox) / t, vy: (S.y + 0.6 - oy) / t + 4.5 * t, vz: (tz - oz) / t, life: 3, spin: 0, lx: ox, lz: oz });
    Sfx.whoosh();
    log('The gloomkin hurls a small axe at you! It misses by a whisker and clatters to the floor beside you.', 'warn');
    log('Its owner looks at its empty hands, squeaks, and scuttles off into the dark. That was careless of it.', 'good');
    c.state = 'flee'; c.life = 4;
    return;
  }
  // Like the original's dwarves: the first volley always misses, and after that each knife has a fixed
  // chance of flying true (12% on level 1, rising to 30%). True knives are aimed where you will be, so you
  // can still dodge them; the rest go visibly wide. Three hits will kill you.
  const dist = Math.hypot(S.x - ox, S.z - oz), lead = dist / 16;
  const tx = S.x + S.vx * lead, ty = S.y + 1.1, tz = S.z + S.vz * lead;
  let dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const d = Math.hypot(dx, dy, dz) || 1;
  dx /= d; dy /= d; dz /= d;
  const p = knifeAccuracy();
  const truth = S.knives > 0 && Math.random() < p;
  S.knives++;
  if (!truth) {
    const side = (Math.random() < 0.5 ? 1 : -1) * (0.09 + Math.random() * 0.12), c0 = Math.cos(side), s0 = Math.sin(side);
    [dx, dz] = [dx * c0 - dz * s0, dx * s0 + dz * c0];
    dy += (Math.random() - 0.3) * 0.12;
  }
  projectiles.push({ type: 'knife', x: ox, y: oy, z: oz, vx: dx * 16, vy: dy * 16 + 0.3, vz: dz * 16, life: 3, spin: 0 });
  Sfx.whoosh();
  knifeMsgT -= 1;
  if (knifeMsgT <= 0) { knifeMsgT = 4; log('A knife whistles out of the darkness!', 'warn'); }
}
function knifeAccuracy() { return Math.min(0.3, 0.12 + 0.02 * Math.max(0, S.level - 1)); }
// gloomkins hunt you through the passages, like the original's dwarves following you from room to room
function chaseDir(c, dt) {
  c.pathT = (c.pathT || 0) - dt;
  if (!c.path || c.pathT <= 0) {
    c.pathT = 1.5 + Math.random();
    c.path = findPath(S.level, c.x, c.z, S.x, S.z, 1, 2500, c.y);
    c.pi = 0;
  }
  if (!c.path || !c.path.length) return null;
  while (c.pi < c.path.length - 1 && Math.hypot(c.path[c.pi][0] - c.x, c.path[c.pi][1] - c.z) < 0.8) c.pi++;
  const w = c.path[c.pi], wx = w[0] - c.x, wz = w[1] - c.z, wd = Math.hypot(wx, wz) || 1;
  return [wx / wd, wz / wd];
}
function moveCreature(c, mx, mz, spd, dt, radius) {
  const ox = c.x, oz = c.z;
  const r = collide(S.level, c.x + mx * spd * dt, c.z + mz * spd * dt, radius, c.y);
  const g = groundInfo(S.level, r[0], r[1]);
  if (g.kind === 1 && !(g.flags & F_LAVA)) { c.x = r[0]; c.z = r[1]; c.y = g.floor; }
  const moved = Math.hypot(c.x - ox, c.z - oz);
  c.walk += moved * 3.2;
  c.speed = moved / Math.max(dt, 1e-4);
  return moved;
}
function updateGloom(c, dt, d, dx, dz, see) {
  if (see && !c.seen && d < 24) {
    c.seen = true; Sfx.growl(panFor(c.x, c.z));
    if (!S.metGloom) {
      S.metGloom = true;
      log('A gloomkin, one of the hunched grey things that hate light and love sharp objects, snarls at you from the shadows!', 'bad');
      log('(Click to swing your axe, right-click or Q to throw it. Watch for its arm going back: that is a knife on the way.)', 'dim');
    } else log('A gloomkin snarls at you from the darkness!', 'bad');
  }
  c.st -= dt;
  let mx = 0, mz = 0;
  switch (c.state) {
    case 'hurt': if (c.st <= 0) c.state = 'move'; break;
    case 'windup': if (c.st <= 0) { throwKnife(c); if (c.state !== 'flee') { c.state = 'throw'; c.st = 0.25; } } break;
    case 'throw': if (c.st <= 0) c.state = 'move'; break;
    case 'lunge':
      if (c.st <= 0) {
        c.state = 'swipe'; c.st = 0.22;
        if (d < 2.1) {
          hurt(10, 'claw');
          log('A gloomkin rakes you with its claws!', 'bad');
          const r = collide(S.level, S.x + dx / d * 0.9, S.z + dz / d * 0.9, RADIUS, S.y); S.x = r[0]; S.z = r[1];
        }
      }
      break;
    case 'swipe': if (c.st <= 0) c.state = 'move'; break;
    case 'flee': mx = -dx / d; mz = -dz / d; break;
    default: {
      const ideal = lampLevel() > 0 ? 10 : 3;
      if (!see) { const cd = chaseDir(c, dt); if (cd) { mx = cd[0]; mz = cd[1]; } else { mx = dx / d; mz = dz / d; } }
      else if (d > ideal + 3) { mx = dx / d; mz = dz / d; c.path = null; }
      else if (d < ideal - 3 && d > 2.2) { mx = -dx / d * 0.7; mz = -dz / d * 0.7; }
      else if (d >= 2.2) { mx = -dz / d * c.strafe * 0.6; mz = dx / d * c.strafe * 0.6; if (Math.random() < dt * 0.4) c.strafe *= -1; }
      if (see && d < 22 && d > 2.6) {
        c.cool -= dt;
        if (c.cool <= 0) { c.cool = 2.4 + Math.random() * 2.2; c.state = 'windup'; c.st = 0.6; Sfx.grunt(panFor(c.x, c.z)); }
      }
      c.melee -= dt;
      if (d < 1.9 && c.melee <= 0) { c.melee = 1.6; c.state = 'lunge'; c.st = 0.38; Sfx.grunt(panFor(c.x, c.z)); }
    }
  }
  if (mx || mz) {
    if (moveCreature(c, mx, mz, c.state === 'flee' ? 5 : 3.1, dt, 0.4) < 3.1 * dt * 0.3) c.strafe *= -1;
  } else c.speed *= Math.max(0, 1 - dt * 10);
  const target = (mx || mz) && (!see || c.state === 'flee') ? Math.atan2(mx, mz) : Math.atan2(dx, dz);
  c.face += clamp(angWrap(target - c.face), -7 * dt, 7 * dt);
}

// ---- the Cinder Wyrm ---------------------------------------------------------
// The model is "Animated Monsters" by Quaternius (CC0), baked into per-vertex
// keyframes; here we blend between keyframes and rebuild a flat-shaded mesh.
const Dragon = (() => {
  let ready = false, V = 0, NT = 0, idx, pos, triLayer, triTint, mesh, buf, P, eyes = [], anims;
  const MATS = {
    Main: [T.SCALES, [1, 1, 1]], Belly: [T.BONE, [1.0, 0.78, 0.5]], Wings: [T.SCALES, [0.6, 0.45, 0.45]],
    Claws: [T.BONE, [0.95, 0.9, 0.85]], Eyes: [T.EYE, [1, 1, 1]],
  };
  function b64(str) { const s = atob(str), a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  function init() {
    const d = DRAGON_DATA;
    V = d.verts; NT = d.tris; anims = d.anims;
    idx = new Uint16Array(b64(d.index).buffer);
    const q = new Uint16Array(b64(d.frames).buffer);
    pos = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) pos[i] = d.lo[i % 3] + q[i] * d.scale[i % 3];
    triLayer = new Float32Array(NT); triTint = new Float32Array(NT * 3);
    const eyeSet = new Set();
    d.triMat.forEach((m, t) => {
      const [lay, tint] = MATS[d.materials[m]] || MATS.Main;
      triLayer[t] = lay; triTint.set(tint, t * 3);
      if (d.materials[m] === 'Eyes') for (let k = 0; k < 3; k++) eyeSet.add(idx[t * 3 + k]);
    });
    eyes = [...eyeSet];
    mesh = R.createDynamicMesh(NT * 3);
    buf = new Float32Array(NT * 3 * 10);
    P = new Float32Array(V * 3);
    ready = true;
  }
  // blend the two keyframes around time t (seconds) of an animation into P
  function sample(name, t, loop) {
    if (!ready) init();
    const a = anims[name], n = a.count;
    let f = t * a.fps;
    f = loop ? ((f % n) + n) % n : clamp(f, 0, n - 1);
    const f0 = Math.floor(f), f1 = loop ? (f0 + 1) % n : Math.min(n - 1, f0 + 1), k = f - f0;
    const o0 = (a.start + f0) * V * 3, o1 = (a.start + f1) * V * 3;
    for (let i = 0; i < V * 3; i++) P[i] = pos[o0 + i] + (pos[o1 + i] - pos[o0 + i]) * k;
  }
  function eyeCentre() {
    let x = 0, y = 0, z = 0;
    for (const v of eyes) { x += P[v * 3]; y += P[v * 3 + 1]; z += P[v * 3 + 2]; }
    return [x / eyes.length, y / eyes.length, z / eyes.length];
  }
  function draw(model, light, glow) {
    let o = 0;
    for (let t = 0; t < NT; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (const v of [a, b, c]) {
        buf[o] = P[v]; buf[o + 1] = P[v + 1]; buf[o + 2] = P[v + 2];
        buf[o + 3] = nx; buf[o + 4] = ny; buf[o + 5] = nz;
        buf[o + 6] = triTint[t * 3]; buf[o + 7] = triTint[t * 3 + 1]; buf[o + 8] = triTint[t * 3 + 2];
        buf[o + 9] = triLayer[t];
        o += 10;
      }
    }
    R.updateMesh(mesh, buf, NT * 3);
    R.drawEntity(mesh, model, light, glow, 1, 1.2);
  }
  return { sample, eyeCentre, draw };
})();
// which animation (and how far into it) each wyrm state shows
function wyrmClip(c) {
  switch (c.state) {
    case 'sleep': return ['death', 99, false, true];                            // curled up on the hoard, slowly breathing
    case 'roar': return ['attack2', (1.5 - c.st) * 1.1, false];
    case 'breathW': return ['attack2', (1.0 - c.st) * 0.55, false];
    case 'breath': return ['attack2', 0.55 + (1.4 - c.st) * 0.85, false];
    case 'biteW': return ['attack', (0.55 - c.st) * 0.8, false];
    case 'bite': return ['attack', 0.45 + (0.3 - c.st) * 1.5, false];
    case 'tailW': return ['hit', (0.5 - c.st) * 1.2, false];
    case 'tail': return ['hit', 0.6 + (0.4 - c.st) * 2.5, false];
    case 'dying': return ['death', c.dieT * 0.6, false];
  }
  if (c.flinch > 0) return ['hit', (0.3 - c.flinch) * 2, false];
  return ['flying', c.t, true];
}
function wyrmModelMatrix(c) {
  const sinking = c.state === 'dying' ? Math.max(0, c.dieT - 1.8) * 0.5 : 0;
  return m4trs(c.x, c.y - sinking, c.z, c.face, 0, 0, c.scale);
}
function wyrmMouth(c) {
  const [anim, t, loop] = wyrmClip(c);
  Dragon.sample(anim, t, loop);
  const e = Dragon.eyeCentre(), M = wyrmModelMatrix(c);
  const p = m4pt(M, e[0], e[1] - 0.25, e[2] + 0.75);
  return { p, d: [Math.sin(c.aim), -0.12, Math.cos(c.aim)] };
}
function wakeWyrm(c, why) {
  if (c.state !== 'sleep' && c.state !== 'return') return;
  c.state = 'roar'; c.st = 1.5; c.cool = 1.5;
  Sfx.roar(panFor(c.x, c.z)); shake = Math.max(shake, 0.6);
  if (!S.metWyrm) {
    S.metWyrm = true;
    log(why === 'hit' ? 'Your axe glances off a scale the size of a dinner plate. The heap of treasure heaves, and the Cinder Wyrm uncoils with a roar that shakes dust from the ceiling!'
      : 'The heap of treasure heaves. Two eyes like furnace doors swing open, and the Cinder Wyrm uncoils with a roar that shakes dust from the ceiling!', 'bad');
    log('(Watch its throat: when it glows, get out of the way. Its back end swings a mean tail. Or run: it will not leave its lair.)', 'dim');
  } else log('The Cinder Wyrm wakes with a furious roar!', 'bad');
}
function hurtWyrm(c, how) {
  if (c.state === 'sleep' || c.state === 'return') wakeWyrm(c, 'hit');
  c.flinch = 0.3;
  if (c.hp <= 0) {
    c.state = 'dying'; c.dieT = 0;
    Sfx.roar(panFor(c.x, c.z)); shake = Math.max(shake, 0.8);
    S.slain.add(c.id); S.score.slain = (S.score.slain || 0) + 50; S.kills++;
    log('With a last, shuddering roar the Cinder Wyrm crashes down onto its hoard and lies still. (+50)', 'good');
    return;
  }
  const lines = ['The wyrm hisses as your axe bites between its scales!', 'A hit! Black blood smokes on the stone.', 'The wyrm flinches and snarls.'];
  log(lines[Math.floor(Math.random() * lines.length)] + ' (' + c.hp + '/' + c.maxHp + ')', 'good');
}
function updateWyrm(c, dt) {
  const dx = S.x - c.x, dz = S.z - c.z, d = Math.hypot(dx, dz) || 0.001;
  const rel = angWrap(Math.atan2(dx, dz) - c.face);
  const homeD = Math.hypot(c.x - c.home.x, c.z - c.home.z);
  if (c.flinch > 0) c.flinch -= dt;
  c.st -= dt;
  if (c.state === 'dying') {
    c.dieT += dt;
    if (c.dieT > 2.4) { dustBurst(c.x, c.y + 1, c.z, 24); c.gone = true; }
    return;
  }
  if (c.state === 'sleep') {
    c.snoreT -= dt;
    if (c.snoreT <= 0) { c.snoreT = 3.8; if (d < 32) Sfx.snore(panFor(c.x, c.z)); }
    const running = (keys.ShiftLeft || keys.ShiftRight) && Math.hypot(S.vx, S.vz) > 5;
    const seenLight = lampLevel() > 0 && d < 13 && los(S.level, c.x, c.y + 2, c.z, S.x, S.y + 1.5, S.z);
    if (seenLight || d < 5.5 || (running && d < 9)) wakeWyrm(c, 'light');
    return;
  }
  const turn = (rate) => { c.face += clamp(rel, -rate * dt, rate * dt); };
  switch (c.state) {
    case 'roar': turn(1.0); if (c.st <= 0) c.state = 'stalk'; break;
    case 'return': {
      const hx = c.home.x - c.x, hz = c.home.z - c.z, hd = Math.hypot(hx, hz);
      if (hd < 1) { c.state = 'sleep'; c.snoreT = 4; log('Somewhere behind you, the wyrm settles back onto its hoard with a grumbling sigh.', 'dim'); break; }
      c.face += clamp(angWrap(Math.atan2(hx, hz) - c.face), -1.5 * dt, 1.5 * dt);
      moveCreature(c, hx / hd, hz / hd, 1.6, dt, 1.2);
      if (d < 9 && lampLevel() > 0) wakeWyrm(c, 'light');
      break;
    }
    case 'stalk': {
      turn(1.4);
      c.cool -= dt;
      if (d > c.leash + 16) { c.awayT += dt; if (c.awayT > 6) { c.state = 'return'; c.awayT = 0; break; } } else c.awayT = 0;
      // shuffle towards the player, but never far from the hoard
      if (d > 3 * c.scale && homeD < c.leash) {
        const nx = c.x + dx / d * 1.8 * dt, nz = c.z + dz / d * 1.8 * dt;
        if (Math.hypot(nx - c.home.x, nz - c.home.z) < c.leash) moveCreature(c, dx / d, dz / d, 1.8, dt, 1.2);
        else c.speed *= 0.9;
      } else c.speed *= Math.max(0, 1 - dt * 6);
      if (c.cool <= 0) {
        if (d < 2.7 * c.scale && Math.abs(rel) < 0.7) { c.state = 'biteW'; c.st = 0.55; Sfx.grunt(panFor(c.x, c.z)); }
        else if (d < 3.0 * c.scale && Math.abs(rel) > 2.2) { c.state = 'tailW'; c.st = 0.5; }
        else if (d < 15 && Math.abs(rel) < 0.5 && los(S.level, c.x, c.y + 2.5, c.z, S.x, S.y + 1.5, S.z)) {
          c.state = 'breathW'; c.st = 1.0; c.aim = c.face;
          log('The wyrm rears back. Its throat begins to glow!', 'warn');
        }
      }
      break;
    }
    case 'biteW': turn(2.0); if (c.st <= 0) {
      c.state = 'bite'; c.st = 0.3; Sfx.thwack(panFor(c.x, c.z));
      if (d < 3.0 * c.scale && Math.abs(rel) < 0.9) {
        hurt(25, 'wyrm'); log('The wyrm\'s jaws snap shut on you!', 'bad');
        const r = collide(S.level, S.x + dx / d * 2, S.z + dz / d * 2, RADIUS, S.y); S.x = r[0]; S.z = r[1];
      }
    } break;
    case 'bite': if (c.st <= 0) { c.state = 'stalk'; c.cool = 1.3 + Math.random(); } break;
    case 'tailW': if (c.st <= 0) {
      c.state = 'tail'; c.st = 0.4; Sfx.whoosh();
      if (d < 3.3 * c.scale && Math.abs(rel) > 1.8) {
        hurt(15, 'tail'); log('The wyrm\'s tail sweeps you off your feet!', 'bad');
        const r = collide(S.level, S.x + dx / d * 2.5, S.z + dz / d * 2.5, RADIUS, S.y); S.x = r[0]; S.z = r[1];
      }
    } break;
    case 'tail': if (c.st <= 0) { c.state = 'stalk'; c.cool = 1.5 + Math.random(); } break;
    case 'breathW': c.aim += clamp(angWrap(Math.atan2(dx, dz) - c.aim), -0.8 * dt, 0.8 * dt); c.face = c.aim;
      if (c.st <= 0) { c.state = 'breath'; c.st = 1.4; c.pitch = undefined; c.burnMsg = false; Sfx.fire(panFor(c.x, c.z)); } break;
    case 'breath': {
      c.aim += clamp(angWrap(Math.atan2(dx, dz) - c.aim), -0.45 * dt, 0.45 * dt); c.face = c.aim;
      const m = wyrmMouth(c);
      // pitch the jet down towards the player
      const hx = S.x - m.p[0], hz = S.z - m.p[2], hy = (S.y + 1) - m.p[1];
      const want = Math.atan2(hy, Math.hypot(hx, hz) || 0.01);
      c.pitch = c.pitch === undefined ? want : c.pitch + clamp(want - c.pitch, -0.8 * dt, 0.8 * dt);
      const cp = Math.cos(c.pitch), dir = [Math.sin(c.aim) * cp, Math.sin(c.pitch), Math.cos(c.aim) * cp];
      fireAcc += dt * 40;
      while (fireAcc >= 1) {
        fireAcc--;
        const sp = 12 + Math.random() * 4, j = () => (Math.random() - 0.5) * 0.3;
        particles.push({ x: m.p[0], y: m.p[1], z: m.p[2], vx: (dir[0] + j()) * sp, vy: (dir[1] + j()) * sp, vz: (dir[2] + j()) * sp,
          life: 0.75, max: 0.75, s: 1.3, grow: 4, mat: 'FIRE', glow: 1, nograv: true });
      }
      // inside the cone of fire?
      const px = S.x - m.p[0], py = S.y + 1 - m.p[1], pz = S.z - m.p[2], pd = Math.hypot(px, py, pz) || 0.01;
      const cosA = (px * dir[0] + py * dir[1] + pz * dir[2]) / pd;
      if (pd < 15 && cosA > Math.cos(0.32) && los(S.level, m.p[0], m.p[1], m.p[2], S.x, S.y + 1.2, S.z)) {
        hurt(24 * dt, 'fire');
        flashCol[0] = 1.0; flashCol[1] = 0.45; flashCol[2] = 0.05;
        if (!c.burnMsg) { c.burnMsg = true; log('You are engulfed in flame!', 'bad'); }
      }
      if (c.st <= 0) { c.state = 'stalk'; c.cool = 2.4 + Math.random() * 1.6; }
      break;
    }
  }
}

// ---- main creature update ------------------------------------------------------
function updateCreatures(dt) {
  if (swingCool > 0) swingCool -= dt;
  if (swingT > 0) swingT -= dt;
  if (swingHitT >= 0) { swingHitT -= dt; if (swingHitT < 0) resolveSwing(); }
  if (flash <= 0.01) { flashCol[0] = 0.75; flashCol[1] = 0.06; flashCol[2] = 0.02; }
  const L = S.level;
  for (let i = creatures.length - 1; i >= 0; i--) {
    const c = creatures[i];
    c.t += dt; c.life -= dt;
    if (c.flashT > 0) c.flashT -= dt;
    if (c.type === 'wyrm') { updateWyrm(c, dt); if (c.gone) creatures.splice(i, 1); continue; }
    if (c.gone) { creatures.splice(i, 1); continue; }
    if (c.state === 'dying') {
      c.st += dt;
      if (c.st > 1.0) { dustBurst(c.x, c.y + 0.3, c.z, 10); creatures.splice(i, 1); }
      continue;
    }
    const dx = S.x - c.x, dz = S.z - c.z, d = Math.hypot(dx, dz) || 0.001;
    if (d > 60 || c.life < 0) {
      if (c.type === 'shade' && d < 30) log('The laughter fades away into the dark.', 'dim');
      creatures.splice(i, 1); continue;
    }
    if (Math.abs(c.kx) + Math.abs(c.kz) > 0.05) {
      const r = collide(L, c.x + c.kx * dt, c.z + c.kz * dt, 0.4, c.y);
      const g = groundInfo(L, r[0], r[1]);
      if (g.kind === 1 && !(g.flags & F_LAVA)) { c.x = r[0]; c.z = r[1]; c.y = g.floor; }
      const k = Math.exp(-7 * dt); c.kx *= k; c.kz *= k;
    }
    const see = d < 32 && los(L, c.x, c.y + 1.0, c.z, S.x, S.y + 1.5, S.z);
    if (c.type === 'gloom') { updateGloom(c, dt, d, dx, dz, see); continue; }
    // the shade glides straight for you
    moveCreature(c, dx / d, dz / d, 5.6, dt, 0.4);
    c.face = Math.atan2(dx, dz);
    if (d < 1.4) { steal(c); creatures.splice(i, 1); }
  }
}
function updateProjectiles(dt) {
  const L = S.level;
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.vy -= (p.type === 'knife' ? 3 : 9) * dt; p.spin += dt * 14; p.life -= dt;
    const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
    const g = groundInfo(L, nx, nz);
    if (g.kind === 0 || ny < g.floor || ny > g.ceil || p.life < 0) {
      if (p.type === 'axe' || p.type === 'gaxe') { dropAxeAt(p, p.x, p.z); Sfx.clink(); }
      else if (Math.hypot(p.x - S.x, p.z - S.z) < 15) Sfx.clink();
      projectiles.splice(i, 1); continue;
    }
    if (g.kind === 1 || g.kind === 3) { p.lx = nx; p.lz = nz; }
    p.x = nx; p.y = ny; p.z = nz;
    if (p.type === 'gaxe') continue;          // the gift axe never hits anyone
    if (p.type === 'knife') {
      if (Math.hypot(p.x - S.x, p.y - (S.y + 1.0), p.z - S.z) < 0.75) {
        projectiles.splice(i, 1);
        log(['The knife slashes your arm!', 'Ouch! A knife grazes your ribs.', 'A knife bites into your shoulder!'][Math.floor(Math.random() * 3)], 'bad');
        hurt(30 + Math.floor(Math.random() * 15), 'knife');
      }
      continue;
    }
    for (const c of creatures) {
      if (c.state === 'dying') continue;
      let hit;
      if (c.type === 'wyrm') hit = Math.hypot(p.x - c.x, p.z - c.z) < 1.3 * c.scale && p.y > c.y && p.y < c.y + 2.2 * c.scale;
      else {
        const top = c.y + (c.type === 'shade' ? 2.3 : 1.45 * (c.scale || 1));
        hit = Math.hypot(p.x - c.x, p.z - c.z) < (c.type === 'shade' ? 0.9 : 0.8) && p.y > c.y - 0.1 && p.y < top;
      }
      if (hit) {
        const d = Math.hypot(p.vx, p.vz) || 1;
        dropAxeAt(p, c.x - p.vx / d * 1.2, c.z - p.vz / d * 1.2);
        damageCreature(c, 1, p.vx / d, p.vz / d, 'throw');
        projectiles.splice(i, 1);
        break;
      }
    }
  }
}

// ---- posing & drawing ----------------------------------------------------------
function drawPart(name, mat, m, light, glow) { R.drawEntity(getModel(name, mat), m, light, glow); }
function poseGloom(c) {
  const mv = Math.min(1, (c.speed || 0) / 3), sw = Math.sin(c.walk);
  const P = { legL: sw * 0.75 * mv, legR: -sw * 0.75 * mv, armLx: -sw * 0.55 * mv, armRx: sw * 0.55 * mv, armLz: -0.15, armRz: 0.15,
    torso: 0.3 + 0.05 * Math.sin(c.t * 2.3), bob: Math.abs(Math.cos(c.walk)) * 0.07 * mv, headPitch: -0.15, rootPitch: 0, sink: 0, knife: 0 };
  P.headYaw = clamp(angWrap(Math.atan2(S.x - c.x, S.z - c.z) - c.face), -0.9, 0.9);
  switch (c.state) {
    case 'windup': { const t = ease(progress(c, 0.6)); P.armRx = lerp(P.armRx, 2.7, t); P.armRz = 0.35 * t; P.torso = lerp(P.torso, -0.2, t); P.legL = 0.3 * t; P.legR = -0.3 * t; break; }
    case 'throw': { const t = ease(progress(c, 0.25) * 2); P.armRx = lerp(2.7, -1.3, t); P.torso = lerp(-0.2, 0.55, t); P.knife = 1; break; }
    case 'lunge': { const t = ease(progress(c, 0.38)); P.torso = lerp(0.3, 0.75, t); P.armLx = P.armRx = lerp(0, 2.3, t); P.armLz = -0.55 * t; P.armRz = 0.55 * t; P.bob = -0.1 * t; P.legL = 0.5 * t; P.legR = 0.5 * t; break; }
    case 'swipe': { const t = ease(progress(c, 0.22)); P.torso = 0.7; P.armLx = P.armRx = lerp(2.3, -1.1, t); P.armLz = -0.3; P.armRz = 0.3; break; }
    case 'hurt': { const t = 1 - progress(c, 0.45); P.torso = 0.3 - 0.8 * t; P.headPitch = -0.5 * t; P.armLz = -0.15 - 0.9 * t; P.armRz = 0.15 + 0.9 * t; P.armLx = P.armRx = 0.6 * t; break; }
    case 'dying': {
      const t = ease(c.st / 0.5);
      P.rootPitch = -1.45 * t; P.armLz = -1.2 * t; P.armRz = 1.2 * t; P.armLx = P.armRx = 1.0 * t; P.legL = 0.4 * t; P.legR = -0.2 * t;
      P.headPitch = -0.6 * t; P.torso = 0.1; P.sink = Math.max(0, c.st - 0.55) * 0.9; P.bob = 0;
      break;
    }
  }
  return P;
}
function drawGloom(c) {
  const P = poseGloom(c), light = sampleLight(c.x, c.y + 1, c.z), glow = c.flashT > 0 ? c.flashT * 2.4 : 0;
  const shrink = c.state === 'dying' ? 1 - ease((c.st - 0.55) / 0.45) * 0.8 : 1;
  const root = m4trs(c.x, c.y + P.bob - P.sink, c.z, c.face, P.rootPitch, 0, (c.scale || 1.1) * shrink);
  const hip = 0.42;
  const torso = m4chain(root, m4t(0, hip, 0), m4rx(P.torso));
  drawPart('gk_torso', 'SKIN', torso, light, glow);
  drawPart('gk_head', 'SKIN', m4chain(torso, m4t(0, 0.46, 0.0), m4ry(P.headYaw), m4rx(P.headPitch)), light, glow);
  drawPart('gk_arm', 'SKIN', m4chain(torso, m4t(-0.27, 0.38, 0.03), m4rx(-P.armLx), m4rz(P.armLz)), light, glow);
  const armR = m4chain(torso, m4t(0.27, 0.38, 0.03), m4rx(-P.armRx), m4rz(P.armRz));
  drawPart('gk_arm', 'SKIN', armR, light, glow);
  if (!(c.state === 'throw' && P.knife)) drawPart('gk_knife', 'METAL', m4chain(armR, m4t(0, -0.42, 0.03), m4rx(-1.3)), light, glow);
  drawPart('gk_leg', 'SKIN', m4chain(root, m4t(-0.11, hip, 0), m4rx(-P.legL)), light, glow);
  drawPart('gk_leg', 'SKIN', m4chain(root, m4t(0.11, hip, 0), m4rx(-P.legR)), light, glow);
}
function drawWyrm(c) {
  const [anim, t, loop, breathe] = wyrmClip(c);
  Dragon.sample(anim, t, loop);
  let M = wyrmModelMatrix(c);
  if (breathe) M = m4mul(M, m4s(1 + Math.sin(c.t * 1.2) * 0.012));
  const light = sampleLight(c.x, c.y + 2, c.z);
  const glow = (c.flashT > 0 ? c.flashT * 2 : 0) + (c.state === 'breathW' ? 0.25 * (1 - c.st) : c.state === 'breath' ? 0.2 : 0);
  Dragon.draw(M, [light[0] + 0.06, light[1] + 0.035, light[2] + 0.025], glow);
}
function drawCreatures() {
  for (const c of creatures) {
    if (c.type === 'gloom') drawGloom(c);
    else if (c.type === 'wyrm') drawWyrm(c);
    else R.drawEntity(getModel('shade', 'CLOTH'), m4trs(c.x, c.y + 0.3 + Math.sin(c.t * 3) * 0.15, c.z, c.face, 0.15, Math.sin(c.t * 2) * 0.1, 1.0),
      sampleLight(c.x, c.y + 1, c.z), 0.05 + (c.flashT > 0 ? c.flashT * 2 : 0));
  }
}
// first-person axe: idle sway, swing arc, or throw
function drawViewAxe(vlight, sb, cb) {
  if (!hasAxe() && throwAnim <= 0) return;
  let m;
  if (swingT > 0) {
    const t = 1 - swingT / SWING_TIME;
    const a = t < 0.3 ? ease(t / 0.3) : 1 - ease((t - 0.3) / 0.7) * 0.0;   // raise, then chop
    const chop = t < 0.3 ? 0 : ease((t - 0.3) / 0.35);
    const back = t > 0.65 ? ease((t - 0.65) / 0.35) : 0;
    const pitch = lerp(lerp(-0.35, 0.9, a), -1.7, chop) * (1 - back) + -0.35 * back;
    const x = lerp(0.34, 0.12, chop * (1 - back)), y = lerp(-0.62, -0.42, a * (1 - chop)) - chop * (1 - back) * 0.12;
    m = m4trs(x - sb, y + cb, -0.62, -1.9 + chop * (1 - back) * 0.5, pitch, 0.25, 0.9);
  } else if (throwAnim > 0) {
    const t = 1 - throwAnim / 0.35;
    if (t >= 0.5) return;
    m = m4trs(0.34 - sb, -0.62 + cb - t * 0.3, -0.62 - t * 0.2, -1.9, -0.35 - t * 2, 0.25, 0.9);
  } else m = m4trs(0.34 - sb, -0.62 + cb, -0.62, -1.9, -0.35, 0.25, 0.9);
  R.drawEntity(getModel('axe', 'METAL'), m, vlight);
}
// boss health bar
function updateBossBar() {
  const el = $('boss');
  const w = creatures.find(c => c.type === 'wyrm' && c.state !== 'sleep' && c.state !== 'dying' && Math.hypot(c.x - S.x, c.z - S.z) < 40);
  if (!w) { el.classList.remove('on'); return; }
  el.classList.add('on');
  $('bossName').textContent = 'THE CINDER WYRM';
  $('bossFill').style.width = Math.max(0, w.hp / w.maxHp * 100) + '%';
}
