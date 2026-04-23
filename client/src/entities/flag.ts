import * as THREE from 'three';

import countries from './countries.json';

export const FLAGS = Object.entries(countries).map(([id, name]) => ({
  id: id.toLowerCase(),
  name: name as string,
})).sort((a, b) => a.name.localeCompare(b.name));

const flagTextureCache: Map<string, THREE.Texture> = new Map();

const ALIASES: Record<string, string> = {
  'italy': 'it',
  'spain': 'es',
  'france': 'fr',
  'germany': 'de',
  'usa': 'us',
  'uk': 'gb',
  'japan': 'jp'
};

export function getFlagTexture(flagId: string): THREE.Texture {
  let id = flagId.toLowerCase();
  if (ALIASES[id]) id = ALIASES[id];
  
  if (flagTextureCache.has(id)) return flagTextureCache.get(id)!;

  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const url = `https://flagcdn.com/w160/${id}.png`;
  
  const tex = loader.load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  
  flagTextureCache.set(id, tex);
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
  const flagTex = getFlagTexture(flagId);
  const flagMat = new THREE.MeshStandardMaterial({
    map: flagTex,
    emissiveMap: flagTex,
    emissive: 0xffffff,
    emissiveIntensity: 0.2,
    side: THREE.DoubleSide,
    roughness: 1.0,
    metalness: 0.0,
  });
  const flag = new THREE.Mesh(flagGeo, flagMat);
  flag.position.set(0, 1.0, 0);
  flag.rotation.y = Math.PI; // Rotate 180deg so it points outward (to -X) while keeping UVs correct at the pole
  flag.castShadow = true;
  group.add(flag);

  // Add a little wobble to the flag? 
  // We can do it in the animation loop if we return the flag mesh.
  flag.userData.wobbleSpeed = 2 + Math.random() * 2;
  flag.userData.wobblePhase = Math.random() * Math.PI * 2;

  return group;
}
