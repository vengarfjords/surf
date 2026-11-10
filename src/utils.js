import * as THREE from "three";
import { PALETTE, TUNING } from "./config.js";

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a, b, x) => {
  const t = invLerp(a, b, x);
  return t * t * (3 - 2 * t);
};
export const damp = (current, target, lambda, dt) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));
export const dampVec3 = (current, target, lambda, dt) => {
  const k = 1 - Math.exp(-lambda * dt);
  current.x += (target.x - current.x) * k;
  current.y += (target.y - current.y) * k;
  current.z += (target.z - current.z) * k;
  return current;
};
export const wrapAngle = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x, y) {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

function smoothNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

export function noise2(x, y) {
  let n = 0;
  let amp = 0.55;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < 4; i++) {
    n += smoothNoise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return n / norm;
}

export function fbm(x, y, octaves = 4, lacunarity = 2.02, gain = 0.5) {
  let n = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    n += smoothNoise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return n / norm;
}

/**
 * Reef focus multiplier for the big-wave bank. The swell grows from the open
 * shelf value to `surfFocus` at the bank centre with a Gaussian footprint.
 * Shared by the CPU field, foam field and shader uniforms.
 */
export function surfFocusAt(x, z, cfg) {
  const dx = x - cfg.surfZoneX;
  const dz = z - cfg.surfZoneZ;
  const wx = Math.cos(cfg.swellDirection);
  const wz = Math.sin(cfg.swellDirection);
  const cross = dx * wx + dz * wz;
  const along = -dx * wz + dz * wx;
  const crossOff = cross - cfg.surfRidgeCross;
  const width = Math.max(1, cfg.surfFocusWidth);
  const length = Math.max(1, cfg.surfFocusRadius);
  // Keep the amplified break on the seaward face of the ridge; the lee side
  // only gets a quarter of the focus so the wave does not break twice.
  const gate = 1 - 0.9 * smoothstep(0, 40, crossOff);
  return (
    1 +
    (cfg.surfFocus - 1) *
      Math.exp(-(crossOff * crossOff) / (width * width) - (along * along) / (length * length)) *
      gate
  );
}

/**
 * Deterministic neritic bathymetry. Shallow eelgrass flats, sand bars, and
 * deeper tidal channels. Shared by the renderer, collision, sand sim and reef
 * placement, so the world stays coherent everywhere.
 */
export function seabedHeight(x, z) {
  const broad = fbm(x * 0.00105 + 13.2, z * 0.00105 - 7.7, 4);
  const mid = fbm(x * 0.0042 - 4.1, z * 0.0042 + 9.3, 3);
  const fine = fbm(x * 0.021 + 1.7, z * 0.021 - 3.4, 2);

  // A couple of broad tidal channels wander through the shelf.
  const channelNoise = fbm(x * 0.00135 + 31.7, z * 0.00135 - 12.4, 3);
  const channel = Math.pow(Math.max(0, channelNoise - 0.53) * 2.35, 2.1) * 9.5;

  // A pale sandbar sits beneath the opening shot.
  const bar =
    Math.exp(-((x - 2) * (x - 2) + (z - 26) * (z - 26)) / 4800) * 2.4 +
    Math.exp(-((x + 34) * (x + 34) + (z - 78) * (z - 78)) / 9500) * 1.35;

  // A directional deep-water big-wave ridge, aligned across the dominant
  // swell. The seaward face rises out of a ~45 m basin; the lee side stays
  // deep so the swell breaks once, along one long wall, instead of ringing a
  // circular shoal. The ridge follows the surf-arena config.
  const swx = Math.cos(TUNING.water.swellDirection);
  const swz = Math.sin(TUNING.water.swellDirection);
  const dsx = x - TUNING.water.surfZoneX;
  const dsz = z - TUNING.water.surfZoneZ;
  const sCross = dsx * swx + dsz * swz;
  const sAlong = -dsx * swz + dsz * swx;
  const sCrossOff = sCross - TUNING.water.surfRidgeCross;
  const ridgeWidth = sCrossOff < 0 ? 30 : 20;
  const surfRidge =
    Math.exp(-(sCrossOff * sCrossOff) / (2 * ridgeWidth * ridgeWidth)) *
    Math.exp(-(sAlong * sAlong) / (2 * 150 * 150)) *
    48;
  const surfBasin =
    Math.exp(-((sCross + 120) * (sCross + 120) + sAlong * sAlong) / (2 * 120 * 120)) * 38;

  // Patchy reef shelf outcrops, slight raised humps.
  const shelf = Math.max(0, fbm(x * 0.0072 + 51.1, z * 0.0072 + 4.4, 2) - 0.5) * 2.7;

  const radius = Math.max(Math.abs(x), Math.abs(z));
  const openWater = smoothstep(1120, 1510, radius) * 14;

  const depth =
    7.15 +
    broad * 6.4 +
    mid * 2.1 +
    fine * 0.6 +
    channel +
    surfBasin -
    bar -
    shelf -
    surfRidge +
    openWater;
  return -Math.max(2.55, depth);
}

// Cached palette colors: the sand mesh rebuilds call this per vertex, and
// allocating three Colors per vertex was a major source of recenter stalls.
const SAND_LIGHT = new THREE.Color(PALETTE.sandLight);
const SAND_SHADE = new THREE.Color(PALETTE.sandShade);
const SAND_WET = new THREE.Color(PALETTE.sandWet);
const SAND_GREEN = new THREE.Color(0x435f4c);

export function sandColor(x, z, y, out = new THREE.Color()) {
  const broad = fbm(x * 0.0034 + 7.3, z * 0.0034 - 2.1, 4);
  const patch = fbm(x * 0.012 - 9.1, z * 0.012 + 3.7, 3);
  const depth = -y;
  out.copy(SAND_LIGHT).lerp(SAND_SHADE, clamp(broad * 0.75 + patch * 0.3, 0, 1));
  out.lerp(SAND_WET, smoothstep(6, 21, depth) * 0.38);
  if (patch < 0.38) {
    out.lerp(SAND_GREEN, (0.38 - patch) * 0.9);
  }
  return out;
}

export function seabedNormal(x, z, out = { x: 0, y: 1, z: 0 }) {
  const e = 0.8;
  const hl = seabedHeight(x - e, z);
  const hr = seabedHeight(x + e, z);
  const hd = seabedHeight(x, z - e);
  const hu = seabedHeight(x, z + e);
  out.x = hl - hr;
  out.y = e * 2;
  out.z = hd - hu;
  const l = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= l;
  out.y /= l;
  out.z /= l;
  return out;
}

export const glslNoise = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm2(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      v += vnoise(p) * amp;
      p = p * 2.03 + 7.1;
      amp *= 0.5;
    }
    return v;
  }
`;

export const glslCaustics = /* glsl */ `
  // Domain-warped refracted sunlight. This is the classic iterated inverse
  // distance construction: sharp filaments with soft, moving cells.
  float causticNetwork(vec2 p, float t) {
    vec2 uv = p * 0.18;
    vec2 q = mod(uv * 6.2831853, 6.2831853) - 250.0;
    vec2 i = q;
    float c = 1.0;
    float inten = 0.005;
    for (int n = 0; n < 3; n++) {
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = q + vec2(
        cos(tt - i.x) + sin(tt + i.y),
        sin(tt - i.y) + cos(tt + i.x)
      );
      c += 1.0 / length(vec2(
        q.x / (sin(i.x + tt) / inten),
        q.y / (cos(i.y + tt) / inten)
      ));
    }
    c /= 3.0;
    c = 1.17 - pow(c, 1.35);
    float m = clamp(abs(c) / 0.48, 0.0, 1.6);
    return min(2.4, pow(m, 2.25) * 2.25);
  }
`;

export const glslFog = /* glsl */ `
  vec3 applyWaterFog(vec3 color, float dist, vec3 fogColor, float density) {
    float f = 1.0 - exp(-density * density * dist * dist);
    return mix(color, fogColor, clamp(f, 0.0, 1.0));
  }
`;

export function makeSandTextures() {
  // A muted, slightly damp mineral color map and a small ripple normal map.
  // They are procedural so the build has no exterior asset dependencies.
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const rnd = mulberry32(7143);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const grain = rnd() * 24 - 12;
      const n =
        (smoothNoise(x * 0.021, y * 0.021) - 0.5) * 34 +
        (smoothNoise(x * 0.11 + 20, y * 0.11) - 0.5) * 12;
      const ripple = Math.sin(x * 0.19 + Math.sin(y * 0.04) * 2.2) * 4;
      const v = 167 + grain + n + ripple;
      img.data[i] = v + 14;
      img.data[i + 1] = v + 5;
      img.data[i + 2] = v - 20;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const color = c;

  const nCanvas = document.createElement("canvas");
  nCanvas.width = nCanvas.height = size;
  const nctx = nCanvas.getContext("2d");
  const nImg = nctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n0 = smoothNoise(x * 0.025, y * 0.025) * 0.6 + smoothNoise(x * 0.07, y * 0.07) * 0.4;
      const nx = smoothNoise(x * 0.025 + 2, y * 0.025) - n0;
      const ny = smoothNoise(x * 0.025, y * 0.025 + 2) - n0;
      nImg.data[i] = 128 + nx * 90;
      nImg.data[i + 1] = 128 + ny * 90;
      nImg.data[i + 2] = 232;
      nImg.data[i + 3] = 255;
    }
  }
  nctx.putImageData(nImg, 0, 0);

  return { color, normal: nCanvas };
}

export function canvasTexture(canvas, repeat = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 2;
  return t;
}

export function formatCoord(v) {
  return `${v >= 0 ? "E" : "W"}${Math.abs(v).toFixed(0).padStart(4, "0")}`;
}

export function timecode(seconds, fps = 24) {
  const f = Math.floor((seconds % 1) * fps);
  const s = Math.floor(seconds) % 60;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600) % 24;
  return [h, m, s, f].map((n) => String(n).padStart(2, "0")).join(":");
}
