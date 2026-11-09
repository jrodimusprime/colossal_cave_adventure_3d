'use strict';
// ---------------------------------------------------------------------------
// Geometry: flat-shaded low-poly meshes. Vertex = pos3 nor3 col3 layer1.
// For world meshes `col` is baked light; for entity models it is a tint.
// ---------------------------------------------------------------------------

class MeshBuilder {
  constructor(cap = 4096) { this.d = new Float32Array(cap * 10); this.n = 0; }
  ensure(k) {
    if ((this.n + k) * 10 > this.d.length) {
      const nd = new Float32Array(Math.max(this.d.length * 2, (this.n + k) * 10));
      nd.set(this.d); this.d = nd;
    }
  }
  v(p, nx, ny, nz, col, l) {
    const o = this.n * 10, d = this.d;
    d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2]; d[o + 3] = nx; d[o + 4] = ny; d[o + 5] = nz;
    d[o + 6] = col[0]; d[o + 7] = col[1]; d[o + 8] = col[2]; d[o + 9] = l;
    this.n++;
  }
  // triangle with a facing hint vector; the normal is flipped to agree with it
  tri(a, b, c, layer, hx, hy, hz, col = ONE3) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    this.ensure(3);
    if (nx * hx + ny * hy + nz * hz < 0) { nx = -nx; ny = -ny; nz = -nz; this.v(a, nx, ny, nz, col, layer); this.v(c, nx, ny, nz, col, layer); this.v(b, nx, ny, nz, col, layer); }
    else { this.v(a, nx, ny, nz, col, layer); this.v(b, nx, ny, nz, col, layer); this.v(c, nx, ny, nz, col, layer); }
  }
  // triangle facing away from a centre point (convex shapes)
  triC(a, b, c, layer, ctr, col) {
    this.tri(a, b, c, layer, (a[0] + b[0] + c[0]) / 3 - ctr[0], (a[1] + b[1] + c[1]) / 3 - ctr[1], (a[2] + b[2] + c[2]) / 3 - ctr[2], col);
  }
  quad(a, b, c, d, layer, hx, hy, hz, col) { this.tri(a, b, c, layer, hx, hy, hz, col); this.tri(a, c, d, layer, hx, hy, hz, col); }
  quadC(a, b, c, d, layer, ctr, col) { this.triC(a, b, c, layer, ctr, col); this.triC(a, c, d, layer, ctr, col); }
  finish() { return this.d.slice(0, this.n * 10); }
}
const ONE3 = [1, 1, 1];

// ---- primitive helpers ----------------------------------------------------
// lathe around an arbitrary axis. profile = [[radius, height], ...]
function addLathe(mb, ox, oy, oz, profile, sides, layer, rot = 0, col = ONE3, axis = null) {
  let ax = [0, 1, 0], u = [1, 0, 0], w = [0, 0, 1];
  if (axis) {
    ax = axis;
    const ref = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    u = norm3(cross3(ax, ref)); w = cross3(ax, u);
  }
  let ymin = 1e9, ymax = -1e9;
  for (const p of profile) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
  const ym = (ymin + ymax) / 2;
  const ctr = [ox + ax[0] * ym, oy + ax[1] * ym, oz + ax[2] * ym];
  const P = (r, h, a) => {
    const c = Math.cos(a) * r, s = Math.sin(a) * r;
    return [ox + ax[0] * h + u[0] * c + w[0] * s, oy + ax[1] * h + u[1] * c + w[1] * s, oz + ax[2] * h + u[2] * c + w[2] * s];
  };
  for (let k = 0; k < profile.length - 1; k++) {
    const [r0, h0] = profile[k], [r1, h1] = profile[k + 1];
    for (let s = 0; s < sides; s++) {
      const a0 = s / sides * Math.PI * 2 + rot, a1 = (s + 1) / sides * Math.PI * 2 + rot;
      mb.quadC(P(r0, h0, a0), P(r0, h0, a1), P(r1, h1, a1), P(r1, h1, a0), layer, ctr, col);
    }
  }
}
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

function addBox(mb, cx, cy, cz, hx, hy, hz, layer, rotY = 0, col = ONE3, rotX = 0) {
  const c = Math.cos(rotY), s = Math.sin(rotY), cx2 = Math.cos(rotX), sx2 = Math.sin(rotX);
  const P = (x, y, z) => {
    const y2 = y * cx2 - z * sx2, z2 = y * sx2 + z * cx2;
    return [cx + x * c + z2 * s, cy + y2, cz - x * s + z2 * c];
  };
  const v = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
  const ctr = [cx, cy, cz];
  const F = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
  for (const f of F) mb.quadC(v[f[0]], v[f[1]], v[f[2]], v[f[3]], layer, ctr, col);
}

const ICO_V = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  return [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm3);
})();
const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
function addRock(mb, x, y, z, sx, sy, sz, seed, layer, jitter = 0.35, col = ONE3) {
  const v = ICO_V.map((p, i) => {
    const k = 1 - jitter / 2 + jitter * hrand(seed, i, 7, 3);
    return [x + p[0] * sx * k, y + p[1] * sy * k, z + p[2] * sz * k];
  });
  const ctr = [x, y, z];
  for (const f of ICO_F) mb.triC(v[f[0]], v[f[1]], v[f[2]], layer, ctr, col);
}
function addSpike(mb, bx, by, bz, dir, len, r, sides, layer, col = ONE3) {
  addLathe(mb, bx, by, bz, [[0, 0], [r, 0.02], [r, len * 0.72], [0, len]], sides, layer, 0.3, col, norm3(dir));
}

// ---- props baked into chunk meshes ----------------------------------------
function addProp(mb, p) {
  switch (p.t) {
    case 'mite':
      addLathe(mb, p.x, p.y - 0.5, p.z, [[0, 0], [p.r, 0], [p.r * 0.65, p.h * 0.45 + 0.5], [p.r * 0.25, p.h * 0.8 + 0.5], [0, p.h + 0.5]], 5, p.layer, p.x);
      break;
    case 'tite':
      addLathe(mb, p.x, p.y, p.z, [[0, 0], [p.r, 0], [p.r * 0.55, -p.h * 0.5], [p.r * 0.2, -p.h * 0.85], [0, -p.h]], 5, p.layer, p.z);
      break;
    case 'col': {
      const h = p.y1 - p.y0, r = p.r;
      addLathe(mb, p.x, p.y0, p.z, [[0, 0], [r * 1.25, 0], [r * 0.95, h * 0.15], [r * 0.75, h * 0.5], [r * 0.95, h * 0.85], [r * 1.25, h], [0, h]],
        p.square ? 4 : 6, p.layer, p.square ? Math.PI / 4 : p.x);
      break;
    }
    case 'crys': {
      const r = new RNG(p.seed);
      for (let k = 0; k < p.n; k++) {
        const dir = [r.range(-0.7, 0.7), 1, r.range(-0.7, 0.7)];
        const len = p.s * r.range(0.6, 1.5);
        addSpike(mb, p.x + r.range(-0.4, 0.4), p.y - 0.3, p.z + r.range(-0.4, 0.4), dir, len + 0.3, len * 0.17, 6, p.layer);
      }
      break;
    }
    case 'mush': {
      const s = p.s;
      addLathe(mb, p.x, p.y - 0.2, p.z, [[0, 0], [0.13 * s, 0], [0.09 * s, 1.25 * s], [0, 1.25 * s]], 5, T.BONE);
      addLathe(mb, p.x, p.y - 0.2, p.z, [[0, 1.05 * s], [0.62 * s, 1.0 * s], [0.52 * s, 1.25 * s], [0.22 * s, 1.45 * s], [0, 1.5 * s]], 7, T.MUSHCAP, p.x);
      break;
    }
    case 'rock': addRock(mb, p.x, p.y + p.s * 0.25, p.z, p.s, p.s * 0.7, p.s * 0.9, p.seed, p.layer); break;
    case 'bones': {
      const r = new RNG(p.seed);
      addRock(mb, p.x, p.y + 0.12, p.z, 0.16, 0.13, 0.19, p.seed, T.BONE, 0.15);
      addBox(mb, p.x + 0.04, p.y + 0.12, p.z + 0.13, 0.04, 0.03, 0.02, T.BLACK, 0);
      for (let k = 0; k < 4; k++) addBox(mb, p.x + r.range(-0.7, 0.7), p.y + 0.04, p.z + r.range(-0.7, 0.7), 0.03, 0.03, r.range(0.15, 0.3), T.BONE, r.range(0, 3));
      break;
    }
    case 'trunk':
      addBox(mb, p.x, p.y + 0.38, p.z, 0.75, 0.38, 0.45, T.WOOD, p.rot);
      addBox(mb, p.x, p.y + 0.84, p.z, 0.78, 0.1, 0.48, T.WOOD, p.rot);
      for (const o of [-0.45, 0.45]) {
        const ox = Math.cos(p.rot) * o, oz = -Math.sin(p.rot) * o;
        addBox(mb, p.x + ox, p.y + 0.48, p.z + oz, 0.06, 0.47, 0.5, T.METAL, p.rot);
      }
      addBox(mb, p.x - Math.sin(p.rot) * 0.5, p.y + 0.66, p.z - Math.cos(p.rot) * 0.5, 0.08, 0.1, 0.03, T.GOLD, p.rot);
      break;
    case 'barrel':
      addLathe(mb, p.x, p.y - 0.1, p.z, [[0, 0], [0.45, 0], [0.56, 0.6], [0.45, 1.2], [0, 1.2]], 8, T.WOOD);
      addLathe(mb, p.x, p.y - 0.1, p.z, [[0.47, 0.2], [0.53, 0.25], [0.53, 0.33], [0.47, 0.38]], 8, T.METAL);
      addLathe(mb, p.x, p.y - 0.1, p.z, [[0.47, 0.88], [0.53, 0.86], [0.53, 0.95], [0.46, 1.0]], 8, T.METAL);
      break;
    case 'fire':
      for (let k = 0; k < 8; k++) {
        const a = k / 8 * Math.PI * 2;
        addRock(mb, p.x + Math.cos(a) * 0.62, p.y + 0.1, p.z + Math.sin(a) * 0.62, 0.2, 0.15, 0.2, k * 13 + 1, T.ROCK2);
      }
      addBox(mb, p.x, p.y + 0.12, p.z, 0.5, 0.07, 0.07, T.WOOD, 0.3);
      addBox(mb, p.x, p.y + 0.18, p.z, 0.5, 0.07, 0.07, T.WOOD, 1.9);
      for (let k = 0; k < 5; k++) {
        const a = k / 5 * Math.PI * 2;
        addSpike(mb, p.x + Math.cos(a) * 0.15, p.y + 0.1, p.z + Math.sin(a) * 0.15, [Math.cos(a) * 0.2, 1, Math.sin(a) * 0.2], 0.6 + (k % 2) * 0.35, 0.13, 4, T.FIRE);
      }
      break;
    case 'rope':
      addLathe(mb, p.x, p.y0, p.z, [[0, 0], [0.06, 0], [0.06, p.y1 - p.y0], [0, p.y1 - p.y0]], 4, T.ROPE);
      break;
    case 'frame': {
      const o = CELL * 0.5;
      addBox(mb, p.x - o, p.y + 1.15, p.z, 0.1, 1.45, 0.1, T.WOOD);
      addBox(mb, p.x + o, p.y + 1.15, p.z, 0.1, 1.45, 0.1, T.WOOD);
      addBox(mb, p.x, p.y + 2.55, p.z, o + 0.2, 0.09, 0.09, T.WOOD);
      addLathe(mb, p.x, p.y + 2.4, p.z, [[0, 0], [0.12, 0], [0.12, 0.3], [0, 0.3]], 6, T.ROPE);
      break;
    }
    case 'chute':
      // a polished stone lip around a steep hole
      for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; addRock(mb, p.x + Math.cos(a) * 1.35, p.y + 0.05, p.z + Math.sin(a) * 1.35, 0.35, 0.18, 0.35, k * 5 + 3, T.ROCK2, 0.2); }
      break;
    case 'rune':
      addLathe(mb, p.x, p.y - 0.4, p.z, [[0, 0], [0.62, 0], [0.5, 2.4], [0.28, 2.75], [0, 2.8]], 4, T.STONE, p.rot);
      break;
  }
}

// ---- chunk mesh -----------------------------------------------------------
function surfLayers(room, reg) {
  let wall = reg.wall, floor = reg.floor, ceil = reg.ceil;
  if (room) {
    switch (room.type) {
      case 'camp': floor = T.MOSS; wall = T.ROCK; ceil = T.ROCK; break;
      case 'fungus': floor = T.FUNGUS; break;
      case 'lava': floor = T.BASALT; wall = T.BASALT; break;
      case 'lake': floor = T.ROCK2; break;
      case 'shrine': floor = T.ROCK2; break;
      case 'crystal': ceil = reg.wall; break;
    }
  }
  return { wall, floor, ceil };
}

function wallStrip(mb, ca, cb, ba, bb, ta, tb, layer, hx, hz, L) {
  const ROWS = 3;
  let pA = null, pB = null;
  for (let r = 0; r <= ROWS; r++) {
    const t = r / ROWS, s = Math.sin(Math.PI * t);
    const ka = s * ca.bul * (0.6 + 0.8 * hrand(ca.gx, ca.gz, r * 7 + L, WORLD.seed));
    const kb = s * cb.bul * (0.6 + 0.8 * hrand(cb.gx, cb.gz, r * 7 + L, WORLD.seed));
    const A = [ca.x + ca.jx * ka, ba + (ta - ba) * t, ca.z + ca.jz * ka];
    const B = [cb.x + cb.jx * kb, bb + (tb - bb) * t, cb.z + cb.jz * kb];
    if (pA) mb.quad(pA, pB, B, A, layer, hx, 0, hz);
    pA = A; pB = B;
  }
}

function bakeLights(mb, lights, amb) {
  const d = mb.d;
  for (let i = 0; i < mb.n; i++) {
    const o = i * 10, px = d[o], py = d[o + 1], pz = d[o + 2], nx = d[o + 3], ny = d[o + 4], nz = d[o + 5];
    let r = amb[0], g = amb[1], b = amb[2];
    for (const L of lights) {
      const dx = L.x - px, dy = L.y - py, dz = L.z - pz, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > L.rad * L.rad) continue;
      const dist = Math.sqrt(d2) || 1e-3;
      let att = 1 - dist / L.rad; att *= att;
      const lam = Math.max(0, (dx * nx + dy * ny + dz * nz) / dist) * 0.75 + 0.25;
      const k = att * lam * L.i;
      r += L.r * k; g += L.g * k; b += L.b * k;
    }
    d[o + 6] = r; d[o + 7] = g; d[o + 8] = b;
  }
}

const DIRS = [[0, -1, 0, 0, 1, 0], [1, 0, 1, 0, 1, 1], [0, 1, 1, 1, 0, 1], [-1, 0, 0, 1, 0, 0]];
function buildChunkMesh(cx, cz, L) {
  const ch = getChunk(cx, cz, L), reg = regionFor(L);
  const mb = new MeshBuilder(24000), wb = new MeshBuilder(600);
  const gx0 = cx * CHUNK, gz0 = cz * CHUNK, S1 = CHUNK + 1;
  const C = new Array(S1 * S1);
  for (let j = 0; j <= CHUNK; j++) for (let i = 0; i <= CHUNK; i++) C[j * S1 + i] = cornerData(L, gx0 + i, gz0 + j);
  const P = (q, y) => [q.x, y, q.z];
  for (let j = 0; j < CHUNK; j++) for (let i = 0; i < CHUNK; i++) {
    const idx = j * CHUNK + i, k = ch.kind[idx];
    if (!k) continue;
    const fl = ch.flags[idx], room = ch.room[idx] >= 0 ? ch.rooms[ch.room[idx]] : null;
    const lay = surfLayers(room, reg);
    const c0 = C[j * S1 + i], c1 = C[j * S1 + i + 1], c2 = C[(j + 1) * S1 + i + 1], c3 = C[(j + 1) * S1 + i];
    const fy = q => (k === 2 ? q.fp : k === 3 ? q.fl : q.fo);
    const fLayer = k === 2 ? T.BLACK : lay.floor;
    const diag = hash4(gx0 + i, gz0 + j, L, 3) & 1;
    const f0 = P(c0, fy(c0)), f1 = P(c1, fy(c1)), f2 = P(c2, fy(c2)), f3 = P(c3, fy(c3));
    if (diag) { mb.tri(f0, f1, f2, fLayer, 0, 1, 0); mb.tri(f0, f2, f3, fLayer, 0, 1, 0); }
    else { mb.tri(f0, f1, f3, fLayer, 0, 1, 0); mb.tri(f1, f2, f3, fLayer, 0, 1, 0); }
    const cLayer = (fl & F_SKY) ? T.SKY : (fl & F_SHAFTUP) ? T.BLACK : lay.ceil;
    const e0 = P(c0, c0.c), e1 = P(c1, c1.c), e2 = P(c2, c2.c), e3 = P(c3, c3.c);
    if (diag) { mb.tri(e0, e1, e2, cLayer, 0, -1, 0); mb.tri(e0, e2, e3, cLayer, 0, -1, 0); }
    else { mb.tri(e0, e1, e3, cLayer, 0, -1, 0); mb.tri(e1, e2, e3, cLayer, 0, -1, 0); }
    for (const d of DIRS) {
      const nk = kindAtG(L, gx0 + i + d[0], gz0 + j + d[1]);
      const ca = C[(j + d[3]) * S1 + i + d[2]], cb = C[(j + d[5]) * S1 + i + d[4]];
      if (nk === 0) wallStrip(mb, ca, cb, fy(ca), fy(cb), ca.c, cb.c, lay.wall, -d[0], -d[1], L);
      else if (k === 2 && nk === 1) mb.quad(P(ca, ca.fp), P(cb, cb.fp), P(cb, cb.fo), P(ca, ca.fo), lay.wall, -d[0], 0, -d[1]);
      else if (k === 1 && nk === 3) mb.quad(P(ca, ca.fo), P(cb, cb.fo), P(cb, cb.fl), P(ca, ca.fl), lay.wall, -d[0], 0, -d[1]);
    }
    if (fl & F_LIQUID) {
      const y = ch.liquid[idx];
      wb.quad(P(c0, y), P(c1, y), P(c2, y), P(c3, y), T.WATER, 0, 1, 0);
    }
    if (fl & F_LAVA) {
      const y = ch.liquid[idx];
      mb.quad(P(c0, y), P(c1, y), P(c2, y), P(c3, y), T.LAVA, 0, 1, 0);
    }
  }
  for (const p of ch.props) addProp(mb, p);
  const lights = [];
  const x0 = gx0 * CELL - 50, x1 = (gx0 + CHUNK) * CELL + 50, z0 = gz0 * CELL - 50, z1 = (gz0 + CHUNK) * CELL + 50;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    for (const l of getChunk(cx + dx, cz + dz, L).lights) if (l.x > x0 && l.x < x1 && l.z > z0 && l.z < z1) lights.push(l);
  }
  bakeLights(mb, lights, reg.amb);
  bakeLights(wb, lights, reg.amb);
  return { opaque: mb.finish(), water: wb.finish() };
}

// ---- entity models (built at the origin, +z forward, feet at y=0) ---------
function buildModel(name, mat) {
  const mb = new MeshBuilder(512);
  switch (name) {
    case 'nugget':
      addRock(mb, 0, 0.13, 0, 0.2, 0.14, 0.17, 7, mat); addRock(mb, 0.14, 0.08, 0.06, 0.1, 0.08, 0.1, 9, mat); break;
    case 'bars':
      for (let k = 0; k < 3; k++) addBox(mb, (k - 1) * 0.14 + (k === 2 ? -0.07 : 0), 0.06 + (k === 2 ? 0.12 : 0), 0, 0.065, 0.06, 0.2, mat, k === 2 ? 0.3 : 0);
      break;
    case 'coins':
      addLathe(mb, 0, 0, 0, [[0, 0], [0.32, 0], [0.24, 0.12], [0.1, 0.2], [0, 0.21]], 7, mat);
      for (let k = 0; k < 5; k++) { const a = k * 1.3; addLathe(mb, Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4, [[0, 0], [0.07, 0], [0.07, 0.02], [0, 0.02]], 6, mat); }
      break;
    case 'gem': addLathe(mb, 0, 0.04, 0, [[0, 0], [0.17, 0.2], [0.12, 0.32], [0, 0.34]], 6, mat); break;
    case 'chalice':
      addLathe(mb, 0, 0, 0, [[0, 0], [0.18, 0], [0.17, 0.05], [0.05, 0.1], [0.04, 0.3], [0.15, 0.36], [0.2, 0.56], [0.16, 0.56], [0, 0.44]], 8, mat);
      break;
    case 'idol':
      addBox(mb, 0, 0.05, 0, 0.17, 0.05, 0.14, mat);
      addBox(mb, 0, 0.26, 0, 0.12, 0.16, 0.08, mat);
      addBox(mb, 0, 0.5, 0, 0.1, 0.09, 0.09, mat);
      addBox(mb, -0.15, 0.3, 0.02, 0.04, 0.12, 0.04, mat, 0, ONE3, 0.4);
      addBox(mb, 0.15, 0.3, 0.02, 0.04, 0.12, 0.04, mat, 0, ONE3, 0.4);
      addBox(mb, -0.04, 0.52, 0.09, 0.02, 0.015, 0.01, T.RUBY); addBox(mb, 0.04, 0.52, 0.09, 0.02, 0.015, 0.01, T.RUBY);
      break;
    case 'urn': addLathe(mb, 0, 0, 0, [[0, 0], [0.13, 0], [0.2, 0.15], [0.22, 0.3], [0.12, 0.48], [0.09, 0.56], [0.14, 0.6], [0, 0.6]], 8, mat); break;
    case 'orb': addRock(mb, 0, 0.15, 0, 0.15, 0.15, 0.15, 3, mat, 0.04); break;
    case 'egg': addLathe(mb, 0, 0, 0, [[0, 0], [0.12, 0.04], [0.17, 0.15], [0.15, 0.3], [0.08, 0.4], [0, 0.43]], 7, mat); break;
    case 'crown':
      addLathe(mb, 0, 0, 0, [[0.22, 0], [0.23, 0.06], [0.22, 0.13]], 10, mat);
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; addSpike(mb, Math.cos(a) * 0.22, 0.1, Math.sin(a) * 0.22, [Math.cos(a) * 0.15, 1, Math.sin(a) * 0.15], 0.16, 0.04, 4, mat); }
      for (let k = 0; k < 4; k++) { const a = k / 4 * Math.PI * 2; addBox(mb, Math.cos(a) * 0.235, 0.065, Math.sin(a) * 0.235, 0.03, 0.03, 0.03, T.RUBY, -a); }
      break;
    case 'mask':
      addRock(mb, 0, 0.25, 0, 0.18, 0.24, 0.07, 5, mat, 0.08);
      addBox(mb, -0.07, 0.3, 0.06, 0.04, 0.02, 0.02, T.EYE); addBox(mb, 0.07, 0.3, 0.06, 0.04, 0.02, 0.02, T.EYE);
      break;
    case 'skull':
      addRock(mb, 0, 0.2, 0, 0.18, 0.16, 0.21, 11, mat, 0.08);
      addBox(mb, 0, 0.07, 0.08, 0.1, 0.05, 0.09, mat);
      addBox(mb, -0.07, 0.21, 0.17, 0.04, 0.035, 0.03, T.BLACK); addBox(mb, 0.07, 0.21, 0.17, 0.04, 0.035, 0.03, T.BLACK);
      break;
    case 'flask':
      addLathe(mb, 0, 0, 0, [[0, 0], [0.13, 0], [0.14, 0.22], [0.06, 0.3], [0.05, 0.38], [0, 0.38]], 7, mat);
      addLathe(mb, 0, 0.36, 0, [[0, 0], [0.04, 0], [0.04, 0.06], [0, 0.06]], 5, T.WOOD);
      addBox(mb, 0, 0.12, 0.13, 0.08, 0.06, 0.01, T.BONE);
      break;
    case 'food':
      addBox(mb, 0, 0.09, 0, 0.18, 0.09, 0.13, mat, 0.2);
      addBox(mb, 0, 0.09, 0, 0.03, 0.1, 0.14, T.ROPE, 0.2);
      addRock(mb, 0, 0.2, 0, 0.07, 0.05, 0.07, 4, mat);
      break;
    case 'axe':
      addBox(mb, 0, 0.32, 0, 0.025, 0.32, 0.025, T.WOOD);
      addBox(mb, 0.09, 0.56, 0, 0.09, 0.07, 0.015, mat);
      addBox(mb, 0.19, 0.56, 0, 0.02, 0.11, 0.012, T.SILVER);
      break;
    case 'knife':
      addBox(mb, 0, 0.06, 0, 0.02, 0.06, 0.02, T.WOOD);
      addBox(mb, 0, 0.22, 0, 0.025, 0.11, 0.006, T.SILVER);
      break;
    case 'gloomkin':
      addBox(mb, -0.12, 0.2, 0, 0.06, 0.2, 0.06, T.SKIN); addBox(mb, 0.12, 0.2, 0, 0.06, 0.2, 0.06, T.SKIN);
      addBox(mb, 0, 0.62, 0.02, 0.2, 0.22, 0.14, T.SKIN, 0, ONE3, 0.25);
      addBox(mb, 0, 0.42, 0, 0.21, 0.08, 0.15, T.CLOTH);
      addBox(mb, 0, 0.95, 0.12, 0.17, 0.14, 0.15, T.SKIN);
      addSpike(mb, -0.15, 1.0, 0.1, [-1, 0.6, -0.3], 0.26, 0.06, 4, T.SKIN);
      addSpike(mb, 0.15, 1.0, 0.1, [1, 0.6, -0.3], 0.26, 0.06, 4, T.SKIN);
      addBox(mb, -0.07, 0.99, 0.27, 0.035, 0.025, 0.01, T.EYE); addBox(mb, 0.07, 0.99, 0.27, 0.035, 0.025, 0.01, T.EYE);
      addBox(mb, 0, 0.88, 0.27, 0.07, 0.015, 0.01, T.BLACK);
      addBox(mb, -0.27, 0.6, 0.08, 0.05, 0.22, 0.05, T.SKIN, 0, ONE3, -0.5);
      addBox(mb, 0.27, 0.6, 0.08, 0.05, 0.22, 0.05, T.SKIN, 0, ONE3, -0.5);
      addBox(mb, 0.27, 0.45, 0.32, 0.015, 0.02, 0.12, T.SILVER);
      break;
    case 'shade':
      addLathe(mb, 0, 0, 0, [[0, 0.2], [0.45, 0.15], [0.36, 0.8], [0.25, 1.5], [0.2, 1.78], [0, 1.95]], 7, mat);
      addBox(mb, 0, 1.6, 0.13, 0.12, 0.13, 0.08, T.BLACK);
      addBox(mb, -0.06, 1.63, 0.22, 0.03, 0.015, 0.01, T.EYE); addBox(mb, 0.06, 1.63, 0.22, 0.03, 0.015, 0.01, T.EYE);
      addSpike(mb, -0.25, 1.25, 0.05, [-0.3, -0.2, 1], 0.6, 0.06, 4, mat);
      addSpike(mb, 0.25, 1.25, 0.05, [0.3, -0.2, 1], 0.6, 0.06, 4, mat);
      break;
    case 'lantern':
      addLathe(mb, 0, 0, 0, [[0, 0], [0.085, 0], [0.085, 0.035], [0, 0.035]], 8, T.METAL);
      addLathe(mb, 0, 0.035, 0, [[0, 0], [0.055, 0], [0.065, 0.08], [0.055, 0.16], [0, 0.16]], 8, mat);
      for (let k = 0; k < 4; k++) { const a = k / 4 * Math.PI * 2 + 0.4; addBox(mb, Math.cos(a) * 0.075, 0.115, Math.sin(a) * 0.075, 0.01, 0.085, 0.01, T.METAL); }
      addLathe(mb, 0, 0.195, 0, [[0, 0], [0.09, 0], [0.04, 0.06], [0, 0.07]], 8, T.METAL);
      addBox(mb, 0, 0.3, 0, 0.06, 0.008, 0.008, T.METAL);
      addBox(mb, -0.055, 0.28, 0, 0.008, 0.03, 0.008, T.METAL); addBox(mb, 0.055, 0.28, 0, 0.008, 0.03, 0.008, T.METAL);
      break;
    case 'puff': addRock(mb, 0, 0, 0, 0.12, 0.12, 0.12, 2, mat, 0.3); break;
    case 'flame': addRock(mb, 0, 0, 0, 0.18, 0.18, 0.18, 5, mat, 0.5); break;
    // ---- gloomkin parts (each built around its joint) ----
    case 'gk_torso':
      addBox(mb, 0, 0.24, 0.02, 0.2, 0.22, 0.14, T.SKIN);
      addBox(mb, 0, 0.42, -0.04, 0.16, 0.06, 0.1, T.SKIN);             // hunched shoulders
      addBox(mb, 0, 0.02, 0, 0.21, 0.08, 0.15, T.CLOTH);               // loincloth
      addBox(mb, 0, -0.08, 0.12, 0.12, 0.08, 0.02, T.CLOTH);
      break;
    case 'gk_head':
      addBox(mb, 0, 0.12, 0.06, 0.17, 0.14, 0.15, T.SKIN);
      addBox(mb, 0, 0.06, 0.2, 0.07, 0.05, 0.05, T.SKIN);              // snout
      addSpike(mb, -0.15, 0.16, 0.04, [-1, 0.6, -0.3], 0.26, 0.06, 4, T.SKIN);
      addSpike(mb, 0.15, 0.16, 0.04, [1, 0.6, -0.3], 0.26, 0.06, 4, T.SKIN);
      addBox(mb, -0.07, 0.15, 0.21, 0.035, 0.025, 0.01, T.EYE); addBox(mb, 0.07, 0.15, 0.21, 0.035, 0.025, 0.01, T.EYE);
      addBox(mb, 0, 0.02, 0.21, 0.07, 0.015, 0.01, T.BLACK);
      break;
    case 'gk_arm':
      addBox(mb, 0, -0.18, 0, 0.05, 0.19, 0.05, T.SKIN);
      addRock(mb, 0, -0.41, 0.02, 0.065, 0.06, 0.07, 3, T.SKIN, 0.2);
      break;
    case 'gk_leg':
      addBox(mb, 0, -0.19, 0, 0.065, 0.2, 0.065, T.SKIN);
      addBox(mb, 0, -0.39, 0.06, 0.07, 0.035, 0.11, T.SKIN);
      break;
    case 'gk_knife':
      addBox(mb, 0, 0, -0.02, 0.018, 0.018, 0.05, T.WOOD);
      addBox(mb, 0, 0, 0.12, 0.006, 0.025, 0.1, T.SILVER);
      break;
    // ---- the Cinder Wyrm (built around its joints, +z forward) ----
    case 'wy_body':
      addLathe(mb, 0, 0, 0, [[0, -1.9], [0.62, -1.55], [0.95, -0.6], [1.0, 0.4], [0.8, 1.35], [0.45, 1.95], [0, 2.05]], 8, T.SCALES, 0.2, ONE3, [0, 0, 1]);
      addLathe(mb, 0, -0.25, 0, [[0, -1.3], [0.6, -0.9], [0.68, 0.3], [0.5, 1.2], [0, 1.5]], 6, T.BONE, 0.3, [0.9, 0.75, 0.6], [0, 0, 1]);   // pale belly
      for (let k = 0; k < 7; k++) addSpike(mb, 0, 0.82, -1.5 + k * 0.5, [0, 1, -0.4], 0.45 - Math.abs(k - 3) * 0.05, 0.12, 4, T.BONE);
      break;
    case 'wy_neck':
      addLathe(mb, 0, 0, 0, [[0, -0.1], [0.5, 0], [0.4, 0.8], [0.34, 1.45], [0, 1.5]], 7, T.SCALES, 0.2, ONE3, [0, 0, 1]);
      for (let k = 0; k < 3; k++) addSpike(mb, 0, 0.38, 0.25 + k * 0.42, [0, 1, -0.5], 0.28, 0.08, 4, T.BONE);
      break;
    case 'wy_head':
      addBox(mb, 0, 0.08, 0.35, 0.36, 0.28, 0.42, T.SCALES);
      addBox(mb, 0, 0.0, 0.92, 0.26, 0.18, 0.32, T.SCALES);
      addBox(mb, 0, 0.18, 0.62, 0.3, 0.06, 0.12, T.SCALES);
      addSpike(mb, -0.24, 0.3, 0.1, [-0.4, 0.7, -1], 0.75, 0.09, 4, T.BONE);
      addSpike(mb, 0.24, 0.3, 0.1, [0.4, 0.7, -1], 0.75, 0.09, 4, T.BONE);
      addBox(mb, -0.27, 0.16, 0.66, 0.05, 0.05, 0.08, T.EYE); addBox(mb, 0.27, 0.16, 0.66, 0.05, 0.05, 0.08, T.EYE);
      for (let k = 0; k < 4; k++) { addSpike(mb, -0.2 + k * 0.13, -0.17, 1.12, [0, -1, 0.2], 0.14, 0.03, 3, T.BONE); }
      break;
    case 'wy_jaw':
      addBox(mb, 0, -0.06, 0.55, 0.24, 0.07, 0.5, T.SCALES);
      for (let k = 0; k < 4; k++) addSpike(mb, -0.18 + k * 0.12, 0.0, 0.95, [0, 1, 0.1], 0.13, 0.03, 3, T.BONE);
      break;
    case 'wy_mouth': addBox(mb, 0, -0.03, 0.75, 0.2, 0.05, 0.35, T.FIRE); break;
    case 'wy_tail':
      addLathe(mb, 0, 0, 0, [[0, 0.1], [0.5, 0], [0.3, -1.55], [0, -1.65]], 7, T.SCALES, 0.2, ONE3, [0, 0, 1]);
      addSpike(mb, 0, 0.35, -0.6, [0, 1, -0.6], 0.3, 0.08, 4, T.BONE);
      break;
    case 'wy_tailtip':
      addLathe(mb, 0, 0, 0, [[0, 0.1], [0.3, 0], [0.12, -1.2], [0, -1.6]], 6, T.SCALES, 0.2, ONE3, [0, 0, 1]);
      addSpike(mb, 0, 0, -1.4, [0, 0.4, -1], 0.6, 0.18, 4, T.BONE);
      break;
    case 'wy_leg':
      addBox(mb, 0, -0.4, 0, 0.2, 0.42, 0.24, T.SCALES);
      addBox(mb, 0, -0.85, 0.12, 0.24, 0.08, 0.32, T.SCALES);
      for (let k = 0; k < 3; k++) addSpike(mb, -0.14 + k * 0.14, -0.88, 0.4, [0, -0.3, 1], 0.22, 0.05, 3, T.BONE);
      break;
    case 'wy_wingL': case 'wy_wingR': {
      const sx = name === 'wy_wingL' ? -1 : 1;
      addBox(mb, sx * 0.9, 0.1, 0, 0.9, 0.06, 0.06, T.SCALES);
      addBox(mb, sx * 1.75, -0.2, -0.3, 0.06, 0.4, 0.06, T.SCALES);
      const A = [0, 0, 0], B = [sx * 1.8, 0.15, 0], C = [sx * 1.85, -0.55, -0.6], D = [sx * 1.1, -0.35, -1.3], E = [sx * 0.2, -0.1, -0.9];
      const lay = T.SCALES, h = [0, 1, 0];
      mb.tri(A, B, C, lay, ...h); mb.tri(A, C, D, lay, ...h); mb.tri(A, D, E, lay, ...h);
      break;
    }
    case 'key':
      addLathe(mb, -0.12, 0.03, 0, [[0.05, 0], [0.08, 0.015], [0.08, 0.03], [0.05, 0.045]], 8, mat);
      addBox(mb, 0.06, 0.03, 0, 0.12, 0.015, 0.015, mat);
      addBox(mb, 0.15, 0.03, 0.03, 0.015, 0.015, 0.03, mat); addBox(mb, 0.11, 0.03, 0.025, 0.012, 0.015, 0.025, mat);
      break;
    case 'planks':
      for (let k = 0; k < 3; k++) addBox(mb, 0, 0.04 + k * 0.08, (k - 1) * 0.02, 0.6, 0.035, 0.12, mat, (k - 1) * 0.08);
      addBox(mb, 0.3, 0.12, 0, 0.03, 0.13, 0.14, T.ROPE); addBox(mb, -0.3, 0.12, 0, 0.03, 0.13, 0.14, T.ROPE);
      break;
    case 'skin':
      addRock(mb, 0, 0.16, 0, 0.17, 0.16, 0.13, 21, mat, 0.12);
      addLathe(mb, 0, 0.28, 0, [[0, 0], [0.05, 0], [0.04, 0.1], [0.055, 0.12], [0, 0.12]], 6, T.ROPE);
      break;
    case 'gate': {
      for (let k = 0; k < 8; k++) addBox(mb, -1.12 + k * 0.32, 1.6, 0, 0.035, 1.75, 0.035, mat);
      for (const y of [0.25, 1.6, 2.95]) addBox(mb, 0, y, 0, 1.25, 0.05, 0.05, mat);
      addBox(mb, 0.55, 1.45, 0.07, 0.09, 0.12, 0.04, T.GOLD);
      break;
    }
    case 'mole':
      addRock(mb, 0, 0.9, -0.1, 1.0, 0.85, 1.15, 31, mat, 0.15);
      addRock(mb, 0, 0.95, 0.95, 0.55, 0.5, 0.5, 32, mat, 0.12);
      addLathe(mb, 0, 0.88, 1.3, [[0, 0], [0.22, 0], [0.12, 0.3], [0.06, 0.42], [0, 0.44]], 6, T.PALE, 0, ONE3, [0, 0, 1]);
      for (const sx of [-1, 1]) {
        for (let k = 0; k < 3; k++) addSpike(mb, sx * 0.55, 0.35, 0.75 + k * 0.08, [sx * 0.4, -0.3, 1], 0.4, 0.05, 4, T.BONE);
        addBox(mb, sx * 0.2, 1.12, 1.33, 0.03, 0.03, 0.02, T.BLACK);
      }
      break;
    case 'bridge':
      for (let k = 0; k < 14; k++) addBox(mb, 0, -0.06, -2.4 + k * 0.37, 0.6, 0.06, 0.15, mat, (k % 3 - 1) * 0.04);
      for (const sx of [-0.62, 0.62]) {
        addBox(mb, sx, 0.85, 0, 0.03, 0.03, 2.5, T.ROPE);
        for (const z of [-2.45, 0, 2.45]) addBox(mb, sx, 0.4, z, 0.05, 0.5, 0.05, mat);
      }
      break;
    case 'door': {
      const rust = [0.95, 0.55, 0.35];
      addBox(mb, 0, 1.5, 0, 1.15, 1.5, 0.09, T.WOOD);
      for (const y of [0.45, 1.5, 2.55]) addBox(mb, 0, y, 0.07, 1.17, 0.08, 0.03, T.METAL, 0, rust);
      for (const y of [0.6, 2.4]) addBox(mb, -1.08, y, 0.1, 0.1, 0.16, 0.05, T.METAL, 0, rust);
      addBox(mb, 0.85, 1.4, 0.12, 0.06, 0.06, 0.06, T.METAL, 0, rust);
      break;
    }
    case 'shard': addRock(mb, 0, 0.03, 0, 0.06, 0.02, 0.05, 9, mat, 0.6); break;
    case 'bulb':
      addLathe(mb, 0, 0, 0, [[0, 0], [0.32, 0.08], [0.38, 0.3], [0.18, 0.55], [0.04, 0.7], [0, 0.72]], 7, mat);
      for (let k = 0; k < 3; k++) { const a = k * 2.1; addSpike(mb, Math.cos(a) * 0.25, 0.2, Math.sin(a) * 0.25, [Math.cos(a), 0.4, Math.sin(a)], 0.35, 0.05, 3, T.SKIN); }
      break;
    case 'vine': {
      const H = 4.4;
      addLathe(mb, 0, 0, 0, [[0, 0], [0.4, 0.1], [0.42, 0.35], [0.2, 0.6], [0, 0.65]], 7, mat);
      for (let k = 0; k < 4; k++) addLathe(mb, Math.sin(k * 1.7) * 0.12, 0.4 + k * (H / 4), Math.cos(k * 1.7) * 0.12, [[0, 0], [0.09, 0], [0.08, H / 4 + 0.05], [0, H / 4 + 0.05]], 5, mat);
      for (let k = 0; k < 14; k++) {
        const a = k * 2.4, y = 0.6 + k * 0.3;
        addSpike(mb, Math.cos(a) * 0.1, y, Math.sin(a) * 0.1, [Math.cos(a), 0.35, Math.sin(a)], 0.55, 0.12, 3, T.JADE);
      }
      addLathe(mb, 0, H + 0.4, 0, [[0, 0], [0.35, 0.1], [0.2, 0.3], [0, 0.32]], 6, T.MUSHCAP);
      break;
    }
    default: addBox(mb, 0, 0.1, 0, 0.1, 0.1, 0.1, mat);
  }
  return mb.finish();
}
