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
 *   across the swell, a set length apart (from the orbital diameter and
 *   the grain size, Wiberg & Harris 1994: ~0.2 m in a storm). They grow to full height where the bed speed is
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
 * The ripples are a few centimetres tall, so they are drawn by the sand
 * shader alone (GLSL_RIPPLES, normal detail with no mesh relief) and the
 * physics ignores them. The shader fades them by pixel footprint instead of
 * letting them alias into lines.
 */

const G = 9.81;
const LUT_SIZE = 128; // depth 0..LUT_DEPTH m
const LUT_DEPTH = 127;

// Gentle crest wander over tens of metres (the swell's direction drifts
// across the shelf). Plain sines, precise in float32 anywhere on the shelf.
export const GLSL_RIPPLES = /* glsl */ `
  uniform vec4 uRipK;      // k (rad/m), unused, migration offset (m), unused
  uniform vec4 uRipDir;    // xy: crest normal (the swell's travel direction)
  uniform vec4 uRipShape;  // height (m), unused, length (m), on
  uniform sampler2D uRipLut; // r: equilibrium ripple height 0..1, g: bed speed / 3 m/s
  uniform sampler2D uFlow;   // r,g: surge excursion (m), b: stirred sand 0..1, a: bed speed / 3 m/s
  uniform vec2 uFlowCenter;
  uniform float uFlowExtent;

  // Smooth noise for natural, unaligned variation: value noise with a
  // quintic fade (no creases at the lattice lines) whose octaves are each
  // turned by a different angle, so no lattice direction survives. Plain
  // fbm2 lines its features up with the world axes, which shows as straight
  // bands across the bed from a distance.
  float vnoiseQ(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbmR(vec2 p) {
    p = mat2(0.809, 0.588, -0.588, 0.809) * p;
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      v += vnoiseQ(p) * amp;
      p = mat2(1.62, 1.18, -1.18, 1.62) * p + 7.1;
      amp *= 0.5;
    }
    return v;
  }
  float ripWarp(vec2 p) {
    return 1.25 * sin(0.23 * p.x + 0.31 * p.y + 1.3) +
      0.8 * sin(-0.41 * p.x + 0.17 * p.y + 2.9) +
      0.45 * sin(0.11 * p.x - 0.52 * p.y + 0.4);
  }
  float ripPatch(vec2 p) {
    float a = sin(0.071 * p.x - 0.093 * p.y + 0.7) * sin(0.057 * p.x + 0.083 * p.y + 2.1);
    float b = sin(0.19 * p.x + 0.13 * p.y + 4.4) * 0.5 + sin(-0.29 * p.x + 0.37 * p.y + 1.9) * 0.35;
    return clamp(0.9 + 0.12 * a + 0.06 * b, 0.0, 1.0);
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

  // One field of wave ripples, as in photographs of rippled sand: crests a
  // hand or two apart lying across the swell, gently sinuous, and broken
  // every few wavelengths by a crest that forks or ends. Everything is in
  // wavelength units (q), so the pattern scales with the ripple length.
  //
  // The forks are phase dislocations: a pair of opposite twists of the
  // phase, arg((q - a) / (q - b)), which adds a crest between a and b and
  // so ends one crest at each. Its only jump is a whole turn (2 pi) on the
  // segment a-b, which the cosine never sees; each pair lives in its own
  // cell and fades out well before the cell's edge.
  // core: shrinks toward 0 within ~0.6 wavelengths of a crest end, so the
  // ends taper and flatten as real ones do instead of pinching to a dot.
  float ripFork(vec2 q, float cellSize, float seed, inout float core) {
    vec2 g = q / cellSize;
    vec2 cell = floor(g);
    vec2 f = g - cell - 0.5;
    float r0 = hash21(cell + seed);
    if (r0 < 0.12) return 0.0;
    vec2 c = (vec2(hash21(cell + seed + 17.3), hash21(cell + seed + 41.7)) - 0.5) * 0.3;
    float ang = hash21(cell + seed + 3.1) * 6.2832;
    vec2 d = vec2(cos(ang), sin(ang)) * (1.3 + 1.4 * hash21(cell + seed + 9.2)) / (2.0 * cellSize);
    vec2 a = f - c - d;
    vec2 b = f - c + d;
    // atan(0, 0) is undefined: Safari's Metal backend can return NaN for a
    // pixel that lands exactly on a fork end, and the bloom then smears that
    // one NaN over the whole screen as a black frame.
    float tY = a.y * b.x - a.x * b.y;
    float tX = dot(a, b);
    float twist = abs(tY) + abs(tX) > 1e-12 ? atan(tY, tX) : 0.0;
    float win = 1.0 - smoothstep(0.34, 0.49, max(abs(f.x), abs(f.y)));
    float r = min(length(a), length(b)) * cellSize;
    core = min(core, mix(1.0, smoothstep(0.05, 0.65, r), win));
    return (r0 < 0.56 ? twist : -twist) * win;
  }
  float ripPhase(vec2 p, inout float core) {
    vec2 q = p * uRipK.x * 0.159155;
    float w = ripWarp(p) +
      (fbmR(q * 0.18 + 3.0) - 0.5) * 5.0 +
      (fbmR(q * 0.55 + 11.0) - 0.5) * 1.0 +
      ripFork(q, 5.0, 0.0, core) + ripFork(q + 2.5, 7.0, 31.0, core);
    return uRipK.x * (dot(p, uRipDir.xy) - uRipK.z) + w;
  }
  float ripAmpMod(vec2 p) {
    vec2 q = p * uRipK.x * 0.159155;
    return 0.7 + 0.3 * smoothstep(0.3, 0.62, fbmR(q * 0.075 + 7.0));
  }
  // Peaked crests and broad rounded troughs, as wave ripples stand: two
  // flanks meeting at an edge on the crest (where the light breaks from
  // the lit flank to the shaded one) and flattening into the trough.
  // (1 - u)^1.7 with u the distance from the crest in half wavelengths,
  // zero mean.
  // soft rounds the crest edge over about two pixels (in half
  // wavelengths), so far off the edge does not break into beads.
  float ripProfile(float ph, float soft) {
    float u = abs(fract(ph * 0.159155 + 0.5) - 0.5) * 2.0;
    u = sqrt(u * u + soft * soft) - soft;
    float v = 1.0 - u;
    return pow(max(v, 1e-5), 1.7) - 0.37037;
  }
  // Height and slope (forward differences over 1/25 of a wavelength). wdx
  // and wdy are the world steps of one pixel. The field fades to flat once
  // a wavelength, measured across the crests, spans fewer than ~5 pixels,
  // so it never aliases into lines; beyond that the sand reads as its mean
  // tone.
  vec3 ripples(vec2 p, float amp, vec2 wdx, vec2 wdy) {
    float across = max(abs(dot(wdx, uRipDir.xy)), abs(dot(wdy, uRipDir.xy)));
    float pixel = max(across, 0.4 * max(length(wdx), length(wdy)));
    amp *= 1.0 - smoothstep(1.3, 2.7, pixel * uRipK.x);
    if (amp < 1e-5) return vec3(0.0);
    amp *= ripAmpMod(p);
    float soft = clamp(pixel * uRipK.x * 0.318310 * 1.6, 0.1, 0.7);
    float e = 0.25 / uRipK.x;
    float c0 = 1.0, cx = 1.0, cz = 1.0;
    float h0 = amp * ripProfile(ripPhase(p, c0), soft) * c0;
    float hx = amp * ripProfile(ripPhase(p + vec2(e, 0.0), cx), soft) * cx;
    float hz = amp * ripProfile(ripPhase(p + vec2(0.0, e), cz), soft) * cz;
    return vec3(h0, (hx - h0) / e, (hz - h0) / e);
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
      cfg.grainSize, cfg.heightRatio, cfg.breakWash, cfg.regrowTime, wcfg.breakRatio,
      wcfg.shoalReference, wcfg.shoalStrength,
    ].join("|");
    if (key === this.lutKey) return;
    this.lutKey = key;
    this.rowStale.fill(1);

    // Components that move the bed, strongest at the bed first. Ranked by
    // their orbital speed at a typical shelf depth, not at the surface: the
    // short wind sea is fast at the surface but barely reaches the bottom,
    // and ranking by surface speed gave it a quarter of the slots, cutting
    // the peak surges that stir the sand. Their phase is evaluated at the
    // bed.
    const comps = [];
    const refDepth = cfg.rankDepth ?? 10;
    for (let i = 0; i < water.count; i++) {
      const kb = dispersionK(water.omega[i], refDepth);
      const w = (water.amp[i] * water.omega[i]) / Math.sinh(Math.max(1e-3, kb * refDepth));
      comps.push({ i, w, swell: i < water.swellCount });
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
    // Wiberg & Harris (1994): under small orbits ripples are "orbital",
    // 0.62 of the orbital diameter d0; under big ones (d0 / D > 5587 for
    // grain size D) they stop growing at an "anorbital" 535 D; in between
    // the length runs log-linearly from one to the other. A storm over
    // medium sand gives ~0.2 m ripples, a gentle swell in the shallows
    // ~0.3-0.4 m.
    const orbital = (ubRef * period) / Math.PI;
    const D = cfg.grainSize;
    const lOrb = 0.62 * orbital;
    const lAno = 535 * D;
    const r = orbital / D;
    let lambda;
    if (r <= 1754) lambda = lOrb;
    else if (r >= 5587) lambda = lAno;
    else {
      const t = Math.log(r / 1754) / Math.log(5587 / 1754);
      lambda = Math.exp(Math.log(0.62 * 1754 * D) * (1 - t) + Math.log(lAno) * t);
    }
    this.lambda = clamp(lambda, cfg.lambdaMin, cfg.lambdaMax);
    // Crests lie across the swell: their normal is its travel direction.
    this.ripK.x = (2 * Math.PI) / this.lambda;
    this.ripK.y = 0;
    this.ripDir.set(water.peakDirX, water.peakDirZ, 0, 0);
    this.ripShape.x = cfg.heightRatio * this.lambda;
    this.ripShape.y = 0;
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
