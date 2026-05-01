import { randomUUID } from 'node:crypto';
import {
  PlayerId,
  ShotResult,
  ShotStep,
  ShotVisualStyle,
  TankState,
  TerrainOp,
  Vec3,
  WeaponDefinition,
} from '@shared/types/index';
import { BLAST_UPWARD_BIAS, GRAVITY, SIM_DT, SHOT_MAX_SIM_TICKS } from '@shared/constants';
import { blastImpulse } from '@shared/airborne';
import { computeMuzzle } from '@shared/muzzle';
import { resolveRailEndpoint } from '@shared/rail';

/** Sphere radius used for direct-hit intersection against a flying shell —
 *  slightly larger than the 0.8 Rapier hull so visually-plausible shots
 *  register even with a shell tick granularity of 1/60 s. */
const DIRECT_HIT_RADIUS = 1.1;
/** Vertical offset from the tank's ground position to its body centre —
 *  matches BODY_Y_OFFSET on the Rapier side. Shots should hit the body,
 *  not the feet. */
const TANK_BODY_CENTRE_OFFSET_Y = 0.8;
/** Damage multiplier applied to a direct-hit tank on top of the normal
 *  blast-radius falloff. Adds teeth to actually landing a cannon shot. */
const DIRECT_HIT_DAMAGE_MULTIPLIER = 1.6;
/** Impulse magnitude per point of weapon damage. With default weapons
 *  (damage 20–40) this gives ~6–12 m/s delta-v at the blast centre — well
 *  above the AIRBORNE_ENTRY_SPEED threshold. */
const IMPULSE_PER_DAMAGE = 0.35;
/** Extra impulse multiplier on direct hits. Same logic as the damage
 *  multiplier but tuned so a clean shot always launches. */
const DIRECT_HIT_IMPULSE_BONUS = 2.2;

/**
 * Terrain surface Simulation queries for shell collisions. Satisfied directly
 * by VoxelGrid via its width/height aliases and the shared noise-seeded
 * surface. Shell trajectories sample the same isosurface tanks ride on and
 * carves mutate, so impact prediction and actual impact match exactly.
 */
export interface SimulationTerrain {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  getHeight(x: number, z: number): number;
  getSurfaceNormal(x: number, z: number): Vec3;
}

export const SAMPLE_EVERY_TICKS = 4;
export const SECONDS_PER_SAMPLE = SAMPLE_EVERY_TICKS * SIM_DT;

interface SegmentOptions {
  splitTime?: number;
  airburstHeight?: number;
  /** Tanks to test the shell path against. A per-tick sphere intersection
   *  on any tank in this list detonates the shell at that point. Caller is
   *  responsible for excluding the shooter's own tank. */
  hitCandidates?: TankState[];
}

export interface SegmentResult {
  trajectory: Vec3[];
  endPoint: Vec3;
  endVelocity: Vec3;
  elapsed: number;
  reason: 'impact' | 'airburst' | 'split' | 'bounds' | 'direct_hit';
  /** Present when `reason === 'direct_hit'` — the tank the shell collided
   *  with mid-flight. */
  directHitTankId?: PlayerId;
}

interface ImpactSpec {
  point: Vec3;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  /** When the shell made a direct hit on a tank mid-flight, pass its id
   *  here. That tank receives bonus damage and a guaranteed-airborne
   *  impulse regardless of distance. */
  directHitTankId?: PlayerId | null;
  /** Optional inner radius where damage stays flat at the full `damage`
   *  value before the quadratic falloff kicks in. Models a "crater zone":
   *  inside → certain death, outside → fading splash. Default undefined
   *  → falloff starts at the impact point (every legacy weapon's
   *  behaviour). */
  flatCoreRadius?: number;
  /** Multiplier on the kinetic impulse applied to victims. 1 = the
   *  default damage-derived push, larger values yeet survivors clear of
   *  the blast (used by the nuke for spectacle). */
  impulseScale?: number;
}

export type DamageTotals = Map<string, { damage: number; killed: boolean; impulse: Vec3; shielded?: boolean }>;

function makeDamageEntry(): { damage: number; killed: boolean; impulse: Vec3; shielded?: boolean } {
  return { damage: 0, killed: false, impulse: { x: 0, y: 0, z: 0 } };
}

export interface DrillPlan {
  entryResult: ShotResult;
  didImpact: boolean;
  impactTime: number;
  eruptionDelay: number;
  eruptionPoint: Vec3;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
}

function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function normalize(v: Vec3): Vec3 {
  const len = length(v) || 1;
  return {
    x: v.x / len,
    y: v.y / len,
    z: v.z / len,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function add(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

function scale(v: Vec3, amount: number): Vec3 {
  return {
    x: v.x * amount,
    y: v.y * amount,
    z: v.z * amount,
  };
}

export function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export interface StepExtras {
  terrainOp?: TerrainOp;
  /** Shell id for live-tracked ballistic steps. When set, the room registers
   *  a LiveShell against this id; `shell_intercepted` events use it to
   *  retarget the client visual on early detonation. */
  shellId?: string;
  /** Damage / terrain damage the room's live tracker applies at the
   *  detonation. Only set on live-tracked steps; precomputed legacy paths
   *  (mortar landings, drill bursts, etc.) leave them undefined and apply
   *  damage inline. */
  damage?: number;
  terrainDamage?: number;
  /** Velocity at the step's terminal point (split / bounce). The room's
   *  live tracker hands this to the chain helper unchanged so fragments
   *  / ricochets inherit the exact parent velocity instead of a noisy
   *  finite-difference approximation. */
  endVelocity?: Vec3;
}

export function makeStep(
  startDelay: number,
  trajectory: Vec3[],
  endPoint: Vec3,
  eventType: ShotStep['eventType'],
  carveTerrain: boolean,
  blastRadius: number,
  visualStyle: ShotVisualStyle,
  extrasOrTerrainOp?: TerrainOp | StepExtras,
): ShotStep {
  const step: ShotStep = {
    startDelay,
    trajectory,
    endPoint,
    eventType,
    carveTerrain,
    blastRadius,
    visualStyle,
  };
  if (extrasOrTerrainOp !== undefined) {
    // Backward-compatible: legacy callers pass a TerrainOp directly. New
    // callers (simulate*Shot post live-shell refactor) pass a StepExtras
    // bag with shellId/damage/terrainDamage and optionally a terrainOp.
    if ('kind' in extrasOrTerrainOp) {
      step.terrainOp = extrasOrTerrainOp;
    } else {
      if (extrasOrTerrainOp.terrainOp !== undefined) step.terrainOp = extrasOrTerrainOp.terrainOp;
      if (extrasOrTerrainOp.shellId !== undefined) step.shellId = extrasOrTerrainOp.shellId;
      if (extrasOrTerrainOp.damage !== undefined) step.damage = extrasOrTerrainOp.damage;
      if (extrasOrTerrainOp.terrainDamage !== undefined) step.terrainDamage = extrasOrTerrainOp.terrainDamage;
      if (extrasOrTerrainOp.endVelocity !== undefined) step.endVelocity = extrasOrTerrainOp.endVelocity;
    }
  }
  return step;
}

export function createShotResult(
  shooterId: string,
  weaponId: string,
  steps: ShotStep[],
  damageTotals: DamageTotals = new Map(),
): ShotResult {
  const impulses: ShotResult['impulses'] = [];
  const damageDealt: ShotResult['damageDealt'] = [];
  for (const [playerId, value] of damageTotals) {
    damageDealt.push({ playerId, damage: value.damage, killed: value.killed, shielded: value.shielded });
    const impLenSq = value.impulse.x ** 2 + value.impulse.y ** 2 + value.impulse.z ** 2;
    if (impLenSq > 1e-4) impulses.push({ playerId, impulse: value.impulse });
  }
  return impulses.length > 0
    ? { shooterId, weaponId, steps, damageDealt, impulses }
    : { shooterId, weaponId, steps, damageDealt };
}

function finalizeDamageTotals(allTanks: TankState[], damageTotals: DamageTotals): void {
  for (const [playerId, totals] of damageTotals) {
    const victim = allTanks.find((tank) => tank.playerId === playerId);
    if (victim) {
      if (victim.shieldActive) totals.shielded = true;
      if (totals.damage >= victim.hp) totals.killed = true;
    }
  }
}

function createPredictedShotResult(
  shooterId: string,
  weaponId: string,
  steps: ShotStep[],
  damageTotals: DamageTotals,
  allTanks: TankState[],
): ShotResult {
  finalizeDamageTotals(allTanks, damageTotals);
  return createShotResult(shooterId, weaponId, steps, damageTotals);
}

export function createInitialVelocity(tank: TankState, speed: number): Vec3 {
  const muzzle = computeMuzzle(tank);
  return {
    x: muzzle.direction.x * speed,
    y: muzzle.direction.y * speed,
    z: muzzle.direction.z * speed,
  };
}

/** Shell spawn position — exactly the barrel tip in world space. Honours
 *  body yaw/pitch/roll + turret yaw + barrel pitch, so the shot always
 *  emerges from the cannon, even when the tank is on its side. No ground
 *  clearance: if the barrel is buried in terrain, the shell detonates on
 *  spawn (self-damage) — that's the correct physical outcome. */
export function createMuzzlePosition(tank: TankState): Vec3 {
  return cloneVec3(computeMuzzle(tank).origin);
}

export function createLinearTrajectory(start: Vec3, end: Vec3, duration: number): Vec3[] {
  const steps = Math.max(2, Math.ceil(duration / SECONDS_PER_SAMPLE) + 1);
  const points: Vec3[] = [];

  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 1 : i / (steps - 1);
    points.push({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      z: start.z + (end.z - start.z) * t,
    });
  }

  return points;
}

export function simulateSegment(
  startPos: Vec3,
  startVel: Vec3,
  terrain: SimulationTerrain,
  options: SegmentOptions = {},
): SegmentResult {
  const pos = cloneVec3(startPos);
  const vel = cloneVec3(startVel);
  const trajectory: Vec3[] = [cloneVec3(pos)];
  let endPoint = cloneVec3(pos);
  let reason: SegmentResult['reason'] = 'bounds';
  let elapsed = 0;

  const hitCandidates = options.hitCandidates;
  const directHitRadiusSq = DIRECT_HIT_RADIUS * DIRECT_HIT_RADIUS;
  let directHitTankId: PlayerId | undefined;

  for (let tick = 0; tick < SHOT_MAX_SIM_TICKS; tick++) {
    vel.y += GRAVITY * SIM_DT;
    pos.x += vel.x * SIM_DT;
    pos.y += vel.y * SIM_DT;
    pos.z += vel.z * SIM_DT;
    elapsed += SIM_DT;

    const terrainH = terrain.getHeight(pos.x, pos.z);

    if (tick % SAMPLE_EVERY_TICKS === 0) {
      trajectory.push(cloneVec3(pos));
    }

    if (hitCandidates && hitCandidates.length > 0) {
      for (const candidate of hitCandidates) {
        if (!candidate.alive) continue;
        const dx = pos.x - candidate.position.x;
        const dy = pos.y - (candidate.position.y + TANK_BODY_CENTRE_OFFSET_Y);
        const dz = pos.z - candidate.position.z;
        if (dx * dx + dy * dy + dz * dz <= directHitRadiusSq) {
          endPoint = cloneVec3(pos);
          reason = 'direct_hit';
          directHitTankId = candidate.playerId;
          break;
        }
      }
      if (directHitTankId) break;
    }

    if (pos.y <= terrainH) {
      pos.y = terrainH;
      endPoint = cloneVec3(pos);
      reason = 'impact';
      break;
    }

    if (
      pos.y < -10 ||
      pos.x < -20 || pos.x > terrain.width * terrain.cellSize + 20 ||
      pos.z < -20 || pos.z > terrain.height * terrain.cellSize + 20
    ) {
      endPoint = cloneVec3(pos);
      reason = 'bounds';
      break;
    }

    if (options.airburstHeight !== undefined && vel.y < 0 && pos.y <= terrainH + options.airburstHeight) {
      endPoint = cloneVec3(pos);
      reason = 'airburst';
      break;
    }

    if (options.splitTime !== undefined && elapsed >= options.splitTime) {
      endPoint = cloneVec3(pos);
      reason = 'split';
      break;
    }

    endPoint = cloneVec3(pos);
  }

  const last = trajectory[trajectory.length - 1];
  if (!last || last.x !== endPoint.x || last.y !== endPoint.y || last.z !== endPoint.z) {
    trajectory.push(cloneVec3(endPoint));
  }

  return directHitTankId
    ? {
        trajectory,
        endPoint,
        endVelocity: cloneVec3(vel),
        elapsed,
        reason,
        directHitTankId,
      }
    : {
        trajectory,
        endPoint,
        endVelocity: cloneVec3(vel),
        elapsed,
        reason,
      };
}

/**
 * Accumulate tank damage contributions for an impact. Returns true when the
 * impact should carve terrain (i.e. terrainDamage > 0) so the caller can
 * forward that flag on the ShotStep. The caller still commits the voxel
 * carve itself against the authoritative grid at the visual moment.
 */
export function applyImpact(
  impact: ImpactSpec,
  allTanks: TankState[],
  damageTotals: DamageTotals,
): boolean {
  const impulseMagnitude = impact.damage * IMPULSE_PER_DAMAGE * (impact.impulseScale ?? 1);
  if (impact.damage > 0) {
    for (const tank of allTanks) {
      if (!tank.alive) continue;

      const dx = tank.position.x - impact.point.x;
      const dy = tank.position.y - impact.point.y;
      const dz = tank.position.z - impact.point.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const isDirect = impact.directHitTankId === tank.playerId;
      if (isDirect || dist < impact.blastRadius) {
        const entry = damageTotals.get(tank.playerId) ?? makeDamageEntry();

        // Falloff curve. With a flatCoreRadius, damage stays at full
        // strength inside the crater and tapers quadratically from
        // there out to blastRadius. Without it, the legacy radial
        // taper from the impact point applies.
        let falloff: number;
        if (isDirect) {
          falloff = 1;
        } else if (impact.flatCoreRadius && dist <= impact.flatCoreRadius) {
          falloff = 1;
        } else if (impact.flatCoreRadius) {
          const span = Math.max(0.001, impact.blastRadius - impact.flatCoreRadius);
          const t = (dist - impact.flatCoreRadius) / span;
          falloff = Math.max(0, 1 - t * t);
        } else {
          const t = dist / Math.max(impact.blastRadius, 0.001);
          falloff = 1 - t * t;
        }
        const dmgScalar = isDirect ? DIRECT_HIT_DAMAGE_MULTIPLIER : 1;
        const dmg = Math.round(impact.damage * falloff * dmgScalar);
        if (dmg > 0) entry.damage += dmg;

        const baseImpulse = blastImpulse(
          impact.point,
          impact.blastRadius,
          impulseMagnitude,
          tank.position,
          BLAST_UPWARD_BIAS,
        );
        if (isDirect) {
          // Direct hits get a guaranteed-airborne impulse along the shell's
          // line of flight; blastImpulse alone (dist ≈ 0) gives a degenerate
          // direction so we synthesize one from the impact offset with a
          // hard upward kick.
          const len = Math.hypot(dx, dz) || 1;
          const push = impulseMagnitude * DIRECT_HIT_IMPULSE_BONUS;
          entry.impulse.x += (dx / len) * push;
          entry.impulse.y += push * BLAST_UPWARD_BIAS * 2;
          entry.impulse.z += (dz / len) * push;
        } else {
          entry.impulse.x += baseImpulse.x;
          entry.impulse.y += baseImpulse.y;
          entry.impulse.z += baseImpulse.z;
        }

        damageTotals.set(tank.playerId, entry);
      }
    }
  }

  return impact.terrainDamage > 0;
}

function makeFragmentVelocity(baseVelocity: Vec3, yawOffset: number, speedScale: number): Vec3 {
  const baseSpeed = length(baseVelocity) * speedScale;
  const horizontal = Math.sqrt(baseVelocity.x ** 2 + baseVelocity.z ** 2);
  const baseYaw = Math.atan2(baseVelocity.x, baseVelocity.z);
  const basePitch = Math.atan2(baseVelocity.y, Math.max(horizontal, 0.0001));
  const pitch = Math.max(-0.65, basePitch - 0.18);
  const yaw = baseYaw + yawOffset;

  return {
    x: Math.sin(yaw) * Math.cos(pitch) * baseSpeed,
    y: Math.sin(pitch) * baseSpeed,
    z: Math.cos(yaw) * Math.cos(pitch) * baseSpeed,
  };
}

function reflectVelocity(velocity: Vec3, normal: Vec3, damping: number): Vec3 {
  const n = normalize(normal);
  const factor = 2 * dot(velocity, n);
  const reflected = sub(velocity, scale(n, factor));
  const bounced = scale(reflected, damping);
  bounced.y = Math.max(Math.abs(bounced.y), 2.5);
  return bounced;
}

function applyDirectHit(tank: TankState, damage: number, damageTotals: DamageTotals): void {
  if (!tank.alive || damage <= 0) return;

  const current = damageTotals.get(tank.playerId) ?? makeDamageEntry();
  current.damage += damage;
  damageTotals.set(tank.playerId, current);
}

/** Alive-and-not-shooter slice of the tank list, used as `hitCandidates`
 *  for simulateSegment so a shell can detect body intersections mid-flight. */
function hitCandidatesFor(shooter: TankState, allTanks: TankState[]): TankState[] {
  return allTanks.filter((t) => t.alive && t.playerId !== shooter.playerId);
}

/** Resolve an impact step from a segment. Handles both terrain `'impact'`
 *  and `'direct_hit'` (shell collided with a tank mid-flight) uniformly.
 *  Returns whether the caller should carve terrain at this step. */
function applySegmentImpact(
  segment: SegmentResult,
  blastRadius: number,
  damage: number,
  terrainDamage: number,
  allTanks: TankState[],
  damageTotals: DamageTotals,
): boolean {
  if (segment.reason === 'impact') {
    return applyImpact({
      point: segment.endPoint,
      blastRadius,
      damage,
      terrainDamage,
    }, allTanks, damageTotals);
  }
  if (segment.reason === 'direct_hit') {
    applyImpact({
      point: segment.endPoint,
      blastRadius,
      damage,
      terrainDamage: 0, // mid-air on a tank — don't carve the ground
      directHitTankId: segment.directHitTankId,
    }, allTanks, damageTotals);
    return false;
  }
  return false;
}

function simulateStandardShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  // Trajectory is purely geometric: gravity + terrain only. Tank intersection
  // is checked tick-by-tick by the room's live shell tracker against current
  // tank positions, not against fire-time snapshots — that's the whole point
  // of this refactor (a moving target should be able to dodge).
  const segment = simulateSegment(startPos, startVel, terrain);
  // Live-tracked: damage applied at the live impact moment by the room.
  // carveTerrain is true so the carve happens at detonation.
  return createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', weapon.terrainDamage > 0, weapon.blastRadius, 'standard', {
      shellId: randomUUID(),
      damage: weapon.damage,
      terrainDamage: weapon.terrainDamage,
    }),
  ]);
}

function simulateAirburstShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const segment = simulateSegment(startPos, startVel, terrain, {
    airburstHeight: weapon.behaviorConfig?.airburstHeight ?? 2.5,
  });

  // Airburst by design detonates mid-air; only a terrain impact carves
  // ground. The flag below stays consistent with the legacy behaviour:
  // carve only when the round actually hit dirt.
  const carveTerrain = segment.reason === 'impact' && weapon.terrainDamage > 0;
  const terrainDamage = segment.reason === 'impact' ? weapon.terrainDamage : 0;
  return createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'big_blast', {
      shellId: randomUUID(),
      damage: weapon.damage,
      terrainDamage,
    }),
  ]);
}

function simulateSplitShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const splitTime = weapon.behaviorConfig?.splitTime ?? 0.7;
  const segment = simulateSegment(startPos, startVel, terrain, { splitTime });

  // Parent only — fragments are spawned by the room's live tracker when the
  // parent reaches its split moment naturally. If the parent is intercepted
  // (terrain hit before splitTime, or tank intersect mid-flight), no
  // fragments fire — same intent as a fizzling cluster shell.
  if (segment.reason !== 'split') {
    return createShotResult(shooter.playerId, weapon.id, [
      makeStep(0, segment.trajectory, segment.endPoint, 'impact', weapon.terrainDamage > 0, weapon.blastRadius, 'splitter_parent', {
        shellId: randomUUID(),
        damage: weapon.damage,
        terrainDamage: weapon.terrainDamage,
      }),
    ]);
  }

  return createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'split', false, 0, 'splitter_parent', {
      shellId: randomUUID(),
      damage: 0,
      terrainDamage: 0,
      // The exact velocity at the split point — fragments inherit this
      // verbatim, so the per-fragment yaw/pitch math runs against the
      // true post-flight vector instead of a halved approximation.
      endVelocity: cloneVec3(segment.endVelocity),
    }),
  ]);
}

/** Spawn fragment shells from a parent splitter that reached its split
 *  point naturally. Pure geometric trajectories; the room registers each
 *  fragment as its own LiveShell. */
export function planSplitFragments(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  splitPoint: Vec3,
  splitVelocity: Vec3,
): ShotStep[] {
  const fragmentCount = weapon.behaviorConfig?.fragmentCount ?? 3;
  const fragmentSpread = weapon.behaviorConfig?.fragmentSpread ?? 0.34;
  const fragmentSpeedScale = weapon.behaviorConfig?.fragmentSpeedScale ?? 0.9;
  const fragmentBlastRadius = weapon.behaviorConfig?.fragmentBlastRadius ?? 2;
  const fragmentDamage = weapon.behaviorConfig?.fragmentDamage ?? weapon.damage;
  const fragmentTerrainDamage = weapon.behaviorConfig?.fragmentTerrainDamage ?? weapon.terrainDamage;
  const half = (fragmentCount - 1) / 2;

  const steps: ShotStep[] = [];
  for (let i = 0; i < fragmentCount; i++) {
    const yawOffset = (i - half) * fragmentSpread;
    const fragmentVelocity = makeFragmentVelocity(splitVelocity, yawOffset, fragmentSpeedScale);
    const fragmentSegment = simulateSegment(splitPoint, fragmentVelocity, terrain);
    steps.push(makeStep(
      0,
      fragmentSegment.trajectory,
      fragmentSegment.endPoint,
      'impact',
      fragmentTerrainDamage > 0,
      fragmentBlastRadius,
      'splitter_fragment',
      {
        shellId: randomUUID(),
        damage: fragmentDamage,
        terrainDamage: fragmentTerrainDamage,
      },
    ));
  }
  // Suppress unused-param warning when the helper is used purely for
  // weapon-driven config (no shooter dependence beyond the muzzle the
  // parent already departed from).
  void shooter;
  return steps;
}

/** Range (m) within which the bouncer's bounce snaps its outgoing XZ
 *  direction onto the nearest enemy. Outside this radius the geometric
 *  reflection is preserved, so a long-range bounce off a wall behaves
 *  predictably when no target is around. */
const BOUNCER_RETARGET_RADIUS = 30;
/** Range (m) within which the drill steers underground toward the
 *  nearest enemy on entry. Mirrors BOUNCER_RETARGET_RADIUS. */
const DRILL_RETARGET_RADIUS = 30;

function findNearestEnemy(
  shooterId: string,
  fromXZ: { x: number; z: number },
  allTanks: TankState[],
  maxRadius: number,
): TankState | null {
  let best: TankState | null = null;
  let bestDist2 = maxRadius * maxRadius;
  for (const tank of allTanks) {
    if (tank.playerId === shooterId) continue;
    if (!tank.alive) continue;
    const dx = tank.position.x - fromXZ.x;
    const dz = tank.position.z - fromXZ.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      best = tank;
    }
  }
  return best;
}

function simulateBounceShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const firstSegment = simulateSegment(startPos, startVel, terrain);

  if (firstSegment.reason !== 'impact' || (weapon.behaviorConfig?.bounceCount ?? 1) <= 0) {
    return createShotResult(shooter.playerId, weapon.id, [
      makeStep(0, firstSegment.trajectory, firstSegment.endPoint, 'impact', weapon.terrainDamage > 0, weapon.blastRadius, 'bouncer_parent', {
        shellId: randomUUID(),
        damage: weapon.damage,
        terrainDamage: weapon.terrainDamage,
      }),
    ]);
  }

  // Parent only. The room's live tracker spawns the bounce-segment via
  // planBounceSegment when the parent reaches terrain naturally. If the
  // parent is intercepted by a tank mid-flight, the bounce is skipped and
  // the parent detonates as a regular impact at the interception point.
  return createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, firstSegment.trajectory, firstSegment.endPoint, 'bounce', false, 0, 'bouncer_parent', {
      shellId: randomUUID(),
      // Same fix as the splitter parent: the bounce-segment helper
      // reflects this velocity off the terrain normal, and a halved
      // input was launching the ricochet straight into the dirt.
      endVelocity: cloneVec3(firstSegment.endVelocity),
      damage: 0,
      terrainDamage: 0,
    }),
  ]);
}

/** Spawn the bounce-segment of a bouncer that reached terrain naturally.
 *  Reflects the parent's end velocity off the local surface normal,
 *  optionally retargets the outgoing XZ heading toward the nearest enemy,
 *  and runs a fresh geometric segment from the bounce origin. */
export function planBounceSegment(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  parentEndPoint: Vec3,
  parentEndVelocity: Vec3,
  allTanks: TankState[],
): ShotStep {
  const impactNormal = terrain.getSurfaceNormal(parentEndPoint.x, parentEndPoint.z);
  const damping = weapon.behaviorConfig?.bounceDamping ?? 0.72;
  let bouncedVelocity = reflectVelocity(parentEndVelocity, impactNormal, damping);

  // Smart-bounce retarget — uses *current* tank positions so it actually
  // tracks moving targets, unlike the old fire-time snapshot.
  const target = findNearestEnemy(shooter.playerId, parentEndPoint, allTanks, BOUNCER_RETARGET_RADIUS);
  if (target) {
    const tx = target.position.x - parentEndPoint.x;
    const tz = target.position.z - parentEndPoint.z;
    const horizLen = Math.sqrt(tx * tx + tz * tz);
    if (horizLen > 1e-3) {
      const horizSpeed = Math.sqrt(bouncedVelocity.x * bouncedVelocity.x + bouncedVelocity.z * bouncedVelocity.z);
      bouncedVelocity = {
        x: (tx / horizLen) * horizSpeed,
        y: bouncedVelocity.y,
        z: (tz / horizLen) * horizSpeed,
      };
    }
  }

  const bounceStart = add(parentEndPoint, scale(impactNormal, 0.25));
  const secondSegment = simulateSegment(bounceStart, bouncedVelocity, terrain);
  return makeStep(
    0,
    secondSegment.trajectory,
    secondSegment.endPoint,
    'impact',
    weapon.terrainDamage > 0,
    weapon.blastRadius,
    'bouncer_bounce',
    {
      shellId: randomUUID(),
      damage: weapon.damage,
      terrainDamage: weapon.terrainDamage,
    },
  );
}

function simulateDiggerShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const segment = simulateSegment(startPos, startVel, terrain);

  // Capsule axis follows the shell's final velocity so the tunnel burrows
  // along the incoming flight line. If the shell stopped (bounds exit or
  // intercepted at near-zero), fall back to the shot direction to avoid
  // a degenerate zero-length axis.
  const vlen = Math.sqrt(
    segment.endVelocity.x ** 2 + segment.endVelocity.y ** 2 + segment.endVelocity.z ** 2,
  );
  const axis: Vec3 = vlen > 1e-3
    ? { x: segment.endVelocity.x / vlen, y: segment.endVelocity.y / vlen, z: segment.endVelocity.z / vlen }
    : { x: startVel.x, y: startVel.y, z: startVel.z };
  if (vlen <= 1e-3) {
    const axlen = Math.sqrt(axis.x ** 2 + axis.y ** 2 + axis.z ** 2) || 1;
    axis.x /= axlen; axis.y /= axlen; axis.z /= axlen;
  }

  const tunnelLength = weapon.behaviorConfig?.diggerTunnelLength ?? 10;
  const tunnelRadius = weapon.behaviorConfig?.diggerTunnelRadius ?? 3.5;
  // Only attach the capsule op when the shell actually reached terrain —
  // a tank-intercept mid-flight should crater via the normal sphere carve.
  const terrainOp: TerrainOp | undefined = segment.reason === 'impact'
    ? { kind: 'carve_capsule', axis, length: tunnelLength, radius: tunnelRadius }
    : undefined;

  return createShotResult(shooter.playerId, weapon.id, [
    makeStep(
      0,
      segment.trajectory,
      segment.endPoint,
      'impact',
      weapon.terrainDamage > 0 || terrainOp !== undefined,
      weapon.blastRadius,
      'digger_shell',
      {
        shellId: randomUUID(),
        damage: weapon.damage,
        terrainDamage: weapon.terrainDamage,
        terrainOp,
      },
    ),
  ]);
}

function simulateWallShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const segment = simulateSegment(startPos, startVel, terrain);
  const damageTotals: DamageTotals = new Map();

  // Forward direction for wall orientation: projected flight direction at
  // impact in XZ. Fall back to the shot's initial horizontal velocity if
  // the shell was vertical on impact (unlikely but harmless).
  const flat = { x: segment.endVelocity.x, y: 0, z: segment.endVelocity.z };
  const flen = Math.sqrt(flat.x * flat.x + flat.z * flat.z);
  const forward: Vec3 = flen > 1e-3
    ? { x: flat.x / flen, y: 0, z: flat.z / flen }
    : { x: Math.sin(shooter.turretRotation), y: 0, z: Math.cos(shooter.turretRotation) };

  const terrainOp: TerrainOp | undefined = segment.reason === 'impact' ? {
    kind: 'add_wall',
    forward,
    width: weapon.behaviorConfig?.wallWidth ?? 6,
    height: weapon.behaviorConfig?.wallHeight ?? 3,
    thickness: weapon.behaviorConfig?.wallThickness ?? 1.2,
  } : undefined;

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(
      0,
      segment.trajectory,
      segment.endPoint,
      'impact',
      terrainOp !== undefined,
      0,
      'wall_shell',
      terrainOp,
    ),
  ], damageTotals, []);
}

function simulateRampShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const segment = simulateSegment(startPos, startVel, terrain);
  const damageTotals: DamageTotals = new Map();

  const flat = { x: segment.endVelocity.x, y: 0, z: segment.endVelocity.z };
  const flen = Math.sqrt(flat.x * flat.x + flat.z * flat.z);
  const forward: Vec3 = flen > 1e-3
    ? { x: flat.x / flen, y: 0, z: flat.z / flen }
    : { x: Math.sin(shooter.turretRotation), y: 0, z: Math.cos(shooter.turretRotation) };

  const length = weapon.behaviorConfig?.rampLength ?? 8;
  // Centre the base on the impact so the ramp sits half behind / half
  // ahead of where the aim reticle lands. Anchor base.y on the terrain
  // height at that XZ — using segment.endPoint.y directly put the ramp
  // at whatever Y the shell happened to hit (a crater rim, a slope), so
  // the back edge floated over the ground elsewhere. The addRamp SDF
  // now fills downward to bedrock, so a slightly-too-low base lifts
  // into the terrain rather than leaving an unclimbable step.
  const baseX = segment.endPoint.x - forward.x * (length / 2);
  const baseZ = segment.endPoint.z - forward.z * (length / 2);
  const base: Vec3 = {
    x: baseX,
    y: terrain.getHeight(baseX, baseZ),
    z: baseZ,
  };

  const terrainOp: TerrainOp | undefined = segment.reason === 'impact' ? {
    kind: 'add_ramp',
    forward,
    length,
    width: weapon.behaviorConfig?.rampWidth ?? 3.6,
    height: weapon.behaviorConfig?.rampHeight ?? 3,
  } : undefined;

  // Rewrite endPoint to the ramp base so the server's terrain committer
  // (which treats endPoint as the op anchor) lines up with the wedge.
  const impactPoint = terrainOp ? base : segment.endPoint;

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(
      0,
      segment.trajectory,
      impactPoint,
      'impact',
      terrainOp !== undefined,
      0,
      'ramp_shell',
      terrainOp,
    ),
  ], damageTotals, []);
}

function simulateRailShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  const maxRange = weapon.behaviorConfig?.railRange ?? 50;
  const beamRadius = weapon.behaviorConfig?.railRadius ?? weapon.blastRadius;
  const terrainDamage = weapon.behaviorConfig?.railTerrainDamage ?? weapon.terrainDamage;
  const railHit = resolveRailEndpoint(
    shooter,
    maxRange,
    beamRadius,
    (x, z) => terrain.getHeight(x, z),
    allTanks,
  );
  const hitTank = railHit.hitTankId
    ? allTanks.find((tank) => tank.playerId === railHit.hitTankId) ?? null
    : null;

  const damageTotals: DamageTotals = new Map();
  let carveTerrain = false;

  if (hitTank) {
    applyDirectHit(hitTank, weapon.damage, damageTotals);
  } else if (railHit.terrainHit) {
    carveTerrain = applyImpact({
      point: railHit.hitPoint,
      blastRadius: beamRadius,
      damage: 0,
      terrainDamage,
    }, allTanks, damageTotals);
  }

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(0, [railHit.startPos, railHit.hitPoint], railHit.hitPoint, 'beam', carveTerrain, beamRadius, 'rail'),
  ], damageTotals, allTanks);
}

function simulateMinigunShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  // Minigun is hitscan with a short trail, identical to a thinned-out
  // rail beam. Range / hit radius come from behaviorConfig; per-shot
  // damage is small (the punishing total comes from sustained fire).
  // No terrain carving — bullet ground impacts only spawn a tracer.
  const maxRange = weapon.behaviorConfig?.minigunRange ?? 55;
  const beamRadius = weapon.behaviorConfig?.minigunRadius ?? 0.7;
  const railHit = resolveRailEndpoint(
    shooter,
    maxRange,
    beamRadius,
    (x, z) => terrain.getHeight(x, z),
    allTanks,
  );
  const hitTank = railHit.hitTankId
    ? allTanks.find((tank) => tank.playerId === railHit.hitTankId) ?? null
    : null;

  const damageTotals: DamageTotals = new Map();
  if (hitTank) {
    applyDirectHit(hitTank, weapon.damage, damageTotals);
  }

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(0, [railHit.startPos, railHit.hitPoint], railHit.hitPoint, 'beam', false, beamRadius, 'minigun_tracer'),
  ], damageTotals, allTanks);
}

export function planDrillShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[] = [],
): DrillPlan {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const segment = simulateSegment(startPos, startVel, terrain);
  const entryResult = createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', false, 0, 'drill_entry'),
  ]);

  const didImpact = segment.reason === 'impact';
  const horizontal = normalize({ x: segment.endVelocity.x, y: 0, z: segment.endVelocity.z });
  const fallback = {
    x: Math.sin(shooter.turretRotation),
    y: 0,
    z: Math.cos(shooter.turretRotation),
  };
  let direction = (Math.abs(horizontal.x) + Math.abs(horizontal.z)) > 0.001 ? horizontal : fallback;
  // Smart underground steering: when entering the ground, redirect the burrow
  // toward the nearest enemy (XZ only) so the eruption surfaces under them
  // instead of along the inertial heading. Falls back to the geometric
  // direction if no enemy is in range.
  const target = findNearestEnemy(shooter.playerId, segment.endPoint, allTanks, DRILL_RETARGET_RADIUS);
  if (target) {
    const tx = target.position.x - segment.endPoint.x;
    const tz = target.position.z - segment.endPoint.z;
    const horizLen = Math.sqrt(tx * tx + tz * tz);
    if (horizLen > 1e-3) direction = { x: tx / horizLen, y: 0, z: tz / horizLen };
  }
  const drillDistance = weapon.behaviorConfig?.drillDistance ?? 5;
  const eruptionXZ = {
    x: segment.endPoint.x + direction.x * drillDistance,
    z: segment.endPoint.z + direction.z * drillDistance,
  };
  const eruptionPoint = {
    x: eruptionXZ.x,
    y: terrain.getHeight(eruptionXZ.x, eruptionXZ.z),
    z: eruptionXZ.z,
  };

  return {
    entryResult,
    didImpact,
    impactTime: segment.elapsed,
    eruptionDelay: weapon.behaviorConfig?.drillDelay ?? 0.4,
    eruptionPoint,
    blastRadius: weapon.behaviorConfig?.drillBlastRadius ?? Math.max(weapon.blastRadius, 3.4),
    damage: weapon.behaviorConfig?.drillDamage ?? weapon.damage,
    terrainDamage: weapon.behaviorConfig?.drillTerrainDamage ?? Math.max(weapon.terrainDamage, 3),
  };
}

export function buildImpactResult(
  shooterId: string,
  weaponId: string,
  point: Vec3,
  blastRadius: number,
  visualStyle: ShotVisualStyle,
  carveTerrain: boolean,
  damageTotals: DamageTotals = new Map(),
): ShotResult {
  return createShotResult(shooterId, weaponId, [
    makeStep(0, [cloneVec3(point)], cloneVec3(point), 'impact', carveTerrain, blastRadius, visualStyle),
  ], damageTotals);
}

/** Simulate a projectile from a tank's turret and return the result.
 *  Ballistic variants (standard / airburst / split / bounce / digger)
 *  return trajectory geometry only; their damage is applied by the room's
 *  live shell tracker at the actual impact moment, against current tank
 *  positions, so a target that walks out of the blast radius before the
 *  shell lands no longer takes damage. Hitscan / instant variants
 *  (rail / minigun) and pure-terrain ones (wall / ramp) keep precomputed
 *  damage since they have no flight-time gap that can be exploited. */
export function simulateShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  switch (weapon.behavior) {
    case 'airburst':
      return simulateAirburstShot(shooter, weapon, terrain);
    case 'split':
      return simulateSplitShot(shooter, weapon, terrain);
    case 'bounce':
      return simulateBounceShot(shooter, weapon, terrain);
    case 'rail':
      return simulateRailShot(shooter, weapon, terrain, allTanks);
    case 'minigun':
      return simulateMinigunShot(shooter, weapon, terrain, allTanks);
    case 'digger':
      return simulateDiggerShot(shooter, weapon, terrain);
    case 'wall':
      return simulateWallShot(shooter, weapon, terrain);
    case 'ramp':
      return simulateRampShot(shooter, weapon, terrain);
    case 'standard':
    default:
      return simulateStandardShot(shooter, weapon, terrain);
  }
}
