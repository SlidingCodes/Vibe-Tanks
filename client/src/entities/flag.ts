import * as THREE from 'three';

export const FLAGS = [
  { id: 'italy', name: 'Italy' },
  { id: 'spain', name: 'Spain' },
  { id: 'france', name: 'France' },
  { id: 'germany', name: 'Germany' },
  { id: 'usa', name: 'USA' },
  { id: 'uk', name: 'UK' },
  { id: 'japan', name: 'Japan' },
];

const flagTextureCache: Map<string, THREE.CanvasTexture> = new Map();

export function getFlagTexture(flagId: string): THREE.CanvasTexture {
  if (flagTextureCache.has(flagId)) return flagTextureCache.get(flagId)!;

  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 85;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  // Default white background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  switch (flagId) {
    case 'italy':
      ctx.fillStyle = '#008d46';
      ctx.fillRect(0, 0, 42, 85);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(42, 0, 44, 85);
      ctx.fillStyle = '#d2232c';
      ctx.fillRect(86, 0, 42, 85);
      break;
    case 'spain':
      ctx.fillStyle = '#aa151b';
      ctx.fillRect(0, 0, 128, 21);
      ctx.fillStyle = '#f1bf00';
      ctx.fillRect(0, 21, 128, 43);
      ctx.fillStyle = '#aa151b';
      ctx.fillRect(0, 64, 128, 21);
      break;
    case 'france':
      ctx.fillStyle = '#002395';
      ctx.fillRect(0, 0, 42, 85);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(42, 0, 44, 85);
      ctx.fillStyle = '#ed2939';
      ctx.fillRect(86, 0, 42, 85);
      break;
    case 'germany':
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, 128, 28);
      ctx.fillStyle = '#dd0000';
      ctx.fillRect(0, 28, 128, 29);
      ctx.fillStyle = '#ffce00';
      ctx.fillRect(0, 57, 128, 28);
      break;
    case 'usa':
      // Red/White stripes
      for (let i = 0; i < 13; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#b22234' : '#ffffff';
        ctx.fillRect(0, (i * 85) / 13, 128, 85 / 13 + 1);
      }
      // Blue canton
      ctx.fillStyle = '#3c3b6e';
      ctx.fillRect(0, 0, 51, 46);
      // Stars (simple dots)
      ctx.fillStyle = '#ffffff';
      for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 11; x++) {
          if ((x + y) % 2 === 0) {
            ctx.fillRect(4 + x * 4, 4 + y * 4.5, 2, 2);
          }
        }
      }
      break;
    case 'uk':
      ctx.fillStyle = '#012169';
      ctx.fillRect(0, 0, 128, 85);
      // White diagonals
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 12;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(128, 85); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(128, 0); ctx.lineTo(0, 85); ctx.stroke();
      // Red diagonals
      ctx.strokeStyle = '#c8102e';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(128, 85); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(128, 0); ctx.lineTo(0, 85); ctx.stroke();
      // White cross
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(52, 0, 24, 85);
      ctx.fillRect(0, 32, 128, 21);
      // Red cross
      ctx.fillStyle = '#c8102e';
      ctx.fillRect(58, 0, 12, 85);
      ctx.fillRect(0, 38, 128, 9);
      break;
    case 'japan':
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 128, 85);
      ctx.fillStyle = '#bc002d';
      ctx.beginPath();
      ctx.arc(64, 42.5, 25, 0, Math.PI * 2);
      ctx.fill();
      break;
    default:
      // Checkered placeholder
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(0, 0, 64, 42);
      ctx.fillRect(64, 42, 64, 43);
      ctx.fillStyle = '#000000';
      ctx.fillRect(64, 0, 64, 42);
      ctx.fillRect(0, 42, 64, 43);
      break;
  }

  const tex = new THREE.CanvasTexture(canvas);
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
