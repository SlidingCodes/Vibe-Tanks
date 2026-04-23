import * as THREE from 'three';

import countries from './countries.json';

export const FLAGS = Object.entries(countries).map(([id, name]) => ({
  id: id.toLowerCase(),
  name: name as string,
})).sort((a, b) => a.name.localeCompare(b.name));

const flagTextureCache: Map<string, THREE.Texture> = new Map();

export function getFlagTexture(flagId: string): THREE.Texture {
  if (flagTextureCache.has(flagId)) return flagTextureCache.get(flagId)!;

  // Use FlagCDN for all countries. Quality 'w160' is enough for a small flag.
  // We use a TextureLoader to load the external image.
  const loader = new THREE.TextureLoader();
  const url = `https://flagcdn.com/w160/${flagId.toLowerCase()}.png`;
  const tex = loader.load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  
  flagTextureCache.set(flagId, tex);
  return tex;
}

export function createFlagMesh(flagId: string): THREE.Group {
  const group = new THREE.Group();

  // Flag pole
  const poleGeo = new THREE.CylinderGeometry(0.015, 0.015, 1.2, 8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.2 });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = 0.6;
  pole.castShadow = true;
  group.add(pole);

  // Flag cloth
  // We use a PlaneGeometry but we want it to be double sided.
  const flagGeo = new THREE.PlaneGeometry(0.6, 0.4);
  flagGeo.translate(0.3, 0, 0); // align left edge to pole
  const flagMat = new THREE.MeshStandardMaterial({
    map: getFlagTexture(flagId),
    side: THREE.DoubleSide,
    roughness: 0.8,
    metalness: 0.1,
  });
  const flag = new THREE.Mesh(flagGeo, flagMat);
  flag.position.set(0, 1.0, 0);
  flag.castShadow = true;
  group.add(flag);

  // Add a little wobble to the flag? 
  // We can do it in the animation loop if we return the flag mesh.
  flag.userData.wobbleSpeed = 2 + Math.random() * 2;
  flag.userData.wobblePhase = Math.random() * Math.PI * 2;

  return group;
}
