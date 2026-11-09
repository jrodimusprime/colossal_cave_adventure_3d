'use strict';
// ---------------------------------------------------------------------------
// Shared constants, deterministic hashing / noise and tiny matrix maths.
// ---------------------------------------------------------------------------

const CELL = 2.5;      // world units per grid cell
const CHUNK = 32;      // cells per chunk side

function mix32(h) {
  h = h >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
function hash4(a, b, c, d) {
  let h = mix32((a | 0) + 0x9e3779b9);
  h = mix32(h ^ ((b | 0) + 0x85ebca6b));
  h = mix32(h ^ ((c | 0) + 0xc2b2ae35));
  h = mix32(h ^ ((d | 0) + 0x27d4eb2f));
  return h;
}
function hrand(a, b, c, d) { return hash4(a, b, c, d) / 4294967296; }

class RNG {
  constructor(seed) { this.a = seed >>> 0; }
  next() {
    let t = (this.a = (this.a + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

function vnoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hrand(xi, zi, seed, 0), b = hrand(xi + 1, zi, seed, 0);
  const c = hrand(xi, zi + 1, seed, 0), d = hrand(xi + 1, zi + 1, seed, 0);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z, seed, oct) {
  let s = 0, amp = 1, tot = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    s += (vnoise(x * f, z * f, seed + o * 131) * 2 - 1) * amp;
    tot += amp; amp *= 0.5; f *= 2.03;
  }
  return s / tot;
}

// ---- column-major 4x4 matrices ------------------------------------------
function m4ident() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
function m4mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function m4persp(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect,0,0,0, 0,f,0,0, 0,0,(far + near) * nf,-1, 0,0,2 * far * near * nf,0]);
}
function m4t(x, y, z) { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]); }
function m4s(s) { return new Float32Array([s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]); }
function m4rx(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]); }
function m4ry(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]); }
function m4rz(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]); }
// translate * rotY * rotX * rotZ * scale
function m4trs(x, y, z, yaw, pitch, roll, s) {
  let m = m4t(x, y, z);
  if (yaw) m = m4mul(m, m4ry(yaw));
  if (pitch) m = m4mul(m, m4rx(pitch));
  if (roll) m = m4mul(m, m4rz(roll));
  if (s !== undefined && s !== 1) m = m4mul(m, m4s(s));
  return m;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
// north is -z
function dirWord(dx, dz) {
  const a = Math.atan2(dx, -dz);
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return COMPASS[i];
}
