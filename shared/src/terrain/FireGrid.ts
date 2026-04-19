import { PlayerId } from '../types/index';
import { VoxelGrid } from './VoxelGrid';

/**
 * 2D cellular-automaton fire layer. Lives at coarser resolution than the
 * voxel grid (one fire cell per 2x2 voxel columns). Server-authoritative;
 * the client mirrors active cells for rendering but doesn't simulate.
 *
 * Model: "fuel scende, combustione sta" — ignite() stamps a patch of
 * napalm gel (fuel) + initial flames. Tick() burns each lit cell (fuel
 * drops, intensity stays high), and a lit cell tries to ignite its 4
 * neighbours with a probability biased by voxel-height gradient so the
 * fire preferentially flows toward lower terrain. Out of fuel, intensity
 * decays and the cell goes dark.
 */

const MAX_INTENSITY = 255;
const MAX_FUEL = 255;
/** Hard cap on simultaneously active cells per room. Prevents runaway
 *  spread from cooking the server: new ignitions past this cap are
 *  dropped. Tuned to ~3 large napalm patches coexisting. */
const MAX_ACTIVE_CELLS = 600;

// ── Combustion tuning (per second) ─────────────────────────────────────
const BURN_RATE_FUEL_PER_SEC = 36;
const INTENSITY_DECAY_PER_SEC = 90;
const FUELED_INTENSITY_RECOVER = 120;
/** A neighbour cell only gets a chance to ignite once the source cell is
 *  at least this hot — lets fire "settle" before it spreads. */
const IGNITE_INTENSITY_THRESHOLD = 160;
/** Seed intensity on a freshly ignited neighbour. Below MAX so the first
 *  propagation pulse doesn't immediately re-spread elsewhere. */
const NEIGHBOUR_SEED_INTENSITY = 210;
/** Initial fuel added to a fresh ignition from spread (not stamp). */
const NEIGHBOUR_SEED_FUEL = 55;
/** Base probability per spread tick that fire jumps one flat neighbour.
 *  Slope bias adds/subtracts up to ±0.45 (downhill boost / uphill block). */
const SPREAD_BASE_PROB = 0.55;
const SPREAD_SLOPE_COEFF = 0.25;

export interface FireCellDelta {
  /** Cell index (iz * sizeX + ix). */
  idx: number;
  /** 0-255 current flame intensity. 0 = dark. */
  intensity: number;
  /** 0 = unowned; else matches FireGrid.owners(). */
  ownerSlot: number;
}

export interface FireSnapshot {
  sizeX: number;
  sizeZ: number;
  cellSize: number;
  cells: FireCellDelta[];
  /** Slot → playerId map so the client can attribute visuals / sounds. */
  owners: Array<{ slot: number; playerId: PlayerId }>;
}

export class FireGrid {
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly cellSize: number;
  readonly fuel: Uint8Array;
  readonly intensity: Uint8Array;
  readonly ownerSlot: Uint8Array;

  private readonly voxels: VoxelGrid;
  private readonly active: Set<number> = new Set();
  private readonly dirty: Set<number> = new Set();
  private readonly slotToPlayer: Map<number, PlayerId> = new Map();
  private readonly playerToSlot: Map<PlayerId, number> = new Map();
  private nextSlot = 1;

  constructor(voxels: VoxelGrid) {
    this.voxels = voxels;
    // One fire cell spans two voxel cells — matches our resolution budget
    // without losing too much visual fidelity for crater-scale patches.
    const VOXEL_PER_FIRE_CELL = 2;
    this.cellSize = voxels.cellSize * VOXEL_PER_FIRE_CELL;
    this.sizeX = Math.ceil(voxels.sizeX / VOXEL_PER_FIRE_CELL);
    this.sizeZ = Math.ceil(voxels.sizeZ / VOXEL_PER_FIRE_CELL);
    const total = this.sizeX * this.sizeZ;
    this.fuel = new Uint8Array(total);
    this.intensity = new Uint8Array(total);
    this.ownerSlot = new Uint8Array(total);
  }

  clear(): void {
    this.fuel.fill(0);
    this.intensity.fill(0);
    this.ownerSlot.fill(0);
    this.active.clear();
    this.dirty.clear();
    this.slotToPlayer.clear();
    this.playerToSlot.clear();
    this.nextSlot = 1;
  }

  activeCount(): number {
    return this.active.size;
  }

  indexOf(ix: number, iz: number): number {
    return iz * this.sizeX + ix;
  }

  private cellAtWorld(wx: number, wz: number): { ix: number; iz: number; idx: number } | null {
    const ix = Math.floor(wx / this.cellSize);
    const iz = Math.floor(wz / this.cellSize);
    if (ix < 0 || ix >= this.sizeX || iz < 0 || iz >= this.sizeZ) return null;
    return { ix, iz, idx: this.indexOf(ix, iz) };
  }

  worldCenter(ix: number, iz: number): { x: number; z: number } {
    return {
      x: (ix + 0.5) * this.cellSize,
      z: (iz + 0.5) * this.cellSize,
    };
  }

  private ensureSlot(ownerId: PlayerId): number {
    const existing = this.playerToSlot.get(ownerId);
    if (existing !== undefined) return existing;
    if (this.nextSlot > 255) return 255;
    const slot = this.nextSlot++;
    this.playerToSlot.set(ownerId, slot);
    this.slotToPlayer.set(slot, ownerId);
    return slot;
  }

  ownerForSlot(slot: number): PlayerId | undefined {
    return this.slotToPlayer.get(slot);
  }

  listOwners(): Array<{ slot: number; playerId: PlayerId }> {
    return Array.from(this.slotToPlayer.entries()).map(([slot, playerId]) => ({ slot, playerId }));
  }

  /** Stamp a napalm patch at the given world position. `radius` is in world
   *  units; cells within radius gain fuel scaled by distance and are lit. */
  ignite(center: { x: number; z: number }, radius: number, fuelAmount: number, ownerId: PlayerId): void {
    if (radius <= 0 || fuelAmount <= 0) return;
    const slot = this.ensureSlot(ownerId);
    const c = this.cellAtWorld(center.x, center.z);
    if (!c) return;
    const radiusCells = radius / this.cellSize;
    const rInt = Math.ceil(radiusCells);
    for (let dz = -rInt; dz <= rInt; dz++) {
      for (let dx = -rInt; dx <= rInt; dx++) {
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > radiusCells) continue;
        const ix = c.ix + dx;
        const iz = c.iz + dz;
        if (ix < 0 || ix >= this.sizeX || iz < 0 || iz >= this.sizeZ) continue;
        // Skip cells that sit on water — napalm on water extinguishes.
        const worldCenter = this.worldCenter(ix, iz);
        const terrainH = this.voxels.getHeight(worldCenter.x, worldCenter.z);
        if (terrainH < 0.3) continue;
        const idx = this.indexOf(ix, iz);
        const falloff = 1 - d / Math.max(0.001, radiusCells);
        const addFuel = Math.round(fuelAmount * falloff);
        this.fuel[idx] = Math.min(MAX_FUEL, this.fuel[idx] + addFuel);
        if (falloff > 0.15) {
          const lit = Math.round(220 * falloff);
          this.intensity[idx] = Math.min(MAX_INTENSITY, Math.max(this.intensity[idx], lit));
        }
        this.ownerSlot[idx] = slot;
        if (this.fuel[idx] > 0 || this.intensity[idx] > 0) {
          if (!this.active.has(idx) && this.active.size >= MAX_ACTIVE_CELLS) continue;
          this.active.add(idx);
          this.dirty.add(idx);
        }
      }
    }
  }

  /** Remove any fire in the given world sphere — used when an explosion
   *  carves the ground under a burning patch (no fuel to float on). */
  extinguishArea(center: { x: number; z: number }, radius: number): void {
    if (radius <= 0) return;
    const c = this.cellAtWorld(center.x, center.z);
    if (!c) return;
    const radiusCells = radius / this.cellSize;
    const rInt = Math.ceil(radiusCells);
    for (let dz = -rInt; dz <= rInt; dz++) {
      for (let dx = -rInt; dx <= rInt; dx++) {
        if (Math.sqrt(dx * dx + dz * dz) > radiusCells) continue;
        const ix = c.ix + dx;
        const iz = c.iz + dz;
        if (ix < 0 || ix >= this.sizeX || iz < 0 || iz >= this.sizeZ) continue;
        const idx = this.indexOf(ix, iz);
        if (this.fuel[idx] === 0 && this.intensity[idx] === 0) continue;
        this.fuel[idx] = 0;
        this.intensity[idx] = 0;
        this.ownerSlot[idx] = 0;
        this.active.delete(idx);
        this.dirty.add(idx);
      }
    }
  }

  /** Advance the CA one step. Call at ~5 Hz, not the sim tick rate. */
  tick(dt: number): void {
    if (this.active.size === 0) return;
    const snapshot = Array.from(this.active);
    const ignitions: Array<{ idx: number; ownerSlot: number }> = [];

    for (const idx of snapshot) {
      const fuel = this.fuel[idx];
      const intensity = this.intensity[idx];
      if (intensity === 0 && fuel === 0) {
        this.active.delete(idx);
        this.ownerSlot[idx] = 0;
        this.dirty.add(idx);
        continue;
      }

      if (intensity > 0) {
        const consume = Math.min(
          fuel,
          Math.max(1, Math.round(BURN_RATE_FUEL_PER_SEC * dt * (intensity / MAX_INTENSITY))),
        );
        this.fuel[idx] = fuel - consume;

        if (this.fuel[idx] === 0) {
          this.intensity[idx] = Math.max(0, intensity - Math.round(INTENSITY_DECAY_PER_SEC * dt));
        } else {
          this.intensity[idx] = Math.min(MAX_INTENSITY, intensity + Math.round(FUELED_INTENSITY_RECOVER * dt));
        }
        this.dirty.add(idx);

        if (this.intensity[idx] >= IGNITE_INTENSITY_THRESHOLD && this.active.size < MAX_ACTIVE_CELLS) {
          const ix = idx % this.sizeX;
          const iz = (idx - ix) / this.sizeX;
          this.maybeSpread(ix, iz, idx, ix + 1, iz, ignitions);
          this.maybeSpread(ix, iz, idx, ix - 1, iz, ignitions);
          this.maybeSpread(ix, iz, idx, ix, iz + 1, ignitions);
          this.maybeSpread(ix, iz, idx, ix, iz - 1, ignitions);
        }
      }

      if (this.fuel[idx] === 0 && this.intensity[idx] === 0) {
        this.active.delete(idx);
        this.ownerSlot[idx] = 0;
      }
    }

    for (const ig of ignitions) {
      if (this.active.size >= MAX_ACTIVE_CELLS) break;
      if (this.intensity[ig.idx] >= NEIGHBOUR_SEED_INTENSITY) continue;
      this.intensity[ig.idx] = NEIGHBOUR_SEED_INTENSITY;
      this.fuel[ig.idx] = Math.max(this.fuel[ig.idx], NEIGHBOUR_SEED_FUEL);
      if (this.ownerSlot[ig.idx] === 0) this.ownerSlot[ig.idx] = ig.ownerSlot;
      this.active.add(ig.idx);
      this.dirty.add(ig.idx);
    }
  }

  private maybeSpread(
    srcIx: number,
    srcIz: number,
    srcIdx: number,
    nIx: number,
    nIz: number,
    out: Array<{ idx: number; ownerSlot: number }>,
  ): void {
    if (nIx < 0 || nIx >= this.sizeX || nIz < 0 || nIz >= this.sizeZ) return;
    const nIdx = this.indexOf(nIx, nIz);
    if (this.intensity[nIdx] >= NEIGHBOUR_SEED_INTENSITY) return;

    const srcW = this.worldCenter(srcIx, srcIz);
    const nW = this.worldCenter(nIx, nIz);
    const srcH = this.voxels.getHeight(srcW.x, srcW.z);
    const nH = this.voxels.getHeight(nW.x, nW.z);
    // Water extinguishes — no spread onto low-lying wet cells.
    if (nH <= 0.3) return;

    const dh = nH - srcH; // >0 = uphill, <0 = downhill
    const slopeBias = Math.max(-0.45, Math.min(0.35, -dh * SPREAD_SLOPE_COEFF));
    const p = SPREAD_BASE_PROB + slopeBias;
    if (p <= 0) return;
    if (Math.random() > p) return;

    out.push({ idx: nIdx, ownerSlot: this.ownerSlot[srcIdx] });
  }

  /** Damage-per-second and owning player at the given world point. Damage
   *  scales linearly with cell intensity, so a freshly seeded edge does
   *  less than a raging core. */
  sampleDamage(wx: number, wz: number, damageAtFullIntensity: number): { damage: number; ownerId: PlayerId | undefined } {
    const c = this.cellAtWorld(wx, wz);
    if (!c) return { damage: 0, ownerId: undefined };
    const intensity = this.intensity[c.idx];
    if (intensity === 0) return { damage: 0, ownerId: undefined };
    const slot = this.ownerSlot[c.idx];
    const ownerId = this.slotToPlayer.get(slot);
    const damage = damageAtFullIntensity * (intensity / MAX_INTENSITY);
    return { damage, ownerId };
  }

  /** Full snapshot of every currently-active cell. Use for joiner sync
   *  and for match-reset re-baselining. */
  snapshot(): FireSnapshot {
    const cells: FireCellDelta[] = [];
    for (const idx of this.active) {
      cells.push({ idx, intensity: this.intensity[idx], ownerSlot: this.ownerSlot[idx] });
    }
    return {
      sizeX: this.sizeX,
      sizeZ: this.sizeZ,
      cellSize: this.cellSize,
      cells,
      owners: this.listOwners(),
    };
  }

  /** Drain dirty cells since the last call. Use for 5 Hz delta broadcast. */
  consumeDirty(): FireCellDelta[] {
    if (this.dirty.size === 0) return [];
    const out: FireCellDelta[] = [];
    for (const idx of this.dirty) {
      out.push({ idx, intensity: this.intensity[idx], ownerSlot: this.ownerSlot[idx] });
    }
    this.dirty.clear();
    return out;
  }

  /** Apply a remote delta to a client-side mirror grid. Also maintains the
   *  active/dirty sets so the renderer can discover just-extinguished cells. */
  applyDelta(cells: FireCellDelta[]): void {
    for (const cell of cells) {
      const prevIntensity = this.intensity[cell.idx];
      this.intensity[cell.idx] = cell.intensity;
      this.ownerSlot[cell.idx] = cell.ownerSlot;
      if (cell.intensity > 0) {
        this.active.add(cell.idx);
      } else if (prevIntensity > 0) {
        this.active.delete(cell.idx);
      }
    }
  }

  /** Replace the client-side mirror with a full authoritative snapshot. */
  loadSnapshot(snap: FireSnapshot): void {
    this.fuel.fill(0);
    this.intensity.fill(0);
    this.ownerSlot.fill(0);
    this.active.clear();
    this.slotToPlayer.clear();
    this.playerToSlot.clear();
    this.nextSlot = 1;
    for (const o of snap.owners) {
      this.slotToPlayer.set(o.slot, o.playerId);
      this.playerToSlot.set(o.playerId, o.slot);
      if (o.slot >= this.nextSlot) this.nextSlot = o.slot + 1;
    }
    for (const cell of snap.cells) {
      if (cell.idx < 0 || cell.idx >= this.intensity.length) continue;
      this.intensity[cell.idx] = cell.intensity;
      this.ownerSlot[cell.idx] = cell.ownerSlot;
      if (cell.intensity > 0) this.active.add(cell.idx);
    }
  }

  forEachActive(fn: (idx: number, ix: number, iz: number, intensity: number, ownerSlot: number) => void): void {
    for (const idx of this.active) {
      const ix = idx % this.sizeX;
      const iz = (idx - ix) / this.sizeX;
      fn(idx, ix, iz, this.intensity[idx], this.ownerSlot[idx]);
    }
  }
}
