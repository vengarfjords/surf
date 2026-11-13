import * as THREE from "three";
import { TUNING, PALETTE, SUN_DIRECTION } from "./config.js";
import { clamp, glslCaustics, glslFog, glslNoise } from "./utils.js";
import { WaveField } from "./water/field.js";
import { SurfSolver } from "./water/solver.js";
import { FoamField } from "./water/foam.js";
import { makeBathymetry } from "./water/bathymetry.js";
import { MAX_WAVES, probeFragmentShader, waterVertexShader } from "./water/shaders.js";
import { glslSky } from "./atmosphere.js";

/**
 * Seamless procedural ripple maps. Three independent maps are sampled at
 * non-commensurate world scales in the shader, which is the visual stand-in
 * for three FFT cascades: high-frequency detail only, never physics.
 */
function makeWaterNormalTexture(size = 256, seed = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const tau = Math.PI * 2;
  const waves = [
    [3, 5, 0.42, 0.0],
    [7, -2, 0.3, 1.7],
    [-5, 9, 0.24, 3.1],
    [11, 7, 0.16, 5.2],
    [-13, 9, 0.12, 2.4],
    [17, -5, 0.09, 4.6],
    [-9, -17, 0.07, 0.8],
    [23, 7, 0.05, 3.9],
    [5, -11, 0.18, 1.0],
    [-19, 13, 0.06, 2.9],
    [29, 3, 0.04, 5.8],
    [2, 19, 0.1, 4.2],
  ];
  const phaseShift = seed * 1.937;
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
        const a = tau * (w[0] * u + w[1] * v) + w[3] + phaseShift * (i + 1);
        const s = Math.sin(a);
        const c = Math.cos(a) * w[2] * tau;
        h += s * w[2];
        dhdu += c * w[0];
        dhdv += c * w[1];
      }
      const scale = 0.0042;
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
 * Small GPU heightfield for surface contact and propagating wakes. The large
 * sea is the analytic WaveField; this only parts the surface around the body.
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
    this.bathy = makeBathymetry(256);
    this.water = new WaveField(TUNING.water, this.bathy);
    this.solver = new SurfSolver(this.water, this.bathy);
    this.foamField = new FoamField(this.water, this.bathy);
    this.sim = new SurfaceSimulation(renderer);
    this.lastSample = {};
    this._surfaceSample = {};
    this._bodySample = {};
    this._solverSample = {};
    this._solverSurface = {};
    this._solver3D = {};
    this._foamSample = {};
    this._underwater = 1;
    this._wetness = 0;
    this._tempColor = new THREE.Color();
    this._waveSig = "";

    this.sunDir = new THREE.Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize();
    this.fogColor = new THREE.Color(PALETTE.fogShallow);
    this.fogDeepColor = new THREE.Color(PALETTE.fogDeep);
    this.waterDeep = new THREE.Color(PALETTE.waterDeep);
    this.waterTop = new THREE.Color(PALETTE.waterTop);
    this.skyHorizon = new THREE.Color(PALETTE.skyHorizon);
    this.skyZenith = new THREE.Color(PALETTE.skyZenith);
    this.sunColor = new THREE.Color(PALETTE.sunColor);

    const bathy = this.bathy;
    this.bathyTexture = bathy.texture;

    this.uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector2() },
      uWaves: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
      uWaveCount: { value: this.water.count },
      uSwellCount: { value: this.water.swellCount },
      uChop: { value: this.water.chop },
      uMaxCrest: { value: Math.max(0.5, this.water.stats.height * 0.8) },
      uSimCenter: { value: this.sim.center },
      uSimExtent: { value: this.sim.extent },
      uSimState: { value: this.sim.texture },
      uSimScale: { value: 1 },
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
      uFoamAmount: { value: TUNING.water.foamAmount },
      uFoamThreshold: { value: TUNING.water.foamThreshold },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uDetailStrength: { value: TUNING.water.detailStrength },
      uDetailScale: { value: new THREE.Vector3(53.0, 17.0, 5.7) },
      uDetail0: { value: makeWaterNormalTexture(256, 1) },
      uDetail1: { value: makeWaterNormalTexture(256, 2) },
      uDetail2: { value: makeWaterNormalTexture(256, 3) },
      uBathy: { value: bathy.texture },
      uPhaseField: { value: bathy.phaseTexture },
      uPhaseFieldSize: { value: bathy.size },
      uBathyExtent: { value: bathy.extent },
      uBathyMaxDepth: { value: bathy.maxDepth },
      uDepthResponse: { value: TUNING.water.depthResponse ? 1 : 0 },
      uPeakK: { value: this.water.peakK },
      uShoalRef: { value: TUNING.water.shoalReference },
      uShoalStrength: { value: TUNING.water.shoalStrength },
      uFocusCenter: { value: new THREE.Vector2(TUNING.water.surfZoneX, TUNING.water.surfZoneZ) },
      uFocusGain: { value: TUNING.water.reefFocus },
      uFocusCross: { value: TUNING.water.reefFocusCross },
      uFocusReach: { value: TUNING.water.reefFocusReach },
      uBreakRatio: { value: TUNING.water.breakRatio },
      uBreakSoftness: { value: TUNING.water.breakSoftness },
      uHs: { value: this.water.stats.height },
      uPeakKx: { value: this.water.peakKx },
      uPeakKz: { value: this.water.peakKz },
      uPeakPhase: { value: this.water.peakPhaseNow || 0 },
      uBreakerLip: { value: TUNING.water.breakerLip },
      uFaceSkew: { value: TUNING.water.faceSkew || 0 },
      uMegaOn: { value: 0 },
      uMegaA: { value: new THREE.Vector4() },
      uProbeOffset: { value: 0 },
      uMegaB: { value: new THREE.Vector4() },
      uAerationAmount: { value: TUNING.water.aerationAmount },
      uFoamPersistence: { value: TUNING.water.foamPersistence },
      uPeakWavelength: { value: this.water.stats.peakWavelength },
      uBodyPos: { value: new THREE.Vector3() },
      uBodyRadius: { value: 0.62 },
      uBodyActive: { value: 0 },
      uBodySpeed: { value: 0 },
      uSolverTexture: { value: this.solver.texture },
      uSolverCenter: { value: new THREE.Vector2(this.solver.centerX, this.solver.centerZ) },
      uSolverExtent: { value: this.solver.extent },
      uSolverTexel: { value: new THREE.Vector2(1 / this.solver.n, 1 / this.solver.n) },
      uSolverCell: { value: this.solver.dx },
      uSolverEnabled: { value: this.solver.enabled ? 1 : 0 },
      uFoamTexture: { value: this.foamField.texture },
      uFoamCenter: { value: new THREE.Vector2(this.foamField.centerX, this.foamField.centerZ) },
      uFoamExtent: { value: this.foamField.extent },
      uFoamEnabled: { value: this.foamField.enabled ? 1 : 0 },
      uDebugCrest: { value: 0 },
      uDebugSlope: { value: 0 },
      uDebugFoam: { value: 0 },
      uWhitecaps: { value: TUNING.visuals.whitecaps },
      uFoamStreaks: { value: TUNING.visuals.foamStreaks },
      uHorizonFog: { value: TUNING.visuals.horizonFog },
    };

    this.material = this._buildMaterial();
    this.geometry = this._buildGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);

    this.probeTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.probeTarget.texture.colorSpace = THREE.NoColorSpace;
    this.probeScene = new THREE.Scene();
    this.probeMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: waterVertexShader(MAX_WAVES),
      fragmentShader: probeFragmentShader,
      side: THREE.DoubleSide,
    });
    // The parity probe gets a dedicated 96×96 patch (±12 m, 25 cm cells).
    // This isolates CPU-vs-shader parity from the main clipmap's tessellation
    // error, which is measured separately by the visual surface itself.
    const probeGeo = new THREE.PlaneGeometry(24, 24, 192, 192);
    probeGeo.rotateX(-Math.PI / 2);
    this.probeMesh = new THREE.Mesh(probeGeo, this.probeMaterial);
    this.probeMesh.frustumCulled = false;
    this.probeScene.add(this.probeMesh);
    this.probeCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 140);
    this._probePixels = new Uint8Array(4);
    this._clearColor = new THREE.Color();

    this.sky = this._buildSky();
    this.scene.add(this.sky);

    this.tmpVec = new THREE.Vector3();
    this.tmpVec2 = new THREE.Vector3();
    this.updateWaveUniforms();
  }

  _buildGeometry() {
    const radius = TUNING.water.surfaceRadius;
    const rings = TUNING.water.surfaceRings;
    const segments = TUNING.water.surfaceSegments;
    const exponent = TUNING.water.meshExponent;
    const positions = [0, 0, 0];
    const uvs = [0, 0.5];
    const indices = [];

    // A single centre vertex caps the innermost ring. Without it the 1×1
    // parity probe sits in a tiny hole at the mesh centre and reads back the
    // clear colour instead of the surface.
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      const r = Math.pow(t, exponent) * radius + 0.12;
      for (let j = 0; j < segments; j++) {
        const a = (j / segments) * Math.PI * 2;
        positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
        uvs.push(j / segments, t);
      }
    }
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments;
      indices.push(0, 1 + j, 1 + j2);
    }
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < segments; j++) {
        const j2 = (j + 1) % segments;
        const a = 1 + i * segments + j;
        const b = 1 + i * segments + j2;
        const c = 1 + (i + 1) * segments + j;
        const d = 1 + (i + 1) * segments + j2;
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
    return new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      fog: false,
      vertexShader: waterVertexShader(MAX_WAVES),
      fragmentShader: /* glsl */ `
        precision highp float;

        uniform float uTime;
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
        uniform vec2 uWindDir;
        uniform float uDetailStrength;
        uniform vec3 uDetailScale;
        uniform sampler2D uDetail0;
        uniform sampler2D uDetail1;
        uniform sampler2D uDetail2;
        uniform sampler2D uBathy;
        uniform float uBathyExtent;
        uniform float uBathyMaxDepth;
        uniform float uAerationAmount;
        uniform float uFoamPersistence;
        uniform float uBreakRatio;
        uniform float uHs;
        uniform float uPeakWavelength;
        uniform vec3 uBodyPos;
        uniform float uBodyRadius;
        uniform float uBodyActive;
        uniform float uBodySpeed;
        uniform float uDebugCrest;
        uniform float uDebugSlope;
        uniform float uDebugFoam;
        uniform float uMegaOn;
        uniform vec4 uMegaA;
        uniform float uPeakK;
        uniform float uPeakKx;
        uniform float uPeakKz;
        uniform float uWhitecaps;
        uniform float uFoamStreaks;
        uniform float uHorizonFog;

        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying float vWaveHeight;
        varying float vCrest;
        varying float vJacobian;
        varying float vDistance;
        varying vec2 vSlope;
        varying float vBreak;
        varying float vFacePhase;
        varying vec2 vCapSlope;
        varying float vShoal;
        varying float vDepth;
        varying float vPeakCrest;
        varying float vXi;
        varying float vSolverFoam;
        varying float vFoamField;

        ${glslNoise}
        ${glslFog}
        ${glslCaustics}
        ${glslSky}

        // Bubbly foam texture: the bright cell walls of two drifting
        // Voronoi layers, which reads as lace rather than as a smooth fog.
        float foamCells(vec2 p) {
          vec2 n = floor(p);
          vec2 f = fract(p);
          float d1 = 8.0;
          float d2 = 8.0;
          for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
              vec2 g = vec2(float(i), float(j));
              vec2 o = vec2(hash21(n + g), hash21(n + g + 19.7));
              vec2 r = g + o - f;
              float d = dot(r, r);
              if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
            }
          }
          return 1.0 - smoothstep(0.0, 0.35, sqrt(d2) - sqrt(d1));
        }

        float foamTexture(vec2 p, float dist) {
          float near = 1.0 - smoothstep(25.0, 140.0, dist);
          // Warp the cells so the lace never reads as a regular net.
          vec2 warp = vec2(vnoise(p * 0.6 + 3.0), vnoise(p * 0.6 - 5.0)) * 1.6;
          float lace = foamCells(p * 1.7 + warp + vec2(uTime * 0.05, -uTime * 0.03));
          float fine = near > 0.01 ? foamCells(p * 4.6 - vec2(uTime * 0.08, uTime * 0.05)) : 0.5;
          float body = fbm2(p * 0.45 + uTime * 0.02);
          float t = mix(0.35 + 0.65 * body, lace * 0.35 + fine * 0.25 + body * 0.6, near * 0.7 + 0.1);
          return clamp(t, 0.0, 1.0);
        }

        vec3 skyReflection(vec3 d) {
          d.y = abs(d.y);
          // A wind-roughened sea reflects a blurred, slightly darker sky.
          return skyColor(d, uSunDir, uTime, 0.4) * 0.82;
        }

        vec2 detailSlope(vec2 p, float dist) {
          // Three non-commensurate cascades. The far fade is a cheap normal
          // filter: sub-pixel ripple slopes are removed before they shimmer.
          float fadeNear = 1.0 - smoothstep(120.0, 1100.0, dist);
          float fadeFar = 1.0 - smoothstep(1800.0, 4200.0, dist);
          vec2 drift = uWindDir * uTime;
          vec2 uv0 = p / uDetailScale.x + drift * 0.009;
          vec2 uv1 = p / uDetailScale.y + vec2(-uWindDir.y, uWindDir.x) * uTime * 0.011;
          vec2 uv2 = p / uDetailScale.z + drift * 0.017;
          vec2 s0 = texture2D(uDetail0, uv0).rg * 2.0 - 1.0;
          vec2 s1 = texture2D(uDetail1, uv1).rg * 2.0 - 1.0;
          vec2 s2 = texture2D(uDetail2, uv2).rg * 2.0 - 1.0;
          // A fourth, much larger cascade only fades in with distance, so a
          // 500 m face seen from a kilometre away still carries chop.
          vec2 s3 = texture2D(uDetail1, p / 210.0 + drift * 0.004).rg * 2.0 - 1.0;
          vec2 s4 = texture2D(uDetail2, p / 640.0 - drift * 0.002).rg * 2.0 - 1.0;
          float fadeBig = smoothstep(60.0, 600.0, dist);
          vec2 s = s0 * 0.52 * fadeNear + s1 * 0.32 * fadeNear + s2 * 0.2 * fadeFar;
          s += (s3 * 0.42 + s4 * 0.3) * fadeBig;
          return s * uDetailStrength;
        }

        float detailHeight(vec2 p, float dist) {
          float fade = 1.0 - smoothstep(150.0, 900.0, dist);
          float h0 = texture2D(uDetail0, p / uDetailScale.x + uWindDir * uTime * 0.009).b;
          float h1 = texture2D(uDetail1, p / uDetailScale.y + vec2(-uWindDir.y, uWindDir.x) * uTime * 0.011).b;
          return (h0 * 0.6 + h1 * 0.4) * fade;
        }

        void main() {
          vec3 n = normalize(vNormalW);
          vec3 view = normalize(uCameraPos - vWorld);
          vec2 detail = detailSlope(vWorld.xz, vDistance);
          float microHeight = detailHeight(vWorld.xz, vDistance);
          vec3 microN = normalize(vec3(n.x + detail.x * 0.3, n.y, n.z + detail.y * 0.3));
          if (microN.y < 0.0) microN = -microN;

          float distFilter = smoothstep(900.0, 5200.0, vDistance);
          microN = normalize(mix(microN, n, distFilter * 0.6));

          float depthRaw = texture2D(uBathy, vWorld.xz / uBathyExtent + 0.5).r * uBathyMaxDepth;
          // vDepth carries the mega wave's water column, so its face reads
          // as deep water instead of the shelf tint underneath.
          float pathDepth = clamp(max(depthRaw, vDepth), 0.0, 24.0);
          // Height of the mega crest above the shelf, 0 in the trough and ~1
          // at the lip. Drives the thin, glowing water near its crest.
          float megaRise = uMegaOn > 0.5
            ? clamp((vDepth - max(depthRaw, 0.3)) / max(1.0, uMegaA.w), 0.0, 1.4)
            : 0.0;
          vec2 megaDir = vec2(uPeakKx, uPeakKz) / max(1e-6, uPeakK);
          bool megaFront = vFacePhase > 0.0 && megaRise > 0.02;

          vec2 p = vWorld.xz;
          float crest = clamp(vCrest, 0.0, 1.0);
          // Only strong horizontal compression reads as a whitecap; a big
          // swell squeezes every crest a little without breaking it.
          float compression = 1.0 - smoothstep(0.0, 0.42, vJacobian);
          float slopeEnergy = smoothstep(0.08, 0.22, length(vCapSlope));
          float foamNoise = fbm2(p * 0.31 + vec2(uTime * 0.014, -uTime * 0.009));
          float perpA = dot(p, uWindDir);
          float perpB = dot(p, vec2(-uWindDir.y, uWindDir.x));
          float lace = vnoise(vec2(perpA * 0.32 + uTime * 0.05, perpB * 1.9 - uTime * 0.04) + 13.7);
          float windMask = smoothstep(0.4, 0.72, foamNoise * 0.72 + lace * 0.42);
          float crestMask = smoothstep(0.12, 0.7, crest);
          float foamSignal =
            crestMask * (0.38 + slopeEnergy * 0.5 + windMask * 0.4) +
            compression * 2.2;
          float threshold = uFoamThreshold / max(0.35, uWhitecaps);
          float foam = smoothstep(threshold, threshold + 0.2, foamSignal) * min(1.0, uFoamAmount * uWhitecaps);
          // Scattered wind whitecaps: short-lived patches on the wind-sea
          // crests, the white flecks that cover the reference sea.
          float capCell = vnoise(vec2(perpA * 0.045 - uTime * 0.11, perpB * 0.09) + 3.1);
          float capLife = vnoise(vec2(perpA * 0.11, perpB * 0.11) + uTime * 0.21);
          float windCaps = smoothstep(0.7, 0.92, capCell * 0.6 + capLife * 0.55 + slopeEnergy * 0.25)
            * smoothstep(-0.2, 0.5, vCrest + microHeight * 0.4);
          // A mega face is swept clean by its own flow; keep its caps sparse.
          windCaps *= 1.0 - 0.75 * smoothstep(0.05, 0.3, megaRise);
          foam = max(foam, windCaps * 0.85 * clamp(uWhitecaps - 0.4, 0.0, 1.0));
          foam *= 1.0 - smoothstep(1500.0, 5200.0, vDistance);

          // ---- breaking and aeration ------------------------------------
          float broken = smoothstep(0.15, 0.7, vBreak);
          float roller = 1.0 - smoothstep(0.1, 1.3, vFacePhase);
          float aeration = clamp(
            broken * (0.35 + 0.5 * foamNoise) * (0.35 + 0.65 * roller) * uAerationAmount,
            0.0,
            0.85
          );
          aeration = max(aeration, vSolverFoam * 0.85);
          aeration = max(aeration, vFoamField * 0.5);
          float plunge = smoothstep(0.5, 2.8, vXi);
          float crestFoam = 0.55 + 0.45 * roller;
          float whitewater = broken * crestFoam * smoothstep(
            0.22,
            0.7,
            foamNoise * 0.5 + lace * 0.25 + roller * 0.2
          );
          float lipTongue =
            broken * plunge * (1.0 - smoothstep(0.0, 0.7, abs(vFacePhase - 0.25))) *
            smoothstep(0.45, 0.9, foamNoise);
          whitewater = clamp(whitewater * 0.85 + lipTongue * 0.3, 0.0, 1.0);
          foam *= 1.0 - broken * 0.6;
          foam = max(foam, whitewater);
          foam = max(foam, vSolverFoam * 1.15);
          float fieldLace = 0.55 * foamNoise + 0.45 * lace;
          float fieldMask = smoothstep(0.28, 0.72, fieldLace);
          foam = max(foam, vFoamField * fieldMask * 1.15);

          // Foam streaks: old whitecap foam stretched into long lines along
          // the wind, lying over the backs of the waves, and on a mega face
          // the scars of foam that pour down from the lip.
          float streakA = vnoise(vec2(perpA * 0.035 + uTime * 0.03, perpB * 0.55));
          float streakB = vnoise(vec2(perpA * 0.09 - uTime * 0.02, perpB * 1.6) + 7.0);
          float streaks = smoothstep(0.58, 0.9, streakA * 0.6 + streakB * 0.45);
          streaks *= smoothstep(0.35, 0.75, vnoise(p * 0.02 + 11.0));
          streaks *= 1.0 - smoothstep(250.0, 1400.0, vDistance);
          if (megaRise > 0.02) {
            float along = dot(p, megaDir);
            float across = dot(p, vec2(-megaDir.y, megaDir.x));
            float scar = vnoise(vec2(along * 0.006 - uTime * 0.05, across * 0.06));
            scar = scar * 0.6 + vnoise(vec2(along * 0.02, across * 0.21) + 5.0) * 0.4;
            float scars = smoothstep(0.62, 0.95, scar) * smoothstep(0.08, 0.5, megaRise) * 0.75;
            streaks = max(streaks, scars * (megaFront ? 1.0 : 0.45));
          }
          foam = max(foam, streaks * 0.42 * uFoamStreaks);

          // Meniscus/foam collar hugging the dolphin at the waterline.
          float bodyDist = length(vWorld.xz - uBodyPos.xz);
          float bodyRing = exp(-pow((bodyDist - uBodyRadius) / 0.3, 2.0));
          float bodyFoam = bodyRing * uBodyActive * clamp(uBodySpeed / 7.0, 0.0, 1.1);
          foam = max(foam, bodyFoam * 0.9);
          float foamTex = foamTexture(p, vDistance);
          // Thin foam is lace; thick foam closes up into a white sheet.
          float foamCover = clamp(foam * (0.45 + 0.9 * foamTex) + foam * foam * 0.4, 0.0, 1.0);
          foamCover = smoothstep(0.08, 0.85, foamCover);
          // Far foam is unresolved: softer and thinner, never paint flecks.
          foamCover *= 1.0 - 0.45 * smoothstep(200.0, 1200.0, vDistance);

          float nearSurface = clamp(1.0 - abs(uUnderwater - 0.5) * 2.0, 0.0, 1.0);
          float localAbove = smoothstep(-0.08, 0.08, uCameraPos.y - vWorld.y);
          float aboveWeight = mix(clamp(1.0 - uUnderwater, 0.0, 1.0), localAbove, nearSurface);

          // ---- above the surface ----------------------------------------
          // Only the side the camera can see is shaded.
          vec3 above = vec3(0.0);
          vec3 aboveFog = vec3(0.0);
          if (aboveWeight > 0.001) {
            float cosView = clamp(dot(view, microN), 0.0, 1.0);
            float fres = 0.02 + 0.98 * pow(1.0 - cosView, 5.0);
            // A rough sea never reaches mirror reflectance at grazing angles.
            fres = min(fres, 0.52);
            vec3 refl = reflect(-view, microN);
            vec3 sky = skyReflection(refl);
            vec3 viewFlat = normalize(vec3(-view.x, 0.0, -view.z) + vec3(1e-4, 0.0, 0.0));
            vec3 horizon = skyHorizonColor(viewFlat, uSunDir);

            // Diffuse light under the overcast: mostly sky, a little sun.
            float skyLight = 0.62 + 0.38 * microN.y;
            vec3 ambient = mix(SKY_HORIZON_AWAY, SKY_MID, 0.5) * skyLight;

            float shallowMix = smoothstep(0.9, 14.0, pathDepth);
            vec3 shallow = uTopColor * 0.55 + vec3(0.03, 0.05, 0.02);
            vec3 body = mix(shallow, uDeepColor, shallowMix) * ambient;

            // Subsurface light. The water near a crest is thin, and the face
            // tilted toward the viewer shows light coming through it: the
            // translucent turquoise of the reference sea. Looking toward the
            // sun the whole crest glows.
            float thin = max(smoothstep(-0.15, 0.9, vCrest), smoothstep(0.45, 1.0, megaRise));
            vec2 nH = microN.xz;
            vec2 vH = view.xz / max(length(view.xz), 1e-4);
            float faceView = clamp(dot(nH, vH) * 3.0, 0.0, 1.0);
            float towardSun = pow(clamp(dot(-view, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
            float sss = thin * (0.35 + faceView * 0.9 + towardSun * 0.8);
            sss += faceView * 0.18;
            vec3 sssColor = uTopColor * vec3(0.85, 1.05, 0.95);
            body += sssColor * sss * 0.42 * (0.7 + 0.3 * microHeight);
            // Wave-face legibility from the sun side.
            vec2 sunFlat = normalize(uSunDir.xz);
            float faceSun = clamp(-dot(n.xz, sunFlat) * 2.0, -1.0, 1.0);
            body *= 1.0 + faceSun * 0.14;
            // Bubbles below the foam scatter the light: pale turquoise.
            body = mix(body, sssColor * 0.9 + 0.08, clamp(aeration * 0.75 + foam * 0.3, 0.0, 0.85));

            above = mix(body, sky, fres);

            // Overcast sheen: a broad soft highlight toward the hidden sun and
            // only a scatter of small sparkles, never a hard sun path.
            float sunAlign = max(dot(refl, uSunDir), 0.0);
            float sheen = pow(sunAlign, 18.0) * 0.12 + pow(sunAlign, 160.0) * 0.35;
            float sparkle = smoothstep(0.7, 0.95, vnoise(p * 3.4 + vec2(uTime * 0.4, -uTime * 0.33)));
            sheen += pow(sunAlign, 600.0) * sparkle * 1.4 * (1.0 - smoothstep(60.0, 500.0, vDistance));
            above += SKY_HORIZON_SUN * sheen * (1.0 - foamCover);

            // Foam: lit by the sky, slightly shadowed in its own cell walls.
            vec3 foamLit = mix(ambient * 0.86, ambient * 1.18 + SKY_HORIZON_SUN * 0.08, foamTex);
            foamLit *= 1.0 + faceSun * 0.08;
            above = mix(above, foamLit, foamCover * 0.94);


            // Above-water distance fog fades to the horizon colour in that
            // direction, so the far sea dissolves into the sea mist.
            // Clear for the first few hundred metres, then thickening, so a
            // nearby face stays crisp while the far sea melts away.
            float hz = 1.0 - exp(-pow(vDistance * 0.00021 * uHorizonFog, 1.6));
            hz = max(hz, (1.0 - exp(-pow(vDistance * 0.00036 * uHorizonFog, 1.6))) * (1.0 - smoothstep(0.0, 0.15, abs(view.y))));
            aboveFog = mix(above, horizon, clamp(hz, 0.0, 0.97));

          }

          // ---- below the surface ----------------------------------------
          vec3 below = vec3(0.0);
          if (aboveWeight < 0.999) {
            // Snell's window: refracted sky within the critical angle
            // (48.6°, cos 0.6614), total internal reflection outside it.
            vec3 I = -view; // camera -> surface
            float cosI = clamp(dot(I, microN), 0.0, 1.0);
            float window = smoothstep(0.654, 0.69, cosI);
            float rim = exp(-pow((cosI - 0.6614) / 0.014, 2.0));
            vec3 refr = refract(I, -microN, 1.0 / 1.333);
            vec3 winDir = length(refr) > 0.5 ? normalize(refr) : normalize(I);

            float wav = clamp(vCrest * 0.5 + 0.5, 0.0, 1.0);
            vec3 tir = uDeepColor * 0.55 + uTopColor * 0.06;
            tir *= 0.88 + 0.28 * wav;
            tir += uTopColor * (0.06 + 0.13 * wav) * (0.4 + 0.6 * microHeight);
            tir += uTopColor * pow(max(0.0, 1.0 - cosI), 1.25) * 0.08;
            float undersideSheen = pow(max(dot(reflect(-view, microN), uSunDir), 0.0), 24.0);
            tir += uSunColor * undersideSheen * 0.1;
            float veins = causticNetwork(vWorld.xz * 0.34 + vec2(uTime * 0.02, -uTime * 0.015), uTime * 0.55);
            tir += uTopColor * veins * 0.03 * (0.45 + 0.55 * wav);

            vec3 winCol = skyColor(winDir, uSunDir, uTime, 0.6);
            winCol = mix(winCol, uTopColor * 0.9, 0.3);
            // The window is broken up by the ripples it is seen through.
            winCol *= (0.62 + 0.6 * microHeight) * (0.68 + 0.65 * veins) * 0.74;

            below = mix(tir, winCol, window * 0.94);
            below += uTopColor * rim * 0.7;
            // Foam seen from below: a dark-edged, bright lace ceiling.
            below = mix(below, vec3(0.46, 0.6, 0.58), foamCover * foamCover * 0.3);
            below = mix(below, vec3(0.45, 0.62, 0.58), aeration * 0.45);
            below = applyWaterFog(below, vDistance, uFogColor, uFogDensity * 0.72);
          }

          float camGap = uCameraPos.y - vWorld.y;
          float meniscus = exp(-pow(camGap / 0.05, 2.0)) * nearSurface;
          vec3 color = mix(below, aboveFog, aboveWeight);
          color = mix(color, vec3(0.92, 0.99, 0.97), meniscus * 0.22);
          color = mix(color, vec3(0.9, 0.99, 0.95), bodyRing * uBodyActive * 0.06);
          foam = foamCover;

          // ---- debug overlays ------------------------------------------
          if (uDebugCrest > 0.5) {
            float band = abs(fract((vWaveHeight + 2.0) / 0.35) - 0.5);
            float line = 1.0 - smoothstep(0.0, 0.055, band);
            color = mix(color, vec3(0.15, 1.0, 0.62), line * 0.65);
          }
          if (uDebugSlope > 0.5) {
            float s = clamp(length(vSlope) / 0.7, 0.0, 1.0);
            color = mix(color, vec3(s * 1.3, 0.15 + s * 0.5, 1.0 - s), 0.55);
          }
          if (uDebugFoam > 0.5) {
            color = mix(color, vec3(1.0, 0.2, 0.75), foam * 0.8);
          }

          color = min(color, vec3(1.8));
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
        ${glslSky}
        void main() {
          vec3 d = normalize(vDir);
          gl_FragColor = vec4(skyColor(d, uSunDir, uTime, 1.0), 1.0);
        }
      `,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(9000, 40, 28), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    return mesh;
  }

  _needsRebuild() {
    const w = TUNING.water;
    const sig = [
      w.seed,
      w.swellHeight,
      w.swellWavelength,
      w.swellWavelengthSpread,
      w.swellDirection,
      w.swellDirectionSpread,
      w.swellComponents,
      w.windSeaHeight,
      w.windSeaWavelength,
      w.windSeaWavelengthSpread,
      w.windSeaDirection,
      w.windSeaDirectionSpread,
      w.windSeaComponents,
      w.chop,
    ].join("|");
    if (sig === this._waveSig) return false;
    this._waveSig = sig;
    return true;
  }

  updateWaveUniforms() {
    if (this._needsRebuild()) this.water.rebuild(TUNING.water);
    // Cheap key check; re-integrates only when the peak or depth mode changes.
    this.water.bakeDelay();
    this.water.setTime(this.time);
    const waves = this.uniforms.uWaves.value;
    const n = this.water.count;
    for (let i = 0; i < MAX_WAVES; i++) {
      const v = waves[i];
      if (i < n) {
        v.set(this.water.kx[i], this.water.kz[i], this.water.amp[i], this.water.phase[i]);
      } else {
        v.set(0, 0, 0, 0);
      }
    }
    this.uniforms.uWaveCount.value = n;
    this.uniforms.uSwellCount.value = this.water.swellCount;
    this.uniforms.uChop.value = this.water.chop;
    this.uniforms.uMaxCrest.value = Math.max(0.5, this.water.stats.height * 0.8);
    this.uniforms.uFoamAmount.value = TUNING.water.foamAmount;
    this.uniforms.uFoamThreshold.value = TUNING.water.foamThreshold;
    this.uniforms.uDetailStrength.value = TUNING.water.detailStrength;
    this.uniforms.uWindDir.value.set(
      Math.cos(TUNING.water.windSeaDirection),
      Math.sin(TUNING.water.windSeaDirection)
    );
    this.uniforms.uDepthResponse.value = TUNING.water.depthResponse ? 1 : 0;
    this.uniforms.uPeakK.value = this.water.peakK;
    this.uniforms.uShoalRef.value = TUNING.water.shoalReference;
    this.uniforms.uShoalStrength.value = TUNING.water.shoalStrength;
    this.uniforms.uFocusCenter.value.set(TUNING.water.surfZoneX, TUNING.water.surfZoneZ);
    this.uniforms.uFocusGain.value = TUNING.water.reefFocus;
    this.uniforms.uFocusCross.value = TUNING.water.reefFocusCross;
    this.uniforms.uFocusReach.value = TUNING.water.reefFocusReach;
    this.uniforms.uBreakRatio.value = TUNING.water.breakRatio;
    this.uniforms.uBreakSoftness.value = TUNING.water.breakSoftness;
    this.uniforms.uHs.value = this.water.stats.height;
    this.uniforms.uPeakKx.value = this.water.peakKx;
    this.uniforms.uPeakKz.value = this.water.peakKz;
    this.uniforms.uPeakPhase.value = this.water.peakPhaseNow || 0;
    this.uniforms.uBreakerLip.value = TUNING.water.breakerLip;
    this.uniforms.uFaceSkew.value = TUNING.water.faceSkew || 0;
    const w = TUNING.water;
    this.uniforms.uMegaOn.value = w.megaWave && w.megaHeight > 0 ? 1 : 0;
    this.uniforms.uMegaA.value.set(
      this.water.megaCrestMod,
      this.water.megaIndex,
      Math.max(100, w.megaWavelength),
      w.megaHeight
    );
    this.uniforms.uMegaB.value.set(w.megaFront, w.megaBack, w.megaVariation, w.megaLateral);
    this.uniforms.uAerationAmount.value = TUNING.water.aerationAmount;
    this.uniforms.uFoamPersistence.value = TUNING.water.foamPersistence;
    this.uniforms.uPeakWavelength.value = this.water.stats.peakWavelength;
  }

  /** CPU-accessible surface height (spectral outside the surf solver). */
  getWaterHeight(x, z) {
    const analytic = this.water.sampleHeight(x, z);
    if (!this.solver.enabled) return analytic;
    const s = this.solver.sample(x, z, this._solverSample);
    return s.mask > 0 ? analytic + (s.eta - analytic) * s.mask : analytic;
  }

  /** Surface-only sample, blended with the surf-zone solver. */
  getWaterSample(x, z) {
    const out = this.water.sampleSurface(x, z, this.lastSample);
    if (!this.solver.enabled) {
      if (this.foamField.enabled) {
        const f = this.foamField.sample(x, z, this._foamSample);
        out.aeration = Math.max(out.aeration, f.foam * 0.5);
        out.foamField = f.foam;
      }
      return out;
    }
    const s = this.solver.surfaceSample(x, z, this._solverSurface);
    if (!s) return out;
    const m = s.solverMask;
    out.height += (s.height - out.height) * m;
    out.nx += (s.nx - out.nx) * m;
    out.ny += (s.ny - out.ny) * m;
    out.nz += (s.nz - out.nz) * m;
    const nl = Math.hypot(out.nx, out.ny, out.nz) || 1;
    out.nx /= nl;
    out.ny /= nl;
    out.nz /= nl;
    out.slope += (s.slope - out.slope) * m;
    out.slopeX += (s.slopeX - out.slopeX) * m;
    out.slopeZ += (s.slopeZ - out.slopeZ) * m;
    out.depth += (s.depth - out.depth) * m;
    out.aeration = Math.max(out.aeration, s.aeration * m);
    out.turbulence = Math.max(out.turbulence, s.turbulence * m);
    out.breakMask = Math.max(out.breakMask || 0, s.breakMask * m);
    out.phaseSpeed += (s.phaseSpeed - out.phaseSpeed) * m;
    out.solverActive = s.solverActive;
    out.solverMask = m;
    out.solverU = s.solverU;
    out.solverV = s.solverV;
    if (this.foamField.enabled) {
      const f = this.foamField.sample(x, z, this._foamSample);
      out.aeration = Math.max(out.aeration, f.foam * 0.5);
      out.foamField = f.foam;
    }
    return out;
  }

  /** Full 3D sample, blended with the surf-zone solver. */
  sampleWater(x, y, z, out = {}) {
    const a = this.water.sample(x, y, z, out);
    if (!this.solver.enabled) {
      if (this.foamField.enabled) {
        const f = this.foamField.sample(x, z, this._foamSample);
        out.aeration = Math.max(out.aeration, f.foam * 0.5 * Math.exp(-Math.max(0, out.height - y) / 0.6));
        out.foamField = f.foam;
      }
      return a;
    }
    const s = this.solver.sample3D(x, y, z, this._solver3D);
    if (!s) return a;
    const m = s.solverMask;
    out.height += (s.height - out.height) * m;
    out.nx += (s.nx - out.nx) * m;
    out.ny += (s.ny - out.ny) * m;
    out.nz += (s.nz - out.nz) * m;
    const nl = Math.hypot(out.nx, out.ny, out.nz) || 1;
    out.nx /= nl;
    out.ny /= nl;
    out.nz /= nl;
    out.velocityX += (s.velocityX - out.velocityX) * m;
    out.velocityY += (s.velocityY - out.velocityY) * m;
    out.velocityZ += (s.velocityZ - out.velocityZ) * m;
    out.accelX += (s.accelX - out.accelX) * m;
    out.accelY += (s.accelY - out.accelY) * m;
    out.accelZ += (s.accelZ - out.accelZ) * m;
    out.dynamicPressure += (s.dynamicPressure - out.dynamicPressure) * m;
    out.aeration = Math.max(out.aeration, s.aeration * m);
    out.turbulence = Math.max(out.turbulence, s.turbulence * m);
    out.breakMask = Math.max(out.breakMask || 0, s.breakMask * m);
    out.phaseSpeed += (s.phaseSpeed - out.phaseSpeed) * m;
    out.wavelength += (s.wavelength - out.wavelength) * m;
    out.depth += (s.depth - out.depth) * m;
    out.seabedY = -out.depth;
    out.depthToSeabed = y + out.depth;
    out.solverMask = m;
    out.solverActive = s.solverMask > 0.5;
    if (this.foamField.enabled) {
      const f = this.foamField.sample(x, z, this._foamSample);
      out.aeration = Math.max(out.aeration, f.foam * 0.5 * Math.exp(-Math.max(0, out.height - y) / 0.6));
      out.foamField = f.foam;
    }
    return out;
  }

  sampleWaterBatch(positions, out, stride = 3, forForces = false) {
    const count = positions.length / stride;
    this.water.sampleBatch(positions, out, stride, count, forForces);
    if (!this.solver.enabled) {
      if (this.foamField.enabled) {
        for (let i = 0; i < count; i++) {
          const p = i * stride;
          const f = this.foamField.sample(positions[p], positions[p + 2], this._foamSample);
          if (f.mask > 0.001) {
            // Residual foam is a surface layer, not the whole water column.
            const below = Math.max(0, out.height[i] - positions[p + 1]);
            out.aeration[i] = Math.max(out.aeration[i], f.foam * 0.5 * Math.exp(-below / 0.6));
          }
        }
      }
      return out;
    }
    for (let i = 0; i < count; i++) {
      const p = i * stride;
      const s = this.solver.sample(positions[p], positions[p + 2], this._solverSample);
      if (s.mask <= 0.001) continue;
      const m = s.mask;
      out.height[i] += (s.eta - out.height[i]) * m;
      const nx = -s.slopeX;
      const nz = -s.slopeZ;
      const nl = Math.hypot(nx, 1, nz) || 1;
      out.nx[i] += (nx / nl - out.nx[i]) * m;
      out.ny[i] += (1 / nl - out.ny[i]) * m;
      out.nz[i] += (nz / nl - out.nz[i]) * m;
      out.velocityX[i] += (s.u - out.velocityX[i]) * m;
      out.velocityZ[i] += (s.v - out.velocityZ[i]) * m;
      out.velocityY[i] += (-(s.u * s.slopeX + s.v * s.slopeZ) - out.velocityY[i]) * m;
      out.dynamicPressure[i] += (1025 * 9.81 * s.eta - out.dynamicPressure[i]) * m;
      out.aeration[i] = Math.max(out.aeration[i], s.foam * 0.85 * m);
      out.slope[i] += (s.slope - out.slope[i]) * m;
      out.phaseSpeed[i] += (s.phaseSpeed - out.phaseSpeed[i]) * m;
    }
    if (this.foamField.enabled) {
      for (let i = 0; i < count; i++) {
        const p = i * stride;
        const f = this.foamField.sample(positions[p], positions[p + 2], this._foamSample);
        if (f.mask > 0.001) {
          // Residual foam is a surface layer, not the whole water column.
          const below = Math.max(0, out.height[i] - positions[p + 1]);
          out.aeration[i] = Math.max(out.aeration[i], f.foam * 0.5 * Math.exp(-below / 0.6));
        }
      }
    }
    return out;
  }

  addSurfaceContact(x, z, force, radius = 0.85) {
    this.sim.addSplat(x, z, clamp(force, -0.8, 0.8), radius);
  }

  update(dt, playerPos, camera, underwater, wetness, context = {}) {
    this.time += dt * TUNING.water.timeScale;
    this.solver.enabled = TUNING.water.solverEnabled;
    this.solver.update(dt, this.time);
    this.foamField.enabled = TUNING.water.foamFieldEnabled;
    this.foamField.update(dt, this.time);
    const u = this.uniforms;
    u.uSolverEnabled.value = this.solver.enabled ? 1 : 0;
    u.uFoamEnabled.value = this.foamField.enabled ? 1 : 0;
    u.uTime.value = this.time;
    u.uCenter.value.set(camera.position.x, camera.position.z);
    u.uCameraPos.value.copy(camera.position);
    u.uUnderwater.value = underwater;

    const camSurf = this.water.sampleSurface(camera.position.x, camera.position.z, this._surfaceSample);
    const bodySurf = this.water.sampleSurface(playerPos.x, playerPos.z, this._bodySample);
    const bodyNear = Math.abs(playerPos.y - bodySurf.height) < 1.3;
    u.uBodyPos.value.set(playerPos.x, bodySurf.height, playerPos.z);
    u.uBodyActive.value = bodyNear ? 1 : 0;
    u.uBodySpeed.value = context.dolphinSpeed || 0;
    u.uFogColor.value.copy(context.fogColor || this.fogColor);
    u.uFogDensity.value = context.fogDensity ?? TUNING.visuals.underwaterDensity;

    this.sim.update(dt, playerPos);
    u.uSimState.value = this.sim.texture;
    u.uSimCenter.value.copy(this.sim.center);
    u.uSimExtent.value = this.sim.extent;
    const waveStart = performance.now();
    this.updateWaveUniforms();
    this.water.lastUniformMs = performance.now() - waveStart;
    u.uDebugCrest.value = TUNING.debug.crestOverlay ? 1 : 0;
    u.uDebugSlope.value = TUNING.debug.slopeOverlay ? 1 : 0;
    u.uDebugFoam.value = TUNING.debug.foamOverlay ? 1 : 0;
    u.uWhitecaps.value = TUNING.visuals.whitecaps;
    u.uFoamStreaks.value = TUNING.visuals.foamStreaks;
    u.uHorizonFog.value = TUNING.visuals.horizonFog;

    this.mesh.visible = true;
    this.sky.visible = camera.position.y > camSurf.height;
    this.sky.position.set(camera.position.x, Math.min(camera.position.y, 0) * 0.2, camera.position.z);
    this.skyUniforms.uTime.value = this.time;
    u.uSunDir.value.copy(this.sunDir);
  }

  /**
   * One-pixel top-down render of the actual ocean mesh at (x,z). The fragment
   * writes vWaveHeight as 16-bit fixed point; this validates the rendered
   * mesh against the CPU field, including tessellation error. Synchronous
   * readback is acceptable because this is a debug probe (2 Hz), never part of
   * the frame path.
   */
  gpuProbeHeight(x, z, offset = 0) {
    const u = this.uniforms;
    const renderer = this.renderer;
    const oldCenterX = u.uCenter.value.x;
    const oldCenterZ = u.uCenter.value.y;
    const oldSim = u.uSimScale.value;
    u.uCenter.value.set(x, z);
    u.uSimScale.value = 0;

    u.uProbeOffset.value = offset;
    this.probeCamera.position.set(x, offset + 60, z);
    this.probeCamera.up.set(0, 0, -1);
    this.probeCamera.lookAt(x, offset, z);
    this.probeCamera.updateMatrixWorld();

    const oldTarget = renderer.getRenderTarget();
    renderer.getClearColor(this._clearColor);
    const oldAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.probeTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.probeScene, this.probeCamera);
    renderer.readRenderTargetPixels(this.probeTarget, 0, 0, 1, 1, this._probePixels);
    renderer.setRenderTarget(oldTarget);
    renderer.setClearColor(this._clearColor, oldAlpha);

    u.uCenter.value.set(oldCenterX, oldCenterZ);
    u.uSimScale.value = oldSim;

    u.uProbeOffset.value = 0;
    const q = this._probePixels[0] * 256 + this._probePixels[1];
    return (q / 65535) * 16 - 8 + offset;
  }

  shouldDrawSurface() {
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
