import * as THREE from "three";
import { TUNING } from "../config.js";
import { seabedHeight } from "../utils.js";

/**
 * Bathymetry shared by physics and rendering. The same 256² depth samples are
 * baked once from seabedHeight(), uploaded as a texture for the GPU and kept
 * as a Float32Array for CPU bilinear queries. Physics and the vertex shader
 * therefore see the same depth field (within bilinear interpolation).
 */
export function makeBathymetry(size = 256) {
  const extent = TUNING.world.size;
  const maxDepth = 30;
  const data = new Float32Array(size * size);
  const pixels = new Uint8Array(size * size * 4);
  let p = 0;
  for (let j = 0; j < size; j++) {
    const z = ((j + 0.5) / size - 0.5) * extent;
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size - 0.5) * extent;
      const depth = Math.max(0, -seabedHeight(x, z));
      data[j * size + i] = depth;
      const v = Math.round(Math.min(1, depth / maxDepth) * 255);
      pixels[p++] = v;
      pixels[p++] = v;
      pixels[p++] = 255;
      pixels[p++] = 255;
    }
  }

  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  const sampleDepth = (x, z) => {
    // Match the GPU's texture lookup: texel centres are at (i+0.5)/size.
    let u = (x / extent + 0.5) * size - 0.5;
    let v = (z / extent + 0.5) * size - 0.5;
    u = Math.max(0, Math.min(size - 1.001, u));
    v = Math.max(0, Math.min(size - 1.001, v));
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fx = u - i0;
    const fz = v - j0;
    const i1 = i0 + 1;
    const j1 = j0 + 1;
    const d00 = data[j0 * size + i0];
    const d10 = data[j0 * size + i1];
    const d01 = data[j1 * size + i0];
    const d11 = data[j1 * size + i1];
    const a = d00 + (d10 - d00) * fx;
    const b = d01 + (d11 - d01) * fx;
    return a + (b - a) * fz;
  };

  /**
   * Local bed slope magnitude (rise/run). Used for the Iribarren breaker
   * classification; it is deliberately finite-differenced on the baked grid.
   */
  const sampleSlope = (x, z, e = 8) => {
    const hl = sampleDepth(x - e, z);
    const hr = sampleDepth(x + e, z);
    const hd = sampleDepth(x, z - e);
    const hu = sampleDepth(x, z + e);
    const gx = (hl - hr) / (2 * e);
    const gz = (hd - hu) / (2 * e);
    return Math.hypot(gx, gz);
  };

  // Float field for the wave vertex shader: R = depth (full precision, so the
  // GPU's dispersion and shoaling match the CPU exactly), G = the shoaling
  // phase delay baked by bakePhaseDelay(). Sampled with texelFetch and a
  // manual bilinear that mirrors sampleField() below.
  const phaseData = new Float32Array(size * size * 2);
  for (let i = 0; i < size * size; i++) phaseData[i * 2] = data[i];
  const delay = new Float32Array(size * size);
  const phaseTexture = new THREE.DataTexture(phaseData, size, size, THREE.RGFormat, THREE.FloatType);
  phaseTexture.wrapS = phaseTexture.wrapT = THREE.ClampToEdgeWrapping;
  phaseTexture.minFilter = THREE.NearestFilter;
  phaseTexture.magFilter = THREE.NearestFilter;
  phaseTexture.generateMipmaps = false;
  phaseTexture.colorSpace = THREE.NoColorSpace;
  phaseTexture.needsUpdate = true;

  const sampleField = (field, x, z) => {
    let u = (x / extent + 0.5) * size - 0.5;
    let v = (z / extent + 0.5) * size - 0.5;
    u = Math.max(0, Math.min(size - 1.001, u));
    v = Math.max(0, Math.min(size - 1.001, v));
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fx = u - i0;
    const fz = v - j0;
    const a = field[j0 * size + i0] + (field[j0 * size + i0 + 1] - field[j0 * size + i0]) * fx;
    const b = field[(j0 + 1) * size + i0] + (field[(j0 + 1) * size + i0 + 1] - field[(j0 + 1) * size + i0]) * fx;
    return a + (b - a) * fz;
  };
  const sampleDelay = (x, z) => sampleField(delay, x, z);

  return {
    texture,
    extent,
    maxDepth,
    data,
    size,
    sampleDepth,
    sampleSlope,
    delay,
    phaseData,
    phaseTexture,
    sampleDelay,
    _delayKey: "",
  };
}

/**
 * Shoaling phase delay. In water of depth h a wave's wavenumber grows from
 * k0 to k0 * r(h) with r = 1/sqrt(tanh(k0 h)). Scaling k by the *local* r
 * (the old approach) is only right where r is constant: across the bank's
 * slope the phase gradient picked up a spurious x * dr/dx term, so crests
 * crawled at ~3 m/s on the shoal where the true phase speed is ~5.5 m/s and
 * their spacing was wrong. Here the extra optical path is integrated along
 * the dominant travel direction instead:
 *
 *   D(p) = integral (r(h(p - t d)) - 1) dt,   phase_i = k_i (d_i . p + D(p))
 *
 * so the local wavenumber along d is k0 r and crests move at the local
 * phase speed. Refraction (turning of crests) is not modelled.
 */
export function bakePhaseDelay(bathy, k0, dirX, dirZ, enabled = true) {
  const key = `${k0.toFixed(6)}|${dirX.toFixed(5)}|${dirZ.toFixed(5)}|${enabled ? 1 : 0}`;
  if (key === bathy._delayKey) return false;
  bathy._delayKey = key;
  const { size, extent, data, delay, phaseData } = bathy;
  if (!enabled) {
    delay.fill(0);
  } else {
    const cell = extent / size;
    const step = cell * 2;
    const ratioAt = (depth) => Math.min(4.5, Math.max(0.65, 1 / Math.sqrt(Math.tanh(Math.max(1e-4, k0 * Math.max(0.3, depth))))));
    // Sweep texels in order of their position along the travel direction, so
    // every upstream sample is already known (step >= sqrt(2) texels).
    const order = new Uint32Array(size * size);
    const along = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const idx = j * size + i;
        order[idx] = idx;
        along[idx] = (i + 0.5) * dirX + (j + 0.5) * dirZ;
      }
    }
    order.sort((a, b) => along[a] - along[b]);
    const sample = (field, gx, gz) => {
      const i0 = Math.floor(gx);
      const j0 = Math.floor(gz);
      const fx = gx - i0;
      const fz = gz - j0;
      const a = field[j0 * size + i0] + (field[j0 * size + i0 + 1] - field[j0 * size + i0]) * fx;
      const b = field[(j0 + 1) * size + i0] + (field[(j0 + 1) * size + i0 + 1] - field[(j0 + 1) * size + i0]) * fx;
      return a + (b - a) * fz;
    };
    const back = step / cell;
    for (let n = 0; n < order.length; n++) {
      const idx = order[n];
      const i = idx % size;
      const j = (idx / size) | 0;
      const here = ratioAt(data[idx]) - 1;
      const gx = i - dirX * back;
      const gz = j - dirZ * back;
      if (gx < 0 || gz < 0 || gx > size - 1.001 || gz > size - 1.001) {
        // Upstream of the surveyed shelf: deep water, no delay yet.
        delay[idx] = here * step * 0.5;
        continue;
      }
      const prevDelay = sample(delay, gx, gz);
      const prevRatio = ratioAt(sample(data, gx, gz)) - 1;
      delay[idx] = prevDelay + 0.5 * (here + prevRatio) * step;
    }
  }
  for (let i = 0; i < size * size; i++) phaseData[i * 2 + 1] = delay[i];
  bathy.phaseTexture.needsUpdate = true;
  return true;
}
