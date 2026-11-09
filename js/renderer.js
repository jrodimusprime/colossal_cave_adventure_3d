'use strict';
// ---------------------------------------------------------------------------
// Tiny WebGL2 renderer in the spirit of 1996 software rendering:
// low internal resolution, nearest-neighbour texels, banded light levels,
// overbright lighting, black fog, then a chunky upscale to the screen.
// ---------------------------------------------------------------------------

const SCENE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
layout(location=2) in vec3 aCol;
layout(location=3) in float aLayer;
uniform mat4 uVP;
uniform mat4 uModel;
uniform float uEnt;
uniform float uTexScale;
out vec3 vWPos;
out vec3 vNor;
out vec3 vCol;
out vec2 vUv;
flat out float vLayer;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWPos = wp.xyz;
  vNor = normalize(mat3(uModel) * aNor);
  vCol = aCol;
  vLayer = aLayer;
  vec3 tp = (uEnt > 0.5 ? aPos : wp.xyz) * uTexScale;
  vec3 an = abs(aNor);
  vUv = an.y > 0.7 ? tp.xz : (an.x > an.z ? tp.zy : tp.xy);
  gl_Position = uVP * wp;
}`;

const SCENE_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform float uEnt;
uniform vec3 uEntLight;
uniform float uGlow;
uniform float uAlpha;
uniform vec3 uLampPos;
uniform vec3 uLampCol;
uniform float uLampRange;
uniform vec3 uCamPos;
uniform float uFog;
uniform float uTime;
in vec3 vWPos;
in vec3 vNor;
in vec3 vCol;
in vec2 vUv;
flat in float vLayer;
out vec4 outColor;
void main() {
  vec2 uv = vUv;
  if (abs(vLayer - ${T.WATER}.0) < 0.5) uv += vec2(sin(uv.y * 5.0 + uTime * 1.3), cos(uv.x * 5.0 + uTime * 1.1)) * 0.05;
  if (abs(vLayer - ${T.LAVA}.0) < 0.5) uv += vec2(uTime * 0.03, sin(uv.x * 3.0 + uTime * 0.6) * 0.05);
  if (abs(vLayer - ${T.FIRE}.0) < 0.5) uv.y -= uTime * 1.5;
  vec4 t = texture(uTex, vec3(uv, vLayer));
  vec3 n = normalize(vNor);
  vec3 light = uEnt > 0.5 ? uEntLight : vCol;
  vec3 Ld = uLampPos - vWPos;
  float d = max(length(Ld), 0.001);
  float att = clamp(1.0 - d / uLampRange, 0.0, 1.0);
  att *= att;
  float lam = max(dot(n, Ld / d), 0.0) * 0.75 + 0.25;
  light += uLampCol * att * lam;
  light = floor(light * 12.0 + 0.5) / 12.0;       // light-level banding
  vec3 tint = uEnt > 0.5 ? vCol : vec3(1.0);
  float e = clamp(t.a + uGlow, 0.0, 1.0);
  vec3 col = t.rgb * tint * (light * 1.9 * (1.0 - e) + e * 1.3);
  float fd = length(vWPos - uCamPos);
  float f = exp(-fd * uFog);
  f = mix(f, sqrt(f), e);
  outColor = vec4(col * f, uAlpha);
}`;

const POST_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;
const POST_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform float uFade;
uniform float uFlash;
uniform vec3 uFlashCol;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  c = floor(c * 40.0 + 0.5) / 40.0;
  vec2 d = vUv - 0.5;
  c *= 1.0 - dot(d, d) * 0.9;
  c = mix(c, uFlashCol, uFlash);
  c *= 1.0 - uFade;
  outColor = vec4(c, 1.0);
}`;

class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl; this.canvas = canvas;
    this.prog = this.program(SCENE_VS, SCENE_FS);
    this.post = this.program(POST_VS, POST_FS);
    this.u = {};
    for (const n of ['uVP', 'uModel', 'uEnt', 'uTexScale', 'uTex', 'uEntLight', 'uGlow', 'uAlpha', 'uLampPos', 'uLampCol', 'uLampRange', 'uCamPos', 'uFog', 'uTime'])
      this.u[n] = gl.getUniformLocation(this.prog, n);
    this.pu = {};
    for (const n of ['uScene', 'uFade', 'uFlash', 'uFlashCol']) this.pu[n] = gl.getUniformLocation(this.post, n);
    this.ident = m4ident();
    this.postVao = gl.createVertexArray();
    this.fbo = null; this.aspect = 1; this.lw = 1; this.lh = 1;
  }
  program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  uploadTextures(layers) {
    const gl = this.gl, S = TEX_SIZE;
    const all = new Uint8Array(S * S * 4 * layers.length);
    layers.forEach((d, i) => all.set(d, i * S * S * 4));
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, S, S, layers.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, all);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }
  resize(w, h, lowH) {
    const gl = this.gl, dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(w * dpr); this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.aspect = w / h;
    this.lh = lowH; this.lw = Math.max(1, Math.round(lowH * w / h));
    if (this.fbo) { gl.deleteFramebuffer(this.fbo); gl.deleteTexture(this.fboTex); gl.deleteRenderbuffer(this.fboDepth); }
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.lw, this.lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fboDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.fboDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.lw, this.lh);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.fboDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  createMesh(data) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const st = 40;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, st, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, st, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, st, 36);
    gl.bindVertexArray(null);
    return { vao, vbo, count: data.length / 10 };
  }
  deleteMesh(m) { if (!m) return; this.gl.deleteBuffer(m.vbo); this.gl.deleteVertexArray(m.vao); }

  beginScene(time) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.lw, this.lh);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1f(this.u.uTime, time);
  }
  setCamera(vp, camPos, lampPos, lampCol, lampRange, fog) {
    const gl = this.gl, u = this.u;
    gl.uniformMatrix4fv(u.uVP, false, vp);
    gl.uniform3fv(u.uCamPos, camPos);
    gl.uniform3fv(u.uLampPos, lampPos);
    gl.uniform3fv(u.uLampCol, lampCol);
    gl.uniform1f(u.uLampRange, lampRange);
    gl.uniform1f(u.uFog, fog);
  }
  drawWorld(m, alpha = 1) {
    if (!m || !m.count) return;
    const gl = this.gl, u = this.u;
    gl.uniformMatrix4fv(u.uModel, false, this.ident);
    gl.uniform1f(u.uEnt, 0); gl.uniform1f(u.uTexScale, 0.32); gl.uniform1f(u.uGlow, 0); gl.uniform1f(u.uAlpha, alpha);
    gl.bindVertexArray(m.vao);
    gl.drawArrays(gl.TRIANGLES, 0, m.count);
  }
  drawEntity(m, model, light, glow = 0, alpha = 1) {
    const gl = this.gl, u = this.u;
    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniform1f(u.uEnt, 1); gl.uniform1f(u.uTexScale, 3.0);
    gl.uniform3fv(u.uEntLight, light); gl.uniform1f(u.uGlow, glow); gl.uniform1f(u.uAlpha, alpha);
    gl.bindVertexArray(m.vao);
    gl.drawArrays(gl.TRIANGLES, 0, m.count);
  }
  blend(on) {
    const gl = this.gl;
    if (on) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
    else { gl.disable(gl.BLEND); gl.depthMask(true); }
  }
  clearDepth() { const gl = this.gl; gl.clear(gl.DEPTH_BUFFER_BIT); }
  present(fade, flash, flashCol) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(this.post);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1i(this.pu.uScene, 1);
    gl.uniform1f(this.pu.uFade, fade);
    gl.uniform1f(this.pu.uFlash, flash);
    gl.uniform3fv(this.pu.uFlashCol, flashCol);
    gl.bindVertexArray(this.postVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
