import * as THREE from 'three';

export interface TerrainLightingControls {
  updateForTerrain: (terrainWidth: number, terrainHeight: number) => void;
}

export function createLights(scene: THREE.Scene): TerrainLightingControls {
  const ambient = new THREE.AmbientLight(0x8899bb, 0.6);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(30, 40, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0x88bbff, 0x446622, 0.3);
  scene.add(hemi);

  const updateForTerrain = (terrainWidth: number, terrainHeight: number): void => {
    const worldMax = Math.max(terrainWidth, terrainHeight);
    const halfSpan = Math.max(40, worldMax * 0.7);
    sun.position.set(terrainWidth * 0.55, Math.max(40, worldMax * 0.95), terrainHeight * 0.35);
    sun.target.position.set(terrainWidth / 2, 0, terrainHeight / 2);
    sun.target.updateMatrixWorld();
    sun.shadow.camera.left = -halfSpan;
    sun.shadow.camera.right = halfSpan;
    sun.shadow.camera.top = halfSpan;
    sun.shadow.camera.bottom = -halfSpan;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = Math.max(120, worldMax * 3);
    sun.shadow.camera.updateProjectionMatrix();
  };

  updateForTerrain(64, 64);

  return { updateForTerrain };
}
