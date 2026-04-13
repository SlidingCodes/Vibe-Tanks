// Procedural audio using Web Audio API — no external files needed.
// All sounds are synthesized from oscillators + noise for a cartoony arcade feel.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  // Resume if suspended (browsers block autoplay until user gesture).
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// ── Helpers ──

function createNoise(ac: AudioContext, duration: number): AudioBufferSourceNode {
  const len = ac.sampleRate * duration;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  return src;
}

function ramp(param: AudioParam, from: number, to: number, start: number, end: number): void {
  param.setValueAtTime(from, start);
  param.linearRampToValueAtTime(to, end);
}

// ── Master volume ──

let masterVolume = 0.5;

export function setVolume(v: number): void {
  masterVolume = Math.max(0, Math.min(1, v));
}

export function getVolume(): number {
  return masterVolume;
}

function masterGain(ac: AudioContext): GainNode {
  const g = ac.createGain();
  g.gain.value = masterVolume;
  g.connect(ac.destination);
  return g;
}

// ── Shoot ──
// Punchy "thoom" — sine sweep down + short noise burst.

export function playShoot(): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  // Sine sweep 300→60 Hz
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(60, now + 0.15);
  const oscGain = ac.createGain();
  ramp(oscGain.gain, 0.6, 0, now, now + 0.18);
  osc.connect(oscGain).connect(out);
  osc.start(now);
  osc.stop(now + 0.2);

  // Noise burst
  const noise = createNoise(ac, 0.1);
  const nf = ac.createBiquadFilter();
  nf.type = 'lowpass';
  nf.frequency.value = 1200;
  const ng = ac.createGain();
  ramp(ng.gain, 0.35, 0, now, now + 0.1);
  noise.connect(nf).connect(ng).connect(out);
  noise.start(now);
  noise.stop(now + 0.1);
}

// ── Explosion (shell impact) ──
// Scale 0–1 controls size: bigger = longer + lower.

export function playExplosion(scale: number = 0.65): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);
  const s = Math.max(0.3, Math.min(1, scale));
  const dur = 0.25 + s * 0.35;

  // Low rumble
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120 * (1.2 - s * 0.5), now);
  osc.frequency.exponentialRampToValueAtTime(30, now + dur);
  const og = ac.createGain();
  ramp(og.gain, 0.5 * s, 0, now, now + dur);
  osc.connect(og).connect(out);
  osc.start(now);
  osc.stop(now + dur + 0.01);

  // Noise crunch
  const noise = createNoise(ac, dur);
  const filt = ac.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(3000, now);
  filt.frequency.exponentialRampToValueAtTime(200, now + dur);
  const ng = ac.createGain();
  ramp(ng.gain, 0.4 * s, 0, now, now + dur);
  noise.connect(filt).connect(ng).connect(out);
  noise.start(now);
  noise.stop(now + dur + 0.01);
}

// ── Tank explosion (big death boom) ──
// Louder, longer, with a secondary rumble.

export function playTankExplosion(): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  // Main boom
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(100, now);
  osc.frequency.exponentialRampToValueAtTime(20, now + 0.6);
  const og = ac.createGain();
  ramp(og.gain, 0.7, 0, now, now + 0.6);
  osc.connect(og).connect(out);
  osc.start(now);
  osc.stop(now + 0.65);

  // Crackle noise
  const noise = createNoise(ac, 0.5);
  const filt = ac.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = 800;
  filt.Q.value = 1.5;
  const ng = ac.createGain();
  ramp(ng.gain, 0.45, 0, now, now + 0.5);
  noise.connect(filt).connect(ng).connect(out);
  noise.start(now);
  noise.stop(now + 0.5);

  // Secondary low rumble (delayed)
  const osc2 = ac.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(50, now + 0.15);
  osc2.frequency.exponentialRampToValueAtTime(18, now + 0.8);
  const og2 = ac.createGain();
  og2.gain.setValueAtTime(0, now);
  og2.gain.linearRampToValueAtTime(0.4, now + 0.2);
  og2.gain.linearRampToValueAtTime(0, now + 0.8);
  osc2.connect(og2).connect(out);
  osc2.start(now + 0.15);
  osc2.stop(now + 0.85);
}

// ── Death (local player died) ──
// Descending tone — ominous "wah-waaah".

export function playDeath(): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(400, now);
  osc.frequency.exponentialRampToValueAtTime(80, now + 0.8);
  const g = ac.createGain();
  ramp(g.gain, 0.3, 0, now, now + 0.9);

  const filt = ac.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(2000, now);
  filt.frequency.exponentialRampToValueAtTime(200, now + 0.8);

  osc.connect(filt).connect(g).connect(out);
  osc.start(now);
  osc.stop(now + 0.95);
}

// ── Respawn ──
// Cheerful ascending "bling-bling" — two quick rising tones.

export function playRespawn(): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  for (let i = 0; i < 2; i++) {
    const t = now + i * 0.12;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600 + i * 250, t);
    osc.frequency.linearRampToValueAtTime(800 + i * 300, t + 0.1);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.02);
    g.gain.linearRampToValueAtTime(0, t + 0.15);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.16);
  }
}

// ── Weapon switch ──
// Short mechanical "click-clack".

export function playWeaponSwitch(): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  // Click
  const noise = createNoise(ac, 0.04);
  const filt = ac.createBiquadFilter();
  filt.type = 'highpass';
  filt.frequency.value = 3000;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.4, now);
  g.gain.linearRampToValueAtTime(0, now + 0.04);
  noise.connect(filt).connect(g).connect(out);
  noise.start(now);
  noise.stop(now + 0.04);

  // Clack (slightly delayed, lower)
  const noise2 = createNoise(ac, 0.03);
  const filt2 = ac.createBiquadFilter();
  filt2.type = 'bandpass';
  filt2.frequency.value = 2000;
  filt2.Q.value = 3;
  const g2 = ac.createGain();
  g2.gain.setValueAtTime(0.3, now + 0.04);
  g2.gain.linearRampToValueAtTime(0, now + 0.07);
  noise2.connect(filt2).connect(g2).connect(out);
  noise2.start(now + 0.035);
  noise2.stop(now + 0.07);
}

// ── Hit marker (your shot hit someone) ──
// Quick metallic "ting".

// ── Announcer — Metal-Slug-style "VIBE TANKS!" on game start ──
// Uses SpeechSynthesis with low pitch + a reverb-like echo effect.

export function playAnnouncer(): void {
  if (!('speechSynthesis' in window)) return;

  // Cancel any pending speech first.
  speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance('VIBE TANKS!');
  utter.rate = 0.6;   // slow and dramatic
  utter.pitch = 0.4;  // deep, commanding voice
  utter.volume = Math.min(1, masterVolume * 1.5); // a bit louder than SFX

  // Try to pick a male English voice for the best effect.
  const voices = speechSynthesis.getVoices();
  const preferred = voices.find(
    (v) => /male/i.test(v.name) && /en/i.test(v.lang),
  ) ?? voices.find(
    (v) => /en/i.test(v.lang),
  );
  if (preferred) utter.voice = preferred;

  // Voices may load async — retry once if the list was empty.
  if (voices.length === 0) {
    speechSynthesis.addEventListener('voiceschanged', () => {
      const v = speechSynthesis.getVoices();
      const pick = v.find((x) => /male/i.test(x.name) && /en/i.test(x.lang))
        ?? v.find((x) => /en/i.test(x.lang));
      if (pick) utter.voice = pick;
      speechSynthesis.speak(utter);
    }, { once: true });
  } else {
    speechSynthesis.speak(utter);
  }

  // Accompany with an epic brass-like swell for the arcade feel.
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  // Low brass swell (two detuned sawtooths through lowpass)
  for (const detune of [-6, 6]) {
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 147; // D3
    osc.detune.value = detune;
    const filt = ac.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(400, now);
    filt.frequency.linearRampToValueAtTime(1600, now + 0.6);
    filt.frequency.linearRampToValueAtTime(600, now + 1.4);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.2, now + 0.3);
    g.gain.setValueAtTime(0.2, now + 0.8);
    g.gain.linearRampToValueAtTime(0, now + 1.5);
    osc.connect(filt).connect(g).connect(out);
    osc.start(now);
    osc.stop(now + 1.55);
  }

  // Impact hit at the start
  const noise = createNoise(ac, 0.15);
  const nf = ac.createBiquadFilter();
  nf.type = 'lowpass';
  nf.frequency.value = 800;
  const ng = ac.createGain();
  ng.gain.setValueAtTime(0.35, now);
  ng.gain.linearRampToValueAtTime(0, now + 0.15);
  noise.connect(nf).connect(ng).connect(out);
  noise.start(now);
  noise.stop(now + 0.16);
}

// ── Hit marker (your shot hit someone) ──
// Quick metallic "ting".

export function playHitMarker(): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  const osc = ac.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = 1800;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.25, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  osc.connect(g).connect(out);
  osc.start(now);
  osc.stop(now + 0.13);

  const osc2 = ac.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = 2600;
  const g2 = ac.createGain();
  g2.gain.setValueAtTime(0.15, now);
  g2.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
  osc2.connect(g2).connect(out);
  osc2.start(now);
  osc2.stop(now + 0.09);
}
