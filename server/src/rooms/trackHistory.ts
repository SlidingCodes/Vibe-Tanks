import { PlayerId, TankState, TrackHistory, TrackHistoryPoint } from '@shared/types/index';
import { TANK_TREAD_HALF_WIDTH } from '@shared/constants';

/** Min horizontal distance a tank must move between consecutive samples.
 *  Slightly coarser than the client's live paint step so the history payload
 *  stays compact. Clients interpolate between samples via straight segments. */
export const TRACK_SAMPLE_STEP = 0.4;

/** Rolling cap per tank on stored samples. ~1000 points × ~0.4 units ≈ 400
 *  units of trail, plenty for one match; older samples drop off silently. */
export const TRACK_HISTORY_MAX_POINTS = 1000;

/** Append a tread-track sample for this tank if it has moved far enough
 *  since `lastSampleAt`. Returns the new sample XZ if appended, else null. */
export function appendTrackSample(
  history: Map<PlayerId, TrackHistoryPoint[]>,
  playerId: PlayerId,
  tank: TankState,
  lastSampleAt: { x: number; z: number } | null,
): { x: number; z: number } | null {
  if (!tank.alive) return null;
  const px = tank.position.x;
  const pz = tank.position.z;
  if (lastSampleAt) {
    const dx = px - lastSampleAt.x;
    const dz = pz - lastSampleAt.z;
    if (dx * dx + dz * dz < TRACK_SAMPLE_STEP * TRACK_SAMPLE_STEP) return null;
  }
  const rightX = Math.cos(tank.bodyRotation);
  const rightZ = -Math.sin(tank.bodyRotation);
  const point: TrackHistoryPoint = {
    leftX: px - TANK_TREAD_HALF_WIDTH * rightX,
    leftZ: pz - TANK_TREAD_HALF_WIDTH * rightZ,
    rightX: px + TANK_TREAD_HALF_WIDTH * rightX,
    rightZ: pz + TANK_TREAD_HALF_WIDTH * rightZ,
  };
  let arr = history.get(playerId);
  if (!arr) {
    arr = [];
    history.set(playerId, arr);
  }
  arr.push(point);
  if (arr.length > TRACK_HISTORY_MAX_POINTS) arr.shift();
  return { x: px, z: pz };
}

/** Serialize the stored history into the TrackHistory payload shipped to
 *  joining clients. Entries with no points are dropped; point arrays are
 *  copied so later mutation on the server doesn't alias the wire message. */
export function buildTrackHistoryPayload(
  history: Map<PlayerId, TrackHistoryPoint[]>,
): TrackHistory {
  const payload: TrackHistory = [];
  for (const [playerId, points] of history) {
    if (points.length === 0) continue;
    payload.push({ playerId, points: points.slice() });
  }
  return payload;
}
