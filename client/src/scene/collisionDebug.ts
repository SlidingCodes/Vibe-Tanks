import * as THREE from 'three';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { TankMesh } from '../entities/tank';

const HULL_HALF = { x: 0.85, y: 0.35, z: 1.0 };
const TRACK_CLEARANCE = 0.15;
const TRACK_SUSPENSION_REST = HULL_HALF.y + TRACK_CLEARANCE;
const TRACK_SUSPENSION_TRAVEL = 0.58;
const ROOT_Y_FROM_BODY_CENTER = TRACK_SUSPENSION_REST;
const TRACK_LANE_X = HULL_HALF.x * 0.9;
const TRACK_PROBE_ZS = [0.95, 0.57, 0.19, -0.19, -0.57, -0.95].map((t) => t * HULL_HALF.z);
const TANK_BOX_SIZE = new THREE.Vector3(HULL_HALF.x * 2, HULL_HALF.y * 2, HULL_HALF.z * 2);
const LOCAL_TERRAIN_RADIUS_XZ = 5;
const LOCAL_TERRAIN_RADIUS_Y = 4;
const MAX_DEBUG_VOXELS = 1600;
const PROBE_RAY_LENGTH = TRACK_SUSPENSION_REST + TRACK_SUSPENSION_TRAVEL;
const PROBE_NORMAL_LENGTH = 0.55;
const PROBE_DOT_RADIUS = 0.08;

interface ProbeSpec {
  x: number;
  z: number;
}

interface ProbeVisual {
  ray: THREE.Line;
  rayMaterial: THREE.LineBasicMaterial;
  normal: THREE.Line;
  normalMaterial: THREE.LineBasicMaterial;
  dot: THREE.Mesh;
  dotMaterial: THREE.MeshBasicMaterial;
}

const TRACK_PROBES: ProbeSpec[] = TRACK_PROBE_ZS.flatMap((z) => ([
  { x: TRACK_LANE_X, z },
  { x: -TRACK_LANE_X, z },
]));
const BELLY_PROBES: ProbeSpec[] = [
  { x: 0, z: HULL_HALF.z * 0.45 },
  { x: 0, z: -HULL_HALF.z * 0.45 },
];
const ALL_SUPPORT_PROBES: ProbeSpec[] = [...TRACK_PROBES, ...BELLY_PROBES];

export class CollisionDebugOverlay {
  private readonly tankBoxes = new Map<string, THREE.LineSegments>();
  private readonly tankBoxGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(TANK_BOX_SIZE.x, TANK_BOX_SIZE.y, TANK_BOX_SIZE.z));
  private readonly localTankMaterial = new THREE.LineBasicMaterial({ color: 0x4fd1ff, depthTest: false, transparent: true, opacity: 0.95 });
  private readonly remoteTankMaterial = new THREE.LineBasicMaterial({ color: 0xff6b6b, depthTest: false, transparent: true, opacity: 0.8 });
  private readonly terrainMaterial = new THREE.MeshBasicMaterial({ color: 0x58ff8a, wireframe: true, transparent: true, opacity: 0.35, depthTest: false });
  private readonly terrainMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.terrainMaterial, MAX_DEBUG_VOXELS);
  private readonly terrainRoot = new THREE.Group();
  private readonly probeRoot = new THREE.Group();
  private readonly probeVisuals: ProbeVisual[] = ALL_SUPPORT_PROBES.map(() => this.createProbeVisual());
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchAnchor = new THREE.Vector3();
  private readonly scratchOffset = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private enabled = false;

  constructor(private readonly scene: THREE.Scene) {
    this.terrainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.terrainMesh.count = 0;
    this.terrainMesh.frustumCulled = false;
    this.terrainMesh.renderOrder = 998;
    this.terrainRoot.visible = false;
    this.terrainRoot.renderOrder = 998;
    this.terrainRoot.add(this.terrainMesh);
    this.scene.add(this.terrainRoot);

    this.probeRoot.visible = false;
    this.probeRoot.renderOrder = 1000;
    for (const visual of this.probeVisuals) {
      this.probeRoot.add(visual.ray);
      this.probeRoot.add(visual.normal);
      this.probeRoot.add(visual.dot);
    }
    this.scene.add(this.probeRoot);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.terrainRoot.visible = false;
    this.probeRoot.visible = enabled;
    if (!enabled) {
      for (const box of this.tankBoxes.values()) box.visible = false;
      this.hideProbeVisuals();
      this.terrainMesh.count = 0;
      this.terrainMesh.instanceMatrix.needsUpdate = true;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  update(myId: string, tanks: Map<string, TankMesh>, voxelGrid: VoxelGrid | null): void {
    this.syncTankBoxes(myId, tanks);
    this.syncProbes(myId, tanks, voxelGrid);
  }

  private createProbeVisual(): ProbeVisual {
    const rayGeometry = new THREE.BufferGeometry();
    rayGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const rayMaterial = new THREE.LineBasicMaterial({ color: 0xffaa33, depthTest: false, transparent: true, opacity: 0.95 });
    const ray = new THREE.Line(rayGeometry, rayMaterial);
    ray.frustumCulled = false;
    ray.renderOrder = 1000;

    const normalGeometry = new THREE.BufferGeometry();
    normalGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const normalMaterial = new THREE.LineBasicMaterial({ color: 0x66ff66, depthTest: false, transparent: true, opacity: 0.95 });
    const normal = new THREE.Line(normalGeometry, normalMaterial);
    normal.frustumCulled = false;
    normal.renderOrder = 1001;

    const dotMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 });
    const dot = new THREE.Mesh(new THREE.SphereGeometry(PROBE_DOT_RADIUS, 8, 8), dotMaterial);
    dot.frustumCulled = false;
    dot.renderOrder = 1002;

    ray.visible = false;
    normal.visible = false;
    dot.visible = false;

    return { ray, rayMaterial, normal, normalMaterial, dot, dotMaterial };
  }

  private syncTankBoxes(myId: string, tanks: Map<string, TankMesh>): void {
    const seen = new Set<string>();

    for (const [playerId, tank] of tanks) {
      seen.add(playerId);
      let box = this.tankBoxes.get(playerId);
      if (!box) {
        box = new THREE.LineSegments(this.tankBoxGeometry, playerId === myId ? this.localTankMaterial : this.remoteTankMaterial);
        box.position.y = ROOT_Y_FROM_BODY_CENTER;
        box.renderOrder = 999;
        tank.group.add(box);
        this.tankBoxes.set(playerId, box);
      }
      box.material = playerId === myId ? this.localTankMaterial : this.remoteTankMaterial;
      box.visible = this.enabled && tank.group.visible;
    }

    for (const [playerId, box] of this.tankBoxes) {
      if (seen.has(playerId)) continue;
      box.parent?.remove(box);
      this.tankBoxes.delete(playerId);
    }
  }

  private syncTerrain(myId: string, tanks: Map<string, TankMesh>, voxelGrid: VoxelGrid | null): void {
    if (!this.enabled || !voxelGrid) {
      this.terrainMesh.count = 0;
      this.terrainMesh.instanceMatrix.needsUpdate = true;
      return;
    }

    const myTank = tanks.get(myId);
    if (!myTank || !myTank.group.visible) {
      this.terrainMesh.count = 0;
      this.terrainMesh.instanceMatrix.needsUpdate = true;
      return;
    }

    const cs = voxelGrid.cellSize;
    const centerIx = Math.round(myTank.group.position.x / cs - 0.5);
    const centerIy = Math.round((myTank.group.position.y + ROOT_Y_FROM_BODY_CENTER) / cs - 0.5 - voxelGrid.minYCells);
    const centerIz = Math.round(myTank.group.position.z / cs - 0.5);
    const ixMin = Math.max(0, centerIx - LOCAL_TERRAIN_RADIUS_XZ);
    const ixMax = Math.min(voxelGrid.sizeX - 1, centerIx + LOCAL_TERRAIN_RADIUS_XZ);
    const iyMin = Math.max(0, centerIy - LOCAL_TERRAIN_RADIUS_Y);
    const iyMax = Math.min(voxelGrid.sizeY - 1, centerIy + LOCAL_TERRAIN_RADIUS_Y);
    const izMin = Math.max(0, centerIz - LOCAL_TERRAIN_RADIUS_XZ);
    const izMax = Math.min(voxelGrid.sizeZ - 1, centerIz + LOCAL_TERRAIN_RADIUS_XZ);

    let count = 0;
    this.scratchScale.set(cs, cs, cs);
    for (let iy = iyMin; iy <= iyMax; iy++) {
      for (let iz = izMin; iz <= izMax; iz++) {
        for (let ix = ixMin; ix <= ixMax; ix++) {
          if (!voxelGrid.isSolid(ix, iy, iz)) continue;
          this.scratchPosition.set(
            (ix + 0.5) * cs,
            (voxelGrid.minYCells + iy + 0.5) * cs,
            (iz + 0.5) * cs,
          );
          this.scratchMatrix.compose(this.scratchPosition, IDENTITY_QUATERNION, this.scratchScale);
          this.terrainMesh.setMatrixAt(count, this.scratchMatrix);
          count++;
          if (count >= MAX_DEBUG_VOXELS) {
            this.terrainMesh.count = count;
            this.terrainMesh.instanceMatrix.needsUpdate = true;
            return;
          }
        }
      }
    }

    this.terrainMesh.count = count;
    this.terrainMesh.instanceMatrix.needsUpdate = true;
  }

  private syncProbes(myId: string, tanks: Map<string, TankMesh>, voxelGrid: VoxelGrid | null): void {
    if (!this.enabled || !voxelGrid) {
      this.hideProbeVisuals();
      return;
    }

    const myTank = tanks.get(myId);
    if (!myTank || !myTank.group.visible) {
      this.hideProbeVisuals();
      return;
    }

    const bodyCenter = this.scratchAnchor.set(
      myTank.group.position.x,
      myTank.group.position.y + ROOT_Y_FROM_BODY_CENTER,
      myTank.group.position.z,
    );
    myTank.group.getWorldQuaternion(this.scratchQuat);

    for (let i = 0; i < this.probeVisuals.length; i++) {
      const probe = ALL_SUPPORT_PROBES[i];
      const visual = this.probeVisuals[i];
      this.scratchOffset.set(probe.x, 0, probe.z).applyQuaternion(this.scratchQuat);
      const anchorX = bodyCenter.x + this.scratchOffset.x;
      const anchorY = bodyCenter.y + this.scratchOffset.y;
      const anchorZ = bodyCenter.z + this.scratchOffset.z;

      const surfaceY = voxelGrid.getHeightInterpolated(anchorX, anchorZ);
      const grounded = surfaceY <= anchorY && anchorY - surfaceY <= PROBE_RAY_LENGTH;
      const hitY = grounded ? surfaceY : anchorY - PROBE_RAY_LENGTH;

      this.setLine(visual.ray, anchorX, anchorY, anchorZ, anchorX, hitY, anchorZ);
      visual.ray.visible = true;
      visual.rayMaterial.color.setHex(grounded ? 0xffd166 : 0xff5c5c);

      if (grounded) {
        const normal = estimateVoxelNormal(voxelGrid, anchorX, anchorZ);
        this.setLine(
          visual.normal,
          anchorX, hitY, anchorZ,
          anchorX + normal.x * PROBE_NORMAL_LENGTH,
          hitY + normal.y * PROBE_NORMAL_LENGTH,
          anchorZ + normal.z * PROBE_NORMAL_LENGTH,
        );
        visual.normal.visible = true;
        visual.dot.position.set(anchorX, hitY, anchorZ);
        visual.dot.visible = true;
        visual.dotMaterial.color.setHex(0xffffff);
      } else {
        visual.normal.visible = false;
        visual.dot.visible = false;
      }
    }
  }

  private hideProbeVisuals(): void {
    for (const visual of this.probeVisuals) {
      visual.ray.visible = false;
      visual.normal.visible = false;
      visual.dot.visible = false;
    }
  }

  private setLine(line: THREE.Line, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, ax, ay, az);
    positions.setXYZ(1, bx, by, bz);
    positions.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }
}

function estimateVoxelNormal(grid: VoxelGrid, x: number, z: number): THREE.Vector3 {
  const step = grid.cellSize;
  const hW = grid.getHeightInterpolated(x - step, z);
  const hE = grid.getHeightInterpolated(x + step, z);
  const hS = grid.getHeightInterpolated(x, z - step);
  const hN = grid.getHeightInterpolated(x, z + step);
  const nx = hW - hE;
  const ny = 2 * step;
  const nz = hS - hN;
  return new THREE.Vector3(nx, ny, nz).normalize();
}

const IDENTITY_QUATERNION = new THREE.Quaternion();
