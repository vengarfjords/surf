# ocean — a neritic drift

A browser-based dolphin simulator set in an explorable **3 × 3 km neritic shelf**. The point is not a game loop; it is the feeling of a highly agile animal moving through sunlit, silty water.

![a neritic drift](docs/preview.jpg)

![a breach through the surface](docs/breach.jpg)

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints, click **enter the water**, and use:

| input | action |
| --- | --- |
| `W` | glide / swim forward |
| `S` | brake, then slowly reverse |
| `A` / `D` | bank and carve left / right |
| mouse | free-look and steer with the snout (pointer lock; drag fallback) |
| `Shift` | surge; point the snout up at speed to breach and soar |
| `Space` / `C` | rise / dive |
| arrow up / down | pitch (keyboard fallback) |
| `T` | open the live swim-feel tuning panel |
| `M` | mute / unmute |
| `H` | hide the HUD |

Press `Esc` to release the pointer. Clicking the canvas re-acquires it.

## Tuning

Every feeling number lives in [`src/config.js`](src/config.js) and is exposed live as `window.OCEAN.tuning`. Press `T` for sliders bound to speed, acceleration, turn response, mouse look, pitch response, pitch self-level, bank intensity, lateral drift, vertical thrust, air control, air lift, air gravity, breach kick, tail beat, acceleration beat, tail stroke, tail heave, acceleration heave, wave travel, wave start, fluke pitch, segment follow, neck/spine bend limits, swell height, chop, sand disturbance, sand cut depth, contact cut depth, glide scoop, water scatter, god rays, caustic light, surface haze, sea mist, camera distance, shoulder and look response. Pitch self-level is off by default, so a held look holds its attitude.

The full debug surface is available as `window.OCEAN` (ocean, seabed, dolphin, camera rig, habitats, particles, renderer, tuner and a `teleport(x,y,z,yaw)` helper).

## What is simulated

- **Dolphin movement** — heading/pitch/roll flight model with angular inertia, anisotropic body-frame drag, slip/drift through high-speed turns, automatic bank into the turn, buoyancy and surface wave lift. Thrust is quick enough for a standing-start burst, high-speed surface exits get a tail kick, and airborne motion uses low drag, reduced gravity, speed-dependent lift and snout-led air steering so a fast breach can carry into a long free glide.
- **Procedural skeletal spine** — the model is a GPU-skinned 9-bone chain. The snout is anchored to the mouse target and the camera orbits from that same look frame, so the view responds immediately while each following segment keeps its own direction, damps toward the segment ahead and is clamped to an anatomical joint cone (`headBendLimit` at the neck, `bodyBendLimit` down the spine). Fixed segment lengths and a torso-to-fluke swimming wave give the body a semi-rigid, fluid trail. The wave's frequency and amplitude follow actual swim speed and acceleration, so a burst of acceleration produces a stronger, faster stroke; the fluke adds a lagging pitch that tracks the same effort.
- **Snout-led camera** — the chase view orbits from the same yaw/pitch target that drives the snout, with light smoothing rather than physics-body lag. The body, velocity and spine still trail behind, but the view, compass and aim lead with the animal's head.
- **Waves** — layered deterministic Gerstner spectrum driven by wind/choppiness. The same formula is used in the vertex shader and in `OCEAN.ocean.getWaterHeight()` / `getWaterSample()` for physics. Surface shading uses a seam-free procedural water normal/ripple map at two scales — deliberately not a lattice of sine waves, which read as a grid from the air — plus wind-aligned foam lacing and whitecaps, Schlick Fresnel sky reflection with a moving cloud veil, crest translucency and a sharp sun-glitter path. Seen from below, the underside splits into a critical-angle Snell window and smooth total internal reflection, with bright ripple bands and a turquoise window rim rather than noise-shaped dark blobs.
- **Dynamic surface heightfield** — a GPU wave-equation pass in ping-pong render targets. Contact impulses from the dolphin's nose, body and fluke both displace the surface and create foam/wake. The same simulation is sampled by the ocean vertex shader and produces splash particles and whitewater.
- **Reference coral reef** — the opening patch reef uses photogrammetry specimens from the NMNH coral collection: *Corallium* sp., *Diploria labyrinthiformis*, *Distichopora borealis* and *Stylaster sanguineus*. They sit on the sand with soft contact shadows, caustics and a hand-cleared seagrass halo, surrounded by procedural far-field reef.
- **Procedural branching coral** — the non-scan reef coral is now a smooth, tapered, continuously curved branching colony rather than low-radial cylinders. It uses knobby cross-sections, random asymmetric growth, side branchlets, rounded holdfasts and tips. Physical-scale tube UVs map a 512² generated corallite surface with large pale cups, dark centres, radial septa, algae films, a matching normal map, bump detail and an emissive polyp-rim mask, so the texture survives the low-fi grade instead of dissolving into a smooth silhouette.
- **Granular seabed** — a 384² CPU heightfield over a 120 m moving patch, displaced through a one-channel floating-point texture into a matching 384-segment near mesh (~31 cm cells). The deformable layer works over a **–3.6 m to +2.0 m** range, with a 1.4 m contact cut cap and a 0.06 m glide scoop. The 30 Hz physical surface is chased every rendered frame by a smoothed visual height field, so contact and slumping read as continuous motion rather than stepped updates. Stamps are volume-conserving; direct nose/belly contact cuts directional trenches, high-speed impacts throw craters and ejecta rims, and fluke contacts use a wider tail-slap crater. Low glides apply two pressure troughs ahead of the body plus a broad wake wash without touching the bed. An eight-neighbour, mass-conserving talus flow relaxes slopes back toward a 30° angle of repose; no global settling is applied. Direct and indirect events feed soft, long-lived silt particles that drift with the local current. Wind ripples, shell hash, pebbles, organic detritus and coral rubble break up the flat sand. When the 120 m near window recenters, its 148k static height/colour/normal vertices are rebuilt in a worker and uploaded on the next frame, so the frequent 34 m camera crossing does not hitch the main thread.
- **Fine-grained substrate and vegetation** — near rocks use UV-mapped procedural normal detail, pitting and encrusting variation; the opening reef also has smaller high-detail hard-substrate stones. Eelgrass tufts use five curved, twisted blades with five segments, a vein/epiphyte/bump texture, mottled blade shading and brown dieback.
- **Detailed marine life** — schooling fish have shaped bodies, fins, eyes, vertex colouring, scale/gill shading and a shader-driven tail beat. Jellyfish use a high-resolution bell with procedural radial canals and gonads, sixteen animated tentacles and four translucent oral-arm ribbons. Scallops are ribbed, UV-textured and bump-mapped, with visible empty shells scattered through the meadow. The burrowed crab has a mottled carapace, jointed two-segment legs, pincer claws and eyestalks.
- **Hidden objects** — scallop shells and a crab are buried at measured depths in the sand. They appear only when the actual heightfield is lowered by plowing or a tail slap.
- **Depth-aware volumetric light** — the composer keeps a scene depth texture on each read/write buffer and runs a custom pass immediately after the scene. A screen-space march resolves soft sun shafts against real geometry silhouettes, depth-reconstructed normals receive moving caustic filaments, and a depth-scaled scatter/absorption term deepens the water with distance. Above the surface, a separate branch adds warm horizon haze, sea mist and sun halation. The pass runs before bloom and the film grade, so the shafts bloom and grain the same way the scene does.
- **Performance budget** — the reef and seagrass are split into spatial chunks, frustum-culled and faded out at 120 m / 100 m (both beyond readable fog), the composer is capped at roughly 0.6 megapixels, bloom runs at quarter resolution, the shaft march shortens to ten steps and skips when the sun is behind the camera, branch and grass geometry use near-field LODs, and the audio graph is built during the loading card. The recenter worker removes the previous 200-300 ms sand stalls. With the surface shader active, the heavy above-water and underside views measure roughly **6–8 ms average frame time** on the M4 test machine, leaving clear headroom under the 16.7 ms budget for a stable 60 FPS.
- **Film look** — a custom 2000s camcorder pass with lens softness, chromatic aberration, highlight halation, grain, chroma smear, quantised channels, macroblock noise, vignette, scanline smear, slow iris hunting, white-balance drift and optional water droplets. The shelf water is vivid blue in open water and green-teal in the shallows, with suspended particulate, moving surface sheen and uneven sunlight.

## Project layout

```text
src/
  config.js      tuning, palette, control panel map
  main.js        boot, scene assembly, render loop
  dolphin.js     controller, GLB rig, constrained spine, shaders
  ocean.js       Gerstner water, sky, GPU wake heightfield
  sand.js        granular seabed simulation, recenter orchestration and sand shaders
  sand-worker.js off-thread static seabed height/colour/normal rebake
  habitat.js     reference corals, patch reefs, seagrass, fish, jellyfish, shells
  particles.js   splash, bubbles, silt and marine snow
  camera.js      snout-led handheld chase camera
  input.js       keyboard / pointer-lock / drag / touch
  hud.js         telemetry, compass, tuner, toasts
  post.js        composer, depth-aware volumetric light and camera-feed film shader
  audio.js       generative WebAudio ambience
```

The dolphin model is `public/dolphin.glb` and is normalized/rolled upright at load. Its geometry is baked into bind space, weighted to a procedural 9-bone spine, and deformed on the GPU.

The reference coral scans and their 2K diffuse/normal/occlusion maps live under `public/corals/`. They are loaded only for the opening reef's hero specimens; the rest of the shelf uses cheaper procedural reef geometry.
