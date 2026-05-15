# Credits

The source code of Vibe Tanks is released under the MIT license
(see [LICENSE](./LICENSE)). The bundled assets below are **not** covered
by that license — each one keeps the terms of its original source.

## Audio

### Background music — `client/public/music/1.mp3` … `6.mp3`

These tracks are **AI-generated** using:

- **Google Gemini** (most tracks)
- **Suno** (https://suno.com — a small number of tracks)

The tracks are bundled here for convenience so the project plays out of the
box. They are **not** redistributed under MIT and are subject to the terms of
service of the respective AI providers. If you fork this project for your own
deployment or commercial use, **verify the relevant ToS** (especially Suno's
ownership model, which depends on the plan that generated the track) and,
when in doubt, replace the files with your own audio — `audio/music.ts`
expects bare-integer filenames `1.mp3` … `6.mp3` in `client/public/music/`.

### Sound effects — `client/src/audio/sounds.ts`

All gameplay SFX (shoot, explosion, hit-marker, death wah + choir, respawn
jingle, weapon switch, announcer beeps, etc.) are **synthesized at runtime**
via the Web Audio API. No sample files. Original work, MIT.

## Visual assets

### Particles — `client/public/particles/*.png`

Sourced from **Kenney Particle Pack** (https://kenney.nl/assets/particle-pack),
licensed **CC0 1.0** (public domain). Attribution appreciated, not required.

Files used: `flame_06.png`, `fire_01.png`, `fire_02.png` (renamed to
`flame_shape.png`, `fire_noise.png`, `fire_burst.png`).

### Tank hull textures — `client/public/textures/tank/*.jpg`

Sourced from **Poly Haven** (https://polyhaven.com/a/rusty_metal_02),
licensed **CC0 1.0** (public domain). 1K JPEGs. Attribution appreciated,
not required.

### Terrain textures — `client/public/textures/terrain/*.jpg`

Generated procedurally in Substance Designer by the repository author.
Released under the same MIT license as the source code.

### Skybox — `client/public/sky/sky_36_2k.jpg`

Equirectangular 2K JPEG. Provenance to be confirmed before redistribution;
if you fork this project for production use, consider replacing it with a
known-CC0 HDRI (e.g. from Poly Haven) for legal safety.

### Weapon icons — `client/public/weapons/*.svg`

Hand-drawn for this project. Released under the same MIT license as the
source code.

## Libraries

Runtime dependencies (Three.js, Socket.IO, Rapier, Vite, TypeScript, Express,
Zod, geoip-lite) keep their own upstream licenses — see each package's
`LICENSE` file under `node_modules/`.
