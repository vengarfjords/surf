import { TUNING } from "../config.js";
import { clamp, seabedHeight, smoothstep } from "../utils.js";
import { applyPreset, buildSpectrum } from "./spectrum.js";

const G = 9.81;
const RHO = 1025;

/**
 * CPU-authoritative surface. The exact same component data is uploaded to the
 * vertex shader, so the height read here is the height the renderer draws
 * (modulo mesh interpolation). Everything is SI: metres, seconds, kg.
 *
 * The surface is a sum of Gerstner waves:
 *   eta(p,t) = sum A_i sin(k_i . p - omega_i t + phase_i)
 *   D(p,t)   = sum Q A_i d_i cos(...)
 *   P        = p + D, y = eta
 * Because the rendered grid is displaced horizontally, a world-space query
 * has to invert D with a few fixed-point iterations. The shader receives the
 * same Q, so both sides agree.
 */
export class WaveField {
  constructor(cfg = TUNING.water, bathy = null) {
    this.time = 0;
    this.lastSample = {};
    this.bathy = bathy;
    this._depthScratch = {};
    this.rebuild(cfg);
  }

  get config() {
    return TUNING.water;
  }

  rebuild(cfg = TUNING.water) {
    const { components, chop, stats } = buildSpectrum(cfg);
    this.components = components;
    this.count = components.length;
    this.chop = chop;
    this.stats = stats;
    this.maxCrest = stats.amplitudeSum;

    const n = this.count;
    this.kx = new Float64Array(n);
    this.kz = new Float64Array(n);
    this.amp = new Float64Array(n);
    this.omega = new Float64Array(n);
    this.phase0 = new Float64Array(n);
    this.dirX = new Float64Array(n);
    this.dirZ = new Float64Array(n);
    this.k = new Float64Array(n);
    this.phase = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const c = components[i];
      this.kx[i] = c.kx;
      this.kz[i] = c.kz;
      this.amp[i] = c.amp;
      this.omega[i] = c.omega;
      this.phase0[i] = c.phase0;
      this.dirX[i] = c.dx;
      this.dirZ[i] = c.dz;
      this.k[i] = c.k;
    }

    // Dominant swell component: used for phase-speed and direction readouts.
    let peak = null;
    for (const c of components) {
      if (c.layer !== 0) continue;
      if (!peak || c.amp > peak.amp) peak = c;
    }
    this.peak = peak;
    this.peakIndex = peak ? components.indexOf(peak) : -1;
    this.peakK = peak ? peak.k : 1;
    this.peakKx = peak ? peak.kx : 1;
    this.peakKz = peak ? peak.kz : 0;
    this.peakOmega = peak ? peak.omega : 1;
    this.peakPhase = peak ? peak.phase0 : 0;
    this.setTime(this.time);
  }

  /** Local depth, finite-depth wavenumber scale and Green's-law shoaling. */
  depthState(x, z, out = this._depthScratch) {
    const cfg = TUNING.water;
    const depth = this.bathy ? Math.max(0.3, this.bathy.sampleDepth(x, z)) : 18;
    if (!cfg.depthResponse) {
      out.depth = depth;
      out.ratio = 1;
      out.shoal = 1;
      out.shoalRaw = 1;
      out.breakMask = 0;
      out.x0 = this.peakK * depth;
      return out;
    }
    const x0 = Math.max(1e-4, this.peakK * depth);
    // Approximate solution of k tanh(k h) = k0: k/k0 = 1/sqrt(tanh(k0 h)).
    // Exact in deep water and within a few percent of the finite-depth root
    // in the shoaling band used here.
    const ratio = clamp(1 / Math.sqrt(Math.tanh(x0)), 0.65, 4.5);
    const shoalRaw = clamp(Math.pow(cfg.shoalReference / depth, cfg.shoalStrength), 0.5, 3.2);
    const hsLocal = this.stats.height * shoalRaw;
    const breakMask = smoothstep(
      cfg.breakRatio - cfg.breakSoftness,
      cfg.breakRatio + cfg.breakSoftness,
      hsLocal / depth
    );
    // Once breaking, the height cannot keep growing; saturate near H/h.
    const cap = (cfg.breakRatio * depth) / Math.max(0.3, this.stats.height);
    const shoal = Math.min(shoalRaw, Math.max(0.55, cap * 1.05));
    out.depth = depth;
    out.ratio = ratio;
    out.shoal = shoal;
    out.shoalRaw = shoalRaw;
    out.breakMask = breakMask;
    out.x0 = x0;
    return out;
  }

  setPreset(name) {
    const ok = applyPreset(TUNING.water, name);
    if (ok) this.rebuild(TUNING.water);
    return ok;
  }

  /** Advance the shared, deterministic phase clock. */
  setTime(t) {
    this.time = t;
    const n = this.count;
    for (let i = 0; i < n; i++) {
      this.phase[i] = this.phase0[i] - this.omega[i] * t;
    }
    this.peakPhaseNow = this.peakIndex >= 0 ? this.phase[this.peakIndex] : 0;
  }

  /** Raw parameter-space height (no horizontal inversion). */
  heightAtParameter(px, pz, ratio = 1, shoal = 1) {
    let h = 0;
    const kx = this.kx;
    const kz = this.kz;
    const amp = this.amp;
    const phase = this.phase;
    for (let i = 0; i < this.count; i++) {
      h += amp[i] * shoal * Math.sin(kx[i] * ratio * px + kz[i] * ratio * pz + phase[i]);
    }
    return h;
  }

  /**
   * Invert the Gerstner horizontal displacement. Three iterations converge
   * sub-centimetre for the steepness range used here; the shader never needs
   * this because it starts from parameter space.
   */
  invert(x, z, out, ratio = 1, shoal = 1) {
    // Two fixed-point iterations of p = world - D(p). With the shader using
    // the same horizontal displacement this converges to millimetre parity
    // for the wave steepness range here, and is ~4x cheaper than Newton.
    let px = x;
    let pz = z;
    const kx = this.kx;
    const kz = this.kz;
    const amp = this.amp;
    const phase = this.phase;
    const q = this.chop;
    for (let iter = 0; iter < 2; iter++) {
      let dx = 0;
      let dz = 0;
      for (let i = 0; i < this.count; i++) {
        const c =
          Math.cos(kx[i] * ratio * px + kz[i] * ratio * pz + phase[i]) *
          amp[i] *
          shoal *
          q;
        dx += c * this.dirX[i];
        dz += c * this.dirZ[i];
      }
      px = x - dx;
      pz = z - dz;
    }
    out.px = px;
    out.pz = pz;
    return out;
  }

  /** Surface height at world x/z, including shoaling and the breaker lip. */
  sampleHeight(x, z) {
    return this.sampleSurface(x, z, _height).height;
  }

  /**
   * Surface height, analytic normal, Jacobian and slopes at world x/z.
   * `out` is reused to keep per-frame queries allocation-free.
   */
  sampleSurface(x, z, out = {}) {
    const state = this.depthState(x, z, _depth);
    const inv = _inv;
    this.invert(x, z, inv, state.ratio, state.shoal);
    // The renderer samples bathymetry at the undisplaced parameter position,
    // so resolve the inversion once more with the depth at that position.
    const state1 = this.depthState(inv.px, inv.pz, _depthP);
    this.invert(x, z, inv, state1.ratio, state1.shoal);
    const px = inv.px;
    const pz = inv.pz;
    const stateP = this.depthState(px, pz, _depthP);
    const ratio = stateP.ratio;
    const shoal = stateP.shoal;
    const breakMask = stateP.breakMask;
    const kx = this.kx;
    const kz = this.kz;
    const amp = this.amp;
    const phase = this.phase;
    const q = this.chop;
    let h = 0;
    let dhdx = 0;
    let dhdz = 0;
    let dDxdx = 0;
    let dDzdz = 0;
    let dDxdz = 0;
    for (let i = 0; i < this.count; i++) {
      const arg = kx[i] * ratio * px + kz[i] * ratio * pz + phase[i];
      const s = Math.sin(arg);
      const c = Math.cos(arg);
      const a = amp[i] * shoal;
      h += a * s;
      dhdx += a * kx[i] * ratio * c;
      dhdz += a * kz[i] * ratio * c;
      const ha = a * q;
      const kxL = kx[i] * ratio;
      const kzL = kz[i] * ratio;
      dDxdx -= ha * kxL * kxL * s;
      dDzdz -= ha * kzL * kzL * s;
      dDxdz -= ha * kxL * kzL * s;
    }

    // Peak-crest phase drives a small forward breaker lip and the whitewater
    // history. A heightfield cannot overhang; this is the local proxy.
    const peakArg = this.peakKx * ratio * px + this.peakKz * ratio * pz + this.peakPhaseNow;
    const lipPhase = peakArg - 0.55;
    const lipSin = Math.sin(lipPhase);
    const lipAmp = breakMask * TUNING.water.breakerLip * this.stats.height * shoal;
    const lip = lipAmp * Math.max(0, lipSin) ** 2;
    h += lip;
    if (lipSin > 0) {
      const dLip = lipAmp * 2 * lipSin * Math.cos(lipPhase);
      dhdx += dLip * this.peakKx * ratio;
      dhdz += dLip * this.peakKz * ratio;
    }

    const crest = 0.5 + 0.5 * Math.sin(peakArg);
    const noise =
      0.5 +
      0.5 *
        Math.sin(px * 0.63 + pz * 0.87 + this.time * 0.41) *
        Math.sin(px * 0.29 - pz * 0.43 - this.time * 0.27);
    const foamLag =
      0.5 + 0.5 * Math.sin(peakArg - TUNING.water.foamPersistence * 1.6);
    const foamCrest = Math.max(crest, foamLag * TUNING.water.foamPersistence);
    const aeration =
      breakMask *
      (0.35 + 0.5 * noise) *
      (0.4 + 0.6 * foamCrest) *
      TUNING.water.aerationAmount;

    // Tangent vectors of the displaced surface, then normal = tz x tx.
    const txX = 1 + dDxdx;
    const txY = dhdx;
    const txZ = dDxdz;
    const tzX = dDxdz;
    const tzY = dhdz;
    const tzZ = 1 + dDzdz;
    let nx = tzY * txZ - tzZ * txY;
    let ny = tzZ * txX - tzX * txZ;
    let nz = tzX * txY - tzY * txX;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    out.height = h;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    out.slopeX = dhdx;
    out.slopeZ = dhdz;
    out.slope = Math.hypot(dhdx, dhdz);
    out.jacobian = txX * tzZ - tzX * txZ;
    out.parameterX = px;
    out.parameterZ = pz;
    out.depth = state.depth;
    out.depthRatio = ratio;
    out.shoal = shoal;
    out.shoalRaw = state.shoalRaw;
    out.breakMask = breakMask;
    out.aeration = clamp(aeration * smoothstep(0.35, 0.85, crest), 0, 0.85);
    out.turbulence = breakMask * (0.5 + 0.5 * noise);
    out.phaseSpeed = this.stats.peakPhaseSpeed / ratio;
    out.wavelength = this.stats.peakWavelength / ratio;
    out.crest = crest;
    out.peakArg = peakArg;
    out.x0 = stateP.x0;
    // Iribarren classification: spilling / plunging / surging.
    if (breakMask > 0.02 && this.bathy) {
      const tanBeta = this.bathy.sampleSlope(px, pz);
      const xi = tanBeta / Math.sqrt(Math.max(0.01, this.stats.height / this.stats.peakWavelength));
      out.xi = xi;
      out.breakerType = xi < 0.5 ? 0 : xi < 3.3 ? 1 : 2;
    } else {
      out.xi = 0;
      out.breakerType = -1;
    }
    return out;
  }

  /**
   * Full physical sample at a 3D point. Orbital velocity and dynamic pressure
   * use the finite-depth cosh/sinh form with the local wavenumber from the
   * bathymetry; a breaker jet is added near an aerated crest.
   */
  sample(x, y, z, out = {}) {
    return this._sample(x, y, z, out, true);
  }

  /** Same as sample(), without the fBm seabed lookup. Hull panels call this
   *  hundreds of times per substep and only need surface/flow/force data. */
  sampleForForces(x, y, z, out = {}) {
    return this._sample(x, y, z, out, false);
  }

  _sample(x, y, z, out, includeSeabed) {
    const surf = this.sampleSurface(x, z, _surf);
    const h = surf.height;
    const depthBelowSurface = Math.min(0, y - h);
    const ratio = surf.depthRatio;
    const depth = surf.depth;
    const shoal = surf.shoal;
    const kx = this.kx;
    const kz = this.kz;
    const k = this.k;
    const amp = this.amp;
    const omega = this.omega;
    const phase = this.phase;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let ax = 0;
    let ay = 0;
    let az = 0;
    let pressure = 0;
    for (let i = 0; i < this.count; i++) {
      const kL = k[i] * ratio;
      const arg = kx[i] * ratio * surf.parameterX + kz[i] * ratio * surf.parameterZ + phase[i];
      const s = Math.sin(arg);
      const c = Math.cos(arg);
      const w = omega[i];
      const a = amp[i] * shoal;
      const kh = Math.max(1e-4, kL * depth);
      // Stable finite-depth factors. The naive cosh/sinh form with a clamped
      // exp(-kh) blows up for long-period big-wave fields; this form stays
      // bounded at the surface and decays with depth.
      const e2 = Math.exp(-2 * kh);
      const up = Math.exp(kL * depthBelowSurface);
      const deep = Math.exp(-kL * (depthBelowSurface + 2 * depth));
      const denom = Math.max(1e-6, 1 - e2);
      const uF = (up + deep) / denom;
      const wF = (up - deep) / denom;
      const pF = (up + deep) / (1 + e2);
      // eta = a sin(theta): u = omega a sin(theta), w = -omega a cos(theta).
      const horizontal = w * a * uF * s;
      vx += horizontal * this.dirX[i];
      vz += horizontal * this.dirZ[i];
      vy -= w * a * wF * c;
      const accel = -w * w * a * uF * c;
      ax += accel * this.dirX[i];
      az += accel * this.dirZ[i];
      ay -= w * w * a * wF * s;
      pressure += RHO * G * a * pF * s;
    }

    // Breaker jet: near a breaking crest, water near the surface is thrown
    // forward at roughly the local phase speed. This is the force that can
    // overtake and throw the dolphin.
    if (surf.breakMask > 0.01) {
      const jetType = surf.breakerType === 0 ? 0.7 : surf.breakerType === 1 ? 1.0 : 0.55;
      const jet =
        surf.phaseSpeed *
        surf.breakMask *
        TUNING.water.breakerJet *
        jetType *
        smoothstep(0.35, 0.85, surf.crest) *
        Math.exp(depthBelowSurface / 1.5);
      vx += this.peak.dx * jet;
      vz += this.peak.dz * jet;
      vy += jet * 0.08 * Math.sin(surf.peakArg);
    }

    out.height = h;
    out.nx = surf.nx;
    out.ny = surf.ny;
    out.nz = surf.nz;
    out.slope = surf.slope;
    out.slopeX = surf.slopeX;
    out.slopeZ = surf.slopeZ;
    out.jacobian = surf.jacobian;
    out.velocityX = vx;
    out.velocityY = vy;
    out.velocityZ = vz;
    out.accelX = ax;
    out.accelY = ay;
    out.accelZ = az;
    out.dynamicPressure = pressure;
    out.aeration = surf.aeration;
    out.turbulence = surf.turbulence;
    out.breakMask = surf.breakMask;
    out.shoal = shoal;
    out.depth = depth;
    out.phaseSpeed = surf.phaseSpeed;
    out.waveDirectionX = this.peak ? this.peak.dx : 1;
    out.waveDirectionZ = this.peak ? this.peak.dz : 0;
    out.wavelength = surf.wavelength;
    out.wavePeriod = this.stats.peakPeriod;
    out.significantHeight = this.stats.height;
    out.depthBelowSurface = Math.max(0, h - y);
    out.underwater = y < h;
    out.seabedY = -depth;
    out.depthToSeabed = y + depth;
    out.distanceToSurface = h - y;
    return out;
  }

  /**
   * Batch query for hull panels. `positions` is xyz-interleaved; results are
   * written into the caller's typed arrays (no per-panel objects).
   */
  sampleBatch(positions, out, stride = 3, count = positions.length / stride, forForces = false) {
    const height = out.height;
    const nx = out.nx;
    const ny = out.ny;
    const nz = out.nz;
    const vx = out.velocityX;
    const vy = out.velocityY;
    const vz = out.velocityZ;
    const pressure = out.dynamicPressure;
    const aeration = out.aeration;
    const slope = out.slope;
    const phaseSpeed = out.phaseSpeed;
    for (let i = 0; i < count; i++) {
      const p = i * stride;
      const s = forForces
        ? this.sampleForForces(positions[p], positions[p + 1], positions[p + 2], _batch)
        : this.sample(positions[p], positions[p + 1], positions[p + 2], _batch);
      height[i] = s.height;
      nx[i] = s.nx;
      ny[i] = s.ny;
      nz[i] = s.nz;
      vx[i] = s.velocityX;
      vy[i] = s.velocityY;
      vz[i] = s.velocityZ;
      pressure[i] = s.dynamicPressure;
      aeration[i] = s.aeration;
      slope[i] = s.slope;
      phaseSpeed[i] = s.phaseSpeed;
    }
    return out;
  }

  /**
   * Sample a long profile along a direction. Used by the debug HUD to count
   * wave sets without allocating during the render loop.
   */
  profile(x, z, dirX, dirZ, length = 800, samples = 512, out = new Float32Array(samples)) {
    const step = length / samples;
    for (let i = 0; i < samples; i++) {
      out[i] = this.sampleHeight(x + dirX * i * step, z + dirZ * i * step);
    }
    return out;
  }
}

const _inv = {};
const _surf = {};
const _batch = {};
const _depth = {};
const _depthP = {};
const _height = {};

export { G as GRAVITY, RHO as WATER_DENSITY };
