import * as THREE from "three";
import { TUNING, PALETTE, SUN_DIRECTION } from "./config.js";
import {
  clamp,
  getWaveSet,
  glslFog,
  glslNoise,
  smoothstep,
  waveHeightAt,
  waveSampleAt,
} from "./utils.js";

/**
 * A seamless procedural water normal/ripple map. The previous surface used a
 * lattice of sines, which read as a regular grid from above. This map sums
 * twelve integer-frequency wave vectors, so it tiles without seams while the
 * interference pattern stays irregular. R/G are the x/z normal, B is a height
 * mask used for ripple brightness on the underside.
 */
function makeWaterNormalTexture(size = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const tau = Math.PI * 2;
  const waves = [
    [3, 5, 0.42, 0.0],
    [7, -2, 0.30, 1.7],
    [-5, 9, 0.24, 3.1],
    [11, 7, 0.16, 5.2],
    [-13, 9, 0.12, 2.4],
    [17, -5, 0.09, 4.6],
    [-9, -17, 0.07, 0.8],
    [23, 7, 0.05, 3.9],
    [5, -11, 0.18, 1.0],
    [-19, 13, 0.06, 2.9],
    [29, 3, 0.04, 5.8],
    [2, 19, 0.10, 4.2],
  ];
  let p = 0;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let h = 0;
      let dhdu = 0;
      let dhdv = 0;
      for (let i = 0; i < waves.length; i++) {
        const w = waves[i];
        const a = tau * (w[0] * u + w[1] * v) + w[3];
        const s = Math.sin(a);
        const c = Math.cos(a) * w[2] * tau;
        h += s * w[2];
        dhdu += c * w[0];
        dhdv += c * w[1];
      }
      const scale = 0.004;
      let nx = -dhdu * scale;
      let nz = -dhdv * scale;
      const len = Math.hypot(nx, 1, nz);
      nx /= len;
      nz /= len;
      data[p++] = (nx * 0.5 + 0.5) * 255;
      data[p++] = (nz * 0.5 + 0.5) * 255;
      data[p++] = Math.max(0, Math.min(255, (0.5 + h * 0.3) * 255));
      data[p++] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * GPU heightfield for surface contact and propagating wakes.
 * R = surface height, G = vertical velocity. A tiny wave-equation integrator
 * runs in ping-pong render targets and is also sampled by the ocean vertex
 * shader to part the surface around the dolphin.
 */
class SurfaceSimulation {
  constructor(renderer) {
    this.renderer = renderer;
    this.size = TUNING.waves.simResolution;
    this.extent = TUNING.waves.simExtent;
    this.center = new THREE.Vector2(99999, 99999);
    this.splats = [];
    this.enabled = true;
    this.accumulator = 0;

    const opts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.targets = [
      new THREE.WebGLRenderTarget(this.size, this.size, opts),
      new THREE.WebGLRenderTarget(this.size, this.size, opts),
    ];
    this.index = 0;
    for (const t of this.targets) {
      this.renderer.setRenderTarget(t);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.splatData = Array.from({ length: 8 }, () => new THREE.Vector4());
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uState;
        uniform vec2 uTexel;
        uniform float uDamping;
        uniform float uWaveSpeed;
        uniform float uTime;
        uniform float uExtent;
        uniform vec2 uCenter;
        uniform int uSplatCount;
        uniform vec4 uSplats[8];

        vec2 stateAt(vec2 uv) {
          return texture2D(uState, clamp(uv, vec2(0.001), vec2(0.999))).rg;
        }

        void main() {
          vec2 st = texture2D(uState, vUv).rg;
          float h = st.r;
          float v = st.g;

          float n = stateAt(vUv + vec2(0.0, uTexel.y)).r;
          float s = stateAt(vUv - vec2(0.0, uTexel.y)).r;
          float e = stateAt(vUv + vec2(uTexel.x, 0.0)).r;
          float w = stateAt(vUv - vec2(uTexel.x, 0.0)).r;
          float laplacian = n + s + e + w - 4.0 * h;

          // Gentle advection by a slow shelf current.
          vec2 cur = vec2(0.0022, -0.0014) * uTexel;
          float carried = stateAt(vUv - cur).r;
          h = mix(h, carried, 0.006);

          v += laplacian * uWaveSpeed;
          v *= uDamping;
          h += v;

          for (int i = 0; i < 8; i++) {
            if (i >= uSplatCount) break;
            vec4 sp = uSplats[i];
            vec2 d = vUv - sp.xy;
            float r = sp.w;
            float fall = exp(-dot(d, d) / max(r * r, 0.000001) * 2.6);
            float ring = exp(-pow((length(d) - r * 1.5) / (r * 0.75), 2.0));
            h += sp.z * (fall - ring * 0.3);
            v += sp.z * 0.025 * fall;
          }

          h = clamp(h, -1.8, 1.8);
          v = clamp(v, -1.2, 1.2);
          gl_FragColor = vec4(h, v, 0.0, 1.0);
        }
      `,
      uniforms: {
        uState: { value: null },
        uTexel: { value: new THREE.Vector2(1 / this.size, 1 / this.size) },
        uDamping: { value: TUNING.waves.simDamping },
        uWaveSpeed: { value: TUNING.waves.simWaveSpeed },
        uTime: { value: 0 },
        uExtent: { value: this.extent },
        uCenter: { value: new THREE.Vector2() },
        uSplatCount: { value: 0 },
        uSplats: { value: this.splatData },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this._texel = new THREE.Vector2(1 / this.size, 1 / this.size);
    this.renderer.getContext().canvas.addEventListener("webglcontextlost", () => {
      this.enabled = false;
    });
  }

  addSplat(x, z, strength, radius) {
    if (this.splats.length >= 8) return;
    this.splats.push({ x, z, strength, radius });
  }

  update(dt, playerPos) {
    if (!this.enabled) return;
    const maxDist = this.extent * 0.36;
    if (this.center.x > 9999 || this.center.distanceTo(new THREE.Vector2(playerPos.x, playerPos.z)) > maxDist) {
      this.center.set(playerPos.x, playerPos.z);
      for (const t of this.targets) {
        this.renderer.setRenderTarget(t);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.clear(true, false, false);
      }
      this.renderer.setRenderTarget(null);
    }

    this.accumulator = Math.min(this.accumulator + dt, 1 / 20);
    const step = 1 / 60;
    while (this.accumulator >= step) {
      this.accumulator -= step;
      this._step(step);
    }
  }

  _step(dt) {
    const src = this.targets[this.index];
    const dst = this.targets[1 - this.index];
    const mat = this.material;
    mat.uniforms.uState.value = src.texture;
    mat.uniforms.uTime.value += dt;
    mat.uniforms.uDamping.value = TUNING.waves.simDamping;
    mat.uniforms.uWaveSpeed.value = TUNING.waves.simWaveSpeed;
    mat.uniforms.uCenter.value.copy(this.center);
    mat.uniforms.uExtent.value = this.extent;
    mat.uniforms.uTexel.value.copy(this._texel);

    const count = Math.min(this.splats.length, 8);
    for (let i = 0; i < count; i++) {
      const s = this.splats[i];
      const nx = (s.x - this.center.x) / this.extent + 0.5;
      const nz = (s.z - this.center.y) / this.extent + 0.5;
      this.splatData[i].set(
        clamp(nx, 0, 1),
        clamp(nz, 0, 1),
        clamp(s.strength, -0.9, 0.9),
        clamp(s.radius / this.extent, 0.0025, 0.3)
      );
    }
    mat.uniforms.uSplatCount.value = count;
    this.renderer.setRenderTarget(dst);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.index = 1 - this.index;
    this.splats.length = 0;
  }

  get texture() {
    return this.targets[this.index].texture;
  }
}

export class Ocean {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.time = 0;
    this.sim = new SurfaceSimulation(renderer);
    this.lastSample = {};
    this._underwater = 1;
    this._wetness = 0;
    this._tempColor = new THREE.Color();

    this.sunDir = new THREE.Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize();
    this.fogColor = new THREE.Color(PALETTE.fogShallow);
    this.fogDeepColor = new THREE.Color(PALETTE.fogDeep);
    this.waterDeep = new THREE.Color(PALETTE.waterDeep);
    this.waterTop = new THREE.Color(PALETTE.waterTop);
    this.skyHorizon = new THREE.Color(PALETTE.skyHorizon);
    this.skyZenith = new THREE.Color(PALETTE.skyZenith);
    this.sunColor = new THREE.Color(PALETTE.sunColor);

    this.uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector2() },
      uSimCenter: { value: this.sim.center },
      uSimExtent: { value: this.sim.extent },
      uSimState: { value: this.sim.texture },
      uAmplitude: { value: TUNING.waves.amplitude },
      uWind: { value: TUNING.waves.windSpeed },
      uChop: { value: TUNING.waves.choppiness },
      uWaveCount: { value: TUNING.waves.waveCount },
      uWaveDirs: {
        value: Array.from({ length: 6 }, () => new THREE.Vector2(1, 0)),
      },
      uWaveParams: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
      uSunDir: { value: this.sunDir },
      uSunColor: { value: this.sunColor },
      uDeepColor: { value: this.waterDeep },
      uTopColor: { value: this.waterTop },
      uSkyHorizon: { value: this.skyHorizon },
      uSkyZenith: { value: this.skyZenith },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0.025 },
      uCameraPos: { value: new THREE.Vector3() },
      uUnderwater: { value: 1 },
      uFoamAmount: { value: TUNING.waves.foamAmount },
      uFoamThreshold: { value: TUNING.waves.foamThreshold },
      uDisplacement: { value: TUNING.waves.displacementScale },
      uWetness: { value: 0 },
      uWaterNormal: { value: makeWaterNormalTexture() },
    };

    this.material = this._buildMaterial();
    this.mesh = new THREE.Mesh(this._buildGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);

    this.sky = this._buildSky();
    this.scene.add(this.sky);

    this.splashPoints = [];
    this.tmpVec = new THREE.Vector3();
    this.tmpVec2 = new THREE.Vector3();
    this.updateWaveUniforms();
  }

  _buildGeometry() {
    const radius = TUNING.waves.surfaceRadius;
    const rings = TUNING.waves.surfaceRings;
    const segments = TUNING.waves.surfaceSegments;
    const positions = [];
    const uvs = [];
    const indices = [];

    // Exponentially denser rings near the viewer: 0.4 m geometry at the
    // surface, kilometres of ocean at the horizon.
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      const r = Math.pow(t, 2.45) * radius + 0.08;
      for (let j = 0; j < segments; j++) {
        const a = (j / segments) * Math.PI * 2;
        positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
        uvs.push(j / segments, t);
      }
    }
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < segments; j++) {
        const j2 = (j + 1) % segments;
        const a = i * segments + j;
        const b = i * segments + j2;
        const c = (i + 1) * segments + j;
        const d = (i + 1) * segments + j2;
        indices.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    return g;
  }

  _buildMaterial() {
    const uniforms = this.uniforms;
    return new THREE.ShaderMaterial({
      uniforms,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      fog: false,
      vertexShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        uniform vec2 uCenter;
        uniform sampler2D uSimState;
        uniform vec2 uSimCenter;
        uniform float uSimExtent;
        uniform int uWaveCount;
        uniform vec2 uWaveDirs[6];
        uniform vec4 uWaveParams[6];
        uniform float uDisplacement;
        uniform float uWind;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        varying float vSimHeight;
        varying float vWaveHeight;
        varying float vCrest;
        varying float vDistance;

        vec2 simSample(vec2 world) {
          vec2 uv = (world - uSimCenter) / uSimExtent + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec2(0.0);
          return texture2D(uSimState, uv).rg;
        }

        void main() {
          vec3 world = vec3(position.x + uCenter.x, 0.0, position.z + uCenter.y);
          float h = 0.0;
          float dhx = 0.0;
          float dhz = 0.0;
          vec3 horiz = vec3(0.0);

          for (int i = 0; i < 6; i++) {
            if (i >= uWaveCount) break;
            vec2 dir = uWaveDirs[i];
            vec4 wp = uWaveParams[i]; // k, amplitude, phase, horizontal
            float arg = wp.x * dot(dir, world.xz) + wp.z;
            float s = sin(arg);
            float c = cos(arg);
            h += wp.y * s;
            dhx += wp.y * wp.x * dir.x * c;
            dhz += wp.y * wp.x * dir.y * c;
            horiz.x += wp.w * dir.x * c;
            horiz.z += wp.w * dir.y * c;
          }

          world.x += horiz.x;
          world.z += horiz.z;
          vec2 sim = simSample(world.xz);
          world.y = h * (0.9 + uWind * 0.012) + sim.r * uDisplacement;

          vec2 hx = simSample(world.xz + vec2(0.7, 0.0)) - simSample(world.xz - vec2(0.7, 0.0));
          vec2 hz = simSample(world.xz + vec2(0.0, 0.7)) - simSample(world.xz - vec2(0.0, 0.7));
          float simGradX = hx.x;
          float simGradZ = hz.x;

          vec3 n = normalize(vec3(-dhx - simGradX * 2.2, 1.0, -dhz - simGradZ * 2.2));
          world.x += -simGradX * 0.55;
          world.z += -simGradZ * 0.55;

          vec4 mv = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mv;
          vWorld = world;
          vNormalW = normalize(n);
          vSimHeight = sim.r;
          vWaveHeight = h;
          vCrest = clamp((h + 0.08) / 0.62, 0.0, 1.0);
          vDistance = length(world.xz - uCenter);
          vViewDir = normalize(world - cameraPosition);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        uniform sampler2D uWaterNormal;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uDeepColor;
        uniform vec3 uTopColor;
        uniform vec3 uSkyHorizon;
        uniform vec3 uSkyZenith;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform vec3 uCameraPos;
        uniform float uUnderwater;
        uniform float uFoamAmount;
        uniform float uFoamThreshold;
        uniform float uWetness;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        varying float vSimHeight;
        varying float vWaveHeight;
        varying float vCrest;
        varying float vDistance;

        ${glslNoise}
        ${glslFog}

        void main() {
          vec3 n = normalize(vNormalW);
          vec3 view = normalize(uCameraPos - vWorld);
          if (dot(view, n) < 0.0) n = -n;
          float lookingUp = clamp(-view.y, 0.0, 1.0);

          // Two scales of an irregular tiling normal map. The old lattice of
          // sine waves read as a regular grid from the air; this keeps the
          // ripple field broken up while retaining real wave slopes.
          float detailFade = 1.0 - smoothstep(40.0, 260.0, vDistance);
          vec2 uvA = vWorld.xz * 0.075 + vec2(uTime * 0.012, uTime * 0.007);
          vec2 uvB = vec2(vWorld.z, -vWorld.x) * 0.17 - vec2(uTime * 0.005, -uTime * 0.009);
          vec4 waterA = texture2D(uWaterNormal, uvA);
          vec4 waterB = texture2D(uWaterNormal, uvB);
          vec2 slopeA = waterA.rg * 2.0 - 1.0;
          vec2 slopeB = waterB.rg * 2.0 - 1.0;
          slopeB = vec2(-slopeB.y, slopeB.x);
          vec2 slope = slopeA * 0.8 + slopeB * 0.55 * detailFade;
          vec3 microN = normalize(vec3(n.x + slope.x * 0.32, n.y, n.z + slope.y * 0.32));
          float rippleBrightness = waterA.b * 0.65 + waterB.b * 0.35;

          // Wind-aligned foam: a broad broken field plus stretched lacing.
          // The old single fbm was smooth and read as milk rather than spray.
          vec2 windDir = vec2(0.72, 0.69);
          float along = dot(vWorld.xz, windDir);
          float across = dot(vWorld.xz, vec2(-windDir.y, windDir.x));
          float foamNoise = vnoise(vWorld.xz * 1.7 + vec2(uTime * 0.06, -uTime * 0.04));
          float foamLace = vnoise(vec2(along * 1.25 + uTime * 0.05, across * 5.2 - uTime * 0.04) + 17.3);
          float lace = smoothstep(0.52, 0.88, foamLace);
          float crestFoam = smoothstep(uFoamThreshold + 0.06, uFoamThreshold + 0.32, vCrest + foamNoise * 0.16 - 0.16);
          float faceFoam = smoothstep(0.58, 0.9, vCrest + lace * 0.25 - 0.2) * (0.2 + 0.8 * lace);
          float upset = smoothstep(0.015, 0.16, abs(vSimHeight));
          float simFoam = upset * 0.7;
          float foam = clamp((crestFoam * 0.4 + faceFoam * 0.25) * uFoamAmount + simFoam, 0.0, 1.0);
          foam *= smoothstep(0.35, 0.8, foamNoise + lace * 0.3 + foam * 0.2);
          float foamFine = vnoise(vWorld.xz * 8.5 + vec2(uTime * 0.11, -uTime * 0.08));
          foam *= smoothstep(0.2, 0.75, foamFine * 0.6 + foamNoise * 0.4);
          foam *= 1.0 - smoothstep(320.0, 900.0, vDistance);

          // Above the surface: Fresnel sky reflection with a broken cloud
          // veil, crest translucency and a sharp sun glitter path. The broad
          // reflection is pulled toward the water body so grazing angles stay
          // blue instead of becoming a white sheet.
          vec3 refl = reflect(-view, microN);
          float sunAlign = max(dot(refl, uSunDir), 0.0);
          vec3 sky = mix(uSkyHorizon, uSkyZenith * 0.82, pow(clamp(refl.y, 0.0, 1.0), 0.55));
          sky += uSunColor * (pow(sunAlign, 140.0) * 0.9 + pow(sunAlign, 8.0) * 0.035);
          vec2 cloudUV = refl.xz / (max(refl.y, 0.03) + 0.26);
          float cloudVeil = smoothstep(0.45, 0.72, vnoise(cloudUV * 1.8 + vec2(uTime * 0.002, 0.0)));
          sky = mix(sky, vec3(0.58, 0.61, 0.62), cloudVeil * 0.06);
          sky = mix(sky, uDeepColor * 0.55 + uTopColor * 0.45, 0.34);
          float viewDot = clamp(dot(view, microN), 0.0, 1.0);
          float fres = 0.02 + 0.98 * pow(1.0 - viewDot, 5.0);
          vec3 body = uDeepColor * 0.72 + uTopColor * 0.22;
          body += uTopColor * (0.02 + vCrest * 0.13) * 0.45;
          vec3 above = mix(body, sky, clamp(0.08 + fres * 0.65, 0.0, 0.85));
          above += uSunColor * pow(sunAlign, 700.0) * 0.45;
          above += uSunColor * pow(sunAlign, 60.0) * 0.05;
          above += uTopColor * pow(sunAlign, 24.0) * 0.06;
          float whiteWater = clamp(foam * 1.5, 0.0, 1.0);
          vec3 foamColor = mix(
            vec3(0.42, 0.55, 0.58),
            vec3(0.93, 0.96, 0.94),
            smoothstep(0.15, 0.85, foamNoise + lace * 0.3)
          );
          above = mix(above, foamColor, whiteWater * 0.6);
          above = mix(above, vec3(0.96, 0.98, 0.97), whiteWater * 0.08);
          above = applyWaterFog(above, vDistance, uFogColor, uFogDensity * 0.34);

          // Below: the underside of the ceiling. At the shallow grazing angles
          // a submerged camera normally sees, this is mostly dark total
          // internal reflection with thin, moving caustic veins — not a white
          // skylight. Keep the energy bounded so it never blooms into paint.
          float up = smoothstep(-0.12, 0.95, lookingUp);
          // The underside is a liquid ceiling: steep rays look through the
          // Snell window into the bright sky, while grazing rays sit in dark
          // total internal reflection with caustic veins running through it.
          vec3 underNormal = normalize(vec3(microN.x * 1.35, microN.y, microN.z * 1.35));
          float cosUp = clamp(dot(-view, underNormal), 0.0, 1.0);
          float window = smoothstep(0.5, 0.82, cosUp);
          float rim = exp(-pow((cosUp - 0.64) / 0.10, 2.0));
          float rippleFine = smoothstep(0.42, 0.82, rippleBrightness);
          // Grazing rays are total internal reflection: a smooth silver-blue
          // mirror of the water column, with bright ripple bands rather than
          // noise-shaped shadows. Steep rays open into the window.
          vec3 below = mix(uDeepColor * 0.52, uTopColor * 0.15, 0.12 + up * 0.28);
          below *= 0.82 + 0.18 * vCrest;
          below += uTopColor * rippleFine * 0.055 * (0.4 + 0.6 * up);
          below += uTopColor * pow(rippleBrightness, 3.0) * 0.045;
          below += uTopColor * window * 0.08;

          window *= 0.78 + 0.22 * rippleBrightness;
          vec3 windowColor =
            uTopColor * (0.5 + 0.3 * window) +
            uSunColor * pow(max(dot(-view, uSunDir), 0.0), 8.0) * 0.32;
          windowColor *= 0.82 + 0.32 * rippleBrightness;
          below = mix(below, windowColor, window * 0.8);
          // A bright turquoise lip where the refracted window folds under
          // the wave, plus a narrow sunball caught in the surface.
          below += uSunColor * rim * (0.35 + 0.65 * up) * 0.08;
          below += uSunColor * pow(max(dot(-view, uSunDir), 0.0), 90.0) * 0.11 * window;

          float upWash = pow(up, 1.6);
          below += vec3(0.02, 0.08, 0.15) * upWash * 0.1;
          below += uSunColor * pow(max(dot(-view, uSunDir), 0.0), 4.0) * 0.016 * upWash;
          // A shifting specular sheen across the underside of the swell.
          float sheen = pow(max(dot(reflect(-view, microN), uSunDir), 0.0), 22.0);
          below += uSunColor * sheen * 0.1 * smoothstep(-0.1, 0.45, lookingUp);
          below *= 0.9 + clamp(vCrest, 0.0, 1.0) * 0.16;
          below += uTopColor * foam * 0.1;
          below = mix(below, vec3(0.35, 0.48, 0.5), foam * 0.16);
          below = applyWaterFog(below, vDistance, uFogColor, uFogDensity * 0.5);
          below *= 0.95;

          vec3 color = uUnderwater > 0.5 ? below : above;
          color = min(color, vec3(1.7));
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
  }

  _buildSky() {
    const uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: this.sunDir },
      uHorizon: { value: this.skyHorizon },
      uZenith: { value: this.skyZenith },
      uSunColor: { value: this.sunColor },
    };
    this.skyUniforms = uniforms;
    const material = new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vDir = normalize(world.xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vDir;
        uniform vec3 uSunDir;
        uniform vec3 uHorizon;
        uniform vec3 uZenith;
        uniform vec3 uSunColor;
        uniform float uTime;
        ${glslNoise}
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.05, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.48));
          col = mix(col, uHorizon * 1.055, exp(-max(h, 0.0) * 10.0) * 0.7);

          // Blown-out, layered fair-weather cloud banks.
          vec2 cp = d.xz / (max(d.y, 0.035) + 0.22);
          float baseCloud = fbm2(cp * 1.25 + vec2(uTime * 0.003, 0.0));
          float clouds = fbm2(cp * 2.7 + vec2(baseCloud * 2.8 + uTime * 0.002, baseCloud));
          float band = smoothstep(0.43, 0.68, clouds + 0.12 * smoothstep(0.0, 0.3, d.y));
          float cloudWash = band * (0.36 - 0.18 * h);
          vec3 cloudTone = mix(vec3(0.27, 0.29, 0.31), vec3(0.88, 0.8, 0.69), smoothstep(0.0, 0.5, clouds));
          col = mix(col, cloudTone, cloudWash * 0.78);
          col = mix(col, uHorizon * 0.96, exp(-max(d.y, 0.0) * 16.0) * 0.4);

          float sd = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(sd, 360.0) * 2.4 + pow(sd, 18.0) * 0.26 + pow(sd, 4.0) * 0.055);
          col = mix(col, uSunColor * 1.35, pow(sd, 900.0) * 0.96);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(5200, 40, 28), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    return mesh;
  }

  updateWaveUniforms() {
    const set = getWaveSet(this.time);
    for (let i = 0; i < 6; i++) {
      const w = set[i];
      if (!w) {
        this.uniforms.uWaveDirs.value[i].set(1, 0);
        this.uniforms.uWaveParams.value[i].set(0, 0, 0, 0);
        continue;
      }
      this.uniforms.uWaveDirs.value[i].set(w.dx, w.dz);
      this.uniforms.uWaveParams.value[i].set(w.k, w.amp, w.phase, w.q);
    }
    this.uniforms.uAmplitude.value = TUNING.waves.amplitude;
    this.uniforms.uWind.value = TUNING.waves.windSpeed;
    this.uniforms.uChop.value = TUNING.waves.choppiness;
    this.uniforms.uWaveCount.value = TUNING.waves.waveCount;
  }

  /** CPU-accessible water height. Deterministic analytic fallback. */
  getWaterHeight(x, z) {
    return waveHeightAt(x, z, this.time);
  }

  getWaterSample(x, z) {
    return waveSampleAt(x, z, this.time, this.lastSample);
  }

  addSurfaceContact(x, z, force, radius = 0.85) {
    this.sim.addSplat(x, z, clamp(force, -0.8, 0.8), radius);
  }

  update(dt, playerPos, camera, underwater, wetness, context = {}) {
    this.time += dt;
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uCenter.value.set(camera.position.x, camera.position.z);
    u.uCameraPos.value.copy(camera.position);
    u.uWetness.value = wetness;

    const camUnder = camera.position.y < this.getWaterHeight(camera.position.x, camera.position.z);
    u.uUnderwater.value = camUnder ? 1 : 0;
    u.uFogColor.value.copy(context.fogColor || this.fogColor);
    u.uFogDensity.value = context.fogDensity ?? TUNING.visuals.underwaterDensity;

    this.sim.update(dt, playerPos);
    u.uSimState.value = this.sim.texture;
    u.uSimCenter.value.copy(this.sim.center);
    u.uSimExtent.value = this.sim.extent;
    u.uDisplacement.value = TUNING.waves.displacementScale;
    u.uFoamAmount.value = TUNING.waves.foamAmount;
    u.uFoamThreshold.value = TUNING.waves.foamThreshold;
    this.updateWaveUniforms();

    this.mesh.visible = this.shouldDrawSurface(camera);
    this.sky.visible = !camUnder;
    this.sky.position.set(camera.position.x, Math.min(camera.position.y, 0) * 0.2, camera.position.z);
    this.skyUniforms.uTime.value = this.time;
    u.uSunDir.value.copy(this.sunDir);
  }

  shouldDrawSurface(camera) {
    // When the camera is deep and looking away from the surface, the
    // circumhorizon polygon can fill the screen. It is still correct (the
    // surface is above), so draw it; culling would introduce pop.
    return true;
  }

  /** Inject an elliptical surface disturbance splashing outward from a point. */
  surfaceImpulse(x, z, intensity, radius = 1.0) {
    if (intensity <= 0.01) return;
    this.sim.addSplat(x, z, clamp(-intensity * 0.18, -0.72, 0), radius);
    const count = 3 + Math.floor(intensity * 3.2);
    for (let i = 0; i < count; i++) {
      this.sim.addSplat(
        x + (Math.random() - 0.5) * radius * 1.5,
        z + (Math.random() - 0.5) * radius * 1.5,
        (Math.random() - 0.5) * 0.12 * intensity,
        radius * (0.5 + Math.random() * 0.9)
      );
    }
  }
}
