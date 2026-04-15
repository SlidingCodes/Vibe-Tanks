# Tank feel — review pendente post-V4

Promemoria raccolto prima di iniziare V4 (Rapier). Da rivedere una volta che
la fisica Rapier per il terreno voxel è in piedi, perché alcune di queste
osservazioni potrebbero essere già risolte dal passaggio a collider 3D reali.

## Sintomi osservati (branch `feat/voxel-terrain`, kinematic su voxel)

1. **Si blocca sugli spigoli.** Al bordo di un cratere o al passaggio tra
   due colonne voxel con top quantizzato diverso (e.g. 5 → 6), il carro
   rallenta o si impianta.
2. **Gira da solo.** Movimento laterale parassita che da certe angolazioni
   sembra rotazione. Si accentua su crateri e pendii.

## Diagnosi

`stepTankPhysics` (shared/src/physics.ts) campiona `sample(x, z)` =
`voxels.getHeightInterpolated(x, z)` e ricava lo slope per finite-difference
su piccoli passi (`BASE_GRAD_EPS`, `BASE_TILT_SAMPLE`). Il voxel grid è
intrinsecamente discreto: due colonne adiacenti possono differire di 1+
unit quando ci sono crateri, e la bilineare produce una rampa su 1 cella.
La finite-difference puntuale vede slope ≥ 1:1 → scatta
`SLIDE_GRADE_THRESHOLD` (slope slide) o `CLIFF_GRADE` (tracks perdono
trazione, free-fall). Succede per 1-2 frame mentre il carro attraversa il
confine → jitter laterale + stop inatteso.

L'effetto era già presente su heightmap ma molto più lieve, perché lì la
superficie era continua: il gradient non aveva discontinuità.

## Opzioni se V4 non basta

Dopo V4 la fisica è un TriMesh Rapier, quindi:

- Gli spigoli di cella **non esistono più**: il collider è il mesh liscio
  generato da surface-nets. Un capsule/vehicle Rapier scivola sopra senza
  "sentire" il voxel quantization.
- Rapier ha le sue quirks (vehicle controller che pivota da solo se friction
  asimmetrica, sospensioni che oscillano, ecc.). Sono problemi diversi.

Se post-V4 restano issue del feel, pacchetto di fix da considerare in
ordine crescente di invasività:

### A — Sampling multi-punto sotto il carro (sphere-like contact)
Invece di un `sample(x, z)`, campionare 5-9 punti in una disc di raggio
~1.2 m e usare il max Y. Il carro appoggia sempre sul punto più alto
della propria footprint; scalini e piccoli crateri scompaiono come
ostacoli. Puramente kinematic, ~30 righe. Utile anche come **fallback**
se Rapier dovesse creare problemi al client in predizione.

### B — Soglie slope rialzate in voxel mode
`SLIDE_GRADE_THRESHOLD`, `CLIFF_GRADE`, `UPHILL_TRACTION_K` calibrati
~2× più tolleranti. 4 costanti. Risolve il jitter al costo di un feel
leggermente più "arcade".

### C — Capsule character controller invece di vehicle
Rapier `KinematicCharacterController` ha un autostep built-in che supera
spigoli fino a N cells di altezza. Meno realistico di un vehicle con
ruote, ma molto più stabile. È la variante che i giochi voxel usano
tipicamente.

### D — Custom sphere collider
Sostituire il vehicle con un rigid-body sferico + torque arcade. Scivola
su tutto, pochissimi stuck, comportamento molto prevedibile. Perde
inerzia realistica del tank.

## Decisione rimandata

Nessuna azione finché V4c non è stabile. A quel punto valutare se il
Rapier-vehicle risolve da solo o se serve virare su una delle quattro
opzioni sopra.

## Stato alla chiusura di V4b (da riprendere)

Il tank è ora un body kinematic-position-based con sfera r=0.80, guidato da
Rapier `KinematicCharacterController`:
- Slope climb limit 89° (il rim dei crateri è ~79° e con 45° era trattato
  come muro, bloccando l'ingresso).
- Grounded check via raycast dal centro del body verso il basso per
  `HULL_RADIUS + 10cm`, escludendo il collider del tank.
- Nessun autostep, nessun snap-to-ground: tank cade liberamente sopra ai
  crateri.
- Gravità manuale integrata per frame, azzerata solo quando il raycast
  conferma terreno sotto.

**Bug irrisolto**: il tank non riesce comunque a entrare nei crateri
profondi. Si ferma al rim o ci scivola sopra. Il raycast e lo slope limit
sono stati sistemati nei commit 0d06837 / f9d854a ma visivamente non basta.
Da investigare:
- Forse KCC applica ancora una "penalty" sulle superfici steep che non è
  lo slope climb limit.
- Forse il TriMesh alla zona del rim ha triangoli con normali sbagliate
  dalla nostra shared/surfaceNetsMesher — da verificare con un wireframe
  del collider.
- Forse serve abbandonare KCC e fare contatto+gravità manuali con
  raycasting multi-punto sotto la footprint del tank.

Per ora il tank gira sul terreno aperto correttamente. Tunnel orizzontali
e crateri profondi sono **rimandati**; V5 procede con scorch / polish /
perf e ci torniamo dopo.
