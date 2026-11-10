import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { PALETTE, SUN_DIRECTION, TUNING } from "./config.js";
import { glslCaustics, glslNoise } from "./utils.js";

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

    void main() {
      float under = uUnderwater;
      float wet = uWetness;
      vec2 uv = vUv;

      // Very slight spherical lens + water-surface wobble.
      vec2 centered = uv * 2.0 - 1.0;
      float r2 = dot(centered, centered);
      vec2 lens = uv + centered * (0.006 + under * 0.012) * r2;
      if (under > 0.01) {
        lens.x += sin(uv.y * 44.0 + uTime * 1.3) * 0.00075 * under;
        lens.y += cos(uv.x * 36.0 + uTime * 1.1) * 0.00055 * under;
      }

      // Sparse droplets on the lens after a breach.
      if (wet > 0.01) {
        vec2 grid = uv * vec2(19.0, 12.0);
        vec2 cell = floor(grid);
        vec2 local = fract(grid) - 0.5;
        float h = hash(cell + floor(uTime * 0.9) * 0.13);
        float drop = smoothstep(0.26, 0.06, length(local + vec2(h - 0.5, hash(cell.yx) - 0.5) * 0.3));
        drop *= step(0.72, h) * wet;
        lens += normalize(local + 0.0001) * drop * 0.003 * wet;
      }

      vec2 uvA = clamp(lens, vec2(0.001), vec2(0.999));
      float aberration = uAberration * (0.45 + under * 0.9) * (1.0 + uSpeed * 0.22);
      vec3 color = sampleChroma(uvA, aberration);

      // Plastic-lens softness. Small sensor, bad glass, soft corners.
      vec2 softness = vec2(0.0015, 0.0011) * (0.8 + r2 * 1.6);
      vec3 softA = texture2D(tDiffuse, clamp(uvA + softness, 0.001, 0.999)).rgb;
      vec3 softB = texture2D(tDiffuse, clamp(uvA - softness, 0.001, 0.999)).rgb;
      vec3 softC = texture2D(tDiffuse, clamp(uvA + vec2(-softness.x, softness.y), 0.001, 0.999)).rgb;
      vec3 softD = texture2D(tDiffuse, clamp(uvA + vec2(softness.x, -softness.y), 0.001, 0.999)).rgb;
      color = mix(color, (softA + softB + softC + softD) * 0.25, 0.18 + under * 0.08);

      // Slight horizontal smear. Tiny sensors, cheap optics, and a wet lens
      // all leave a little colour dragging along the scan direction.
      vec3 horizontalSmear = texture2D(tDiffuse, clamp(uvA - vec2(0.0045, 0.0), 0.001, 0.999)).rgb;
      color = mix(color, horizontalSmear, 0.03 + under * 0.025);

      // Soft, imperfect optical center: three cheap taps at speed.
      if (uSpeed > 0.15) {
        vec2 blurDir = (uvA - 0.5) * 0.0028 * uSpeed;
        vec3 blur = texture2D(tDiffuse, uvA + blurDir).rgb * 0.5 + texture2D(tDiffuse, uvA - blurDir).rgb * 0.5;
        color = mix(color, blur, 0.18 + under * 0.12);
      }

      // Wet lens highlights.
      if (wet > 0.01) {
        vec2 grid = uv * vec2(19.0, 12.0);
        vec2 cell = floor(grid);
        vec2 local = fract(grid) - 0.5;
        float h = hash(cell + floor(uTime * 0.9) * 0.13);
        float drop = smoothstep(0.26, 0.1, length(local + vec2(h - 0.5, hash(cell.yx) - 0.5) * 0.3)) * step(0.72, h);
        float glint = smoothstep(0.12, 0.0, length(local + vec2(-0.06, -0.05))) * drop * wet;
        color += vec3(0.35, 0.5, 0.45) * glint * 0.16;
      }

      // Bleached, hazy air above; heavier cyan-green density below.
      if (under > 0.01) {
        float depthHaze = smoothstep(0.0, 1.0, r2);
        float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
        vec3 deepTint = vec3(0.005, 0.03, 0.062);
        // Cheap halation: let only the brighter parts bleed into neighbours.
        vec2 haloOff = vec2(0.0026, 0.0017) * (1.0 + under);
        vec3 halo = texture2D(tDiffuse, clamp(uvA + haloOff, 0.001, 0.999)).rgb;
        halo += texture2D(tDiffuse, clamp(uvA - haloOff, 0.001, 0.999)).rgb;
        halo *= 0.5;
        float haloLum = dot(halo, vec3(0.2126, 0.7152, 0.0722));
        color += halo * smoothstep(0.68, 0.98, haloLum) * 0.12;
        color = mix(color, deepTint, 0.07 * under);
        vec3 coolGrade = color * vec3(0.82, 0.96, 1.08);
        vec3 warmGrade = color * vec3(1.08, 1.0, 0.86);
        color = mix(coolGrade, warmGrade, smoothstep(0.32, 0.82, lum));
        color = mix(vec3(lum), color, 1.58 + under * 0.15);
        color = (color - 0.47) * (1.12 + under * 0.05) + 0.47;
        color = mix(color, vec3(lum) * vec3(0.66, 0.93, 1.04), 0.03 * under);
        color += vec3(0.03, 0.12, 0.23) * pow(max(lum - 0.3, 0.0), 1.8) * 0.18 * under;
        color *= mix(1.0, 0.78, depthHaze * under);
        color = max(color, vec3(0.004, 0.018, 0.02));

        // A soft memory of the sun above the surface. The depth-aware
        // volumetric pass now owns the hard shafts; this is only the broad
        // scatter that survives in the lens.
        vec2 sunDelta = (uv - uSunScreen) * vec2(1.0, 0.8);
        float sunDist = length(sunDelta);
        float scatter = exp(-sunDist * 3.6);
        color += uSunPower * under * vec3(0.26, 0.44, 0.6) * scatter * 0.5;
        float upperHaze = smoothstep(0.35, 0.95, uv.y);
        color += vec3(0.025, 0.09, 0.17) * upperHaze * under * 1.25;
      } else {
        // Overexposed tropical air and a warm halation around the sun.
        float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
        // Split-tone the air: cool, blue shadows in the swell and warm,
        // honeyed highlights around the sun and foam.
        vec3 aboveCool = color * vec3(0.88, 0.98, 1.1);
        vec3 aboveWarm = color * vec3(1.09, 1.0, 0.86);
        color = mix(aboveCool, aboveWarm, smoothstep(0.36, 0.86, lum));
        color = mix(color, vec3(1.0, 0.945, 0.82), smoothstep(0.64, 1.16, lum) * 0.2);
        color += vec3(0.07, 0.04, 0.01) * smoothstep(0.58, 1.0, lum);
        color = mix(vec3(lum), color, 0.94);
        color = (color - 0.5) * 0.97 + 0.5;
      }

      // A hint of low-bitrate chroma smear — color remembers its neighbours
      // longer than luminance does.
      if (under > 0.01) {
        vec2 chromaOffset = vec2(0.0021, 0.0) * (0.5 + 1.5 * r2);
        vec3 sideA = texture2D(tDiffuse, clamp(uvA + chromaOffset, 0.001, 0.999)).rgb;
        vec3 sideB = texture2D(tDiffuse, clamp(uvA - chromaOffset, 0.001, 0.999)).rgb;
        float lumA = dot(sideA, vec3(0.2126, 0.7152, 0.0722));
        float lumB = dot(sideB, vec3(0.2126, 0.7152, 0.0722));
        color = mix(color, vec3(lumA * 0.5 + lumB * 0.5), 0.04);
      }

      // Light compression: quantized channels with a gentle dither, plus
      // slow, blocky chroma noise. It should read as data, not pixels.
      float dither = (hash12(gl_FragCoord.xy + floor(uTime * 24.0)) - 0.5) / 48.0;
      vec3 quantized = floor((color + dither) * 48.0) / 48.0;
      color = mix(color, quantized, 0.32);
      vec2 block = floor(gl_FragCoord.xy / (6.0 * max(1.0, uPixelRatio)));
      float blockNoise = hash(block + floor(uTime * 8.0));
      color += (blockNoise - 0.5) * 0.008 * (0.5 + under);

      // Grain, heavier in the shadows, and faint vertical scan smear.
      float grainSeed = hash12(gl_FragCoord.xy * 0.71 + floor(uTime * 30.0) * 17.13);
      float lum2 = dot(color, vec3(0.2126, 0.7152, 0.0722));
      float grain = (grainSeed - 0.5) * uGrain * (1.15 - lum2 * 0.55);
      color += grain;
      color += (hash12(gl_FragCoord.xy * 1.31 + floor(uTime * 24.0)) - 0.5) * vec3(0.012, 0.02, 0.022) * (0.35 + under);
      color -= sin(uv.y * uResolution.y * 1.55) * 0.0045 * (0.3 + under * 0.7);

      // Slow VHS tracking band.
      float band = smoothstep(0.035, 0.0, abs(fract(uv.y * 0.66 + uTime * 0.021) - 0.5) - 0.475);
      color += vec3(0.08, 0.1, 0.08) * band * 0.07;
      color -= vec3(0.03, 0.02, 0.0) * smoothstep(0.01, 0.0, abs(fract(uv.y * 0.31 - uTime * 0.014) - 0.5) - 0.49);

      // Vignette and edge dirt. The vertical axis is deliberately softer so
      // a wide frame does not turn the sky into a grey band.
      float vig = smoothstep(1.16, 0.24, length(centered * vec2(0.98, 0.72)));
      color *= mix(1.0, vig, uVignette);
      color *= 0.965 + 0.055 * smoothstep(0.0, 0.6, uv.y);

      // A cheap camcorder iris hunting for exposure and drifting white balance.
      float iris = 1.0 + sin(uTime * 0.11) * 0.012 + sin(uTime * 0.043 + 1.7) * 0.008;
      iris -= uSunPower * 0.05 * under;
      color *= iris;
      color.r *= 1.0 + sin(uTime * 0.021 + 0.4) * 0.008;
      color.b *= 1.0 + sin(uTime * 0.017 + 2.1) * 0.007;

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

    ${glslNoise}
    ${glslCaustics}

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

        // Thin in-scatter toward the bright surface. This is not a replacement
        // for the material fog; it is the light that hangs between surfaces.
        float scatterAmount = 1.0 - exp(-rayLength * 0.024);
        vec3 scatterTint = mix(
          uWaterDeep,
          uWaterShallow,
          exp(-belowSurface * 0.06) * 0.45 + sunAlign * 0.12
        );
        color = mix(
          color,
          scatterTint * (0.78 + 0.22 * sunAlign),
          scatterAmount * 0.15 * uScatter * uUnderwater
        );

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
        float causticMask =
          upFacing * belowGap * lightFacing * causticDepth * uCaustic * uUnderwater;
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
        float horizon = exp(-abs(rayDir.y - 0.012) * 12.0);
        float distanceHaze = 1.0 - exp(-rayLength * 0.0011);
        vec3 hazeTint = mix(
          uSkyHorizon,
          uSunColor,
          clamp(dot(rayDir, uSunDir) * 0.5 + 0.5, 0.0, 1.0) * 0.58
        );
        float mistBand = smoothstep(
          0.56,
          0.92,
          fbm2(vec2(rayDir.x * 3.5 + uTime * 0.004, rayDir.y * 26.0 - uTime * 0.002))
        );
        mistBand *= exp(-abs(rayDir.y - 0.015) * 7.0);
        color = mix(
          color,
          hazeTint,
          (horizon * 0.08 + distanceHaze * 0.065) * uHaze * above
        );
        color += hazeTint * mistBand * uMist * above * 0.10;
        float sunHalo = pow(max(dot(rayDir, uSunDir), 0.0), 6.0);
        color += uSunColor * sunHalo * (0.045 + uSunPower * 0.15) * uHaze * above;
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
    this.film.material.uniforms.uWetness.value = Math.max(state.wetness, 0);
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
