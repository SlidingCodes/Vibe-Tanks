// Background music — MP3 tracks, rotated randomly on match reset.
// Uses HTML Audio elements routed through Web Audio API GainNode
// so the music volume slider controls playback.

const TRACK_URLS = [
  '/music/song1.mp3',
  '/music/song2.mp3',
];

// ── State ──
let ctx: AudioContext | null = null;
let musicGain: GainNode | null = null;
let musicVolume = 0.5;
let playing = false;
let currentTrackIdx = Math.floor(Math.random() * TRACK_URLS.length);

// Pre-create Audio elements so they can buffer ahead
const audioElements: HTMLAudioElement[] = TRACK_URLS.map((url) => {
  const el = new Audio(url);
  el.preload = 'auto';
  el.loop = true;
  return el;
});

// MediaElementSourceNodes (created once per element, reusable)
const sourceNodes: (MediaElementAudioSourceNode | null)[] = TRACK_URLS.map(() => null);

function ensureCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    musicGain = ctx.createGain();
    musicGain.gain.value = musicVolume;
    musicGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function connectElement(idx: number): void {
  if (sourceNodes[idx]) return; // already connected
  const ac = ensureCtx();
  const source = ac.createMediaElementSource(audioElements[idx]);
  source.connect(musicGain!);
  sourceNodes[idx] = source;
}

function updateGain(): void {
  if (musicGain && ctx) {
    musicGain.gain.setTargetAtTime(musicVolume, ctx.currentTime, 0.05);
  }
}

// ── Public API ──

export function setMusicVolume(v: number): void {
  musicVolume = Math.max(0, Math.min(1, v));
  updateGain();
}

export function getMusicVolume(): number {
  return musicVolume;
}

export function startMusic(): void {
  if (playing) return;
  ensureCtx();
  playing = true;
  playCurrentTrack();
}

export function stopMusic(): void {
  if (!playing) return;
  playing = false;
  for (const el of audioElements) {
    el.pause();
  }
}

export function isMusicPlaying(): boolean {
  return playing;
}

/** Switch to a random different track. Called on match reset. */
export function nextTrack(): void {
  // Pick a different track randomly
  if (TRACK_URLS.length > 1) {
    let next: number;
    do {
      next = Math.floor(Math.random() * TRACK_URLS.length);
    } while (next === currentTrackIdx);
    currentTrackIdx = next;
  }

  if (playing) {
    // Stop all, start new
    for (const el of audioElements) {
      el.pause();
      el.currentTime = 0;
    }
    playCurrentTrack();
  }
}

// ── Internal ──

function playCurrentTrack(): void {
  const el = audioElements[currentTrackIdx];
  connectElement(currentTrackIdx);
  el.currentTime = 0;
  el.play().catch(() => {
    // Autoplay blocked — will start on next user gesture
  });
}
