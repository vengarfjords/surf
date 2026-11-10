import * as THREE from "three";
import { TUNING } from "../config.js";
import { seabedHeight } from "../utils.js";

/**
 * Low-resolution depth map baked from the same deterministic bathymetry the
 * sand mesh, reef placement and dolphin floor collision use. The water shader
 * only needs it for absorption / shallow colour in M1; M3 will consume the
 * same field through the solver.
 */
export function makeBathymetryTexture(size = 192) {
  const extent = TUNING.world.size;
  const data = new Uint8Array(size * size * 4);
  const maxDepth = 30;
  let p = 0;
  for (let j = 0; j < size; j++) {
    const z = (j / (size - 1) - 0.5) * extent;
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1) - 0.5) * extent;
      const depth = Math.max(0, -seabedHeight(x, z));
      const v = Math.round(Math.min(1, depth / maxDepth) * 255);
      data[p++] = v;
      data[p++] = v;
      data[p++] = v;
      data[p++] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, extent, maxDepth };
}
