import * as THREE from "three";
import { TUNING } from "../config.js";
import { clamp, smoothstep } from "../utils.js";

/**
 * Persistent surf-zone foam/aeration state.
 *
 * A 96² field over the 192 m surf bank is advected by the dominant orbital
 * velocity, sourced from the analytic breaking mask/crest phase, and decayed.
 * It is uploaded as a texture for the ocean shader and sampled bilinearly by
 * the physics query, so foam visible on the surface also reduces hull buoyancy
 * and thrust. It deliberately does not move the surface height; the M3
 * breaking profile and spectral swell remain authoritative for geometry.
 */
export class FoamField {
  constructor(wave, bathy) {
    this.wave = wave;
    this.bathy = bathy;
    this.centerX = TUNING.water.surfZoneX;
    this.centerZ = TUNING.water.surfZoneZ;
    this.extent = TUNING.water.foamFieldExtent;
    this.n = Math.round(TUNING.water.foamFieldCells);
    this.dx = this.extent / this.n;
    this.rate = TUNING.water.foamFieldRate;
    this.step = 1 / this.rate;
    this.accumulator = 0;
    this.enabled = TUNING.water.foamFieldEnabled;
    this.time = 0;
    this.stats = { maxFoam: 0, meanFoam: 0, steps: 0 };

    const n = this.n;
    const count = n * n;
    this.bed = new Float32Array(count);
    this.foam = new Float32Array(count);
    this.next = new Float32Array(count);
    this.data = new Uint8Array(count * 4);
    this.texture = new THREE.DataTexture(this.data, n, n, THREE.RGBAFormat);
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;

    this._bakeBed();
    this._sample = {};
    this.updateTexture();
  }

  _bakeBed() {
    const n = this.n;
    const originX = this.centerX - this.extent * 0.5;
    const originZ = this.centerZ - this.extent * 0.5;
    for (let j = 0; j < n; j++) {
      const z = originZ + (j + 0.5) * this.dx;
      for (let i = 0; i < n; i++) {
        const x = originX + (i + 0.5) * this.dx;
        this.bed[j * n + i] = Math.max(0.35, this.bathy.sampleDepth(x, z));
      }
    }
  }

  /**
   * Keep the field over (x, z). In a storm the sea breaks along the whole
   * shelf edge, not only on the reef, so the field travels with the view.
   * It moves in whole cells once the point is an eighth of the field off
   * centre, and the foam already on the water stays where it is.
   */
  follow(x, z) {
    const n = this.n;
    const si = Math.round((x - this.centerX) / this.dx);
    const sj = Math.round((z - this.centerZ) / this.dx);
    const reach = n / 8;
    if (Math.abs(si) < reach && Math.abs(sj) < reach) return false;
    const foam = this.foam;
    const next = this.next;
    next.fill(0);
    if (Math.abs(si) < n && Math.abs(sj) < n) {
      for (let j = Math.max(0, -sj); j < Math.min(n, n - sj); j++) {
        const from = (j + sj) * n;
        const to = j * n;
        for (let i = Math.max(0, -si); i < Math.min(n, n - si); i++) next[to + i] = foam[from + i + si];
      }
    }
    foam.set(next);
    this.centerX += si * this.dx;
    this.centerZ += sj * this.dx;
    this._bakeBed();
    this.updateTexture();
    return true;
  }

  update(dt, time) {
    if (!this.enabled) return;
    this.time = time;
    this.accumulator = Math.min(this.accumulator + dt, 0.25);
    let steps = 0;
    while (this.accumulator >= this.step && steps < 4) {
      this.accumulator -= this.step;
      this._step(this.step);
      steps++;
    }
    if (steps) this.updateTexture();
  }

  _step(dt) {
    const n = this.n;
    const dx = this.dx;
    const foam = this.foam;
    const next = this.next;
    const bed = this.bed;
    const wave = this.wave;
    const cfg = TUNING.water;
    const peak = wave.peak;
    const omega = wave.peakOmega;
    const amp = peak ? peak.amp : 0.4;
    const kx = wave.peakKx;
    const kz = wave.peakKz;
    const phase = wave.peakPhaseNow;
    const dirX = peak ? peak.dx : 1;
    const dirZ = peak ? peak.dz : 0;
    const drift = 0.12 * wave.stats.peakPhaseSpeed;
    const decay = Math.exp(-cfg.foamFieldDecay * dt);
    const source = cfg.foamFieldSource;
    const originX = this.centerX - this.extent * 0.5;
    const originZ = this.centerZ - this.extent * 0.5;

    for (let j = 0; j < n; j++) {
      const z = originZ + (j + 0.5) * dx;
      for (let i = 0; i < n; i++) {
        const x = originX + (i + 0.5) * dx;
        const idx = j * n + i;
        const depth = bed[idx];
        const shoal =
          clamp(Math.pow(cfg.shoalReference / depth, cfg.shoalStrength), 0.5, 3.2) * wave.focusAt(x, z);
        const localH = wave.stats.height * shoal;
        const breaking = smoothstep(cfg.breakRatio - cfg.breakSoftness, cfg.breakRatio + cfg.breakSoftness, localH / depth);
        const delay = cfg.depthResponse ? this.bathy.sampleDelay(x, z) : 0;
        const arg = kx * x + kz * z + wave.peakK * delay + phase;
        const crest = 0.5 + 0.5 * Math.sin(arg);
        // Source only across the break onset, not the saturated shallow bank:
        // the analytic field already paints broad whitewater there. The band
        // peaks where breakMask ~ 0.5 and the advected foam drifts onshore.
        const breakBand = breaking * (1 - breaking) * 4;
        const patch =
          (0.5 + 0.5 * Math.sin(x * 0.23 + z * 0.31 + this.time * 0.21)) *
          (0.5 + 0.5 * Math.sin(z * 0.19 - x * 0.13 - this.time * 0.17));
        const src = breakBand * smoothstep(0.2, 0.85, crest) * source * (0.45 + 0.55 * patch);

        // Orbital advection plus a small onshore drift and cross-wave swirl.
        const wobble = 0.38;
        const u =
          Math.sin(arg) * omega * amp * 0.65 * dirX +
          drift * dirX +
          wobble * Math.sin(z * 0.23 + this.time * 0.37) * Math.cos(x * 0.11 - this.time * 0.19);
        const v =
          Math.sin(arg) * omega * amp * 0.65 * dirZ +
          drift * dirZ +
          wobble * Math.sin(x * 0.19 - this.time * 0.31) * Math.cos(z * 0.13 + this.time * 0.23);

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
        const top = a + (b - a) * fx;
        const bot = c + (d - c) * fx;
        const advected = top + (bot - top) * fz;
        next[idx] = clamp(advected * decay + src * dt, 0, 1);
      }
    }
    // A touch of lateral mixing keeps the semi-Lagrangian streaks from
    // collapsing into one-cell scan lines.
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const idx = j * n + i;
        const avg = 0.25 * (next[idx - 1] + next[idx + 1] + next[idx - n] + next[idx + n]);
        next[idx] += (avg - next[idx]) * 0.16;
      }
    }
    foam.set(next);
    this.stats.steps++;
  }

  updateTexture() {
    const n = this.n;
    const data = this.data;
    const foam = this.foam;
    let max = 0;
    let sum = 0;
    let p = 0;
    for (let i = 0; i < n * n; i++) {
      const f = foam[i];
      data[p++] = Math.round(f * 255);
      data[p++] = Math.round(clamp(f * 1.4, 0, 1) * 255);
      data[p++] = 0;
      data[p++] = 255;
      sum += f;
      if (f > max) max = f;
    }
    this.stats.maxFoam = max;
    this.stats.meanFoam = sum / (n * n);
    this.texture.needsUpdate = true;
  }

  /** Bilinear foam at world x/z; returns {foam, mask}. */
  sample(x, z, out = this._sample) {
    const n = this.n;
    const ox = this.centerX - this.extent * 0.5;
    const oz = this.centerZ - this.extent * 0.5;
    const gx = (x - ox) / this.dx - 0.5;
    const gz = (z - oz) / this.dx - 0.5;
    const u = gx / (n - 1);
    const v = gz / (n - 1);
    const edge = Math.min(u, 1 - u, v, 1 - v);
    const mask = smoothstep(0.0, 0.055, edge);
    if (mask <= 0.001) {
      out.foam = 0;
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
    const a = this.foam[j0 * n + i0];
    const b = this.foam[j0 * n + i1];
    const c = this.foam[j1 * n + i0];
    const d = this.foam[j1 * n + i1];
    const top = a + (b - a) * fx;
    const bot = c + (d - c) * fx;
    out.foam = Math.max(0, Math.min(1, (top + (bot - top) * fz) * mask));
    out.mask = mask;
    return out;
  }

  /** A random cell with significant foam, used to seed breaker spray. */
  randomActive() {
    const n = this.n;
    const count = n * n;
    for (let attempt = 0; attempt < 12; attempt++) {
      const idx = (Math.random() * count) | 0;
      const f = this.foam[idx];
      if (f < 0.3) continue;
      const i = idx % n;
      const j = (idx / n) | 0;
      return {
        x: this.centerX - this.extent * 0.5 + (i + 0.5) * this.dx,
        z: this.centerZ - this.extent * 0.5 + (j + 0.5) * this.dx,
        foam: f,
      };
    }
    return null;
  }
}
