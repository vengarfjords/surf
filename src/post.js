import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { PALETTE, SUN_DIRECTION, TUNING } from "./config.js";
import { glslCaustics, glslNoise } from "./utils.js";
import { glslSky } from "./atmosphere.js";

const FilmShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uUnderwater: { value: 1 },
    uWetness: { value: 0 },
    uSpeed: { value: 0 },
    uGrain: { value: TUNING.visuals.grain },
    uAberration: { value: TUNING.visuals.aberration },
    uVignette: { value: TUNING.visuals.vignette },
    uPixelRatio: { value: 1 },
    uSunScreen: { value: new THREE.Vector2(0.5, 1.1) },
    uSunPower: { value: 0 },
    uDropSeed: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uUnderwater;
    uniform float uWetness;
    uniform float uSpeed;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uPixelRatio;
    uniform vec2 uSunScreen;
    uniform float uSunPower;
    uniform float uDropSeed;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    vec3 sampleChroma(vec2 uv, float amount) {
      vec2 dir = uv - 0.5;
      float r2 = dot(dir, dir);
      vec2 off = dir * (amount + amount * r2 * 2.2);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - off).b;
      return col;
    }

    // Water left on the lens port after the camera comes up: drops of
    // several sizes, each an irregular little lens that bends and blurs the
    // view behind it, with a darker edge. They are out of focus, so they are
    // soft distortions, not circles. Returns the refraction offset (xy) and
    // the drop coverage (z). As the port dries the smaller and less likely
    // drops go first.
    vec3 lensWater(vec2 uv, float wet) {
      vec2 p = uv * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
      vec3 acc = vec3(0.0);
      for (int L = 0; L < 3; L++) {
        float fl = float(L);
        float scale = L == 0 ? 5.0 : (L == 1 ? 9.0 : 17.0);
        vec2 g = p * scale + vec2(fl * 3.7 + uDropSeed * 1.31, fl * 1.9 - uDropSeed * 0.77);
        vec2 cell = floor(g);
        vec2 f = fract(g) - 0.5;
        float h = hash(cell + fl * 17.0 + uDropSeed * 3.3);
        float keep = wet * (L == 0 ? 0.18 : (L == 1 ? 0.28 : 0.38));
        if (h > keep) continue;
        vec2 c = (vec2(hash(cell + 3.1 + fl), hash(cell + 7.7 - fl)) - 0.5) * 0.45;
        vec2 d = f - c;
        float r = 0.14 + 0.2 * hash(cell + 1.3 + fl * 2.0);
        // Shrink as it dries.
        r *= 0.55 + 0.45 * smoothstep(h, h + 0.35, keep + 0.15);
        float ang = atan(d.y, d.x);
        float wob = 1.0 + 0.16 * sin(ang * 3.0 + h * 21.0) + 0.09 * sin(ang * 5.0 + h * 9.0);
        // Gravity drags the bigger drops into a teardrop.
        wob *= 1.0 + 0.25 * smoothstep(0.0, -1.0, sin(ang)) * (1.0 - fl * 0.4);
        float dist = length(d) / (r * wob);
        if (dist >= 1.0) continue;
        // A drop on the lens is far out of focus: its edge is a wide, soft
        // falloff, never a cut-out outline.
        float m = 1.0 - smoothstep(0.3, 1.0, dist);
        m *= m;
        float dome = sqrt(max(0.0, 1.0 - dist * dist));
        // Small drops bend the view less and are blurrier still.
        vec2 off = -(d / (r * wob)) * (1.0 - dome * 0.6) * (0.012 / scale) * (L == 0 ? 4.0 : 2.5);
        acc.xy += off * m;
        acc.z = max(acc.z, m);
      }
      return acc;
    }

    void main() {
      float under = uUnderwater;
      float wet = uWetness;
      vec2 uv = vUv;

      // A slight lens curvature, and under water the faint wobble of
      // looking through a moving medium.
      vec2 centered = uv * 2.0 - 1.0;
      float r2 = dot(centered, centered);
      // Barrel curvature, zoomed in just enough that the corners never
      // sample outside the frame (which smears the edge pixels into bands).
      float curve = 0.003 + under * 0.008;
      vec2 lens = 0.5 + (uv + centered * curve * r2 - 0.5) / (1.0 + curve * 2.0 + 0.006);
      if (under > 0.01) {
        lens.x += sin(uv.y * 31.0 + uTime * 1.1) * 0.0005 * under;
        lens.y += cos(uv.x * 27.0 + uTime * 0.9) * 0.0004 * under;
      }

      // Water on the lens after the camera comes up.
      float dropMask = 0.0;
      if (wet > 0.01 && under < 0.5) {
        vec3 lw = lensWater(uv, wet);
        dropMask = lw.z;
        lens += lw.xy;
        // Right out of the water a film runs down the port and ripples
        // the whole view for a moment.
        float film = smoothstep(0.75, 1.0, wet);
        lens.x += sin(uv.y * 23.0 + uTime * 4.0 + sin(uv.x * 9.0) * 2.0) * 0.004 * film;
        lens.y += sin(uv.x * 17.0 - uTime * 3.0) * 0.002 * film + film * 0.004;
      }

      vec2 uvA = clamp(lens, vec2(0.001), vec2(0.999));
      // Lateral chromatic aberration, only toward the frame edges.
      float aberration = uAberration * r2 * (0.6 + under * 0.6) * (1.0 + uSpeed * 0.3);
      vec3 color = sampleChroma(uvA, aberration);

      // Gentle speed blur toward the edges at a sprint.
      if (uSpeed > 0.25) {
        vec2 blurDir = (uvA - 0.5) * 0.004 * (uSpeed - 0.25);
        vec3 blur = texture2D(tDiffuse, uvA + blurDir).rgb * 0.5 + texture2D(tDiffuse, uvA - blurDir).rgb * 0.5;
        color = mix(color, blur, clamp(r2, 0.0, 1.0) * 0.6);
      }

      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      if (under > 0.01) {
        // Photographic underwater grade: warm wavelengths gone, blue-teal
        // shadows, green-cyan midtones, and a little softness.
        vec3 shadowTint = vec3(0.78, 0.97, 1.08);
        vec3 midTint = vec3(0.94, 1.04, 0.96);
        vec3 graded = color * mix(shadowTint, midTint, smoothstep(0.05, 0.45, lum));
        graded = mix(vec3(lum), graded, 1.08);
        graded = (graded - 0.4) * 1.04 + 0.4;
        color = mix(color, graded, under);
        // Soft scatter around the bright parts (water is never crisp).
        vec2 haloOff = vec2(0.003, 0.002);
        vec3 halo = texture2D(tDiffuse, clamp(uvA + haloOff, 0.001, 0.999)).rgb;
        halo += texture2D(tDiffuse, clamp(uvA - haloOff, 0.001, 0.999)).rgb;
        halo *= 0.5;
        color = mix(color, halo, 0.12 * under);
        vec2 sunDelta = (uv - uSunScreen) * vec2(1.0, 0.8);
        float scatter = exp(-length(sunDelta) * 3.2);
        color += uSunPower * under * vec3(0.12, 0.26, 0.3) * scatter * 0.35;
      }
      if (under < 0.99) {
        // Photographic air: lifted, hazy blacks, cool shadows and warm
        // highlights, a touch of desaturation like a long-lens sea shot.
        vec3 aboveC = color;
        vec3 cool = aboveC * vec3(0.93, 1.0, 1.06);
        vec3 warm = aboveC * vec3(1.05, 1.0, 0.93);
        aboveC = mix(cool, warm, smoothstep(0.25, 0.8, lum));
        aboveC = mix(vec3(lum), aboveC, 0.9);
        aboveC = aboveC * 0.96 + vec3(0.018, 0.02, 0.024);
        color = mix(aboveC, color, under);
      }

      // Lens drops are out of focus: what they show is soft, and their
      // edges are a little darker where the light bends away.
      if (dropMask > 0.001) {
        vec2 bo = vec2(0.004, 0.003);
        vec3 soft = texture2D(tDiffuse, clamp(uvA + bo, 0.001, 0.999)).rgb
          + texture2D(tDiffuse, clamp(uvA - bo, 0.001, 0.999)).rgb
          + texture2D(tDiffuse, clamp(uvA + vec2(-bo.x, bo.y), 0.001, 0.999)).rgb
          + texture2D(tDiffuse, clamp(uvA + vec2(bo.x, -bo.y), 0.001, 0.999)).rgb;
        color = mix(color, soft * 0.25, dropMask * 0.7);
        float edge = dropMask * (1.0 - dropMask) * 4.0;
        color *= 1.0 - edge * 0.03;
      }

      // Fine film grain, mostly in the shadows.
      float grainSeed = hash12(gl_FragCoord.xy * 0.71 + floor(uTime * 30.0) * 17.13);
      float lum2 = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color += (grainSeed - 0.5) * uGrain * (1.0 - lum2 * 0.6);

      // Soft natural vignette.
      float vig = smoothstep(1.35, 0.25, length(centered * vec2(0.92, 0.75)));
      color *= mix(1.0, vig, uVignette);

      // Dither the 8-bit output so the big soft gradients do not band.
      color += (hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) / 255.0;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

/**
 * Scene-depth aware atmosphere. This is the part that makes the water read as
 * a volume instead of a flat fog wall: screen-space sun shafts are occluded by
 * real geometry through the depth buffer, caustics land on surfaces using a
 * reconstructed normal, and the air above the surface gets warm horizon haze.
 */
const VolumetricShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uTime: { value: 0 },
    uUnderwater: { value: 1 },
    uCameraPos: { value: new THREE.Vector3() },
    uCamForward: { value: new THREE.Vector3(0, 0, -1) },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uTanHalfFov: { value: 0.6 },
    uAspect: { value: 1.777 },
    uNear: { value: 0.08 },
    uFar: { value: 9000 },
    uSunDir: { value: new THREE.Vector3(-0.44, 0.76, 0.48) },
    uSunColor: { value: new THREE.Color(0xffe8c2) },
    uSunScreen: { value: new THREE.Vector2(0.5, 1.1) },
    uSunPower: { value: 0 },
    uWaterLevel: { value: 0 },
    uWaterShallow: { value: new THREE.Color(0x2f8198) },
    uWaterDeep: { value: new THREE.Color(0x072b40) },
    uSkyHorizon: { value: new THREE.Color(0xf0ddc1) },
    uScatter: { value: 0.7 },
    uShaft: { value: 0.42 },
    uShaftSteps: { value: 16 },
    uCaustic: { value: 0.55 },
    uHaze: { value: 0.65 },
    uMist: { value: 0.35 },
    uSeaMist: { value: 1 },
    uFogDensity: { value: 0.03 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uUnderwater;
    uniform vec3 uCameraPos;
    uniform vec3 uCamForward;
    uniform vec3 uCamRight;
    uniform vec3 uCamUp;
    uniform float uTanHalfFov;
    uniform float uAspect;
    uniform float uNear;
    uniform float uFar;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform vec2 uSunScreen;
    uniform float uSunPower;
    uniform float uWaterLevel;
    uniform vec3 uWaterShallow;
    uniform vec3 uWaterDeep;
    uniform vec3 uSkyHorizon;
    uniform float uScatter;
    uniform float uShaft;
    uniform int uShaftSteps;
    uniform float uCaustic;
    uniform float uHaze;
    uniform float uMist;
    uniform float uSeaMist;
    uniform float uFogDensity;

    ${glslNoise}
    ${glslCaustics}
    ${glslSky}

    // The colour the water column fades to along a ray. Looking level the
    // water is teal, brightened by light thrown back off the sunlit floor;
    // looking down it turns green over the meadow; looking up into open
    // water it deepens to blue, until the bright surface takes over.
    vec3 waterMedium(vec3 d, float camDepth) {
      vec3 level = uWaterShallow * vec3(0.42, 0.62, 0.7);
      vec3 floorTint = uWaterShallow * vec3(0.45, 0.72, 0.6);
      vec3 open = uWaterDeep * vec3(0.7, 1.05, 1.5);
      vec3 ceiling = uWaterShallow * vec3(0.55, 0.85, 1.0);
      vec3 col = mix(level, floorTint, smoothstep(-0.02, -0.45, d.y));
      col = mix(col, open, smoothstep(0.04, 0.4, d.y));
      col = mix(col, ceiling, smoothstep(0.55, 0.95, d.y) * exp(-camDepth * 0.05));
      // Deeper water darkens and turns bluer.
      float deep = smoothstep(4.0, 40.0, camDepth);
      col = mix(col, uWaterDeep * vec3(0.55, 0.8, 1.15), deep * 0.75);
      return col;
    }

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float linearizeDepth(float d) {
      float z = d * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
    }

    // A screen-space march toward the sun. Visibility is resolved against the
    // scene depth buffer, so a passing dolphin or a coral head carves a soft
    // shadow out of the shafts. The spoke term keeps open water from becoming
    // a flat radial gradient.
    float shaftField(vec2 uv, float sceneDepth) {
      vec2 aspectVec = vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
      vec2 toSun = (uSunScreen - uv) * aspectVec;
      float sunDistance = length(toSun);
      if (sunDistance < 0.0001) return 0.0;

      vec2 stepUV = (uSunScreen - uv) / float(uShaftSteps);
      float jitter = hash12(gl_FragCoord.xy + floor(uTime * 24.0) * 0.37);
      vec2 coord = uv + stepUV * jitter;
      float decay = 1.0;
      float illum = 0.0;
      float weight = 0.0;
      float angle = atan(toSun.y, toSun.x);
      // Relative thickness: deeper pixels need a larger depth separation
      // before they count as a blocker.
      float thickness = 0.7 + sceneDepth * 0.05;

      // Irregular, slow radial bands with a soft edge. Noise on the angle
      // breaks up the "searchlight" look of a pure sine.
      float spokeA = vnoise(vec2(angle * 18.0 + uTime * 0.022, 0.7));
      float spokeB = vnoise(vec2(angle * 37.0 - uTime * 0.016, 4.9));
      float spokes = 0.38 + 0.62 * (spokeA * 0.6 + spokeB * 0.4);

      for (int i = 0; i < 22; i++) {
        if (i >= uShaftSteps) break;
        coord += stepUV;
        vec2 sampleUV = clamp(coord, vec2(0.002), vec2(0.998));
        float sampleDepth = linearizeDepth(texture2D(tDepth, sampleUV).r);
        float visibility = smoothstep(
          sceneDepth - thickness,
          sceneDepth + thickness * 1.6,
          sampleDepth
        );
        // Sample the scene toward the sun as well as the depth. Bright
        // surface patches become the actual shafts; dark water does not.
        // Every other step is enough at this soft focus and halves the
        // colour-texture traffic.
        float sampleLight = 0.18;
        if (i % 2 == 0) {
          vec3 sampleColor = texture2D(tDiffuse, sampleUV).rgb;
          float luma = dot(sampleColor, vec3(0.2126, 0.7152, 0.0722));
          sampleLight = clamp(0.18 + luma * 0.9, 0.0, 1.6);
        }
        float flicker = 0.78 + 0.22 * sin(float(i) * 1.93 + angle * 7.0 + uTime * 0.5);
        illum += visibility * decay * flicker * sampleLight;
        weight += decay;
        decay *= 0.958;
      }

      illum /= max(weight, 0.0001);
      // Keep the shafts concentrated around the projected sun instead of
      // adding a flat screen-wide wash.
      float sunFalloff = mix(0.16, 1.0, exp(-sunDistance * 1.55));
      return illum * (0.55 + 0.45 * spokes) * sunFalloff;
    }

    void main() {
      vec2 uv = vUv;
      vec3 color = texture2D(tDiffuse, uv).rgb;
      float rawDepth = texture2D(tDepth, uv).r;
      float sceneDepth = linearizeDepth(rawDepth);

      vec2 ndc = uv * 2.0 - 1.0;
      vec3 rayDir = normalize(
        uCamForward +
        uCamRight * ndc.x * uTanHalfFov * uAspect +
        uCamUp * ndc.y * uTanHalfFov
      );
      float alongForward = max(dot(rayDir, uCamForward), 0.12);
      float rayLength = sceneDepth / alongForward;
      vec3 worldPos = uCameraPos + rayDir * rayLength;
      float belowSurface = max(0.0, uWaterLevel - worldPos.y);

      if (uUnderwater > 0.01) {
        float sunAlign = pow(max(dot(rayDir, uSunDir), 0.0), 5.0);
        float sunDrive = max(uSunPower, 0.16);

        // Volumetric shafts, occluded by scene depth. Away from the sun the
        // screen-space march has nothing useful to add, so skip its fetches.
        float shaft = 0.0;
        if (uSunPower > 0.01 && uShaft > 0.001) {
          shaft = shaftField(uv, sceneDepth);
        }
        float shaftDepth = exp(-belowSurface * 0.06);
        vec3 shaftTint = mix(uWaterShallow, uSunColor, 0.58);
        color +=
          shaftTint *
          shaft *
          (0.32 + 0.68 * sunAlign) *
          shaftDepth *
          uShaft *
          sunDrive *
          uUnderwater;

        // Directional water medium. The materials fog toward one flat
        // colour; here distant water takes the colour of the column in that
        // direction, so the frame has the up/down falloff of real water.
        float camDepthNow = max(0.0, uWaterLevel - uCameraPos.y);
        float mediumDensity = uFogDensity * (0.85 + 0.25 * uScatter);
        float mediumAmount = 1.0 - exp(-pow(rayLength * mediumDensity, 1.6));
        // Past the visibility limit everything is the water itself, so the
        // far seabed melts into the water instead of meeting it in a line.
        mediumAmount = max(mediumAmount, smoothstep(35.0, 80.0, rayLength));
        vec3 medium = waterMedium(rayDir, camDepthNow);
        medium += uSunColor * 0.05 * pow(max(dot(rayDir, uSunDir), 0.0), 4.0) * exp(-camDepthNow * 0.04);
        color = mix(color, medium, clamp(mediumAmount, 0.0, 1.0) * uUnderwater);

        // Broad solar halo in the water column, plus the brighter ceiling.
        float halo = pow(max(dot(rayDir, uSunDir), 0.0), 18.0);
        color += uSunColor * halo * 0.06 * (0.35 + uSunPower) * uUnderwater;
        float ceiling = smoothstep(0.12, 0.96, rayDir.y);
        color += uWaterShallow * ceiling * 0.025 * uUnderwater;

        // Reconstruct a surface normal from depth derivatives and lay moving
        // caustic filaments over anything facing up. This is what ties the
        // dolphin, coral and sand into the same light field.
        vec3 normalRaw = cross(dFdx(worldPos), dFdy(worldPos));
        float normalLength = length(normalRaw);
        vec3 surfaceNormal = normalLength > 1e-6
          ? normalRaw / normalLength
          : vec3(0.0, 1.0, 0.0);
        if (dot(surfaceNormal, rayDir) > 0.0) surfaceNormal = -surfaceNormal;
        float upFacing = smoothstep(-0.05, 0.7, surfaceNormal.y);
        float belowGap = smoothstep(0.3, 2.2, belowSurface);
        float lightFacing = clamp(dot(surfaceNormal, uSunDir) * 0.55 + 0.45, 0.0, 1.0);
        float causticDepth = exp(-belowSurface * 0.022);
        // Caustics are light on a surface: they fade with the surface into
        // the water, or the far seabed glows as a pale band at the horizon.
        float causticMask =
          upFacing * belowGap * lightFacing * causticDepth * uCaustic * uUnderwater *
          (1.0 - clamp(mediumAmount, 0.0, 1.0));
        if (causticMask > 0.0005) {
          float caustic = clamp(
            causticNetwork(
              worldPos.xz * 1.05 + vec2(uTime * 0.02, -uTime * 0.015),
              uTime * 1.05
            ),
            0.0,
            2.3
          );
          color += uSunColor * caustic * causticMask * 0.085;
        }
      }

      if (uUnderwater < 0.99) {
        float above = 1.0 - uUnderwater;
        vec3 hazeTint = skyHorizonColor(rayDir, uSunDir);
        float distanceHaze = 1.0 - exp(-min(rayLength, 9000.0) * 0.00035);
        bool isSky = rawDepth > 0.99999;
        if (!isSky) {
          color = mix(color, hazeTint, distanceHaze * 0.1 * uHaze * above);
        }

        // Low sea mist: an exponential layer hugging the water, integrated
        // along the ray, broken into slow drifting wisps.
        float H = 16.0;
        float y0 = max(uCameraPos.y - uWaterLevel, 0.0);
        float dy = rayDir.y;
        float L = isSky ? 12000.0 : min(rayLength, 12000.0);
        float base = exp(-y0 / H);
        float od = abs(dy) < 1e-3
          ? base * L
          : H / dy * base * (1.0 - exp(-L * dy / H));
        float az = atan(rayDir.z, rayDir.x);
        float wisps = fbm2(vec2(az * 7.0 + uTime * 0.012, dy * 30.0 - uTime * 0.004));
        wisps = 0.55 + 0.9 * smoothstep(0.3, 0.8, wisps);
        // The layer follows the sea surface, not a flat plane: a ray that
        // drops into a trough far below the camera's local level (the back
        // of a mega wave) never sees more than the at-surface density.
        od = clamp(od, 0.0, L);
        float mist = 1.0 - exp(-od * 0.00012 * uSeaMist * wisps);
        vec3 mistTint = mix(hazeTint, vec3(0.74, 0.78, 0.79), 0.35);
        color = mix(color, mistTint, clamp(mist, 0.0, 0.9) * above);

        float sunHalo = pow(max(dot(rayDir, uSunDir), 0.0), 6.0);
        color += SKY_HORIZON_SUN * sunHalo * 0.04 * uHaze * above;
      }

      gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    }
  `,
};

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Scene depth needs to survive the composer's buffer swaps. Each target
    // gets its own depth texture: RenderPass always writes whichever target
    // is the current read buffer, and the volumetric pass samples that target
    // while writing into the other one, so there is never a feedback loop.
    this.composer.renderTarget1.depthTexture = this._makeDepthTexture("depth-a");
    this.composer.renderTarget2.depthTexture = this._makeDepthTexture("depth-b");

    this.volumetric = new ShaderPass(VolumetricShader);
    this.volumetric.material.depthTest = false;
    this.volumetric.material.depthWrite = false;
    this.volumetric.material.blending = THREE.NoBlending;
    this.volumetric.material.uniforms.uWaterShallow.value.set(PALETTE.waterTop);
    this.volumetric.material.uniforms.uWaterDeep.value.set(PALETTE.waterDeep);
    this.volumetric.material.uniforms.uSkyHorizon.value.set(PALETTE.skyHorizon);
    this.volumetric.material.uniforms.uSunColor.value.set(PALETTE.sunColor);
    this.composer.addPass(this.volumetric);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      TUNING.visuals.bloomStrength,
      TUNING.visuals.bloomRadius,
      TUNING.visuals.bloomThreshold
    );
    // Bloom is deliberately restrained: enough to halate the sun and spray,
    // not enough to turn the Snell window into white paint.
    this.bloom.enabled = true;
    this.composer.addPass(this.bloom);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.film = new ShaderPass(FilmShader);
    this.composer.addPass(this.film);

    this.film.material.uniforms.uGrain.value = TUNING.visuals.grain;
    this.film.material.uniforms.uAberration.value = TUNING.visuals.aberration;
    this.film.material.uniforms.uVignette.value = TUNING.visuals.vignette;

    // "Post off" still needs the output transform (ACES + sRGB), otherwise
    // raw shader values are written straight to an sRGB framebuffer and the
    // water looks unnaturally dark. This chain has no grade, grain, bloom,
    // volumetric haze or downsampling.
    this.rawComposer = new EffectComposer(renderer);
    this.rawComposer.addPass(new RenderPass(scene, camera));
    this.rawComposer.addPass(new OutputPass());

    this.started = false;
    this.enabled = true;
    this.setSize(window.innerWidth, window.innerHeight);
    this._frame = 0;
    this.sunDir = new THREE.Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._sunPoint = new THREE.Vector3();
  }

  _makeDepthTexture(name) {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const texture = new THREE.DepthTexture(
      Math.max(1, size.x),
      Math.max(1, size.y)
    );
    texture.name = name;
    texture.format = THREE.DepthFormat;
    texture.type = THREE.UnsignedIntType;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    return texture;
  }

  /** Toggle the whole post chain. Raw mode renders at native resolution so
   *  the water can be judged without grain, bloom, grade or volumetric haze. */
  setEnabled(enabled) {
    this.enabled = enabled;
    this.setSize(window.innerWidth, window.innerHeight);
  }

  setSize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, TUNING.visuals.maxPixelRatio);
    if (this.enabled) {
      this.renderer.setPixelRatio(dpr * TUNING.visuals.renderScale);
    } else {
      // Clean-judging mode: native pixels, no composer downsample.
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    }
    this.renderer.setSize(w, h, false);
    // The composer is the real render budget. Keep its internal buffers at a
    // fixed fraction of CSS pixels regardless of devicePixelRatio, and cap the
    // total pixel count so a large display cannot quietly double the cost.
    const scaleByBudget = Math.sqrt(
      TUNING.visuals.maxPostPixels / Math.max(1, w * h)
    );
    const composerScale = Math.min(TUNING.visuals.renderScale, scaleByBudget);
    this.composer.setPixelRatio(composerScale);
    this.composer.setSize(w, h);
    const target = this.composer.renderTarget1;
    this.film.material.uniforms.uResolution.value.set(target.width, target.height);
    this.film.material.uniforms.uPixelRatio.value = composerScale;
    // Bloom is a soft effect; half resolution is indistinguishable in motion
    // and removes several full-screen Gaussian passes from the frame.
    this.bloom.setSize(target.width * 0.25, target.height * 0.25);

    this.rawComposer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.rawComposer.setSize(w, h);
  }

  render(dt, state) {
    if (!this.enabled) {
      // The film grade normally pulls exposure down; without it, use a
      // slightly lower exposure so raw-mode highlights do not clip.
      this.renderer.toneMappingExposure = TUNING.visuals.exposure * 0.72;
      this.rawComposer.render(dt);
      return;
    }
    this._frame++;
    const time = performance.now() * 0.001;
    this.film.material.uniforms.uTime.value = time;
    this.film.material.uniforms.uUnderwater.value = state.underwater;
    // A fresh soaking leaves a fresh pattern of drops.
    const wetNow = Math.max(state.wetness, 0);
    if (wetNow > (this._lastWet ?? 0) + 0.25) this.film.material.uniforms.uDropSeed.value = Math.floor(Math.random() * 97);
    this._lastWet = wetNow;
    this.film.material.uniforms.uWetness.value = wetNow;
    this.film.material.uniforms.uSpeed.value = state.speedNorm;

    this.camera.getWorldDirection(this._forward);
    const facing = this._forward.dot(this.sunDir);
    this._sunPoint
      .copy(this.camera.position)
      .addScaledVector(this.sunDir, 480)
      .project(this.camera);
    const sx = this._sunPoint.x * 0.5 + 0.5;
    const sy = this._sunPoint.y * 0.5 + 0.5;
    this.film.material.uniforms.uSunScreen.value.set(
      Math.max(-0.08, Math.min(1.08, sx)),
      Math.max(0.08, Math.min(1.09, sy))
    );
    const sunPower = Math.max(0, Math.min(1, (facing + 0.12) * 1.4)) * 0.8;
    this.film.material.uniforms.uSunPower.value = sunPower;

    this.camera.updateMatrixWorld();
    this._right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._up.setFromMatrixColumn(this.camera.matrixWorld, 1);

    const vu = this.volumetric.material.uniforms;
    const sceneTarget = this.composer.readBuffer;
    vu.tDepth.value = sceneTarget.depthTexture;
    vu.uResolution.value.set(sceneTarget.width, sceneTarget.height);
    vu.uTime.value = time;
    vu.uUnderwater.value = state.underwater;
    vu.uCameraPos.value.copy(this.camera.position);
    vu.uCamForward.value.copy(this._forward);
    vu.uCamRight.value.copy(this._right);
    vu.uCamUp.value.copy(this._up);
    vu.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    vu.uAspect.value = this.camera.aspect;
    vu.uNear.value = this.camera.near;
    vu.uFar.value = this.camera.far;
    vu.uSunDir.value.copy(this.sunDir);
    vu.uSunScreen.value.set(
      Math.max(-0.6, Math.min(1.6, sx)),
      Math.max(-0.5, Math.min(1.6, sy))
    );
    vu.uSunPower.value = sunPower;
    vu.uWaterLevel.value = state.waterLevel ?? 0;
    vu.uScatter.value = TUNING.visuals.volumetricScatter;
    vu.uShaft.value = TUNING.visuals.shaftStrength;
    vu.uShaftSteps.value = TUNING.visuals.shaftSteps;
    vu.uCaustic.value = TUNING.visuals.volumetricCaustics;
    vu.uHaze.value = TUNING.visuals.surfaceHaze;
    vu.uMist.value = TUNING.visuals.surfaceMist;
    vu.uSeaMist.value = TUNING.visuals.seaMist;
    vu.uFogDensity.value = this.scene.fog ? this.scene.fog.density : 0.03;

    this.bloom.strength = TUNING.visuals.bloomStrength * (0.7 + state.underwater * 0.45);
    this.bloom.threshold = TUNING.visuals.bloomThreshold;
    this.bloom.radius = TUNING.visuals.bloomRadius;
    // Above the surface the sky is allowed to sit a little lower in exposure:
    // the reference is pastel, not clipped white. Underwater keeps its full
    // depth response.
    const exposureScale = 0.82 + 0.18 * Math.max(0, Math.min(1, state.underwater));
    this.renderer.toneMappingExposure = TUNING.visuals.exposure * exposureScale;
    this.composer.render(dt);
  }
}
