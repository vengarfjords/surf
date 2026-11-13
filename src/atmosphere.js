import * as THREE from "three";
import { PALETTE } from "./config.js";

/**
 * One sky for everything above the water: the dome, the sea's reflection,
 * the horizon fog and the volumetric haze all call the same function, so the
 * water always melts into the air behind it instead of meeting a seam.
 *
 * The look is a soft dusk under high overcast: a pale, slightly cool zenith,
 * a creamy middle sky, a peach band low on the sun's side and a grey sea mist
 * on the other, with a hazy headland on part of the horizon.
 */
const lin = (hex) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;
};

export const glslSky = /* glsl */ `
  const vec3 SKY_ZENITH = ${lin(PALETTE.skyZenith)};
  const vec3 SKY_MID = ${lin(PALETTE.skyMid)};
  const vec3 SKY_MID_AWAY = ${lin(PALETTE.skyMidAway)};
  const vec3 SKY_HORIZON_SUN = ${lin(PALETTE.skyHorizon)};
  const vec3 SKY_HORIZON_AWAY = ${lin(PALETTE.skyHorizonAway)};
  const vec3 SKY_CLOUD = ${lin(PALETTE.skyCloud)};
  const vec3 SKY_LAND = ${lin(PALETTE.skyLand)};

  // 0 away from the sun, 1 toward it, measured around the horizon only.
  float skyWarmth(vec3 d, vec3 sunDir) {
    vec2 a = d.xz / max(length(d.xz), 1e-4);
    vec2 s = sunDir.xz / max(length(sunDir.xz), 1e-4);
    return pow(dot(a, s) * 0.5 + 0.5, 2.0);
  }

  // Horizon colour in a direction: what distant air and sea mist fade to.
  vec3 skyHorizonColor(vec3 d, vec3 sunDir) {
    return mix(SKY_HORIZON_AWAY, SKY_HORIZON_SUN, skyWarmth(d, sunDir));
  }

  vec3 skyGradient(vec3 d, vec3 sunDir) {
    float w = skyWarmth(d, sunDir);
    float h = max(d.y, 0.0);
    vec3 horizon = mix(SKY_HORIZON_AWAY, SKY_HORIZON_SUN, w);
    vec3 mid = mix(SKY_MID_AWAY, SKY_MID, w);
    vec3 col = mix(horizon, mid, smoothstep(0.0, 0.2, h));
    col = mix(col, SKY_ZENITH, smoothstep(0.16, 0.9, h));
    return col;
  }

  // Distant coastline: two hazy ridges over part of the horizon. The far one
  // is barely darker than the mist; the near one has a misty foot.
  float skyRidge(float az, float seed, float scale) {
    float r = vnoise(vec2(az * 5.0 + seed, seed)) * 0.6;
    r += vnoise(vec2(az * 13.0 + seed * 2.0, seed + 3.0)) * 0.3;
    r += vnoise(vec2(az * 37.0 + seed * 3.0, seed + 7.0)) * 0.1;
    return r * scale;
  }

  vec3 skyLand(vec3 d, vec3 col, vec3 horizon, float detail) {
    float az = atan(d.z, d.x);
    // Sector of the horizon the coast occupies: down-swell and toward the
    // low sun, so it sits backlit in the warm band, with soft ends that
    // taper into the sea.
    float sector = smoothstep(0.0, 0.5, az - 0.9) * smoothstep(0.0, 0.6, 2.95 - az);
    if (sector <= 0.0) return col;
    float farRidge = (0.006 + skyRidge(az, 4.0, 0.03)) * sector;
    float nearRidge = (skyRidge(az, 11.0, 0.05) - 0.012) * smoothstep(0.1, 0.6, sector);
    float y = d.y;
    // Seen directly the coast is crisp. In a reflection off a rough sea
    // (lower detail) it is smeared over a couple of degrees, so wave backs
    // never pick out its outline as dark flecks.
    float aa = mix(0.03, 0.0016, detail * detail);
    float farMask = 1.0 - smoothstep(farRidge - aa, farRidge + aa, y);
    float nearMask = 1.0 - smoothstep(nearRidge - aa, nearRidge + aa, y);
    vec3 farCol = mix(SKY_LAND, horizon, 0.62);
    vec3 nearCol = mix(SKY_LAND, horizon, 0.3);
    // Sea mist pooling at the foot of the land.
    float foot = smoothstep(0.012, -0.002, y);
    nearCol = mix(nearCol, horizon, foot * 0.75);
    farCol = mix(farCol, horizon, foot * 0.5);
    // A rough sea reflects a lobe several degrees wide, so the thin strip of
    // coast is averaged with the haze around it and only faintly darkens a
    // reflection.
    float landA = mix(0.3, 1.0, detail * detail);
    col = mix(col, farCol, farMask * step(0.0, y + 0.004) * landA);
    col = mix(col, nearCol, nearMask * step(0.0, y + 0.004) * landA);
    return col;
  }

  // Full sky. detail 0..1 scales the cloud texture (reflections use less).
  vec3 skyColor(vec3 d, vec3 sunDir, float t, float detail) {
    vec3 col = skyGradient(d, sunDir);
    vec3 horizon = skyHorizonColor(d, sunDir);
    float h = max(d.y, 0.0);

    // High overcast: broad soft decks with darker, cooler undersides, and
    // brighter breaks where the light comes through.
    vec2 cp = d.xz / (h + 0.09);
    float base = fbm2(cp * 0.55 + vec2(t * 0.0025, t * 0.001));
    float fine = fbm2(cp * 1.7 + vec2(base * 1.8 - t * 0.004, base));
    float deck = smoothstep(0.38, 0.78, base * 0.65 + fine * 0.45);
    float thin = smoothstep(0.55, 0.85, fine);
    vec3 cloud = mix(SKY_CLOUD, mix(SKY_MID, SKY_HORIZON_SUN, 0.35) * 1.02, thin * skyWarmth(d, sunDir));
    float fadeHorizon = smoothstep(0.0, 0.12, h);
    col = mix(col, cloud, deck * 0.58 * fadeHorizon * detail);
    // Long streaks of stratus low over the horizon.
    float strat = vnoise(vec2(atan(d.z, d.x) * 9.0, h * 60.0 + t * 0.002));
    col = mix(col, mix(SKY_CLOUD, horizon, 0.5), smoothstep(0.55, 0.9, strat) * (1.0 - smoothstep(0.02, 0.14, h)) * 0.35 * detail);

    // The sun is behind cloud: a wide glow, no hard disc.
    float sd = max(dot(d, sunDir), 0.0);
    vec3 sunTint = mix(SKY_HORIZON_SUN, vec3(1.0, 0.93, 0.8), 0.5);
    col += sunTint * (pow(sd, 5.0) * 0.14 + pow(sd, 28.0) * 0.22 + pow(sd, 260.0) * 0.45) * (1.0 - deck * 0.4);

    col = skyLand(d, col, horizon, detail);
    // Below the horizon the dome only ever shows as reflection: hold it at
    // the horizon colour so a rough sea never reflects "ground".
    col = mix(col, horizon, smoothstep(0.0, -0.06, d.y));
    return col;
  }
`;

/**
 * Seagrass coverage over the whole shelf, written by Seagrass.build and read
 * by the seabed shader. Under a meadow the sand becomes a dense carpet of
 * short blades; the instanced blades stand up out of it near the camera.
 * 1 texel = extent / size metres. Starts empty so the seabed works without it.
 */
export const meadowMap = {
  size: 1024,
  extent: 3000,
  data: null,
  texture: null,
  uniforms: {
    uMeadow: { value: null },
    uMeadowExtent: { value: 3000 },
  },
};
{
  const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RedFormat);
  blank.needsUpdate = true;
  meadowMap.uniforms.uMeadow.value = blank;
}

export function buildMeadowTexture(meadows, coverageAt) {
  const { size, extent } = meadowMap;
  const data = new Uint8Array(size * size);
  const texel = extent / size;
  for (const m of meadows) {
    const r = m.r * 1.25 + 4;
    const x0 = Math.max(0, Math.floor((m.x - r) / texel + size / 2));
    const x1 = Math.min(size - 1, Math.ceil((m.x + r) / texel + size / 2));
    const z0 = Math.max(0, Math.floor((m.z - r) / texel + size / 2));
    const z1 = Math.min(size - 1, Math.ceil((m.z + r) / texel + size / 2));
    for (let j = z0; j <= z1; j++) {
      const z = (j + 0.5 - size / 2) * texel;
      for (let i = x0; i <= x1; i++) {
        const x = (i + 0.5 - size / 2) * texel;
        const d = Math.hypot(x - m.x, z - m.z) / (m.r * 1.15);
        if (d >= 1) continue;
        const edge = 1 - d * d;
        const c = coverageAt(x, z) * edge * Math.min(1, 0.45 + m.density);
        const idx = j * size + i;
        const v = Math.min(255, Math.round(c * 255));
        if (v > data[idx]) data[idx] = v;
      }
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  meadowMap.data = data;
  meadowMap.texture = texture;
  meadowMap.uniforms.uMeadow.value = texture;
  return texture;
}
