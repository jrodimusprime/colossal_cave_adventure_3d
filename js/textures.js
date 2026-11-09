'use strict';
// ---------------------------------------------------------------------------
// Procedural 64x64 palette-ramped textures (one layer per material).
// The alpha channel is used as an EMISSIVE mask by the shader.
// ---------------------------------------------------------------------------

const TEX_NAMES = ['ROCK', 'ROCK2', 'BASALT', 'FLOWSTONE', 'DIRT', 'MOSS', 'CRYSTAL', 'CRYSTAL2', 'CRYSTAL3',
  'FUNGUS', 'LAVA', 'SKY', 'WATER', 'WOOD', 'GOLD', 'SILVER', 'RUBY', 'EMERALD', 'SAPPHIRE', 'AMETHYST',
  'JADE', 'OBSIDIAN', 'SKIN', 'CLOTH', 'BONE', 'ROPE', 'METAL', 'GLASS', 'BLACK', 'STONE', 'MUSHCAP',
  'EYE', 'FIRE', 'SMOKE', 'PALE', 'SCALES'];
const T = {};
TEX_NAMES.forEach((n, i) => { T[n] = i; });
const TEX_SIZE = 64;

function hexRamp(arr) {
  return arr.map(h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
}
function tnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const p = a => ((a % period) + period) % period;
  const a = hrand(p(xi), p(yi), seed, 1), b = hrand(p(xi + 1), p(yi), seed, 1);
  const c = hrand(p(xi), p(yi + 1), seed, 1), d = hrand(p(xi + 1), p(yi + 1), seed, 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function tfbm(px, py, base, oct, seed) {
  let s = 0, amp = 1, tot = 0, per = base;
  for (let o = 0; o < oct; o++) {
    s += tnoise(px * per, py * per, per, seed + o * 17) * amp;
    tot += amp; amp *= 0.5; per *= 2;
  }
  return s / tot;
}
function makeCells(n, seed) {
  const pts = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    pts.push([(i + hrand(i, j, seed, 5)) / n, (j + hrand(i, j, seed, 6)) / n, hrand(i, j, seed, 7)]);
  }
  return { n, pts };
}
function cellAt(c, px, py) {
  const n = c.n, ci = Math.floor(px * n), cj = Math.floor(py * n);
  let f1 = 9, f2 = 9, id = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const ii = ci + di, jj = cj + dj;
    const wi = ((ii % n) + n) % n, wj = ((jj % n) + n) % n;
    const p = c.pts[wj * n + wi];
    const qx = p[0] + (ii - wi) / n, qy = p[1] + (jj - wj) / n;
    const d = Math.hypot(px - qx, py - qy);
    if (d < f1) { f2 = f1; f1 = d; id = p[2]; } else if (d < f2) f2 = d;
  }
  return { f1, f2, id };
}
const TAU = Math.PI * 2;

const GEM_F = (px, py, s, c) => {
  const k = cellAt(c, px, py);
  if (k.f2 - k.f1 < 0.012) return 0.97;
  return 0.12 + 0.75 * k.id;
};
const CRYS_F = (px, py, s, c) => {
  const k = cellAt(c, px, py);
  return 0.2 + 0.45 * k.id + 0.35 * (1 - smoothstep(0, 0.03, k.f2 - k.f1)) + 0.1 * Math.sin(TAU * (px * 2 + py * 3));
};

const TEXGEN = {
  ROCK: { ramp: ['#120d0a', '#1f1610', '#2c2018', '#3a2b20', '#4a3829', '#5b4633', '#6e563f', '#83684d'],
    pre: s => makeCells(5, s),
    f: (px, py, s, c) => {
      let v = tfbm(px, py, 4, 4, s) * 0.85 + tfbm(px, py, 16, 2, s + 9) * 0.3 - 0.08;
      const k = cellAt(c, px, py); if (k.f2 - k.f1 < 0.012) v -= 0.35;
      return v;
    } },
  ROCK2: { ramp: ['#15181c', '#22272c', '#30363c', '#3f464d', '#4f575f', '#626a72', '#777f86'],
    f: (px, py, s) => 0.5 * tfbm(px, py, 4, 4, s) + 0.4 * (0.5 + 0.5 * Math.sin(TAU * (3 * py + 0.7 * tfbm(px, py, 2, 2, s + 3)))) },
  BASALT: { ramp: ['#0a0a0c', '#141416', '#1e1e22', '#2a2a2f', '#37373d', '#45454c'],
    pre: s => makeCells(4, s),
    f: (px, py, s, c) => { const k = cellAt(c, px, py); return 0.2 + 0.6 * smoothstep(0, 0.05, k.f2 - k.f1) * (0.6 + 0.4 * k.id) + 0.15 * tfbm(px, py, 8, 2, s); } },
  FLOWSTONE: { ramp: ['#2a2016', '#3e3122', '#544430', '#6b5940', '#836f52', '#9c8766', '#b39f7c'],
    f: (px, py, s) => 0.35 * tfbm(px, py, 4, 3, s) + 0.5 * (0.5 + 0.5 * Math.sin(TAU * (4 * px + 0.9 * tfbm(px, py, 2, 3, s + 4)))) + 0.08 },
  DIRT: { ramp: ['#1a120b', '#281c11', '#362618', '#45311f', '#553e28', '#674c32', '#7a5b3d'],
    pre: s => makeCells(8, s),
    f: (px, py, s, c) => {
      const k = cellAt(c, px, py);
      if (k.f1 < 0.035) return 0.5 + k.id * 0.45;
      if (k.f1 < 0.046) return 0.08;
      return tfbm(px, py, 8, 4, s) * 0.7;
    } },
  MOSS: { ramp: ['#0d150a', '#15210f', '#1e2e14', '#283d1a', '#344e20', '#426128', '#527530'],
    f: (px, py, s) => tfbm(px, py, 8, 4, s) * 0.9 + (hrand(Math.floor(px * 64), Math.floor(py * 64), s, 3) > 0.92 ? 0.2 : 0) },
  CRYSTAL: { ramp: ['#0a3a4a', '#126070', '#1d8a9a', '#36b5c2', '#6ad8e0', '#b0f4f6'], e: 0.8, pre: s => makeCells(3, s), f: CRYS_F },
  CRYSTAL2: { ramp: ['#2a0f45', '#45186a', '#632690', '#8640b4', '#ac6ad4', '#d8a8f0'], e: 0.8, pre: s => makeCells(3, s), f: CRYS_F },
  CRYSTAL3: { ramp: ['#0c3a1a', '#145e2a', '#1f8a3c', '#38b558', '#6ad880', '#b4f6c0'], e: 0.8, pre: s => makeCells(3, s), f: CRYS_F },
  FUNGUS: { ramp: ['#140c16', '#1e1222', '#2a1a2e', '#36223a', '#432b48', '#523656'],
    pre: s => makeCells(6, s),
    f: (px, py, s, c) => {
      const k = cellAt(c, px, py);
      if (k.f1 < 0.03) return { v: 1, e: 0.6, rgb: [110, 220, 190] };
      return tfbm(px, py, 8, 4, s) * 0.9;
    } },
  LAVA: { ramp: ['#120402', '#2e0a03', '#5a1405', '#8f2507', '#c4420a', '#ee7414', '#ffae2e', '#ffe070'],
    pre: s => makeCells(4, s),
    f: (px, py, s, c) => {
      const k = cellAt(c, px, py);
      const hot = 1 - smoothstep(0, 0.06, k.f2 - k.f1);
      const v = clamp(hot * 0.85 + tfbm(px, py, 4, 3, s) * 0.45 - 0.1, 0, 0.999);
      return { v, e: clamp(v * 1.6 - 0.15, 0, 1) };
    } },
  SKY: { ramp: ['#9fb7c9', '#b5cad8', '#c9dbe6', '#dde9f0', '#eef5f8'], e: 1, f: (px, py, s) => 0.2 + 0.8 * tfbm(px, py, 2, 4, s) },
  WATER: { ramp: ['#04121a', '#071c26', '#0b2733', '#103442', '#164252', '#1f5468'], e: 0.08, f: (px, py, s) => tfbm(px, py, 4, 3, s) },
  WOOD: { ramp: ['#1f130a', '#2e1d10', '#3e2817', '#4f341e', '#614127', '#755031'],
    f: (px, py, s) => {
      const plank = Math.floor(py * 4), local = py * 4 - plank;
      if (local < 0.07) return 0.02;
      return 0.3 * tfbm(px, py, 2, 3, s + plank) + 0.35 + 0.3 * Math.sin(TAU * (py * 16 + tfbm(px, py, 4, 2, s) * 2));
    } },
  GOLD: { ramp: ['#4a3206', '#6e4c0a', '#94690f', '#b98a18', '#dcae2c', '#f6d35a', '#fff0a0'], e: 0.15,
    f: (px, py, s) => 0.5 + 0.35 * Math.sin(TAU * (px + py) * 2 + tfbm(px, py, 4, 3, s) * 5) + 0.1 * tfbm(px, py, 8, 2, s + 1) },
  SILVER: { ramp: ['#3a3e44', '#555a62', '#717780', '#8f959e', '#aeb4bc', '#d0d5db', '#f0f2f5'], e: 0.1,
    f: (px, py, s) => 0.5 + 0.35 * Math.sin(TAU * (px - py) * 2 + tfbm(px, py, 4, 3, s) * 5) + 0.1 * tfbm(px, py, 8, 2, s + 1) },
  RUBY: { ramp: ['#3a0408', '#5e0810', '#8a0e1a', '#b8182a', '#e0344a', '#ff7486'], e: 0.35, pre: s => makeCells(3, s), f: GEM_F },
  EMERALD: { ramp: ['#03301a', '#06502a', '#0b723c', '#16984f', '#30c06a', '#78eaa0'], e: 0.35, pre: s => makeCells(3, s), f: GEM_F },
  SAPPHIRE: { ramp: ['#06104a', '#0b1c70', '#132c98', '#2244c0', '#4068e0', '#86a4ff'], e: 0.35, pre: s => makeCells(3, s), f: GEM_F },
  AMETHYST: { ramp: ['#2a0f45', '#45186a', '#632690', '#8640b4', '#ac6ad4', '#d8a8f0'], e: 0.35, pre: s => makeCells(3, s), f: GEM_F },
  JADE: { ramp: ['#1a3a2a', '#24503a', '#30684a', '#3e805c', '#509a70', '#6ab488'], e: 0.12, f: (px, py, s) => tfbm(px, py, 4, 4, s) * 0.9 + 0.1 },
  OBSIDIAN: { ramp: ['#050508', '#0b0b10', '#131320', '#1d1c2e', '#2a2840', '#3c3858'],
    f: (px, py, s) => 0.15 + 0.8 * Math.pow(0.5 + 0.5 * Math.sin(TAU * (px * 2 + py) + tfbm(px, py, 4, 3, s) * 4), 4) },
  SKIN: { ramp: ['#1c2016', '#283020', '#34402a', '#425034', '#52603e', '#64724a'], f: (px, py, s) => tfbm(px, py, 8, 4, s) * 1.05 - 0.05 },
  CLOTH: { ramp: ['#0e0b0b', '#181212', '#221a19', '#2d2220', '#392b28'],
    f: (px, py, s) => 0.35 + ((Math.floor(px * 32) + Math.floor(py * 32)) % 2) * 0.15 + tfbm(px, py, 8, 2, s) * 0.35 - 0.1 },
  BONE: { ramp: ['#5a5446', '#757060', '#8f8a78', '#aaa592', '#c4bfab', '#ddd8c4'],
    f: (px, py, s) => 0.5 + tfbm(px, py, 8, 3, s) * 0.5 - (hrand(Math.floor(px * 64), Math.floor(py * 64), s, 2) > 0.95 ? 0.4 : 0) },
  ROPE: { ramp: ['#3e2e17', '#56411f', '#6e5428', '#886933', '#a37f40'], f: (px, py) => 0.5 + 0.45 * Math.sin(TAU * (px * 4 + py * 8)) },
  METAL: { ramp: ['#18191b', '#232528', '#303236', '#3e4146', '#4e5258', '#61666d', '#7a8088'],
    f: (px, py, s) => {
      const fx = (px * 4) % 1 - 0.5, fy = (py * 4) % 1 - 0.5;
      if (Math.hypot(fx, fy) < 0.12) return 0.95;
      return tfbm(px, py, 8, 3, s) * 0.8;
    } },
  GLASS: { ramp: ['#ffc860', '#ffd884', '#ffe6ac', '#fff2d4'], e: 1, f: (px, py, s) => 0.3 + 0.7 * tfbm(px, py, 4, 2, s) },
  BLACK: { ramp: ['#000000', '#030303', '#070606'], f: (px, py, s) => tfbm(px, py, 8, 2, s) },
  STONE: { ramp: ['#1c1c20', '#2a2a30', '#3a3a42', '#4b4b55', '#5e5e6a'],
    pre: s => {
      const segs = [], r = new RNG(s);
      for (let gy = 0; gy < 2; gy++) for (let gx = 0; gx < 3; gx++) {
        const ox = (gx + 0.2) / 3, oy = (gy + 0.15) / 2, w = 0.6 / 3, h = 0.7 / 2;
        const P = () => [ox + r.int(0, 2) / 2 * w, oy + r.int(0, 2) / 2 * h];
        const n = r.int(2, 4);
        for (let k = 0; k < n; k++) segs.push([P(), P()]);
      }
      return segs;
    },
    f: (px, py, s, segs) => {
      for (const [a, b] of segs) {
        const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-6;
        const t = clamp(((px - a[0]) * dx + (py - a[1]) * dy) / l2, 0, 1);
        if (Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t) < 0.02) return { v: 1, e: 1, rgb: [200, 140, 255] };
      }
      return tfbm(px, py, 4, 4, s) * 0.8 + 0.1;
    } },
  MUSHCAP: { ramp: ['#0a3a3a', '#0f5a58', '#168078', '#22a89a', '#40d0bc', '#90f4e2'], e: 0.85,
    pre: s => makeCells(5, s),
    f: (px, py, s, c) => { const k = cellAt(c, px, py); if (k.f1 < 0.04) return 0.98; return 0.3 + 0.45 * tfbm(px, py, 4, 3, s); } },
  EYE: { ramp: ['#ff3010', '#ff6020', '#ffa040', '#ffe080'], e: 1, f: (px, py, s) => 0.3 + 0.7 * tfbm(px, py, 8, 2, s) },
  FIRE: { ramp: ['#7a1a02', '#c43c06', '#f07012', '#ffa82a', '#ffd860', '#fff4b0'], e: 1, f: (px, py, s) => 0.2 + 0.8 * tfbm(px, py, 4, 3, s) },
  SMOKE: { ramp: ['#2a2a2a', '#3a3a3a', '#4a4a4a', '#5a5a5a', '#6a6a6a'], f: (px, py, s) => tfbm(px, py, 4, 3, s) },
  SCALES: { ramp: ['#1e0605', '#3a0c08', '#5c160c', '#842414', '#a8381a', '#c85a24', '#e08a3a'],
    pre: s => makeCells(7, s),
    f: (px, py, s, c) => { const k = cellAt(c, px, py); return clamp(0.15 + 0.6 * (1 - k.f1 * 9) + 0.2 * k.id + (k.f2 - k.f1 < 0.01 ? -0.4 : 0), 0, 0.999); } },
  PALE: { ramp: ['#8a8f98', '#a0a6b0', '#b8bec8', '#d0d6de'], e: 0.25, f: (px, py, s) => tfbm(px, py, 4, 3, s) },
};

function generateTextures() {
  const S = TEX_SIZE, out = [];
  for (let li = 0; li < TEX_NAMES.length; li++) {
    const spec = TEXGEN[TEX_NAMES[li]];
    const ramp = hexRamp(spec.ramp);
    const seed = 1000 + li * 97;
    const pre = spec.pre ? spec.pre(seed) : null;
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const r = spec.f(x / S, y / S, seed, pre);
      let v, e = spec.e || 0, rgb = null;
      if (typeof r === 'number') v = r; else { v = r.v; if (r.e !== undefined) e = r.e; rgb = r.rgb || null; }
      if (!rgb) rgb = ramp[clamp(Math.floor(v * ramp.length), 0, ramp.length - 1)];
      const o = (y * S + x) * 4;
      data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
      data[o + 3] = Math.round(clamp(e, 0, 1) * 255);
    }
    out.push(data);
  }
  return out;
}
