import * as THREE from 'three';
import { FireGrid, FireCellDelta } from '@shared/terrain/FireGrid';
import { FireGridSnapshot } from '@shared/types/index';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';

/** Upper bound on simultaneously-rendered flame instances. Mirrors the
 *  server-side cap so the InstancedMesh never spills. */
const MAX_INSTANCES = 600;

/** Client-side renderer for the napalm fire CA. Mirrors the server grid
 *  via deltas and draws one additive-blended flame cone per active cell,
 *  colored and sized by cell intensity with a per-instance flicker. */
export class FireRenderer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly grid: FireGrid;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private time = 0;

  constructor(scene: THREE.Scene, voxels: VoxelGrid, initial?: FireGridSnapshot) {
    this.grid = new FireGrid(voxels);
    if (initial) this.grid.loadSnapshot(initial);

    // Teardrop-ish flame: cone pointing up, base at y=0, open top.
    const geom = new THREE.ConeGeometry(0.55, 1.4, 6, 1, true);
    geom.translate(0, 0.7, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_INSTANCES);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  loadSnapshot(snap: FireGridSnapshot): void {
    this.grid.loadSnapshot(snap);
  }

  applyUpdate(cells: FireCellDelta[]): void {
    this.grid.applyDelta(cells);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  update(dt: number, voxels: VoxelGrid): void {
    this.time += dt;
    let i = 0;
    const t = this.time;

    this.grid.forEachActive((idx, ix, iz, intensity) => {
      if (i >= MAX_INSTANCES) return;
      const wx = (ix + 0.5) * this.grid.cellSize;
      const wz = (iz + 0.5) * this.grid.cellSize;
      const wy = voxels.getHeight(wx, wz);

      const phase = (idx * 1.374) % (Math.PI * 2);
      const flicker = 0.85 + 0.15 * Math.sin(t * 9 + phase);
      const intensityScale = intensity / 255;
      // Wider base at hot cells, thinner tongue at edges.
      const widthScale = 0.75 * (0.55 + 0.45 * intensityScale) * flicker;
      const heightScale = 1.0 * (0.7 + 0.3 * intensityScale) * (0.9 + 0.2 * Math.sin(t * 7 + phase * 1.3));

      this.dummy.position.set(wx, wy + 0.02, wz);
      // Gentle wobble so the flames aren't clones of each other.
      this.dummy.rotation.set(
        0.08 * Math.sin(t * 5 + phase),
        phase,
        0.06 * Math.cos(t * 4 + phase),
      );
      this.dummy.scale.set(widthScale, heightScale, widthScale);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);

      // Palette: edge (cool) → red → orange → yellow core (hot)
      const k = intensityScale;
      const r = 1.0;
      const g = 0.12 + 0.78 * k;
      const b = 0.02 + 0.18 * k;
      this.color.setRGB(r * (0.85 + 0.15 * flicker), g, b);
      this.mesh.setColorAt(i, this.color);

      i++;
    });

    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
