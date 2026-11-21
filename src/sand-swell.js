import * as THREE from "three";
import { TUNING } from "./config.js";
import { clamp, seabedHeight, smoothstep } from "./utils.js";

/**
 * What the swell does to the sand.
 *
 * Under a wave the water at the bed swings back and forth once a period.
 * Linear wave theory gives that orbital speed from the sea state and the
 * depth: u = omega a / sinh(k h) for each component. It sets three things:
 *
 * - Ripples. Above a threshold speed loose sand is combed into ridges lying
 *   across the swell, a set length apart (about 0.6 of the water's orbital
 *   diameter, capped). They grow to full height where the bed speed is
 *   moderate and are washed flat in sheet flow and under breaking water.
 *   They creep slowly in the direction the waves travel. Where the dolphin
 *   cuts or piles the sand the ripples are wiped out (the sand
 *   simulation's erase channel) and grow back at a rate set by the swell.
 * - Stirred sand. When an individual wave pushes the bed speed past a
 *   second threshold, or a breaker's turbulence reaches the bottom, sand
 *   goes up into the water as a cloud that rides the surge and settles
 *   back out over a few seconds.
 * - Smoothing. Strong surge slowly rounds off the dolphin's trenches and
 *   rims, so marks fade over minutes in shallow water and last in the deep.
 *
 * The ripple shape is analytic (ripplePhase / rippleHeight below, mirrored
 * in GLSL by GLSL_RIPPLES), so the far seabed shows it without any grid,
 * the near mesh and the physics see the same ridges, and the shader can
 * fade it by pixel footprint instead of letting it alias into lines.
 */

const G = 9.81;
// Fine ripplets on the big ridges: wavenumber and height relative to the
// swell set, angle (rad) from it, and how much more their crests wander.
const FINE_K = 5.2;
const FINE_AMP = 0.14;
const FINE_ANGLE = -0.3;
const FINE_WARP = 2.4;
const LUT_SIZE = 128; // depth 0..LUT_DEPTH m
const LUT_DEPTH = 127;

// Crest wander, shared with GLSL_RIPPLES. Plain sines rather than hashed
// noise so float32 on the GPU and float64 here agree to well under a
// millimetre anywhere on the 3 km shelf.
export function rippleWarp(x, z) {
  return (
    1.25 * Math.sin(0.23 * x + 0.31 * z + 1.3) +
    0.8 * Math.sin(-0.41 * x + 0.17 * z + 2.9) +
    0.45 * Math.sin(0.11 * x - 0.52 * z + 0.4) +
    0.3 * Math.sin(0.83 * x + 0.61 * z + 5.1)
  );
}

// Patches where the ridges stand tall, and where they die out, giving the
// forks and the ends of crests that real ripple fields have.
export function ripplePatch(x, z) {
  const a = Math.sin(0.071 * x - 0.093 * z + 0.7) * Math.sin(0.057 * x + 0.083 * z + 2.1);
  const b = Math.sin(0.19 * x + 0.13 * z + 4.4) * 0.5 + Math.sin(-0.29 * x + 0.37 * z + 1.9) * 0.35;
  return clamp(0.66 + 0.4 * a + 0.28 * b, 0, 1);
}

export const GLSL_RIPPLES = /* glsl */ `
  uniform vec4 uRipK;      // k1, k2 (rad/m), migration offsets m1, m2 (m)
  uniform vec4 uRipDir;    // crest-normal directions of the two sets
  uniform vec4 uRipShape;  // height of set 1 (m), set 2 / set 1, lambda1 (m), on
  uniform sampler2D uRipLut; // r: equilibrium ripple height 0..1, g: bed speed / 3 m/s
  uniform sampler2D uFlow;   // r,g: surge excursion (m), b: stirred sand 0..1, a: bed speed / 3 m/s
  uniform vec2 uFlowCenter;
  uniform float uFlowExtent;

  float ripWarp(vec2 p) {
    return 1.25 * sin(0.23 * p.x + 0.31 * p.y + 1.3) +
      0.8 * sin(-0.41 * p.x + 0.17 * p.y + 2.9) +
      0.45 * sin(0.11 * p.x - 0.52 * p.y + 0.4) +
      0.3 * sin(0.83 * p.x + 0.61 * p.y + 5.1);
  }
  vec2 ripWarpGrad(vec2 p) {
    vec2 g = 1.25 * cos(0.23 * p.x + 0.31 * p.y + 1.3) * vec2(0.23, 0.31);
    g += 0.8 * cos(-0.41 * p.x + 0.17 * p.y + 2.9) * vec2(-0.41, 0.17);
    g += 0.45 * cos(0.11 * p.x - 0.52 * p.y + 0.4) * vec2(0.11, -0.52);
    g += 0.3 * cos(0.83 * p.x + 0.61 * p.y + 5.1) * vec2(0.83, 0.61);
    return g;
  }
  float ripPatch(vec2 p) {
    float a = sin(0.071 * p.x - 0.093 * p.y + 0.7) * sin(0.057 * p.x + 0.083 * p.y + 2.1);
    float b = sin(0.19 * p.x + 0.13 * p.y + 4.4) * 0.5 + sin(-0.29 * p.x + 0.37 * p.y + 1.9) * 0.35;
    return clamp(0.66 + 0.4 * a + 0.28 * b, 0.0, 1.0);
  }
  float ripEq(float depth) {
    return texture2D(uRipLut, vec2(clamp(depth / ${LUT_DEPTH.toFixed(1)}, 0.0, 1.0) * ${((LUT_SIZE - 1) / LUT_SIZE).toFixed(6)} + ${(0.5 / LUT_SIZE).toFixed(6)}, 0.5)).r;
  }
  vec4 flowAt(vec2 world) {
    vec2 uv = (world - uFlowCenter) / uFlowExtent + 0.5;
    float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    vec4 f = texture2D(uFlow, clamp(uv, 0.0, 1.0));
    return f * smoothstep(0.0, 0.08, edge);
  }
  // Three ripple sets: the swell's (long, across the swell), a shorter one
  // at an angle, and fine ripplets riding on both. Each ridge is
  // sharp-crested with broad troughs: ((1 + cos phi) / 2)^3, zero mean.
  // Returns height and its gradient, each set faded once a wavelength spans
  // too few pixels to draw.
  vec3 ripSet(float ph, vec2 g, float a, float footprint) {
    float f = 1.0 - smoothstep(0.55, 1.5, footprint * length(g));
    float s = 0.5 + 0.5 * cos(ph);
    a *= f;
    return vec3(a * (s * s * s - 0.3125), -a * 1.5 * s * s * sin(ph) * g);
  }
  vec3 ripples(vec2 p, float amp, float footprint) {
    vec2 wg = ripWarpGrad(p);
    float w = ripWarp(p);
    vec2 d1 = uRipDir.xy;
    vec2 d2 = uRipDir.zw;
    vec2 d3 = vec2(d1.x * ${Math.cos(FINE_ANGLE).toFixed(6)} - d1.y * ${Math.sin(FINE_ANGLE).toFixed(6)}, d1.x * ${Math.sin(FINE_ANGLE).toFixed(6)} + d1.y * ${Math.cos(FINE_ANGLE).toFixed(6)});
    float k3 = uRipK.x * ${FINE_K.toFixed(4)};
    vec3 r = ripSet(uRipK.x * (dot(p, d1) - uRipK.z) + w, uRipK.x * d1 + wg, amp, footprint);
    r += ripSet(uRipK.y * (dot(p, d2) - uRipK.w) + w * 0.6, uRipK.y * d2 + wg * 0.6, amp * uRipShape.y, footprint);
    r += ripSet(k3 * dot(p, d3) + w * ${FINE_WARP.toFixed(3)}, k3 * d3 + wg * ${FINE_WARP.toFixed(3)}, amp * ${FINE_AMP.toFixed(4)}, footprint);
    return r;
  }
`;

export class SandSwell {
  constructor(sim) {
    this.sim = sim;
    const cfg = TUNING.sandSwell;
    // Ripple-set parameters (shader uniforms).
    this.ripK = new THREE.Vector4(4, 6.4, 0, 0);
    this.ripDir = new THREE.Vector4(1, 0, 0, 1);
    this.ripShape = new THREE.Vector4(0, 0.3, 1.5, 1);
    this.migration = [0, 0];
    this.lambda = 1.5;

    // Depth lookup: equilibrium ripple height (0..1), bed speed, breaking,
    // ripple regrowth rate, surge smoothing rate.
    this.lut = new Float32Array(LUT_SIZE * 4);
    this.lutEq = new Float32Array(LUT_SIZE);
    this.lutUb = new Float32Array(LUT_SIZE);
    this.lutBreak = new Float32Array(LUT_SIZE);
    this.lutTexture = new THREE.DataTexture(this.lut, LUT_SIZE, 1, THREE.RGBAFormat, THREE.FloatType);
    this.lutTexture.minFilter = this.lutTexture.magFilter = THREE.LinearFilter;
    this.lutTexture.wrapS = this.lutTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.lutKey = "";

    // Bed flow window around the player.
    const n = (this.flowN = cfg.flowCells);
    this.flowExtent = cfg.flowExtent;
    this.flowCell = this.flowExtent / n;
    this.flowCenter = new THREE.Vector2(sim.center.x, sim.center.y);
    this.vx = new Float32Array(n * n);
    this.vz = new Float32Array(n * n);
    this.ex = new Float32Array(n * n);
    this.ez = new Float32Array(n * n);
    this.cloud = new Float32Array(n * n);
    this.depth = new Float32Array(n * n);
    this.foam = new Float32Array(n * n);
    // Bed mobility (significant bed speed / full) per cell, for weathering.
    this.mobility = new Float32Array(n * n);
    // Static per-cell wave state (depth response), refreshed a few rows a
    // frame after the window moves or the sea state changes.
    this.sRatio = new Float32Array(n * n);
    this.sShoal = new Float32Array(n * n);
    this.sDelay = new Float32Array(n * n);
    this.sBreak = new Float32Array(n * n);
    this.rowStale = new Uint8Array(n).fill(1);
    // Per cell and component: bed speed amplitude and the static part of
    // the phase, so a refresh is one sine per component.
    this.cAmp = new Float32Array(n * n * cfg.flowComponents);
    this.cArg = new Float32Array(n * n * cfg.flowComponents);
    this.flowData = new Float32Array(n * n * 4);
    this.flowTexture = new THREE.DataTexture(this.flowData, n, n, THREE.RGBAFormat, THREE.FloatType);
    this.flowTexture.minFilter = this.flowTexture.magFilter = THREE.LinearFilter;
    this.flowTexture.wrapS = this.flowTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.rowCursor = 0;
    this.bakedCenter = null;
    this.components = null;
    this.spawnAccumulator = 0;
    this.onCloud = null;
    this.stats = { ub: 0, eq: 0, lambda: 0, cloud: 0, breakMask: 0 };
    this._ds = {};
    this._fs = {};
  }

  extentHalf() {
    return this.flowExtent * 0.5;
  }

  /** Uniforms the sand material reads (see GLSL_RIPPLES). */
  uniforms() {
    return {
      uRipK: { value: this.ripK },
      uRipDir: { value: this.ripDir },
      uRipShape: { value: this.ripShape },
      uRipLut: { value: this.lutTexture },
      uFlow: { value: this.flowTexture },
      uFlowCenter: { value: this.flowCenter },
      uFlowExtent: { value: this.flowExtent },
    };
  }

  // --- sea state ----------------------------------------------------------

  _rebuildClimate(water) {
    const cfg = TUNING.sandSwell;
    const wcfg = TUNING.water;
    const hs = Math.max(0.05, water.stats.height);
    const key = [
      hs.toFixed(3), water.count, water.peakK.toFixed(5), water.peakDirX.toFixed(4),
      cfg.onset, cfg.full, cfg.washStart, cfg.washEnd, cfg.lambdaMin, cfg.lambdaMax,
      cfg.lambdaScale, cfg.heightRatio, cfg.breakWash, cfg.regrowTime, wcfg.breakRatio,
      wcfg.shoalReference, wcfg.shoalStrength, cfg.secondSet, cfg.secondRatio, cfg.secondAngle,
    ].join("|");
    if (key === this.lutKey) return;
    this.lutKey = key;
    this.rowStale.fill(1);

    // Components that move the bed, strongest first (the short wind sea
    // barely reaches the bottom). Their phase is evaluated at the bed.
    const comps = [];
    for (let i = 0; i < water.count; i++) {
      comps.push({ i, w: water.amp[i] * water.omega[i], swell: i < water.swellCount });
    }
    comps.sort((a, b) => b.w - a.w);
    this.components = comps.slice(0, cfg.flowComponents).map((c) => c.i);

    const peakOmega = water.peakOmega || Math.sqrt(G * water.peakK);
    const period = (2 * Math.PI) / peakOmega;
    for (let d = 0; d < LUT_SIZE; d++) {
      const depth = Math.max(0.6, (d / (LUT_SIZE - 1)) * LUT_DEPTH);
      // Green's law and the depth-limited cap, as WaveField.depthState
      // without the reef focus.
      const shoalRaw = clamp(Math.pow(wcfg.shoalReference / depth, wcfg.shoalStrength), 0.5, 3.2);
      const cap = (wcfg.breakRatio * depth) / hs;
      const floor = Math.min(0.55, (wcfg.breakFloor ?? 2.4) / hs);
      const shoal = Math.min(shoalRaw, Math.max(floor, cap * 1.05));
      const breakMask = smoothstep(
        wcfg.breakRatio - wcfg.breakSoftness,
        wcfg.breakRatio + wcfg.breakSoftness,
        (hs * shoalRaw) / depth
      );
      let u2 = 0;
      for (let i = 0; i < water.count; i++) {
        const k = dispersionK(water.omega[i], depth);
        const a = water.amp[i] * (i < water.swellCount ? shoal : Math.min(1, shoal));
        const u = (water.omega[i] * a) / Math.sinh(Math.max(1e-3, k * depth));
        u2 += 0.5 * u * u;
      }
      // Significant bed speed: twice the rms, the convention behind Hs.
      const ub = 2 * Math.sqrt(u2);
      const grow = smoothstep(cfg.onset, cfg.full, ub);
      const wash = 1 - smoothstep(cfg.washStart, cfg.washEnd, ub);
      const eq = grow * wash * (1 - cfg.breakWash * breakMask);
      this.lutEq[d] = eq;
      this.lutUb[d] = ub;
      this.lutBreak[d] = breakMask;
      this.lut[d * 4] = eq;
      this.lut[d * 4 + 1] = ub / 3;
      this.lut[d * 4 + 2] = breakMask;
      this.lut[d * 4 + 3] = 1;
    }
    this.lutTexture.needsUpdate = true;

    // Ripple length from the orbital diameter (U T / pi) where ripples are
    // best developed on this shelf, so one length holds over the whole bed
    // and the crests can migrate without shearing.
    let best = 0;
    let ubRef = 0;
    for (let d = 3; d < LUT_SIZE; d++) {
      if (this.lutEq[d] > best) {
        best = this.lutEq[d];
        ubRef = this.lutUb[d];
      }
    }
    const orbital = (ubRef * period) / Math.PI;
    this.lambda = clamp(cfg.lambdaScale * orbital, cfg.lambdaMin, cfg.lambdaMax);
    const k1 = (2 * Math.PI) / this.lambda;
    const k2 = k1 * cfg.secondRatio;
    // Crests lie across the swell: their normal is its travel direction.
    const dx = water.peakDirX;
    const dz = water.peakDirZ;
    const ca = Math.cos(cfg.secondAngle);
    const sa = Math.sin(cfg.secondAngle);
    this.ripK.x = k1;
    this.ripK.y = k2;
    this.ripDir.set(dx, dz, dx * ca - dz * sa, dx * sa + dz * ca);
    this.ripShape.x = cfg.heightRatio * this.lambda;
    this.ripShape.y = cfg.secondSet;
    this.ripShape.z = this.lambda;
    this.period = period;
  }

  /** Equilibrium ripple height (0..1) and bed speed for a still-water depth. */
  climateAt(depth, out = this._ds) {
    const f = clamp(depth / LUT_DEPTH, 0, 1) * (LUT_SIZE - 1);
    const i = Math.min(LUT_SIZE - 2, Math.floor(f));
    const t = f - i;
    out.eq = this.lutEq[i] + (this.lutEq[i + 1] - this.lutEq[i]) * t;
    out.ub = this.lutUb[i] + (this.lutUb[i + 1] - this.lutUb[i]) * t;
    out.breakMask = this.lutBreak[i] + (this.lutBreak[i + 1] - this.lutBreak[i]) * t;
    return out;
  }

  // --- ripple shape (mirrors GLSL_RIPPLES) --------------------------------

  /** Ripple height (m) at x, z on a bed whose still-water depth is depth. */
  rippleHeight(x, z, depth) {
    if (!TUNING.sandSwell.ripples) return 0;
    const amp = this.ripShape.x * this.climateAt(depth).eq * ripplePatch(x, z);
    if (amp <= 1e-5) return 0;
    const w = rippleWarp(x, z);
    const d = this.ripDir;
    const ph1 = this.ripK.x * (x * d.x + z * d.y - this.ripK.z) + w;
    const ph2 = this.ripK.y * (x * d.z + z * d.w - this.ripK.w) + w * 0.6;
    const c = Math.cos(FINE_ANGLE);
    const sn = Math.sin(FINE_ANGLE);
    const ph3 = this.ripK.x * FINE_K * (x * (d.x * c - d.y * sn) + z * (d.x * sn + d.y * c)) + w * FINE_WARP;
    const p = (ph) => {
      const s = 0.5 + 0.5 * Math.cos(ph);
      return s * s * s - 0.3125;
    };
    return amp * (p(ph1) + this.ripShape.y * p(ph2) + FINE_AMP * p(ph3));
  }

  // --- bed flow -----------------------------------------------------------

  _recenterFlow(x, z) {
    const n = this.flowN;
    const cell = this.flowCell;
    const cx = Math.round(x / cell) * cell;
    const cz = Math.round(z / cell) * cell;
    if (this.bakedCenter && Math.abs(cx - this.flowCenter.x) < cell * 6 && Math.abs(cz - this.flowCenter.y) < cell * 6) {
      return;
    }
    const si = this.bakedCenter ? Math.round((cx - this.flowCenter.x) / cell) : n;
    const sj = this.bakedCenter ? Math.round((cz - this.flowCenter.y) / cell) : n;
    const shift = (arr) => {
      const copy = arr.slice();
      arr.fill(0);
      for (let j = 0; j < n; j++) {
        const fj = j + sj;
        if (fj < 0 || fj >= n) continue;
        for (let i = 0; i < n; i++) {
          const fi = i + si;
          if (fi < 0 || fi >= n) continue;
          arr[j * n + i] = copy[fj * n + fi];
        }
      }
    };
    shift(this.cloud);
    shift(this.ex);
    shift(this.ez);
    this.flowCenter.set(cx, cz);
    this.bakedCenter = true;
    this.rowStale.fill(1);
  }

  _staticRow(j, water) {
    const n = this.flowN;
    const cell = this.flowCell;
    const full = Math.max(0.1, TUNING.sandSwell.full);
    const x0 = this.flowCenter.x - this.flowExtent * 0.5 + cell * 0.5;
    const z = this.flowCenter.y - this.flowExtent * 0.5 + cell * (j + 0.5);
    for (let i = 0; i < n; i++) {
      const x = x0 + cell * i;
      const idx = j * n + i;
      const st = water.depthState(x, z, this._ds);
      const depth = Math.max(0.6, -seabedHeight(x, z));
      this.depth[idx] = depth;
      this.sRatio[idx] = st.ratio;
      this.sShoal[idx] = st.shoal;
      this.sDelay[idx] = st.delay;
      this.sBreak[idx] = st.breakMask;
      this.mobility[idx] = Math.min(1.6, this.climateAt(depth).ub / full);
      const comps = this.components;
      const nc = TUNING.sandSwell.flowComponents;
      for (let c = 0; c < comps.length; c++) {
        const q = comps[c];
        const swell = q < water.swellCount;
        const k = water.k[q] * (swell ? st.ratio : 1);
        const a = water.amp[q] * (swell ? st.shoal : Math.min(1, st.shoal));
        this.cAmp[idx * nc + c] = (water.omega[q] * a) / Math.sinh(Math.max(1e-3, k * depth));
        // phase0 - omega t is added at refresh time (water.phase).
        this.cArg[idx * nc + c] = water.kx[q] * x + water.kz[q] * z + (swell ? water.k[q] * st.delay : 0);
      }
    }
    this.rowStale[j] = 0;
  }

  _flowRow(j, water, foamField) {
    const n = this.flowN;
    const cell = this.flowCell;
    const comps = this.components;
    const x0 = this.flowCenter.x - this.flowExtent * 0.5 + cell * 0.5;
    const z = this.flowCenter.y - this.flowExtent * 0.5 + cell * (j + 0.5);
    const nc = TUNING.sandSwell.flowComponents;
    for (let i = 0; i < n; i++) {
      const x = x0 + cell * i;
      const idx = j * n + i;
      const base = idx * nc;
      let vx = 0;
      let vz = 0;
      for (let c = 0; c < comps.length; c++) {
        const q = comps[c];
        const u = this.cAmp[base + c] * Math.sin(this.cArg[base + c] + water.phase[q]);
        vx += u * water.dirX[q];
        vz += u * water.dirZ[q];
      }
      this.vx[idx] = vx;
      this.vz[idx] = vz;
      let foam = 0;
      if (foamField && foamField.enabled) foam = foamField.sample(x, z, this._fs).foam;
      // Only a breaker in water shallow for its size stirs the bottom.
      this.foam[idx] = foam * this.sBreak[idx];
    }
  }

  update(dt, ocean, playerPos) {
    const cfg = TUNING.sandSwell;
    const water = ocean.water;
    this._rebuildClimate(water);
    this._recenterFlow(playerPos.x, playerPos.z);

    // Ripples creep with the waves, faster where the surge is strong.
    const local = this.climateAt(Math.max(0.6, -seabedHeight(playerPos.x, playerPos.z)));
    const creep = cfg.migration * clamp(local.ub / Math.max(0.1, cfg.full), 0, 1.5) * (cfg.ripples ? 1 : 0);
    this.ripK.z += creep * dt;
    this.ripK.w += creep * 0.7 * dt;
    this.ripShape.w = cfg.ripples ? 1 : 0;

    // Bed velocity, a few rows a frame: each cell is fresh about 15x a
    // second, faster than any wave period.
    const n = this.flowN;
    // The mega wave changes the depth response as it passes: keep refreshing.
    if (TUNING.water.megaWave) this.rowStale[(this.rowCursor + n / 2) % n] = 1;
    let fresh = 0;
    for (let j = 0; j < n && fresh < cfg.staticRowsPerFrame; j++) {
      if (this.rowStale[j]) {
        this._staticRow(j, water);
        fresh++;
      }
    }
    const rows = Math.max(1, Math.ceil(n / cfg.flowPasses));
    for (let r = 0; r < rows; r++) {
      if (!this.rowStale[this.rowCursor]) this._flowRow(this.rowCursor, water, ocean.foamField);
      this.rowCursor = (this.rowCursor + 1) % n;
    }

    // Surge excursion (for the grains streaming back and forth on the
    // bed) and the stirred-sand cloud.
    const leak = Math.exp(-dt / Math.max(0.5, (this.period || 10) * 0.5));
    const settle = Math.exp(-dt / Math.max(0.2, cfg.settleTime));
    let cloudSum = 0;
    for (let i = 0; i < n * n; i++) {
      const vx = this.vx[i];
      const vz = this.vz[i];
      this.ex[i] = this.ex[i] * leak + vx * dt;
      this.ez[i] = this.ez[i] * leak + vz * dt;
      const speed = Math.hypot(vx, vz);
      const lift =
        cfg.stirRate * Math.max(0, speed - cfg.stirSpeed) / Math.max(0.1, cfg.stirSpeed) +
        cfg.breakerStir * this.foam[i];
      let c = this.cloud[i] * settle + lift * dt;
      c = Math.min(1, c);
      this.cloud[i] = c;
      cloudSum += c;
      const o = i * 4;
      this.flowData[o] = this.ex[i];
      this.flowData[o + 1] = this.ez[i];
      this.flowData[o + 2] = c;
      this.flowData[o + 3] = speed / 3;
    }
    this.flowTexture.needsUpdate = true;

    const pi = this._flowIndex(playerPos.x, playerPos.z);
    this.stats.ub = local.ub;
    this.stats.eq = local.eq;
    this.stats.breakMask = local.breakMask;
    this.stats.lambda = this.lambda;
    this.stats.cloud = pi >= 0 ? this.cloud[pi] : 0;
    this.stats.bedSpeed = pi >= 0 ? Math.hypot(this.vx[pi], this.vz[pi]) : 0;
    this.stats.meanCloud = cloudSum / (n * n);

    this._spawnClouds(dt, playerPos);
  }

  _flowIndex(x, z) {
    const n = this.flowN;
    const i = Math.floor((x - this.flowCenter.x) / this.flowCell + n / 2);
    const j = Math.floor((z - this.flowCenter.y) / this.flowCell + n / 2);
    if (i < 0 || j < 0 || i >= n || j >= n) return -1;
    return j * n + i;
  }

  /** Bed surge velocity, stirred sand and wash at x, z (nearest cell). */
  flowAt(x, z, out = {}) {
    const i = this._flowIndex(x, z);
    out.vx = i >= 0 ? this.vx[i] : 0;
    out.vz = i >= 0 ? this.vz[i] : 0;
    out.cloud = i >= 0 ? this.cloud[i] : 0;
    out.foam = i >= 0 ? this.foam[i] : 0;
    return out;
  }

  _spawnClouds(dt, p) {
    const cfg = TUNING.sandSwell;
    if (!this.onCloud || cfg.cloudParticles <= 0) return;
    // Puffs near the viewer only: the cloud field itself shades the bed
    // farther out.
    this.spawnAccumulator = Math.min(this.spawnAccumulator + dt * cfg.cloudParticles, 8);
    const reach = cfg.cloudReach;
    let tries = 0;
    while (this.spawnAccumulator >= 1 && tries < 24) {
      tries++;
      const x = p.x + (Math.random() - 0.5) * 2 * reach;
      const z = p.z + (Math.random() - 0.5) * 2 * reach;
      const i = this._flowIndex(x, z);
      if (i < 0) continue;
      const c = this.cloud[i];
      if (c < 0.04 || Math.random() > c * 1.4) continue;
      this.spawnAccumulator -= 1;
      this.onCloud({ x, z, strength: c, vx: this.vx[i], vz: this.vz[i] });
    }
    if (tries >= 24) this.spawnAccumulator *= 0.5;
  }
}

/** Wavenumber of angular frequency omega in water `depth` deep. */
function dispersionK(omega, depth) {
  const k0 = (omega * omega) / G;
  // Fenton & McKee's explicit approximation (good to ~1.5%).
  const kd = k0 * depth;
  return k0 / Math.pow(Math.tanh(Math.pow(kd, 0.75)), 2 / 3);
}
