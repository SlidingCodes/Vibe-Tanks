import {
  PlayerId,
  ShotResult,
  ShotStep,
  ShotVisualStyle,
  TankState,
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
}

export type DamageTotals = Map<string, { damage: number; killed: boolean; impulse: Vec3 }>;

function makeDamageEntry(): { damage: number; killed: boolean; impulse: Vec3 } {
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

export function makeStep(
  startDelay: number,
  trajectory: Vec3[],
  endPoint: Vec3,
  eventType: ShotStep['eventType'],
  carveTerrain: boolean,
  blastRadius: number,
  visualStyle: ShotVisualStyle,
): ShotStep {
  return {
    startDelay,
    trajectory,
    endPoint,
    eventType,
    carveTerrain,
    blastRadius,
    visualStyle,
  };
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
    damageDealt.push({ playerId, damage: value.damage, killed: value.killed });
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
    if (victim && totals.damage >= victim.hp) totals.killed = true;
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
  const impulseMagnitude = impact.damage * IMPULSE_PER_DAMAGE;
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

        const t = dist / Math.max(impact.blastRadius, 0.001);
        const falloff = isDirect ? 1 : 1 - t * t;
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
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const segment = simulateSegment(startPos, startVel, terrain, {
    hitCandidates: hitCandidatesFor(shooter, allTanks),
  });
  const carveTerrain = applySegmentImpact(
    segment, weapon.blastRadius, weapon.damage, weapon.terrainDamage, allTanks, damageTotals,
  );

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'standard'),
  ], damageTotals, allTanks);
}

function simulateAirburstShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const segment = simulateSegment(startPos, startVel, terrain, {
    airburstHeight: weapon.behaviorConfig?.airburstHeight ?? 2.5,
    hitCandidates: hitCandidatesFor(shooter, allTanks),
  });

  // Airburst detonates mid-air on its own, but a tank body in the way
  // triggers the same explosion slightly earlier. Route through the
  // shared resolver so impulses/direct-hit bonuses land consistently.
  const terrainDamage = segment.reason === 'impact' ? weapon.terrainDamage : 0;
  let carveTerrain: boolean;
  if (segment.reason === 'direct_hit' || segment.reason === 'impact') {
    carveTerrain = applySegmentImpact(
      segment, weapon.blastRadius, weapon.damage, terrainDamage, allTanks, damageTotals,
    );
  } else {
    carveTerrain = applyImpact({
      point: segment.endPoint,
      blastRadius: weapon.blastRadius,
      damage: weapon.damage,
      terrainDamage: 0,
    }, allTanks, damageTotals);
  }

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'big_blast'),
  ], damageTotals, allTanks);
}

function simulateSplitShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const splitTime = weapon.behaviorConfig?.splitTime ?? 0.7;
  const candidates = hitCandidatesFor(shooter, allTanks);
  const segment = simulateSegment(startPos, startVel, terrain, { splitTime, hitCandidates: candidates });

  if (segment.reason !== 'split') {
    const carveTerrain = applySegmentImpact(
      segment, weapon.blastRadius, weapon.damage, weapon.terrainDamage, allTanks, damageTotals,
    );

    return createPredictedShotResult(shooter.playerId, weapon.id, [
      makeStep(0, segment.trajectory, segment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'splitter_parent'),
    ], damageTotals, allTanks);
  }

  const steps: ShotStep[] = [
    makeStep(0, segment.trajectory, segment.endPoint, 'split', false, 0, 'splitter_parent'),
  ];

  const fragmentCount = weapon.behaviorConfig?.fragmentCount ?? 3;
  const fragmentSpread = weapon.behaviorConfig?.fragmentSpread ?? 0.34;
  const fragmentSpeedScale = weapon.behaviorConfig?.fragmentSpeedScale ?? 0.9;
  const fragmentBlastRadius = weapon.behaviorConfig?.fragmentBlastRadius ?? 2;
  const fragmentDamage = weapon.behaviorConfig?.fragmentDamage ?? weapon.damage;
  const fragmentTerrainDamage = weapon.behaviorConfig?.fragmentTerrainDamage ?? weapon.terrainDamage;
  const half = (fragmentCount - 1) / 2;

  for (let i = 0; i < fragmentCount; i++) {
    const yawOffset = (i - half) * fragmentSpread;
    const fragmentVelocity = makeFragmentVelocity(segment.endVelocity, yawOffset, fragmentSpeedScale);
    const fragmentSegment = simulateSegment(segment.endPoint, fragmentVelocity, terrain, {
      hitCandidates: candidates,
    });
    const carveTerrain = applySegmentImpact(
      fragmentSegment, fragmentBlastRadius, fragmentDamage, fragmentTerrainDamage, allTanks, damageTotals,
    );

    steps.push(makeStep(
      segment.elapsed,
      fragmentSegment.trajectory,
      fragmentSegment.endPoint,
      'impact',
      carveTerrain,
      fragmentBlastRadius,
      'splitter_fragment',
    ));
  }

  return createPredictedShotResult(shooter.playerId, weapon.id, steps, damageTotals, allTanks);
}

function simulateBounceShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const candidates = hitCandidatesFor(shooter, allTanks);
  const firstSegment = simulateSegment(startPos, startVel, terrain, { hitCandidates: candidates });

  if (firstSegment.reason !== 'impact' || (weapon.behaviorConfig?.bounceCount ?? 1) <= 0) {
    // Either no bounces configured, direct_hit, or bounds exit.
    const carveTerrain = applySegmentImpact(
      firstSegment, weapon.blastRadius, weapon.damage, weapon.terrainDamage, allTanks, damageTotals,
    );

    return createPredictedShotResult(shooter.playerId, weapon.id, [
      makeStep(0, firstSegment.trajectory, firstSegment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'bouncer_parent'),
    ], damageTotals, allTanks);
  }

  const impactNormal = terrain.getSurfaceNormal(firstSegment.endPoint.x, firstSegment.endPoint.z);
  const damping = weapon.behaviorConfig?.bounceDamping ?? 0.72;
  const bouncedVelocity = reflectVelocity(firstSegment.endVelocity, impactNormal, damping);
  const bounceStart = add(firstSegment.endPoint, scale(impactNormal, 0.25));
  const secondSegment = simulateSegment(bounceStart, bouncedVelocity, terrain, { hitCandidates: candidates });
  const carveTerrain = applySegmentImpact(
    secondSegment, weapon.blastRadius, weapon.damage, weapon.terrainDamage, allTanks, damageTotals,
  );

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(0, firstSegment.trajectory, firstSegment.endPoint, 'bounce', false, 0, 'bouncer_parent'),
    makeStep(firstSegment.elapsed, secondSegment.trajectory, secondSegment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'bouncer_bounce'),
  ], damageTotals, allTanks);
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

export function planDrillShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
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
  const direction = (Math.abs(horizontal.x) + Math.abs(horizontal.z)) > 0.001 ? horizontal : fallback;
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

/** Simulate a projectile from a tank's turret and return the result */
export function simulateShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  switch (weapon.behavior) {
    case 'airburst':
      return simulateAirburstShot(shooter, weapon, terrain, allTanks);
    case 'split':
      return simulateSplitShot(shooter, weapon, terrain, allTanks);
    case 'bounce':
      return simulateBounceShot(shooter, weapon, terrain, allTanks);
    case 'rail':
      return simulateRailShot(shooter, weapon, terrain, allTanks);
    case 'standard':
    default:
      return simulateStandardShot(shooter, weapon, terrain, allTanks);
  }
}
