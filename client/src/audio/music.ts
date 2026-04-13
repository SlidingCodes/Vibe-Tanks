// Procedural chiptune background music — epic tank battle march.
// Uses Web Audio API oscillators scheduled in a loop. No external files.
// Key: D minor, 128 BPM, heroic/military feel.

import { getVolume } from './sounds';

const BPM = 128;
const BEAT = 60 / BPM;
const MUSIC_VOL_RATIO = 0.35; // music is quieter than SFX

// ── Note table (D minor: D E F G A Bb C) ──
const N: Record<string, number> = {
  D2: 73.4, F2: 87.3, G2: 98, A2: 110, Bb2: 116.5, C3: 131,
  D3: 147, E3: 165, F3: 175, G3: 196, A3: 220, Bb3: 233, C4: 262,
  D4: 294, E4: 330, F4: 349, G4: 392, A4: 440, Bb4: 466, C5: 523,
  D5: 587, F5: 698,
  R: 0, // rest
};

// ── Melody (square wave) — 8-bar heroic march in D minor ──
// [noteFreq, durationInBeats]
const MELODY: [number, number][] = [
  // Bar 1: commanding opening — dotted rhythm
  [N.D4, 1], [N.D4, 0.5], [N.D4, 0.5], [N.F4, 1], [N.A4, 1],
  // Bar 2: heroic descent
  [N.Bb4, 1.5], [N.A4, 0.5], [N.G4, 1], [N.F4, 1],
  // Bar 3: repeat with higher reach
  [N.D4, 1], [N.D4, 0.5], [N.D4, 0.5], [N.F4, 1], [N.A4, 1],
  // Bar 4: resolution to root
  [N.Bb4, 0.5], [N.A4, 0.5], [N.G4, 0.5], [N.A4, 0.5], [N.D4, 2],
  // Bar 5: B section — climbs higher, more intensity
  [N.A4, 0.5], [N.A4, 0.5], [N.C5, 1], [N.D5, 1], [N.C5, 1],
  // Bar 6: powerful descent
  [N.Bb4, 1], [N.A4, 0.5], [N.G4, 0.5], [N.F4, 1], [N.E4, 1],
  // Bar 7: tension build — marching upward
  [N.F4, 0.5], [N.G4, 0.5], [N.A4, 1], [N.Bb4, 0.5], [N.A4, 0.5], [N.G4, 1],
  // Bar 8: triumphant turnaround back to root
  [N.A4, 1], [N.G4, 0.5], [N.F4, 0.5], [N.E4, 1], [N.D4, 1],
];

// ── Bass (triangle wave) — power-fifth root movement ──
const BASS: [number, number][] = [
  // Bar 1-2
  [N.D2, 2], [N.A2, 2], [N.Bb2, 2], [N.F2, 2],
  // Bar 3-4
  [N.D2, 2], [N.A2, 2], [N.G2, 2], [N.D2, 2],
  // Bar 5-6
  [N.A2, 2], [N.C3, 2], [N.Bb2, 2], [N.C3, 2],
  // Bar 7-8
  [N.F2, 2], [N.G2, 2], [N.A2, 2], [N.D2, 2],
];

// ── Drums — military march: double kick for drive ──
// 'k'=kick, 's'=snare, 'h'=hat. One entry per 8th note.
function buildDrumPattern(): ('k' | 's' | 'h' | null)[] {
  const bar: ('k' | 's' | 'h' | null)[] = [
    'k', 'k', 's', 'h', 'k', 'k', 's', 'h',
  ];
  const pattern: ('k' | 's' | 'h' | null)[] = [];
  for (let i = 0; i < 8; i++) pattern.push(...bar);
  return pattern;
}
const DRUMS = buildDrumPattern();

// ── State ──
let ctx: AudioContext | null = null;
let musicGain: GainNode | null = null;
let schedulerId: ReturnType<typeof setInterval> | null = null;
let playing = false;
let muted = false;
let loopStartTime = 0;
let melodyIdx = 0;
let bassIdx = 0;
let drumIdx = 0;

function totalBeats(seq: [number, number][]): number {
  return seq.reduce((sum, [, d]) => sum + d, 0);
}
const LOOP_BEATS = totalBeats(MELODY);
const LOOP_DURATION = LOOP_BEATS * BEAT;

function ensureCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    musicGain = ctx.createGain();
    musicGain.gain.value = muted ? 0 : getVolume() * MUSIC_VOL_RATIO;
    musicGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function updateGain(): void {
  if (musicGain) {
    musicGain.gain.setTargetAtTime(
      muted ? 0 : getVolume() * MUSIC_VOL_RATIO,
      ctx!.currentTime,
      0.05,
    );
  }
}

// ── Instrument voices ──

function playNote(ac: AudioContext, freq: number, start: number, dur: number, type: OscillatorType, vol: number): void {
  if (freq <= 0) return;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;

  const g = ac.createGain();
  const attack = 0.01;
  const release = Math.min(0.08, dur * 0.3);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(vol, start + attack);
  g.gain.setValueAtTime(vol, start + dur - release);
  g.gain.linearRampToValueAtTime(0, start + dur);

  osc.connect(g).connect(musicGain!);
  osc.start(start);
  osc.stop(start + dur + 0.01);
}

// Beefy sawtooth melody voice with lowpass filter for a warm, heroic tone.
function playMelodyNote(ac: AudioContext, freq: number, start: number, dur: number): void {
  if (freq <= 0) return;

  // Main sawtooth
  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = freq;

  // Slight detune layer for thickness
  const osc2 = ac.createOscillator();
  osc2.type = 'square';
  osc2.frequency.value = freq;
  osc2.detune.value = 7;

  const filt = ac.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 2200;
  filt.Q.value = 1.2;

  const g = ac.createGain();
  const attack = 0.015;
  const release = Math.min(0.1, dur * 0.3);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(0.13, start + attack);
  g.gain.setValueAtTime(0.13, start + dur - release);
  g.gain.linearRampToValueAtTime(0, start + dur);

  const mix = ac.createGain();
  mix.gain.value = 1;
  osc.connect(mix);
  osc2.connect(ac.createGain()).connect(mix);
  // osc2 at lower volume
  const g2 = ac.createGain();
  g2.gain.value = 0.4;
  osc2.disconnect();
  osc2.connect(g2).connect(mix);

  mix.connect(filt).connect(g).connect(musicGain!);
  osc.start(start);
  osc.stop(start + dur + 0.01);
  osc2.start(start);
  osc2.stop(start + dur + 0.01);
}

function playKick(ac: AudioContext, time: number): void {
  // Heavy military kick — deeper sweep, longer tail
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(180, time);
  osc.frequency.exponentialRampToValueAtTime(35, time + 0.15);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.45, time);
  g.gain.linearRampToValueAtTime(0, time + 0.18);
  osc.connect(g).connect(musicGain!);
  osc.start(time);
  osc.stop(time + 0.19);
}

function playSnare(ac: AudioContext, time: number): void {
  const len = Math.round(ac.sampleRate * 0.08);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filt = ac.createBiquadFilter();
  filt.type = 'highpass';
  filt.frequency.value = 1500;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.2, time);
  g.gain.linearRampToValueAtTime(0, time + 0.08);
  src.connect(filt).connect(g).connect(musicGain!);
  src.start(time);
  src.stop(time + 0.09);
}

function playHat(ac: AudioContext, time: number): void {
  const len = Math.round(ac.sampleRate * 0.03);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filt = ac.createBiquadFilter();
  filt.type = 'highpass';
  filt.frequency.value = 6000;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.1, time);
  g.gain.linearRampToValueAtTime(0, time + 0.03);
  src.connect(filt).connect(g).connect(musicGain!);
  src.start(time);
  src.stop(time + 0.04);
}

// ── Scheduler ──
// Schedules notes a little ahead of real time for seamless playback.

const SCHEDULE_AHEAD = 0.15; // seconds to look ahead

function scheduleAll(): void {
  const ac = ensureCtx();
  updateGain();

  // Schedule melody
  while (loopStartTime + melodyBeatOffset() * BEAT < ac.currentTime + SCHEDULE_AHEAD) {
    if (melodyIdx >= MELODY.length) break;
    const [freq, dur] = MELODY[melodyIdx];
    const t = loopStartTime + melodyBeatOffset() * BEAT;
    playMelodyNote(ac, freq, t, dur * BEAT * 0.9);
    melodyIdx++;
  }

  // Schedule bass
  while (loopStartTime + bassBeatOffset() * BEAT < ac.currentTime + SCHEDULE_AHEAD) {
    if (bassIdx >= BASS.length) break;
    const [freq, dur] = BASS[bassIdx];
    const t = loopStartTime + bassBeatOffset() * BEAT;
    playNote(ac, freq, t, dur * BEAT * 0.85, 'triangle', 0.22);
    bassIdx++;
  }

  // Schedule drums
  const eighthBeat = BEAT / 2;
  while (loopStartTime + drumIdx * eighthBeat < ac.currentTime + SCHEDULE_AHEAD) {
    if (drumIdx >= DRUMS.length) break;
    const t = loopStartTime + drumIdx * eighthBeat;
    const hit = DRUMS[drumIdx];
    if (hit === 'k') playKick(ac, t);
    else if (hit === 's') playSnare(ac, t);
    else if (hit === 'h') playHat(ac, t);
    drumIdx++;
  }

  // Loop reset
  if (melodyIdx >= MELODY.length && bassIdx >= BASS.length && drumIdx >= DRUMS.length) {
    loopStartTime += LOOP_DURATION;
    melodyIdx = 0;
    bassIdx = 0;
    drumIdx = 0;
  }
}

function melodyBeatOffset(): number {
  let b = 0;
  for (let i = 0; i < melodyIdx; i++) b += MELODY[i][1];
  return b;
}

function bassBeatOffset(): number {
  let b = 0;
  for (let i = 0; i < bassIdx; i++) b += BASS[i][1];
  return b;
}

// ── Public API ──

export function startMusic(): void {
  if (playing) return;
  const ac = ensureCtx();
  playing = true;
  loopStartTime = ac.currentTime + 0.1;
  melodyIdx = 0;
  bassIdx = 0;
  drumIdx = 0;
  schedulerId = setInterval(scheduleAll, 80);
}

export function stopMusic(): void {
  if (!playing) return;
  playing = false;
  if (schedulerId !== null) {
    clearInterval(schedulerId);
    schedulerId = null;
  }
}

export function setMusicMuted(m: boolean): void {
  muted = m;
  updateGain();
}

export function isMusicPlaying(): boolean {
  return playing;
}
