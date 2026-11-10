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
  const maxDepth = 60;
  const data = new Float32Array(size * size);
  const pixels = new Uint16Array(size * size * 4);
  let p = 0;
  for (let j = 0; j < size; j++) {
    const z = ((j + 0.5) / size - 0.5) * extent;
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size - 0.5) * extent;
      const depth = Math.max(0, -seabedHeight(x, z));
      data[j * size + i] = depth;
      const norm = Math.min(1, depth / maxDepth);
      pixels[p++] = THREE.DataUtils.toHalfFloat(norm);
      pixels[p++] = 0;
      pixels[p++] = 0;
      pixels[p++] = THREE.DataUtils.toHalfFloat(1);
    }
  }

  const texture = new THREE.DataTexture(
    pixels,
    size,
    size,
    THREE.RGBAFormat,
    THREE.HalfFloatType
  );
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

  return { texture, extent, maxDepth, data, size, sampleDepth, sampleSlope };
}
