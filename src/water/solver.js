import * as THREE from "three";
import { TUNING } from "../config.js";
import { clamp, smoothstep } from "../utils.js";

const G = 9.81;
const RHO = 1025;

/**
 * Local nonlinear shallow-water solver for the surf bank.
 *
 * The 3 km shelf is still represented by the spectral field; this 192 m
 * window is solved with the depth-integrated shallow-water equations:
 *
 *   eta_t + div((h+eta) u) = 0
 *   u_t + (u.grad)u + g grad(eta) + bed source = friction
 *
 * on a 160² grid at 30 Hz with Lax-Friedrichs fluxes. The open edges are
 * forced by the analytic spectral field and use a sponge layer. Breaking is
 * represented by a slope limiter, momentum damping and a persistent foam
 * scalar that is advected semi-Lagrangian and uploaded for rendering.
 *
 * This is a nonlinear shallow-water model (no Boussinesq dispersion term).
 * It is deliberately local: the bank is the only place where the spectral
 * local-k approximation is not enough, and a fixed window avoids worker
 * latency/window seams.
 */
export class SurfSolver {
  constructor(wave, bathy) {
    this.wave = wave;
    this.bathy = bathy;
    this.centerX = TUNING.water.surfZoneX;
    this.centerZ = TUNING.water.surfZoneZ;
    this.extent = TUNING.water.solverExtent;
    this.n = Math.round(TUNING.water.solverCells);
    this.dx = this.extent / this.n;
    this.rate = TUNING.water.solverRate;
    this.step = 1 / this.rate;
    this.accumulator = 0;
    this.boundaryClock = 0;
    this.enabled = TUNING.water.solverEnabled;
    this.time = 0;
    this.stats = { maxEta: 0, maxFoam: 0, breakFraction: 0, steps: 0 };

    const n = this.n;
    const count = n * n;
    this.eta = new Float32Array(count);
    this.hu = new Float32Array(count);
    this.hv = new Float32Array(count);
    this.foam = new Float32Array(count);
    this.foamNext = new Float32Array(count);
    this.bed = new Float32Array(count);
    this.etaNext = new Float32Array(count);
    this.huNext = new Float32Array(count);
    this.hvNext = new Float32Array(count);
    this.boundaryEta = new Float32Array(n * 4);
    this.fxEta = new Float32Array(count);
    this.fxHu = new Float32Array(count);
    this.fxHv = new Float32Array(count);
    this.fzEta = new Float32Array(count);
    this.fzHu = new Float32Array(count);
    this.fzHv = new Float32Array(count);

    this.textureData = new Uint8Array(count * 4);
    this.texture = new THREE.DataTexture(this.textureData, n, n, THREE.RGBAFormat);
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;

    this._sample = {};
    this._surface = {};
    this.initialize();
  }

  initialize() {
    const n = this.n;
    const originX = this.centerX - this.extent * 0.5;
    const originZ = this.centerZ - this.extent * 0.5;
    for (let j = 0; j < n; j++) {
      const z = originZ + (j + 0.5) * this.dx;
      for (let i = 0; i < n; i++) {
        const x = originX + (i + 0.5) * this.dx;
        const idx = j * n + i;
        this.bed[idx] = Math.max(0.45, this.bathy.sampleDepth(x, z));
        const s = this.wave.sampleSurface(x, z, {});
        this.eta[idx] = s.height;
        this.hu[idx] = 0;
        this.hv[idx] = 0;
        this.foam[idx] = 0;
      }
    }
    this.updateBoundary();
    this.updateTexture();
  }

  updateBoundary() {
    const n = this.n;
    const originX = this.centerX - this.extent * 0.5;
    const originZ = this.centerZ - this.extent * 0.5;
    for (let i = 0; i < n; i++) {
      const x = originX + (i + 0.5) * this.dx;
      const zLow = originZ + 0.5 * this.dx;
      const zHigh = originZ + (n - 0.5) * this.dx;
      this.boundaryEta[i] = this.wave.sampleSurface(x, zLow, {}).height;
      this.boundaryEta[n + i] = this.wave.sampleSurface(x, zHigh, {}).height;
    }
    for (let j = 0; j < n; j++) {
      const z = originZ + (j + 0.5) * this.dx;
      const xLow = originX + 0.5 * this.dx;
      const xHigh = originX + (n - 0.5) * this.dx;
      this.boundaryEta[2 * n + j] = this.wave.sampleSurface(xLow, z, {}).height;
      this.boundaryEta[3 * n + j] = this.wave.sampleSurface(xHigh, z, {}).height;
    }
  }

  update(dt, time) {
    if (!this.enabled) return;
    this.time = time;
    this.boundaryClock += dt;
    if (this.boundaryClock > 0.25) {
      this.boundaryClock = 0;
      this.updateBoundary();
    }
    this.accumulator = Math.min(this.accumulator + dt, 0.25);
    let steps = 0;
    while (this.accumulator >= this.step && steps < 8) {
      this.accumulator -= this.step;
      this._step(this.step);
      steps++;
    }
    if (steps > 0) this.updateTexture();
  }

  _computeFluxes() {
    const n = this.n;
    const count = n * n;
    const eta = this.eta;
    const hu = this.hu;
    const hv = this.hv;
    const bed = this.bed;
    const fxEta = this.fxEta;
    const fxHu = this.fxHu;
    const fxHv = this.fxHv;
    const fzEta = this.fzEta;
    const fzHu = this.fzHu;
    const fzHv = this.fzHv;
    for (let idx = 0; idx < count; idx++) {
      const h = Math.max(0.08, bed[idx] + eta[idx]);
      const u = hu[idx] / h;
      const v = hv[idx] / h;
      const pressure = 0.5 * G * h * h;
      fxEta[idx] = hu[idx];
      fxHu[idx] = hu[idx] * u + pressure;
      fxHv[idx] = hv[idx] * u;
      fzEta[idx] = hv[idx];
      fzHu[idx] = hu[idx] * v;
      fzHv[idx] = hv[idx] * v + pressure;
    }
  }

  _step(dt) {
    const n = this.n;
    const dx = this.dx;
    const eta = this.eta;
    const hu = this.hu;
    const hv = this.hv;
    const bed = this.bed;
    const etaNext = this.etaNext;
    const huNext = this.huNext;
    const hvNext = this.hvNext;
    const sponge = TUNING.water.solverSpongeCells;
    const breakSlope = TUNING.water.solverBreakSlope;
    const inv2dx = 1 / (2 * dx);
    let breakCount = 0;

    this._computeFluxes();
    const fxEta = this.fxEta;
    const fxHu = this.fxHu;
    const fxHv = this.fxHv;
    const fzEta = this.fzEta;
    const fzHu = this.fzHu;
    const fzHv = this.fzHv;

    for (let j = 0; j < n; j++) {
      const jm = Math.max(0, j - 1);
      const jp = Math.min(n - 1, j + 1);
      for (let i = 0; i < n; i++) {
        const im = Math.max(0, i - 1);
        const ip = Math.min(n - 1, i + 1);
        const idx = j * n + i;
        const e = eta[idx];
        const h = Math.max(0.08, bed[idx] + e);
        const u = hu[idx] / h;
        const v = hv[idx] / h;

        const idxW = j * n + im;
        const idxE = j * n + ip;
        const idxS = jm * n + i;
        const idxN = jp * n + i;

        const eAvg = 0.25 * (eta[idxW] + eta[idxE] + eta[idxS] + eta[idxN]);
        const huAvg = 0.25 * (hu[idxW] + hu[idxE] + hu[idxS] + hu[idxN]);
        const hvAvg = 0.25 * (hv[idxW] + hv[idxE] + hv[idxS] + hv[idxN]);

        const divEta = (fxEta[idxE] - fxEta[idxW] + fzEta[idxN] - fzEta[idxS]) * inv2dx;
        const divHu = (fxHu[idxE] - fxHu[idxW] + fzHu[idxN] - fzHu[idxS]) * inv2dx;
        const divHv = (fxHv[idxE] - fxHv[idxW] + fzHv[idxN] - fzHv[idxS]) * inv2dx;
        const bedSX = (bed[j * n + ip] - bed[j * n + im]) * inv2dx;
        const bedSZ = (bed[jp * n + i] - bed[jm * n + i]) * inv2dx;

        let ne = eAvg - dt * divEta;
        let nhu = huAvg - dt * divHu - dt * G * h * bedSX;
        let nhv = hvAvg - dt * divHv - dt * G * h * bedSZ;

        // Bottom friction.
        const speed = Math.hypot(u, v);
        const friction = clamp(0.012 * speed / Math.max(0.4, h), 0, 0.6);
        nhu *= 1 - friction * dt;
        nhv *= 1 - friction * dt;

        // Breaking: steep faces lose momentum and diffuse the crest.
        const sx = (eta[j * n + ip] - eta[j * n + im]) * inv2dx;
        const sz = (eta[jp * n + i] - eta[jm * n + i]) * inv2dx;
        const slope = Math.hypot(sx, sz);
        const breaking = smoothstep(breakSlope * 0.7, breakSlope * 1.15, slope);
        if (breaking > 0.01) {
          breakCount++;
          nhu *= 1 - breaking * 0.35 * dt;
          nhv *= 1 - breaking * 0.35 * dt;
          const avg = 0.25 * (eta[j * n + im] + eta[j * n + ip] + eta[jm * n + i] + eta[jp * n + i]);
          ne += (avg - ne) * breaking * 0.12;
        }

        // Sponge and open-boundary relaxation.
        const edge = Math.min(i, n - 1 - i, j, n - 1 - j);
        if (edge < sponge) {
          const damp = 1 - (1 - edge / sponge) * 0.24 * dt * 30;
          nhu *= damp;
          nhv *= damp;
        }
        if (edge <= 1) {
          let boundary = 0;
          if (j === 0) boundary = this.boundaryEta[i];
          else if (j === n - 1) boundary = this.boundaryEta[n + i];
          else if (i === 0) boundary = this.boundaryEta[2 * n + j];
          else if (i === n - 1) boundary = this.boundaryEta[3 * n + j];
          ne = ne * 0.35 + boundary * 0.65;
          nhu = 0;
          nhv = 0;
        }

        etaNext[idx] = ne;
        huNext[idx] = nhu;
        hvNext[idx] = nhv;
      }
    }

    eta.set(etaNext);
    hu.set(huNext);
    hv.set(hvNext);

    // Advect and decay foam; source from the local breaking fraction.
    const foam = this.foam;
    const foamNext = this.foamNext;
    const decay = Math.exp(-TUNING.water.solverFoamDecay * dt);
    const source = TUNING.water.solverFoamSource;
    let maxFoam = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const h = Math.max(0.08, bed[idx] + eta[idx]);
        const u = hu[idx] / h;
        const v = hv[idx] / h;
        const px = i - (u * dt) / dx;
        const pz = j - (v * dt) / dx;
        const ci = Math.max(0, Math.min(n - 1.001, px));
        const cj = Math.max(0, Math.min(n - 1.001, pz));
        const i0 = Math.floor(ci);
        const j0 = Math.floor(cj);
        const fx = ci - i0;
        const fz = cj - j0;
        const a = foam[j0 * n + i0];
        const b = foam[j0 * n + i0 + 1];
        const c = foam[(j0 + 1) * n + i0];
        const d = foam[(j0 + 1) * n + i0 + 1];
        const advected = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
        const sx = (eta[j * n + Math.min(n - 1, i + 1)] - eta[j * n + Math.max(0, i - 1)]) / (2 * dx);
        const sz = (eta[Math.min(n - 1, j + 1) * n + i] - eta[Math.max(0, j - 1) * n + i]) / (2 * dx);
        const breaking = smoothstep(breakSlope * 0.7, breakSlope * 1.15, Math.hypot(sx, sz));
        const value = clamp(advected * decay + breaking * source * dt, 0, 1);
        foamNext[idx] = value;
        if (value > maxFoam) maxFoam = value;
      }
    }
    foam.set(foamNext);

    this.stats.maxFoam = maxFoam;
    this.stats.breakFraction = breakCount / (n * n);
    this.stats.steps++;
  }

  updateTexture() {
    const n = this.n;
    const data = this.textureData;
    const bed = this.bed;
    let maxEta = 0;
    let p = 0;
    for (let i = 0; i < n * n; i++) {
      const eta = this.eta[i];
      const h = Math.max(0.1, bed[i] + eta);
      const u = this.hu[i] / h;
      const v = this.hv[i] / h;
      data[p++] = Math.round(clamp((eta + 3) / 6, 0, 1) * 255);
      data[p++] = Math.round(clamp(this.foam[i], 0, 1) * 255);
      data[p++] = Math.round(clamp((u + 8) / 16, 0, 1) * 255);
      data[p++] = Math.round(clamp((v + 8) / 16, 0, 1) * 255);
      const ae = Math.abs(eta);
      if (ae > maxEta) maxEta = ae;
    }
    this.stats.maxEta = maxEta;
    this.texture.needsUpdate = true;
  }

  /** Bilinear solver sample at a world position. */
  sample(x, z, out = this._sample) {
    const n = this.n;
    const ox = this.centerX - this.extent * 0.5;
    const oz = this.centerZ - this.extent * 0.5;
    const gx = (x - ox) / this.dx - 0.5;
    const gz = (z - oz) / this.dx - 0.5;
    const u = clamp(gx / (n - 1), 0, 1);
    const v = clamp(gz / (n - 1), 0, 1);
    const edge = Math.min(u, 1 - u, v, 1 - v);
    const mask = smoothstep(0.0, 0.045, edge);
    if (mask <= 0.001) {
      out.mask = 0;
      return out;
    }
    const ci = Math.max(0, Math.min(n - 1.001, gx));
    const cj = Math.max(0, Math.min(n - 1.001, gz));
    const i0 = Math.floor(ci);
    const j0 = Math.floor(cj);
    const fx = ci - i0;
    const fz = cj - j0;
    const i1 = Math.min(n - 1, i0 + 1);
    const j1 = Math.min(n - 1, j0 + 1);
    const samp = (arr) => {
      const a = arr[j0 * n + i0];
      const b = arr[j0 * n + i1];
      const c = arr[j1 * n + i0];
      const d = arr[j1 * n + i1];
      return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
    };
    const eta = samp(this.eta);
    const bed = samp(this.bed);
    const foam = samp(this.foam);
    const hu = samp(this.hu);
    const hv = samp(this.hv);
    const h = Math.max(0.1, bed + eta);
    const sx = (this.eta[j0 * n + i1] - this.eta[j0 * n + i0]) / this.dx;
    const sz = (this.eta[j1 * n + i0] - this.eta[j0 * n + i0]) / this.dx;

    out.mask = mask;
    out.eta = eta;
    out.bed = bed;
    out.foam = foam;
    out.u = hu / h;
    out.v = hv / h;
    out.h = h;
    out.slopeX = sx;
    out.slopeZ = sz;
    out.slope = Math.hypot(sx, sz);
    out.phaseSpeed = Math.sqrt(G * Math.max(0.5, h));
    return out;
  }

  surfaceSample(x, z, out = this._surface) {
    const s = this.sample(x, z, this._sample);
    if (s.mask <= 0.001) return null;
    const len = Math.hypot(s.slopeX, 1, s.slopeZ) || 1;
    out.height = s.eta;
    out.nx = -s.slopeX / len;
    out.ny = 1 / len;
    out.nz = -s.slopeZ / len;
    out.slopeX = s.slopeX;
    out.slopeZ = s.slopeZ;
    out.slope = s.slope;
    out.jacobian = 1;
    out.depth = s.bed;
    out.depthRatio = 1;
    out.shoal = 1;
    out.shoalRaw = 1;
    out.breakMask = s.foam;
    out.aeration = s.foam * 0.85;
    out.turbulence = s.foam;
    out.phaseSpeed = s.phaseSpeed;
    out.wavelength = this.wave.stats.peakWavelength;
    out.crest = clamp(s.eta / 1.5, -1, 1);
    out.peakArg = 0;
    out.xi = 0;
    out.breakerType = s.foam > 0.2 ? 1 : -1;
    out.solverMask = s.mask;
    out.solverActive = s.mask > 0.5;
    out.solverU = s.u;
    out.solverV = s.v;
    return out;
  }

  sample3D(x, y, z, out = {}) {
    const s = this.surfaceSample(x, z, this._surface);
    if (!s) return null;
    const depthBelow = Math.min(0, y - s.height);
    out.height = s.height;
    out.nx = s.nx;
    out.ny = s.ny;
    out.nz = s.nz;
    out.slope = s.slope;
    out.slopeX = s.slopeX;
    out.slopeZ = s.slopeZ;
    out.jacobian = 1;
    out.velocityX = s.solverU;
    out.velocityY = -(s.solverU * s.slopeX + s.solverV * s.slopeZ) * Math.exp(depthBelow / 3);
    out.velocityZ = s.solverV;
    out.accelX = -G * s.slopeX;
    out.accelY = 0;
    out.accelZ = -G * s.slopeZ;
    out.dynamicPressure = RHO * G * s.height;
    out.aeration = s.aeration;
    out.turbulence = s.turbulence;
    out.breakMask = s.breakMask;
    out.phaseSpeed = s.phaseSpeed;
    out.waveDirectionX = s.solverU >= 0 ? 1 : -1;
    out.waveDirectionZ = 0;
    out.wavelength = s.wavelength;
    out.wavePeriod = this.wave.stats.peakPeriod;
    out.significantHeight = this.wave.stats.height;
    out.depthBelowSurface = Math.max(0, s.height - y);
    out.underwater = y < s.height;
    out.seabedY = -s.depth;
    out.depthToSeabed = y + s.depth;
    out.distanceToSurface = s.height - y;
    out.solverMask = s.solverMask;
    return out;
  }
}
