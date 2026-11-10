import { TUNING } from "../config.js";
import { seabedHeight } from "../utils.js";
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
  constructor(cfg = TUNING.water) {
    this.time = 0;
    this.lastSample = {};
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
    this.setTime(this.time);
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
  }

  /** Raw parameter-space height (no horizontal inversion). */
  heightAtParameter(px, pz) {
    let h = 0;
    const kx = this.kx;
    const kz = this.kz;
    const amp = this.amp;
    const phase = this.phase;
    for (let i = 0; i < this.count; i++) {
      h += amp[i] * Math.sin(kx[i] * px + kz[i] * pz + phase[i]);
    }
    return h;
  }

  /**
   * Invert the Gerstner horizontal displacement. Three iterations converge
   * sub-centimetre for the steepness range used here; the shader never needs
   * this because it starts from parameter space.
   */
  invert(x, z, out) {
    let px = x;
    let pz = z;
    const kx = this.kx;
    const kz = this.kz;
    const amp = this.amp;
    const phase = this.phase;
    const q = this.chop;
    for (let iter = 0; iter < 3; iter++) {
      let dx = 0;
      let dz = 0;
      for (let i = 0; i < this.count; i++) {
        const c = Math.cos(kx[i] * px + kz[i] * pz + phase[i]) * amp[i] * q;
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

  /** Surface height at world x/z. */
  sampleHeight(x, z) {
    const inv = _inv;
    this.invert(x, z, inv);
    return this.heightAtParameter(inv.px, inv.pz);
  }

  /**
   * Surface height, analytic normal, Jacobian and slopes at world x/z.
   * `out` is reused to keep per-frame queries allocation-free.
   */
  sampleSurface(x, z, out = {}) {
    const inv = _inv;
    this.invert(x, z, inv);
    const px = inv.px;
    const pz = inv.pz;
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
      const arg = kx[i] * px + kz[i] * pz + phase[i];
      const s = Math.sin(arg);
      const c = Math.cos(arg);
      const a = amp[i];
      h += a * s;
      dhdx += a * kx[i] * c;
      dhdz += a * kz[i] * c;
      const ha = a * q;
      dDxdx -= ha * kx[i] * kx[i] * s;
      dDzdz -= ha * kz[i] * kz[i] * s;
      dDxdz -= ha * kx[i] * kz[i] * s;
    }
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
    return out;
  }

  /**
   * Full physical sample at a 3D point. Depth-dependent orbital velocity and
   * dynamic pressure use the deep-water e^(kz) decay for M1; the finite-depth
   * cosh/sinh form arrives with the bathymetry solver in M3.
   */
  sample(x, y, z, out = {}) {
    const surf = this.sampleSurface(x, z, _surf);
    const h = surf.height;
    const depthBelowSurface = Math.min(0, y - h);
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
      const arg = kx[i] * surf.parameterX + kz[i] * surf.parameterZ + phase[i];
      const decay = Math.exp(k[i] * depthBelowSurface);
      const s = Math.sin(arg);
      const c = Math.cos(arg);
      const w = omega[i];
      const a = amp[i] * decay;
      // eta = a sin(theta): u = omega a sin(theta), w = -omega a cos(theta).
      const horizontal = w * a * s;
      vx += horizontal * this.dirX[i];
      vz += horizontal * this.dirZ[i];
      vy -= w * a * c;
      const accel = -w * w * a * c;
      ax += accel * this.dirX[i];
      az += accel * this.dirZ[i];
      ay -= w * w * a * s;
      pressure += RHO * G * a * s;
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
    out.aeration = 0;
    out.turbulence = 0;
    out.phaseSpeed = this.stats.peakPhaseSpeed;
    out.waveDirectionX = this.peak ? this.peak.dx : 1;
    out.waveDirectionZ = this.peak ? this.peak.dz : 0;
    out.wavelength = this.stats.peakWavelength;
    out.wavePeriod = this.stats.peakPeriod;
    out.significantHeight = this.stats.height;
    out.depthBelowSurface = Math.max(0, h - y);
    out.underwater = y < h;
    out.seabedY = seabedHeight(x, z);
    out.depthToSeabed = y - out.seabedY;
    out.distanceToSurface = h - y;
    return out;
  }

  /**
   * Batch query for hull panels. `positions` is xyz-interleaved; results are
   * written into the caller's typed arrays (no per-panel objects).
   */
  sampleBatch(positions, out, stride = 3, count = positions.length / stride) {
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
      const s = this.sample(positions[p], positions[p + 1], positions[p + 2], _batch);
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

export { G as GRAVITY, RHO as WATER_DENSITY };
