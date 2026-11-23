import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Pass } from "three/addons/postprocessing/Pass.js";
import { PALETTE, SUN_DIRECTION, TUNING } from "./config.js";
import { glslCaustics, glslNoise } from "./utils.js";
import { glslSky } from "./atmosphere.js";

/**
 * The last pass: from the rendered frame to the screen.
 *
 * The frame is rendered at (up to) one pixel per CSS pixel and drawn here at
 * the display's own resolution, with a Catmull-Rom (bicubic) filter so the
 * upscale stays crisp instead of going soft the way a bilinear stretch does.
 *
 * Everything that only imitated a camcorder is gone from the default look:
 * film grain, colour fringing that grew with speed, a two-tap "speed blur"
 * and an underwater "halo" (both drew double images), a sine wobble over
 * the whole frame underwater, a barrel warp that resampled (softened) every
 * pixel, and a grade that lifted the blacks and split-toned the image. The
 * light, haze and colour now come only from the scene and its atmosphere.
 * What a real lens does is kept: a gentle natural vignette, and water drops
 * on the port after it breaks the surface. `uLegacy` brings the old film
 * look back for side-by-side comparison (tuning panel: "legacy film look").
 */
const FilmShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uUnderwater: { value: 1 },
    uWetness: { value: 0 },
    uSpeed: { value: 0 },
    uGrain: { value: 0 },
    uAberration: { value: 0 },
    uVignette: { value: TUNING.visuals.vignette },
    uPixelRatio: { value: 1 },
    uSunScreen: { value: new THREE.Vector2(0.5, 1.1) },
    uSunPower: { value: 0 },
    uDropSeed: { value: 0 },
    uEdgeSmooth: { value: 0 },
    uLensDrops: { value: 1 },
    uLegacy: { value: 0 },
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
    uniform float uEdgeSmooth;
    uniform float uLensDrops;
    uniform float uLegacy;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    // Catmull-Rom bicubic in nine bilinear taps. Draws the rendered frame at
    // the display's resolution without the blur of a bilinear stretch; at a
    // 1:1 scale it returns the source pixel unchanged.
    vec3 sampleBicubic(vec2 uv) {
      vec2 samplePos = uv * uResolution;
      vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
      vec2 f = samplePos - texPos1;
      vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
      vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
      vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
      vec2 w3 = f * f * (-0.5 + 0.5 * f);
      vec2 w12 = w1 + w2;
      vec2 offset12 = w2 / w12;
      vec2 p0 = (texPos1 - 1.0) / uResolution;
      vec2 p3 = (texPos1 + 2.0) / uResolution;
      vec2 p12 = (texPos1 + offset12) / uResolution;
      vec3 c = vec3(0.0);
      c += texture2D(tDiffuse, vec2(p0.x, p0.y)).rgb * (w0.x * w0.y);
      c += texture2D(tDiffuse, vec2(p12.x, p0.y)).rgb * (w12.x * w0.y);
      c += texture2D(tDiffuse, vec2(p3.x, p0.y)).rgb * (w3.x * w0.y);
      c += texture2D(tDiffuse, vec2(p0.x, p12.y)).rgb * (w0.x * w12.y);
      c += texture2D(tDiffuse, vec2(p12.x, p12.y)).rgb * (w12.x * w12.y);
      c += texture2D(tDiffuse, vec2(p3.x, p12.y)).rgb * (w3.x * w12.y);
      c += texture2D(tDiffuse, vec2(p0.x, p3.y)).rgb * (w0.x * w3.y);
      c += texture2D(tDiffuse, vec2(p12.x, p3.y)).rgb * (w12.x * w3.y);
      c += texture2D(tDiffuse, vec2(p3.x, p3.y)).rgb * (w3.x * w3.y);
      return max(c, vec3(0.0));
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

    // Edge anti-aliasing (FXAA). Multisampling smooths the edges as they are
    // rasterised, but the water's colour along each ray is applied after
    // that, from one depth per pixel, which steps an edge pixel to one side
    // or the other again. This looks along each edge in the finished image
    // and blends across it. Returns alpha 0 where the neighbourhood is flat
    // (the sharp upscale is used there).
    vec4 sampleSmooth(vec2 uv) {
      vec2 px = 1.0 / uResolution;
      vec3 cM = texture2D(tDiffuse, uv).rgb;
      // Edges are found on a red-weighted luma: under water a grey body and
      // the teal water around it have almost the same brightness, and only
      // the red channel tells them apart.
      const vec3 W = vec3(0.45, 0.45, 0.1);
      float lNW = dot(texture2D(tDiffuse, uv + vec2(-1.0, -1.0) * px).rgb, W);
      float lNE = dot(texture2D(tDiffuse, uv + vec2(1.0, -1.0) * px).rgb, W);
      float lSW = dot(texture2D(tDiffuse, uv + vec2(-1.0, 1.0) * px).rgb, W);
      float lSE = dot(texture2D(tDiffuse, uv + vec2(1.0, 1.0) * px).rgb, W);
      float lM = dot(cM, W);
      float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
      float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      // Nothing to do where the neighbourhood is flat.
      if (lMax - lMin < max(0.02, lMax * 0.09)) return vec4(0.0);
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
      float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
      float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
      dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * px;
      vec3 cA = 0.5 * (
        texture2D(tDiffuse, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
        texture2D(tDiffuse, uv + dir * (2.0 / 3.0 - 0.5)).rgb
      );
      vec3 cB = cA * 0.5 + 0.25 * (
        texture2D(tDiffuse, uv + dir * -0.5).rgb +
        texture2D(tDiffuse, uv + dir * 0.5).rgb
      );
      float lB = dot(cB, W);
      return vec4((lB < lMin || lB > lMax) ? cA : cB, 1.0);
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
      vec2 centered = uv * 2.0 - 1.0;
      float r2 = dot(centered, centered);
      vec2 lens = uv;

      if (uLegacy > 0.5) {
        // Old look: barrel curvature (zoomed so the corners stay inside the
        // frame) and, under water, a sine wobble over the whole frame.
        float curve = 0.003 + under * 0.008;
        lens = 0.5 + (uv + centered * curve * r2 - 0.5) / (1.0 + curve * 2.0 + 0.006);
        if (under > 0.01) {
          lens.x += sin(uv.y * 31.0 + uTime * 1.1) * 0.0005 * under;
          lens.y += cos(uv.x * 27.0 + uTime * 0.9) * 0.0004 * under;
        }
      }

      // Water on the lens after the camera comes up.
      float dropMask = 0.0;
      if (uLensDrops > 0.5 && wet > 0.01 && under < 0.5) {
        vec3 lw = lensWater(uv, wet);
        dropMask = lw.z;
        lens += lw.xy;
        // Right out of the water a sheet of water runs off the port and
        // bends the whole view for a moment.
        float film = smoothstep(0.75, 1.0, wet);
        lens.x += sin(uv.y * 23.0 + uTime * 4.0 + sin(uv.x * 9.0) * 2.0) * 0.004 * film;
        lens.y += sin(uv.x * 17.0 - uTime * 3.0) * 0.002 * film + film * 0.004;
      }

      vec2 uvA = clamp(lens, vec2(0.0), vec2(1.0));
      vec3 color = sampleBicubic(uvA);
      if (uEdgeSmooth > 0.5) {
        vec4 smoothEdge = sampleSmooth(uvA);
        if (smoothEdge.a > 0.5) color = smoothEdge.rgb;
      }
      if (uAberration > 0.0) {
        // Lateral colour fringe toward the frame edges (legacy look only).
        float aberration = uAberration * r2 * (0.6 + under * 0.6) * (1.0 + uSpeed * 0.3);
        color += sampleChroma(uvA, aberration) - texture2D(tDiffuse, uvA).rgb;
      }

      if (uLegacy > 0.5) {
        // Old look: a two-tap edge blur at speed, and the camcorder grades.
        if (uSpeed > 0.25) {
          vec2 blurDir = (uvA - 0.5) * 0.004 * (uSpeed - 0.25);
          vec3 blur = texture2D(tDiffuse, uvA + blurDir).rgb * 0.5 + texture2D(tDiffuse, uvA - blurDir).rgb * 0.5;
          color = mix(color, blur, clamp(r2, 0.0, 1.0) * 0.6);
        }
        float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
        if (under > 0.01) {
          vec3 shadowTint = vec3(0.78, 0.96, 1.1);
          vec3 midTint = vec3(0.94, 1.02, 1.0);
          vec3 graded = color * mix(shadowTint, midTint, smoothstep(0.05, 0.45, lum));
          graded = mix(vec3(lum), graded, 1.08);
          graded = (graded - 0.4) * 1.04 + 0.4;
          color = mix(color, graded, under);
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
          vec3 aboveC = color;
          vec3 cool = aboveC * vec3(0.93, 1.0, 1.06);
          vec3 warm = aboveC * vec3(1.02, 1.0, 0.97);
          aboveC = mix(cool, warm, smoothstep(0.25, 0.8, lum));
          aboveC = mix(vec3(lum), aboveC, 0.9);
          aboveC = aboveC * 0.93 + vec3(0.034, 0.038, 0.042);
          color = mix(aboveC, color, under);
        }
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

      if (uGrain > 0.0) {
        // Film grain, mostly in the shadows (legacy look only).
        float grainSeed = hash12(gl_FragCoord.xy * 0.71 + floor(uTime * 30.0) * 17.13);
        float lum2 = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color += (grainSeed - 0.5) * uGrain * (1.0 - lum2 * 0.6);
      }

      // Natural lens vignetting: a fraction of a stop in the corners.
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
 * a volume instead of a flat fog wall: the water column takes its colour
 * along each ray, sun shafts are marched through the water in world space,
 * caustics land on surfaces using a reconstructed normal, and the air above
 * the surface gets horizon haze and a low sea mist.
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
    tShaftNoise: { value: null },
    uSunRefr: { value: new THREE.Vector3(0.3, -0.85, 0.35) },
    uCaustic: { value: 0.55 },
    uCausticNet: { value: 0.45 },
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
    uniform sampler2D tShaftNoise;
    uniform vec3 uSunRefr;
    uniform float uCaustic;
    uniform float uCausticNet;
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
      // Clear shelf water as a camera sees it: blue-teal looking level,
      // greener looking down at the lit floor, and falling off to a dark
      // blue with depth, where only blue light is left.
      vec3 level = uWaterShallow * vec3(0.27, 0.36, 0.62);
      vec3 floorTint = uWaterShallow * vec3(0.34, 0.56, 0.52);
      vec3 open = uWaterDeep * vec3(0.7, 1.05, 1.6);
      vec3 ceiling = uWaterShallow * vec3(0.5, 0.8, 1.0);
      vec3 col = mix(level, floorTint, smoothstep(-0.02, -0.45, d.y));
      col = mix(col, open, smoothstep(0.04, 0.4, d.y));
      col = mix(col, ceiling, smoothstep(0.55, 0.95, d.y) * exp(-camDepth * 0.05));
      // Deeper water darkens and turns bluer.
      float deep = smoothstep(3.0, 30.0, camDepth);
      col = mix(col, uWaterDeep * vec3(0.5, 0.8, 1.35), deep * 0.9);
      col *= mix(1.0, 0.4, smoothstep(24.0, 70.0, camDepth));
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

    // Interleaved gradient noise: a fixed, fine per-pixel offset for the
    // shaft march, so its steps never show as bands and never flicker.
    float ign(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    // How much sun reaches the water under surface point s. The short waves
    // focus it into a slowly moving network of bright lines; two drifting
    // layers of a tiling ridge pattern stand in for that focusing. Deeper
    // down each focus has spread, so the pattern is read blurrier (a coarser
    // mip) as well as fainter.
    float shaftLight(vec2 s, float below) {
      float blur = log2(1.0 + below * 0.22) * 1.6;
      vec2 w1 = s * (1.0 / 12.0) + vec2(uTime * 0.055, uTime * 0.021);
      vec2 w2 = s * (1.0 / 7.7) + vec2(-uTime * 0.043, uTime * 0.061) + 0.37;
      float a = texture2D(tShaftNoise, w1, blur).r;
      float b = texture2D(tShaftNoise, w2, blur).r;
      float f = a * 0.62 + b * 0.38;
      return smoothstep(0.46 - below * 0.004, 0.92, f);
    }

    // Sun shafts as light scattered by the water itself, in world space.
    // Every point of the view ray is lit through the patch of surface the
    // refracted sun crossed to reach it, so the shafts hang in the water
    // along the light: they slant with the sun, keep their place in the
    // water as the camera moves, waver with the waves above, and are
    // brightest looking toward the sun (forward scattering). They used to be
    // a screen-space smear toward the sun's position on screen plus cones
    // that travelled with the camera.
    float shaftsWorld(vec3 ro, vec3 rd, float rayLen) {
      float maxLen = min(rayLen, 48.0);
      if (maxLen <= 0.05) return 0.0;
      float n = float(uShaftSteps);
      float stepLen = maxLen / n;
      float t = stepLen * ign(gl_FragCoord.xy);
      float sunDown = max(0.25, -uSunRefr.y);
      // Henyey-Greenstein about the light's travel direction, 1 looking
      // straight into it, plus a floor for the wide-angle scatter.
      float g = 0.6;
      float cosT = dot(uSunRefr, -rd);
      float phase = 0.12 + pow((1.0 - g) * (1.0 - g) / (1.0 + g * g - 2.0 * g * cosT), 1.5);
      float acc = 0.0;
      for (int i = 0; i < 32; i++) {
        if (i >= uShaftSteps) break;
        vec3 p = ro + rd * t;
        float below = uWaterLevel - p.y;
        if (below > 0.05) {
          float up = below / sunDown;
          vec2 s = p.xz - uSunRefr.xz * up;
          float light = shaftLight(s, below);
          // In from the surface over the first metre, fading with depth.
          light *= smoothstep(0.05, 1.4, below) * exp(-below * 0.04);
          acc += light * exp(-0.055 * (up + t));
        }
        t += stepLen;
      }
      return acc * stepLen * phase;
    }

    // NaN / infinity test on the raw bits. Safari compiles shaders to Metal
    // with fast math, which may treat NaN as impossible and optimise away
    // isnan() or a max()/min() clamp; an exponent-bits test cannot be.
    bool badF(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
    vec3 safeColor(vec3 c) {
      return min(max(vec3(badF(c.r) ? 0.0 : c.r, badF(c.g) ? 0.0 : c.g, badF(c.b) ? 0.0 : c.b), vec3(0.0)), vec3(64.0));
    }

    void main() {
      vec2 uv = vUv;
      // Drop any NaN or overflow from the scene before it is blurred: in
      // Safari a single bad pixel spreads through the bloom and blacks out
      // the whole frame.
      vec3 color = safeColor(texture2D(tDiffuse, uv).rgb);
      vec3 surfaceColor = color;
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

        // Light shafts: the water lit unevenly by the focusing surface.
        if (uShaft > 0.001) {
          float shafts = shaftsWorld(uCameraPos, rayDir, rayLength);
          vec3 shaftTint = mix(uWaterShallow, uSunColor, 0.58);
          color += shaftTint * shafts * uShaft * 0.03 * uUnderwater * exp(-camDepthNow * 0.03);
        }

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
          // The net of bright lines is sharp in the first few metres and
          // blurs out with depth, because every ripple focuses at its own
          // distance: by 20 m down the light is even. It also fades to its
          // mean before the lines are finer than a pixel. The mean stays the
          // same either way, so nothing darkens where the net is gone.
          float netSharp =
            uCausticNet * exp(-belowSurface * 0.14) * (1.0 - smoothstep(9.0, 32.0, rayLength));
          float net = 1.0;
          if (netSharp > 0.01) {
            net = mix(
              1.0,
              causticNetwork(worldPos.xz * 2.1 + vec2(uTime * 0.05, -uTime * 0.035), uTime * 1.05),
              netSharp
            );
          }
          // Light landing on a surface comes back in proportion to how
          // light that surface is and how it faces: a ripple's shaded flank
          // or a dark skin returns less of it than pale, sunward sand.
          // (Scaled to the sand's usual level, so open sand keeps its
          // brightness.)
          float surfaceShade = clamp(dot(surfaceColor, vec3(0.3333)) / 0.055, 0.65, 1.4);
          // Far off the surface is already fogged toward the water colour,
          // and no ripple is resolved: light it evenly.
          surfaceShade = mix(surfaceShade, 1.0, smoothstep(8.0, 24.0, rayLength));
          color += uSunColor * net * causticMask * 0.195 * surfaceShade;
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
        // Mist is lit by the same overcast as the haze behind it: a touch
        // paler, never a white band along the horizon.
        vec3 mistTint = hazeTint * 1.06 + vec3(0.012);
        color = mix(color, mistTint, clamp(mist, 0.0, 0.9) * above);

        float sunHalo = pow(max(dot(rayDir, uSunDir), 0.0), 6.0);
        color += SKY_HORIZON_SUN * sunHalo * 0.04 * uHaze * above;
      }

      gl_FragColor = vec4(safeColor(color), 1.0);
    }
  `,
};

/**
 * Draws the scene into its own target, multisampled where the GPU allows it.
 * Real edges (a fin against the sky, a blade of seagrass, the line of a
 * wave against the haze) are resolved from four samples a pixel instead of
 * one, so they come out smooth the way a camera sees them, not as a
 * staircase smeared afterwards by an edge filter. The depth is resolved with
 * the colour, for the volumetric pass.
 */
class ScenePass extends Pass {
  constructor(scene, camera, target) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.target = target;
    this.needsSwap = false;
  }

  render(renderer) {
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }
}

/**
 * A tiling ridge-noise texture for the sun shafts: a soft network of bright
 * lines, like sunlight focused by a wavy surface. Seeded, so it is the same
 * every run.
 */
function makeShaftNoise(size = 128) {
  let seed = 0x5eaf00d;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const octaves = [
    { period: 4, amp: 0.55 },
    { period: 8, amp: 0.3 },
    { period: 16, amp: 0.15 },
  ].map((o) => {
    const lattice = new Float32Array(o.period * o.period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    return { ...o, lattice };
  });
  const fade = (t) => t * t * (3 - 2 * t);
  const data = new Uint8Array(size * size);
  let min = Infinity;
  let max = -Infinity;
  const raw = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (const o of octaves) {
        const gx = (x / size) * o.period;
        const gy = (y / size) * o.period;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const fx = fade(gx - ix);
        const fy = fade(gy - iy);
        const P = o.period;
        const at = (i, j) => o.lattice[((j + P) % P) * P + ((i + P) % P)];
        const v =
          (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) +
          (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
        // Folded into ridges: bright lines where the noise crosses its middle.
        sum += (1 - Math.abs(2 * v - 1)) * o.amp;
      }
      raw[y * size + x] = sum;
      if (sum < min) min = sum;
      if (sum > max) max = sum;
    }
  }
  for (let i = 0; i < raw.length; i++) data[i] = Math.round(((raw[i] - min) / (max - min)) * 255);
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.composer = new EffectComposer(renderer);

    // The scene gets its own (multisampled) target; the composer's two
    // buffers only carry the fullscreen passes after it.
    this.maxSamples = renderer.capabilities.isWebGL2 ? Math.min(4, renderer.capabilities.maxSamples || 0) : 0;
    this.sceneTarget = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this._wantedSamples(),
    });
    this.sceneTarget.texture.name = "scene";
    this.sceneTarget.depthTexture = this._makeDepthTexture("scene-depth");
    this.scenePass = new ScenePass(scene, camera, this.sceneTarget);
    this.composer.addPass(this.scenePass);

    this.volumetric = new ShaderPass(VolumetricShader);
    // The volumetric pass reads the scene target directly (colour and
    // depth), not the composer's read buffer.
    this.volumetric.textureID = "__scene";
    this.volumetric.material.depthTest = false;
    this.volumetric.material.depthWrite = false;
    this.volumetric.material.blending = THREE.NoBlending;
    this.volumetric.material.uniforms.uWaterShallow.value.set(PALETTE.waterTop);
    this.volumetric.material.uniforms.uWaterDeep.value.set(PALETTE.waterDeep);
    this.volumetric.material.uniforms.uSkyHorizon.value.set(PALETTE.skyHorizon);
    this.volumetric.material.uniforms.uSunColor.value.set(PALETTE.sunColor);
    this.volumetric.material.uniforms.tShaftNoise.value = makeShaftNoise(128);
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

    // "Post off" still needs the output transform (tone mapping + sRGB),
    // otherwise raw shader values are written straight to an sRGB
    // framebuffer and the water looks unnaturally dark. This chain has no
    // bloom, volumetric haze or downsampling.
    this.rawComposer = new EffectComposer(renderer);
    this.rawComposer.addPass(new RenderPass(scene, camera));
    this.rawComposer.addPass(new OutputPass());

    this.started = false;
    this.enabled = true;
    this.setSize(window.innerWidth, window.innerHeight);
    this._frame = 0;
    this.sunDir = new THREE.Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize();
    // The sun's light after it refracts into the water (Snell's law, n =
    // 1.333): steeper than in the air, so the shafts below lean less.
    const eta = 1 / 1.333;
    const cosI = this.sunDir.y;
    const k = Math.max(0, 1 - eta * eta * (1 - cosI * cosI));
    this.sunRefr = new THREE.Vector3(-this.sunDir.x * eta, -Math.sqrt(k), -this.sunDir.z * eta).normalize();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._sunPoint = new THREE.Vector3();
  }

  _wantedSamples() {
    return TUNING.visuals.msaa ? this.maxSamples : 0;
  }

  _makeDepthTexture(name) {
    const texture = new THREE.DepthTexture(2, 2);
    texture.name = name;
    texture.format = THREE.DepthFormat;
    texture.type = THREE.UnsignedIntType;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    return texture;
  }

  /** Toggle the whole post chain. Raw mode renders at native resolution so
   *  the water can be judged without bloom or volumetric haze. */
  setEnabled(enabled) {
    this.enabled = enabled;
    this.setSize(window.innerWidth, window.innerHeight);
  }

  /** The composer's scale (rendered pixels per CSS pixel). */
  composerScale(w = window.innerWidth, h = window.innerHeight) {
    // Cap the total pixel count so a very large display cannot quietly
    // multiply the cost; the quality governor in main.js lowers
    // renderScale further if frames run slow.
    const scaleByBudget = Math.sqrt(TUNING.visuals.maxPostPixels / Math.max(1, w * h));
    return Math.min(TUNING.visuals.renderScale, scaleByBudget);
  }

  setSize(w, h) {
    // The canvas always runs at the display's own resolution (capped), so
    // the last pass can upscale the frame with a sharp filter.
    const dpr = Math.min(window.devicePixelRatio || 1, TUNING.visuals.maxPixelRatio);
    this.renderer.setPixelRatio(this.enabled ? dpr : Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(w, h, false);
    const composerScale = this.composerScale(w, h);
    // Whole pixels: a fractional target size is truncated by WebGL, and the
    // last pass would then sample the frame a fraction of a texel off.
    this.composer.setPixelRatio(1);
    this.composer.setSize(Math.max(1, Math.round(w * composerScale)), Math.max(1, Math.round(h * composerScale)));
    const target = this.composer.renderTarget1;
    this.sceneTarget.setSize(target.width, target.height);
    this.film.material.uniforms.uResolution.value.set(target.width, target.height);
    this.film.material.uniforms.uPixelRatio.value = composerScale;
    // Bloom is soft; half resolution is enough and keeps small highlights
    // (glitter, spray) from shimmering as they cross coarse texels.
    this.bloom.setSize(Math.round(target.width * 0.5), Math.round(target.height * 0.5));
    this.appliedScale = TUNING.visuals.renderScale;
    // Point sprites are sized in rendered pixels; this keeps them the same
    // size on screen at any render scale.
    this.scene.userData.renderHeight = target.height * 2.5;
    this.scene.userData.pointPxScale = target.height / Math.max(1, h * 0.6);

    this.rawComposer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.rawComposer.setSize(w, h);
  }

  render(dt, state) {
    if (!this.enabled) {
      // Without the post chain, use a slightly lower exposure so raw-mode
      // highlights do not clip.
      this.renderer.toneMappingExposure = TUNING.visuals.exposure * 0.72;
      this.rawComposer.render(dt);
      return;
    }
    const samples = this._wantedSamples();
    if (this.sceneTarget.samples !== samples) {
      this.sceneTarget.samples = samples;
      this.sceneTarget.dispose();
    }
    this._frame++;
    const time = performance.now() * 0.001;
    const legacy = !!TUNING.visuals.legacyFilm;
    const fu = this.film.material.uniforms;
    fu.uTime.value = time;
    fu.uUnderwater.value = state.underwater;
    // A fresh soaking leaves a fresh pattern of drops.
    const wetNow = Math.max(state.wetness, 0);
    if (wetNow > (this._lastWet ?? 0) + 0.25) fu.uDropSeed.value = Math.floor(Math.random() * 97);
    this._lastWet = wetNow;
    fu.uWetness.value = wetNow;
    fu.uSpeed.value = state.speedNorm;
    fu.uLensDrops.value = TUNING.visuals.lensDrops ? 1 : 0;
    fu.uLegacy.value = legacy ? 1 : 0;
    fu.uGrain.value = legacy ? 0.028 : TUNING.visuals.grain;
    fu.uAberration.value = legacy ? 0.0012 : TUNING.visuals.aberration;
    fu.uVignette.value = legacy ? 0.24 : TUNING.visuals.vignette;
    fu.uEdgeSmooth.value = TUNING.visuals.edgeSmoothing ? 1 : 0;

    this.camera.getWorldDirection(this._forward);
    const facing = this._forward.dot(this.sunDir);
    this._sunPoint
      .copy(this.camera.position)
      .addScaledVector(this.sunDir, 480)
      .project(this.camera);
    const sx = this._sunPoint.x * 0.5 + 0.5;
    const sy = this._sunPoint.y * 0.5 + 0.5;
    fu.uSunScreen.value.set(
      Math.max(-0.08, Math.min(1.08, sx)),
      Math.max(0.08, Math.min(1.09, sy))
    );
    const sunPower = Math.max(0, Math.min(1, (facing + 0.12) * 1.4)) * 0.8;
    fu.uSunPower.value = sunPower;

    this.camera.updateMatrixWorld();
    this._right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._up.setFromMatrixColumn(this.camera.matrixWorld, 1);

    const vu = this.volumetric.material.uniforms;
    vu.tDiffuse.value = this.sceneTarget.texture;
    vu.tDepth.value = this.sceneTarget.depthTexture;
    vu.uResolution.value.set(this.sceneTarget.width, this.sceneTarget.height);
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
    vu.uSunRefr.value.copy(this.sunRefr);
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
    vu.uCausticNet.value = TUNING.visuals.causticNet;
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
