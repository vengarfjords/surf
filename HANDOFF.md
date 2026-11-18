# HANDOFF — ocean (neritic drift dolphin sim)

Written 2026-11-11 after commit `26fe5df`, for a fresh agent with zero conversation memory.

## 1. Project overview

Browser-based dolphin simulator on a **3 × 3 km neritic shelf**. The goal is the feeling of an agile animal in sunlit, silty water: real-ish water physics (swell, shoaling, breaking, foam), a force-driven hull that **surfs emergently** (no scripted surf mode), and convincing above-water, waterline, and underwater rendering at 60 fps.

Stack: vanilla ESM JavaScript, **three.js ^0.187.0** (WebGL2 only), **Vite ^8.3.6** (dev/build, no framework, no bundler config file), procedural WebAudio, no assets except `public/dolphin.glb` and `public/corals/` reference scans.

## 2. Current state

Working tree is **clean**; everything below is committed.

**Works**
- Deterministic 128-component spectrum (96 JONSWAP swell + 32 wind sea), shared CPU/GPU field (`src/water/field.js` + `src/water/shaders.js`), 7 km clipmap, CPU/GPU parity ~0.01 cm.
- 256² bathymetry (`src/water/bathymetry.js`, maxDepth 30) with the **surf bank at (260, 140)** rising ~10 m → ~2.6 m; finite-depth dispersion, Green's-law shoaling, breaking mask, Iribarren breaker types, breaker jet, whitewater/aeration (default `breakRatio` 0.85).
- 170-panel hull (`src/water/hull.js`): hydrostatics/FK/drag/lift/slam/added mass/lung buoyancy at 120 Hz; emergent surfing (scenario 4 held ~9.5 m/s on a breaking face).
- M4 wake/bow wave/tail boil, exit spray, re-entry crown, tail slap (`src/particles.js`).
- M5 waterline camera band, meniscus collar, Snell window/TIR, underwater caustics (`src/ocean.js`, `src/camera.js`, `src/post.js`).
- Advected foam field (`src/water/foam.js`): 96² / 192 m / 15 Hz, sourced at `breakMask ≈ 0.5`, feeds the surface shader **and** hull aeration (≤ 0.5) via `ocean.sampleWater*`; never moves surface height.
- Surf atmosphere: above-water mist (320 particles, 30/s), underwater plume (360 ring bubbles + aeration puffs, 20/s, forward-cone sampling), surf roar (distance-driven filtered noise; **no stereo panning**).
- Perf readout (`src/main.js`): 0.75 s rolling layer averages, whole-frame draw/triangle counts (`renderer.info.autoReset = false`, reset before `post.render`).

**Partially done / known limitation**
- `src/water/solver.js` — experimental Lax-Friedrichs NSWE solver, opt-in via T → **surf-zone solver**, **default off** (`solverEnabled: false`). Visibly flatter/paler than the analytic surf; MacCormack and analytic-velocity boundary variants were tried and **failed numerical validation** (state collapsed to zero) and were reverted. The analytic M3 surf remains authoritative.

**Recently removed (last commit)**
- The M11 **big-wave arena** (40.5 m Hs / 360 m swell, peak-and-shoulder reef at (450, 300), surf-contact/carve physics, 60 m bathymetry) was **fully reverted** back to the classic shelf in `26fe5df`.
- **Fish, jellyfish, and rocks** were removed from the scene (`src/main.js` no longer instantiates `FishSchools`/`Jellyfish`; `src/habitat.js` `Reefs.build()` no longer spawns the patch rocks or hero stones).
- The surf-audio **StereoPanner** and the **master volume** T row were removed at user request.

**Stale docs (need a fix-up)**
- `README.md` "Detailed marine life" bullet and the project-layout line still describe fish/jellyfish even though they're gone from the scene.
- `README.md` "Post-M6 measurements" table still lists pre-removal triangles (788,624 / 858,048); after the removals the surf view measures **24 draws / 568,976 triangles**.

## 3. Git state

- Branch: **ocean-surf** — in sync with `origin/ocean-surf` (https://github.com/vengarfjords/surf.git).
- HEAD: **`26fe5df`** "Return to the classic shelf surf bank; remove fish, jellyfish, rocks and surf-audio panning" (19 files, +841/−707, deletes `docs/m11-big-wave-ridge.jpg`, `docs/m11-big-wave-surf.jpg`, `docs/m11-surf-carve.jpg`).
- No uncommitted or untracked changes.
- This directory is a **worktree**: `.git` is a file → `/Users/j/ocean/.git/worktrees/jolly-orchid`. `main` is checked out at **/Users/j/ocean** (cc12eb4) — **never touch it**.
- History keeps the full M11 big-wave line (`8ab7acc`…`bd260af`) and the panning commit `1aa9fd7` (undone later) — available via `git log`/`git show` if needed.
- Rule: commit milestones on `ocean-surf`, push with `git push -u origin HEAD`, **never force-push, never touch main**.

## 4. Work in progress

Nothing is actively in flight (clean tree). The last completed task was: undo the surf-audio panning edits, remove fish/jellyfish/rocks, and push (`26fe5df`).

**Exact next step:** reconcile `README.md` with the removal — fix the "Detailed marine life" bullet (keep scallops/crab, drop fish/jellyfish), the `habitat.js` layout line, and refresh the perf table to the post-removal numbers — then re-verify at 60 Hz and re-run scenario 4.

## 5. Next steps (prioritized)

1. **README cleanup** (stale doc items from §2). Ask/decide whether to also delete the now-dead `FishSchools`/`Jellyfish` classes in `src/habitat.js` and the `TUNING.fish` block in `src/config.js` (they're tree-shaken out of the bundle, so it's cosmetic).
2. **Re-validate the reverted classic shelf**: `npm run dev`, run `await OCEAN.scenarios.shoalingBreak("moderate", 6)` (expect max speed ≈ 9.5 m/s, aeration ≈ 0.6, no console errors) and `probeParity(30)`; capture the three viewpoints (above/waterline/underwater) at a 60 Hz display link.
3. **Pick the next milestone** (see Open questions): candidates are the NSWE solver rework (blocked, needs a well-balanced scheme), surf-zone rendering depth (curled lip/foam streaks), true surface-normal caustics, or scene refraction in the Snell window (expensive/risky).
4. If continuing surf polish: add a shoreward sink to `FoamField._step` (`src/water/foam.js`) and consider a lip spray sheet at plunging crests.

## 6. Key decisions and rationale

- **Analytic deterministic spectral surf is the shipped default.** The local NSWE solver stays opt-in/off: it is flatter/paler and sits at the 60 fps budget. Do not relitigate without a well-balanced shallow-water/Boussinesq scheme plus an explicit wave-maker/absorbing boundary (MacCormack and analytic-velocity Lax-Friedrichs variants both collapsed numerically and were reverted).
- **Foam field = visual + hull aeration only** (never surface height). Shader thresholds it through the existing foam/lace noise (`smoothstep(0.28, 0.72, fieldLace)` in `src/ocean.js`) so the surf keeps blue gaps instead of a cream sheet.
- **Cooler, smoother grazing-sky reflection** (`skyReflection()` in `src/ocean.js`): muted zenith/horizon mix with `smoothstep(0.0, 0.45, h)`. The warm sky dome is intentional for the sky itself, not for painting the sea; this fixed the "busy cream" patchwork at 15–20 m altitude.
- **Surf atmosphere is three layers**: above-water mist (`emitSurfSpray` in `src/main.js`, gated off when `camState.underwater > 0.9`), underwater plume (`emitSurfBubbles`, gated on when `> 0.05`, forward-cone foam sampling, 160 m cull), and a distance-driven roar in `src/audio.js` (70–320 m falloff, ~620 Hz above / ~190 Hz below, pre-generated crash buffer). Stats are separated (`surfSpray`/`surfBubbles`/`surfAeration`) so scenario 5's dolphin counts stay clean.
- **Surf-audio panning and the master-volume T row were deliberately removed** at user request (`1aa9fd7` undone in `26fe5df`). Do not re-add without asking.
- **Dynamic quality governor steps `renderScale` down only**, floor 0.45, 2.5 s cooldown (`src/main.js`); default `renderScale` 0.6.
- **Fish/jellyfish/rocks removed from the scene** at user request; classes left in `src/habitat.js` as dead code pending a decision on deleting them.
- **M11 big-wave arena was abandoned and reverted** to the classic shelf; the commits remain in history in case it's revisited.
- Audio compressor `release` is `1.0` (spec range [0,1]; 1.2 previously caused a console warning).

## 7. How to run things

```bash
npm install        # verified (node_modules present)
npm run dev        # Vite dev server → http://localhost:5173  (verified)
npm run build      # vite build → dist/  (verified; >500 kB chunk warning is expected, not an error)
npm run preview    # exists, not recently verified
```

- No lint or test scripts. The regression suite is the **in-browser scenario harness**: after `OCEAN.start()`, call `window.OCEAN.scenarios` — `passiveFloat`, `probeParity`, `faceHold`, `thrustSaving`, `shoalingBreak`, `breachCompare` (each restores the animal's state afterward).
- Controls: `W` swim, `S` brake/reverse, `A`/`D` carve, mouse steer (pointer lock), `Shift` surge, `Space`/`C` rise/dive, `T` tuning panel, `P` raw post toggle, `M` mute, `H` HUD.
- **Headless screenshots:** the old CDP helper script (`/private/var/folders/zp/.../T/opencode/m5-shot.mjs`) was in a temp dir that has been cleared — it no longer exists. Recreate it if needed: launch Chrome `--headless=new --remote-debugging-port=9444 --use-angle=metal --window-size=1600,900` with a temp `--user-data-dir`, open `http://localhost:5173/?shot=<mode>`, wait for `window.OCEAN`, pose via CDP `Runtime.evaluate`, then `Page.captureScreenshot`. App-side capture params live in `src/main.js` (`captureParams`): `?shot=underwater|waterline|breach|solver`, plus `foam=0`, `detail=0`, `foamfield=0`, `surfspray=0`, `surfbubbles=0`. For deterministic waterline shots set `O.tuning.water.timeScale = 0` before posing.

## 8. Environment and config

- **No env vars, no API keys, no external services.** Only the local Vite dev server.
- Ports: **5173** (Vite dev), **9444** (headless Chrome CDP, historical convention).
- Tools: Node **v26.12.0**, npm **12.2.0**, Chrome headless with Metal ANGLE on Apple Silicon macOS.
- Repo is a worktree of `/Users/j/ocean`; see §3.
- Tunables: `src/config.js` (`TUNING` + `TUNE_CONTROLS`), exposed live as `window.OCEAN.tuning`.

## 9. Gotchas

- **Battery < ~20% caps the macOS display link at 30 Hz** (rAF 33.3 ms) — frame-pacing numbers become environment-dependent. On a 60 Hz link the app measured 60.2 fps / p95 16.7 ms. Judge perf by GPU/CPU layer ms and pacing, not by the 33.3 ms interval in old captures.
- **Stale Chrome profile locks**: after a killed headless run, delete `SingletonCookie`/`SingletonLock`/`SingletonSocket` inside the headless `--user-data-dir` or the next launch hangs on the loading screen.
- **In-app browser tabs are background-throttled** (rAF can pause, `O.ocean.time` stops) — never use them for perf or animation validation. Headless Chrome audio starts `suspended` without a user gesture; `O.start()` + `ctx.resume()` in a real (focused) tab works.
- **Waterline captures are pose/timing-sensitive** (the camera sits ±cm from the local surface); freeze the wave clock (`O.tuning.water.timeScale = 0`) before posing for reproducible shots. The `?shot=waterline` pose in `src/main.js` was luck-dependent historically.
- The GPU timer (`EXT_disjoint_timer_query_webgl2`) is noisy; trust the 0.75 s layer averages and rAF pacing.
- `renderer.info.autoReset = false` is intentional (whole-frame draw counts); `renderer.info.reset()` runs in `main.js` just before `post.render`. `OCEAN.info` reports these totals.
- The GPU contact heightfield (`uSimScale`) is **visual only** — the physics query deliberately excludes it, and the parity probe sets `uSimScale = 0`.
- Vite prints a >500 kB chunk warning on every build; ignore it (or code-split later — not done on purpose).
- `README.md` is the canonical feature/measurement doc — keep it in sync with code (it currently lags the fish/jellyfish/rocks removal, see §2).
- `npm run dev` binds **IPv6 localhost** — use `http://localhost:5173`, not `127.0.0.1`.

## 10. Conventions

- **Every tunable number** lives in `TUNING` (`src/config.js`) with a `TUNE_CONTROLS` row (SI units: m, s, m/s, m/s²); panel labels are lowercase.
- **Deterministic seeded spectrum** (`TUNING.water.seed`) so scenarios reproduce at a given sim time.
- **CPU field is authoritative** (`src/water/field.js`); GPU shaders in `src/water/shaders.js`/`src/ocean.js` must match (parity target: mean ~0.01 cm via `probeParity`).
- **Milestone discipline**: commit on `ocean-surf` and `git push -u origin HEAD` after each milestone; save screenshots to `docs/` named `m<number>-<name>.jpg`; report ms/frame per layer plus three viewpoints (above-water, waterline, underwater).
- Keep the sim runnable after every change — `npm run build` must pass.
- GLSL lives in JS template literals (no external shader files).
- Deterministic RNG via `mulberry32` (see `src/utils.js`) for procedural content; `Math.random` is fine for particles.

## 11. Open questions

1. Delete the dead `FishSchools`/`Jellyfish` classes (`src/habitat.js`) and the `TUNING.fish` block (`src/config.js`) entirely, or keep them for potential revival?
2. Update `README.md`'s "Detailed marine life" bullet, project-layout line, and perf table for the removal (I can do this immediately — it's the stated next step).
3. Is the classic-shelf return **final** (M11 big-wave arena abandoned), or a checkpoint before reworking the arena?
4. Next milestone direction: NSWE solver rework, deeper surf-zone rendering (curled lip, foam streaks), scene refraction in the Snell window, or true surface-normal caustics?
