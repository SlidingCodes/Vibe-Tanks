import { describe, it, expect } from 'vitest';
import { appendTrackSample, buildTrackHistoryPayload } from '../src/rooms/trackHistory';
import { PlayerId, TankState, TrackHistoryPoint } from '@shared/types/index';

function makeTank(id: string, x: number, z: number, yaw = 0): TankState {
  return {
    playerId: id,
    playerName: id,
    position: { x, y: 0, z },
    bodyRotation: yaw,
    bodyPitch: 0,
    bodyRoll: 0,
    turretRotation: 0,
    barrelPitch: 0,
    hp: 100,
    maxHp: 100,
    alive: true,
    score: 0,
    color: '#fff',
  };
}

describe('trackHistory helpers', () => {
  it('appends one sample per big-enough move per player', () => {
    const history = new Map<PlayerId, TrackHistoryPoint[]>();
    let lastA: { x: number; z: number } | null = null;
    let lastB: { x: number; z: number } | null = null;

    // Simulate 5 movement ticks for two players, each stepping by 1 unit.
    for (let step = 0; step < 5; step++) {
      const a = makeTank('A', step * 1.0, 0);
      const b = makeTank('B', 0, step * 1.0);
      const sa = appendTrackSample(history, 'A', a, lastA);
      if (sa) lastA = sa;
      const sb = appendTrackSample(history, 'B', b, lastB);
      if (sb) lastB = sb;
    }

    expect(history.has('A')).toBe(true);
    expect(history.has('B')).toBe(true);
    expect(history.get('A')!.length).toBeGreaterThan(0);
    expect(history.get('B')!.length).toBeGreaterThan(0);
  });

  it('skips samples that do not clear the movement step threshold', () => {
    const history = new Map<PlayerId, TrackHistoryPoint[]>();
    let last: { x: number; z: number } | null = null;
    // First call seeds the baseline.
    const s0 = appendTrackSample(history, 'A', makeTank('A', 0, 0), last);
    // First call has no prev → always samples. (Check that it did.)
    expect(s0).not.toBeNull();
    last = s0;
    // A move of 0.1 (below TRACK_SAMPLE_STEP = 0.4) should return null.
    const s1 = appendTrackSample(history, 'A', makeTank('A', 0.1, 0), last);
    expect(s1).toBeNull();
  });

  it('skips dead tanks entirely', () => {
    const history = new Map<PlayerId, TrackHistoryPoint[]>();
    const dead = { ...makeTank('A', 0, 0), alive: false };
    const s = appendTrackSample(history, 'A', dead, null);
    expect(s).toBeNull();
    expect(history.has('A')).toBe(false);
  });

  it('buildTrackHistoryPayload includes every player with points', () => {
    const history = new Map<PlayerId, TrackHistoryPoint[]>();
    let lastA: { x: number; z: number } | null = null;
    let lastB: { x: number; z: number } | null = null;
    for (let i = 0; i < 3; i++) {
      lastA = appendTrackSample(history, 'A', makeTank('A', i * 0.5, 0), lastA) ?? lastA;
      lastB = appendTrackSample(history, 'B', makeTank('B', 0, i * 0.5), lastB) ?? lastB;
    }
    const payload = buildTrackHistoryPayload(history);
    const ids = payload.map((e) => e.playerId).sort();
    expect(ids).toEqual(['A', 'B']);
    // Each entry must carry its points.
    for (const entry of payload) {
      expect(entry.points.length).toBeGreaterThan(0);
    }
  });

  it('payload is deep-copied so later mutations on the server do not alias', () => {
    const history = new Map<PlayerId, TrackHistoryPoint[]>();
    let last: { x: number; z: number } | null = null;
    for (let i = 0; i < 3; i++) {
      last = appendTrackSample(history, 'A', makeTank('A', i * 0.5, 0), last) ?? last;
    }
    const payload = buildTrackHistoryPayload(history);
    const snapshotLen = payload[0].points.length;
    // Keep mutating the source map.
    for (let i = 3; i < 6; i++) {
      last = appendTrackSample(history, 'A', makeTank('A', i * 0.5, 0), last) ?? last;
    }
    expect(payload[0].points.length).toBe(snapshotLen);
  });
});
