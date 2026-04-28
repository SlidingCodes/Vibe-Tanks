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

// ── SFX volume ──

let sfxVolume = 1.0;

export function setVolume(v: number): void {
  sfxVolume = Math.max(0, Math.min(1, v));
}

export function getVolume(): number {
  return sfxVolume;
}

function masterGain(ac: AudioContext): GainNode {
  const g = ac.createGain();
  g.gain.value = sfxVolume;
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
// Original descending "wah-waaah" + Dark Souls choir + "YOU DIED" voice.

export function playDeath(): void {
  // Original descending tone
  playDeathWah();
  // Dark Souls choir (slightly delayed so the wah hits first)
  playDeathChoir();
}

function playDeathWah(): void {
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

function playDeathChoir(): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);
  const DUR = 3.5;

  // Dark Souls-style ominous choir chord: D2, A2, D3, F3 (D minor open)
  const chordFreqs = [73.4, 110, 147, 175];
  for (const freq of chordFreqs) {
    // Each voice: detuned pair of sawtooths through lowpass for a choir/organ feel
    for (const detune of [-8, 0, 8]) {
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;

      const filt = ac.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 600 + freq * 0.5;
      filt.Q.value = 0.7;

      const g = ac.createGain();
      // Slow swell in, long sustain, slow fade
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.06, now + 0.8);
      g.gain.setValueAtTime(0.06, now + DUR - 1.2);
      g.gain.linearRampToValueAtTime(0, now + DUR);

      osc.connect(filt).connect(g).connect(out);
      osc.start(now);
      osc.stop(now + DUR + 0.05);
    }
  }

  // Sub bass rumble
  const sub = ac.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 36.7; // D1
  const sg = ac.createGain();
  sg.gain.setValueAtTime(0, now);
  sg.gain.linearRampToValueAtTime(0.25, now + 0.6);
  sg.gain.setValueAtTime(0.25, now + DUR - 1.5);
  sg.gain.linearRampToValueAtTime(0, now + DUR);
  sub.connect(sg).connect(out);
  sub.start(now);
  sub.stop(now + DUR + 0.05);

  // Impact noise at the very start — low thud
  const noise = createNoise(ac, 0.4);
  const nf = ac.createBiquadFilter();
  nf.type = 'lowpass';
  nf.frequency.value = 400;
  const ng = ac.createGain();
  ng.gain.setValueAtTime(0.3, now);
  ng.gain.linearRampToValueAtTime(0, now + 0.4);
  noise.connect(nf).connect(ng).connect(out);
  noise.start(now);
  noise.stop(now + 0.45);

  // "YOU DIED" voice via SpeechSynthesis
  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance('YOU DIED');
    utter.rate = 0.45;
    utter.pitch = 0.1;
    utter.volume = Math.min(1, sfxVolume * 1.2);

    const voices = speechSynthesis.getVoices();
    const pick = voices.find(
      (v) => /male/i.test(v.name) && /en/i.test(v.lang),
    ) ?? voices.find(
      (v) => /en/i.test(v.lang),
    );
    if (pick) utter.voice = pick;

    // Slight delay so the chord hits first
    setTimeout(() => speechSynthesis.speak(utter), 600);
  }
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

// ── Turbo boost ──
// Jet-engine whoosh: noise burst + rising sine sweep, short and punchy.

export function playTurbo(): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  // White noise filtered through bandpass, sweeping 300 → 3000 Hz
  const noise = createNoise(ac, 0.5);
  const nf = ac.createBiquadFilter();
  nf.type = 'bandpass';
  nf.Q.value = 1.2;
  nf.frequency.setValueAtTime(300, now);
  nf.frequency.exponentialRampToValueAtTime(3000, now + 0.35);
  const ng = ac.createGain();
  ng.gain.setValueAtTime(0, now);
  ng.gain.linearRampToValueAtTime(0.55, now + 0.05);
  ng.gain.linearRampToValueAtTime(0, now + 0.4);
  noise.connect(nf).connect(ng).connect(out);
  noise.start(now);
  noise.stop(now + 0.45);

  // Rising sawtooth — gives the "jet spool-up" feel
  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(120, now);
  osc.frequency.exponentialRampToValueAtTime(900, now + 0.3);
  const og = ac.createGain();
  og.gain.setValueAtTime(0, now);
  og.gain.linearRampToValueAtTime(0.2, now + 0.06);
  og.gain.linearRampToValueAtTime(0, now + 0.35);
  osc.connect(og).connect(out);
  osc.start(now);
  osc.stop(now + 0.38);
}

// ── Hit marker (your shot hit someone) ──
// Quick metallic "ting".

// ── Announcer — Metal-Slug-style "VIBE TANKS!" on game start ──
// Uses SpeechSynthesis with low pitch + a reverb-like echo effect.

/**
 * Reusable speech synth with the arcade announcer profile (slow, deep, dramatic).
 */
export function playSpeech(text: string): void {
  if (!('speechSynthesis' in window)) return;

  // Cancel any pending speech first so we don't queue up multiple announcements.
  speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.6;   // slow and dramatic
  utter.pitch = 0.4;  // deep, commanding voice
  utter.volume = Math.min(1, sfxVolume * 1.5);

  const voices = speechSynthesis.getVoices();
  const preferred = voices.find(
    (v) => /male/i.test(v.name) && /en/i.test(v.lang),
  ) ?? voices.find(
    (v) => /en/i.test(v.lang),
  );
  if (preferred) utter.voice = preferred;

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
}

/**
 * Metal-Slug-style arcade intro — plays the speech + the epic brass swell.
 */
export function playAnnouncer(text: string = 'VIBE TANKS!'): void {
  playSpeech(text);

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

// ── Shield activate ──
// Rising energy hum: sine sweep up + harmonic shimmer.
export function playShieldActivate(): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(320, now);
  osc.frequency.exponentialRampToValueAtTime(1100, now + 0.35);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.35, now + 0.05);
  g.gain.linearRampToValueAtTime(0.15, now + 0.35);
  g.gain.linearRampToValueAtTime(0, now + 0.55);
  osc.connect(g).connect(out);
  osc.start(now);
  osc.stop(now + 0.56);

  const osc2 = ac.createOscillator();
  osc2.type = 'triangle';
  osc2.frequency.setValueAtTime(640, now + 0.05);
  osc2.frequency.exponentialRampToValueAtTime(2200, now + 0.4);
  const g2 = ac.createGain();
  g2.gain.setValueAtTime(0.18, now + 0.05);
  g2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
  osc2.connect(g2).connect(out);
  osc2.start(now + 0.05);
  osc2.stop(now + 0.51);
}

// ── Shield break ──
// Shattering descending crack + low thud.
export function playShieldBreak(): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(1800, now);
  osc.frequency.exponentialRampToValueAtTime(180, now + 0.2);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.4, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
  osc.connect(g).connect(out);
  osc.start(now);
  osc.stop(now + 0.23);

  const noise = createNoise(ac, 0.25);
  const nf = ac.createBiquadFilter();
  nf.type = 'bandpass';
  nf.frequency.value = 2400;
  nf.Q.value = 0.8;
  const ng = ac.createGain();
  ng.gain.setValueAtTime(0.5, now);
  ng.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  noise.connect(nf).connect(ng).connect(out);
  noise.start(now);
  noise.stop(now + 0.26);

  const sub = ac.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(90, now + 0.05);
  sub.frequency.exponentialRampToValueAtTime(30, now + 0.25);
  const sg = ac.createGain();
  sg.gain.setValueAtTime(0.45, now + 0.05);
  sg.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
  sub.connect(sg).connect(out);
  sub.start(now + 0.05);
  sub.stop(now + 0.31);
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

// ── End-of-match countdown beep ──
// Short blip on each second tick during the last 10 seconds. The "final"
// variant (the very last tick before reset) is a touch higher and louder so
// the run-out moment is unmistakable.

/** MOAB-style nuclear warning klaxon: a sustained low rumble over the
 *  whole descent + a sequence of evenly-spaced sine beeps that climb in
 *  pitch and intensity as impact approaches. Caller passes the descent
 *  duration so the beeps space themselves out and the rumble fades to
 *  nothing exactly at zero. Returns nothing — fire and forget. */
export function playNukeWarning(durationSec: number): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  // Layer 1 — low rumble: 70 Hz sine with detuned 100 Hz harmonic, fades
  // in over the first second and tapers off over the last.
  for (const [freq, gain] of [[70, 0.18], [102, 0.08]] as const) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.6);
    g.gain.linearRampToValueAtTime(gain * 1.4, now + durationSec - 0.3);
    g.gain.linearRampToValueAtTime(0, now + durationSec);
    osc.connect(g).connect(out);
    osc.start(now);
    osc.stop(now + durationSec + 0.05);
  }

  // Layer 2 — evenly-spaced warning beeps. Pitch climbs from 700 Hz at
  // the start to 1400 Hz on the final beep; spacing tightens slightly
  // toward impact so the rhythm reads as "accelerating countdown".
  const beepCount = Math.max(4, Math.round(durationSec * 2.2));
  for (let i = 0; i < beepCount; i++) {
    // Easing: quadratic — early beeps spaced widely, last few crowd up.
    const t = i / Math.max(1, beepCount - 1);
    const beepAt = now + t * t * durationSec;
    if (beepAt > now + durationSec) break;
    const freq = 700 + (1400 - 700) * t;
    const peak = 0.16 + 0.12 * t;
    const osc = ac.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, beepAt);
    g.gain.linearRampToValueAtTime(peak, beepAt + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0005, beepAt + 0.16);
    osc.connect(g).connect(out);
    osc.start(beepAt);
    osc.stop(beepAt + 0.18);
  }

  // Layer 3 — a final long siren tone that overlaps the last 0.4 s,
  // fading into the explosion sound for that "klaxon → boom" moment.
  const sirenAt = now + durationSec - 0.45;
  const siren = ac.createOscillator();
  siren.type = 'sawtooth';
  siren.frequency.setValueAtTime(900, sirenAt);
  siren.frequency.linearRampToValueAtTime(1600, sirenAt + 0.4);
  const sirenG = ac.createGain();
  sirenG.gain.setValueAtTime(0, sirenAt);
  sirenG.gain.linearRampToValueAtTime(0.22, sirenAt + 0.05);
  sirenG.gain.linearRampToValueAtTime(0, sirenAt + 0.45);
  siren.connect(sirenG).connect(out);
  siren.start(sirenAt);
  siren.stop(sirenAt + 0.5);
}

export function playMatchTickBeep(final: boolean = false): void {
  const ac = getCtx();
  const now = ac.currentTime;
  const out = masterGain(ac);

  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = final ? 1500 : 1100;
  const g = ac.createGain();
  const peak = final ? 0.22 : 0.16;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(peak, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.001, now + (final ? 0.18 : 0.10));
  osc.connect(g).connect(out);
  osc.start(now);
  osc.stop(now + (final ? 0.2 : 0.12));
}
