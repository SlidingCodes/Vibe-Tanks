// Background music — MP3 tracks, rotated randomly on match reset.
// Uses HTML Audio elements routed through Web Audio API GainNode
// so the music volume slider controls playback.
//
// Tracks are lazy-loaded: an <audio> element is created on first play
// of that index and given preload='none', so the browser fetches the
// MP3 only when it is actually about to play. This keeps page weight
// independent of TRACK_URLS.length — adding a song does not slow boot.

// song1 / song2 carry a `_v2` suffix because their original
// uploads (same path, different bytes) had been cached by browsers
// and the CDN; renaming changes the URL and forces a fresh fetch.
const TRACK_URLS = [
  '/music/song1_v2.mp3',
  '/music/song2_v2.mp3',
  '/music/song3.mp3',
  '/music/song4.mp3',
  '/music/song5.mp3',
  '/music/song6.mp3',
];

// ── State ──
let ctx: AudioContext | null = null;
let musicGain: GainNode | null = null;
let musicVolume = 0.5;
let playing = false;
// Boot on song1 so the login screen plays a known opener; nextTrack()
// rotates randomly between matches once a match is in progress.
let currentTrackIdx = 0;

// Lazy-allocated: index stays null until the track has been played at
// least once. After that the element + source node are reused.
const audioElements: (HTMLAudioElement | null)[] = TRACK_URLS.map(() => null);
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

function getOrCreateElement(idx: number): HTMLAudioElement {
  let el = audioElements[idx];
  if (!el) {
    el = new Audio();
    el.preload = 'none';
    // Single-shot playback; the rotation between tracks is driven by the
    // 'ended' listener below, not by HTML's loop attribute. With loop=true
    // the player would only ever hear song1 (or whichever was started
    // first) and `nextTrack` would only fire on match reset — long
    // sessions never reached the second track.
    el.loop = false;
    el.src = TRACK_URLS[idx];
    el.addEventListener('ended', onTrackEnded);
    audioElements[idx] = el;
  }
  return el;
}

/** Auto-advance handler. On natural end-of-file we rotate to a fresh
 *  random track. Skipped if `playing` was toggled off in the meantime
 *  (e.g. `stopMusic` paused mid-fade) so a queued 'ended' from the
 *  paused track doesn't restart playback. */
function onTrackEnded(): void {
  if (!playing) return;
  nextTrack();
}

function connectElement(idx: number): HTMLAudioElement {
  const el = getOrCreateElement(idx);
  if (sourceNodes[idx]) return el;
  const ac = ensureCtx();
  const source = ac.createMediaElementSource(el);
  source.connect(musicGain!);
  sourceNodes[idx] = source;
  return el;
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
    if (el) el.pause();
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
      if (el) {
        el.pause();
        el.currentTime = 0;
      }
    }
    playCurrentTrack();
  }
}

// ── Internal ──

function playCurrentTrack(): void {
  const el = connectElement(currentTrackIdx);
  el.currentTime = 0;
  el.play().catch(() => {
    // Autoplay blocked — re-issue play() inside the first user gesture.
    const retry = (): void => {
      window.removeEventListener('keydown', retry);
      window.removeEventListener('pointerdown', retry);
      ensureCtx();
      el.play().catch(() => {});
    };
    window.addEventListener('keydown', retry, { once: true });
    window.addEventListener('pointerdown', retry, { once: true });
  });
}
