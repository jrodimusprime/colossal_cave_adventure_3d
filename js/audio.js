'use strict';
// ---------------------------------------------------------------------------
// All sound is synthesised with WebAudio: no audio files needed.
// ---------------------------------------------------------------------------
const Sfx = (() => {
  let ac = null, master = null, nbuf = null, muted = false;

  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    ac = new C();
    master = ac.createGain(); master.gain.value = 0.5; master.connect(ac.destination);
    nbuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = nbuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    ambient();
  }
  function out(pan) {
    if (pan === undefined || !ac.createStereoPanner) return master;
    const p = ac.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); p.connect(master); return p;
  }
  function env(g, t, vol, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function tone(f, dur, type = 'sine', vol = 0.15, f2 = null, delay = 0, pan) {
    if (!ac || muted) return;
    const t = ac.currentTime + delay;
    const o = ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ac.createGain(); env(g, t, vol, dur);
    o.connect(g); g.connect(out(pan));
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(dur, vol = 0.2, freq = 1000, type = 'lowpass', f2 = null, delay = 0, q = 1, pan) {
    if (!ac || muted) return;
    const t = ac.currentTime + delay;
    const s = ac.createBufferSource(); s.buffer = nbuf; s.loop = true;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(freq, t);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ac.createGain(); env(g, t, vol, dur);
    s.connect(fl); fl.connect(g); g.connect(out(pan));
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  }
  function ambient() {
    const s = ac.createBufferSource(); s.buffer = nbuf; s.loop = true;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 80;
    const g = ac.createGain(); g.gain.value = 0.16;
    s.connect(f); f.connect(g); g.connect(master); s.start();
    const drip = () => {
      const fr = 900 + Math.random() * 1500, pan = Math.random() * 2 - 1;
      tone(fr, 0.12, 'sine', 0.025 + Math.random() * 0.04, fr * 0.45, 0, pan);
      tone(fr * 0.9, 0.1, 'sine', 0.012, fr * 0.4, 0.25, -pan);
      setTimeout(drip, 900 + Math.random() * 4500);
    };
    setTimeout(drip, 1500);
  }
  return {
    init,
    toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : 0.5; return muted; },
    step(water) { if (water) noise(0.22, 0.12, 1200, 'bandpass', 300, 0, 1.2); else noise(0.07, 0.09, 380 + Math.random() * 250, 'lowpass'); },
    pickup(treasure) { tone(660, 0.12, 'square', 0.05); tone(990, 0.15, 'square', 0.05, null, 0.07); if (treasure) tone(1320, 0.3, 'triangle', 0.07, null, 0.14); },
    deposit() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.35, 'triangle', 0.08, null, i * 0.09)); },
    lamp(on) { noise(0.03, 0.15, 3000, 'highpass'); tone(on ? 300 : 200, 0.15, 'sine', 0.05, on ? 500 : 120, 0.02); },
    whoosh() { noise(0.28, 0.15, 400, 'bandpass', 2200, 0, 2); },
    clink() { tone(1900, 0.08, 'square', 0.04); tone(2600, 0.1, 'triangle', 0.04, null, 0.03); },
    hurt() { tone(160, 0.3, 'sawtooth', 0.12, 50); noise(0.18, 0.15, 800, 'lowpass'); },
    growl(pan) { tone(75, 0.7, 'sawtooth', 0.07, 50, 0, pan); noise(0.6, 0.06, 300, 'lowpass', 150, 0, 1, pan); },
    poof(pan) { noise(0.5, 0.18, 2500, 'lowpass', 150, 0, 1, pan); tone(500, 0.3, 'triangle', 0.05, 90, 0, pan); },
    die() { tone(220, 1.6, 'triangle', 0.12, 40); noise(1.2, 0.1, 600, 'lowpass', 60); },
    shade() { [700, 620, 560, 500].forEach((f, i) => tone(f, 0.12, 'triangle', 0.05, f * 0.8, i * 0.11)); },
    magic() { tone(200, 1.0, 'sine', 0.1, 1600); [880, 1108, 1318, 1760].forEach((f, i) => tone(f, 0.5, 'triangle', 0.04, null, 0.2 + i * 0.1)); },
    rope() { noise(0.9, 0.08, 700, 'bandpass', 300, 0, 0.8); },
    splash() { noise(0.35, 0.14, 1500, 'bandpass', 400, 0, 1); },
    sizzle() { noise(0.35, 0.08, 4000, 'highpass'); },
    fall() { tone(700, 1.0, 'sine', 0.08, 90); noise(1.0, 0.1, 400, 'bandpass', 1500, 0, 0.6); },
    thud() { noise(0.25, 0.25, 200, 'lowpass', 60); tone(80, 0.25, 'sine', 0.15, 40); },
    blip() { tone(880, 0.05, 'square', 0.025); },
  };
})();
