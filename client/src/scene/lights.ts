import * as THREE from 'three/webgpu';

export function createLights(scene: THREE.Scene): void {
  // Ambient
  const ambient = new THREE.AmbientLight(0x8899bb, 0.6);
  scene.add(ambient);

  // Directional (sun)
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(30, 40, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  scene.add(sun);

  // Hemisphere for sky color
  const hemi = new THREE.HemisphereLight(0x88bbff, 0x446622, 0.3);
  scene.add(hemi);
}
