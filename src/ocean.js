import * as THREE from "three";
import { TUNING, PALETTE, SUN_DIRECTION } from "./config.js";
import { clamp, glslCaustics, glslFog, glslNoise } from "./utils.js";
import { WaveField } from "./water/field.js";
import { SurfSolver } from "./water/solver.js";
import { FoamField } from "./water/foam.js";
import { makeBathymetry } from "./water/bathymetry.js";
import { MAX_WAVES, probeFragmentShader, waterVertexShader } from "./water/shaders.js";

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
      uBreakRatio: { value: TUNING.water.breakRatio },
      uBreakSoftness: { value: TUNING.water.breakSoftness },
      uHs: { value: this.water.stats.height },
      uPeakKx: { value: this.water.peakKx },
      uPeakKz: { value: this.water.peakKz },
      uPeakPhase: { value: this.water.peakPhaseNow || 0 },
      uBreakerLip: { value: TUNING.water.breakerLip },
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

        vec3 skyReflection(vec3 d) {
          float h = clamp(d.y, 0.0, 1.0);
          // The sea reflects a cooler, smoother sky than the dome. A literal
          // golden horizon reflected off every wave facet turns a grazing
          // surface into a busy cream patchwork, so the reflection uses a
          // muted horizon and a broad smoothstep instead of a sharp gradient.
          vec3 horizonCol = mix(uSkyZenith * 0.92, uSkyHorizon * 0.68, 0.32);
          vec3 zenithCol = uSkyZenith * 1.04;
          vec3 col = mix(horizonCol, zenithCol, smoothstep(0.0, 0.45, h));
          col = mix(col, horizonCol * 1.04, exp(-h * 18.0) * 0.12);

          vec2 cp = d.xz / (max(d.y, 0.03) + 0.22);
          float baseCloud = fbm2(cp * 1.2 + vec2(uTime * 0.002, 0.0));
          float clouds = fbm2(cp * 2.7 + vec2(baseCloud * 2.4 + uTime * 0.0012, baseCloud));
          float band = smoothstep(0.5, 0.76, clouds + 0.1 * smoothstep(0.0, 0.3, d.y));
          col = mix(col, vec3(0.56, 0.66, 0.72), band * (0.1 - 0.05 * h));

          float sd = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(sd, 700.0) * 2.1 + pow(sd, 30.0) * 0.16 + pow(sd, 5.0) * 0.035);
          return col;
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
          vec2 s = s0 * 0.52 * fadeNear + s1 * 0.32 * fadeNear + s2 * 0.2 * fadeFar;
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
          vec3 microN = normalize(vec3(n.x + detail.x * 0.28, n.y, n.z + detail.y * 0.28));
          if (microN.y < 0.0) microN = -microN;

          float distFilter = smoothstep(600.0, 3600.0, vDistance);
          microN = normalize(mix(microN, vec3(0.0, 1.0, 0.0), distFilter * 0.55));

          float depthRaw = texture2D(uBathy, vWorld.xz / uBathyExtent + 0.5).r * uBathyMaxDepth;
          float pathDepth = clamp(depthRaw, 0.0, 24.0);

          vec2 p = vWorld.xz;
          float crest = clamp(vCrest, 0.0, 1.0);
          // Only strong horizontal compression reads as a whitecap; a big
          // swell squeezes every crest a little without breaking it.
          float compression = 1.0 - smoothstep(0.0, 0.42, vJacobian);
          float slopeEnergy = smoothstep(0.1, 0.25, length(vCapSlope));
          float foamNoise = fbm2(p * 0.31 + vec2(uTime * 0.014, -uTime * 0.009));
          float perpA = dot(p, uWindDir);
          float perpB = dot(p, vec2(-uWindDir.y, uWindDir.x));
          float lace = vnoise(vec2(perpA * 0.32 + uTime * 0.05, perpB * 1.9 - uTime * 0.04) + 13.7);
          float windMask = smoothstep(0.4, 0.72, foamNoise * 0.72 + lace * 0.42);
          float crestMask = smoothstep(0.16, 0.78, crest);
          float foamSignal =
            crestMask * (0.35 + slopeEnergy * 0.45 + windMask * 0.35) +
            compression * 2.2;
          float foam = smoothstep(uFoamThreshold, uFoamThreshold + 0.17, foamSignal) * uFoamAmount;
          foam *= 1.0 - smoothstep(1200.0, 4200.0, vDistance);
          float fineFoam = vnoise(p * 4.6 + vec2(uTime * 0.16, -uTime * 0.12));
          foam *= 0.55 + 0.6 * fineFoam;

          // ---- breaking and aeration ------------------------------------
          // vBreak is the per-wave bore (WaveField.sampleSurface breaking):
          // the same signal drives buoyancy, thrust loss and the breaker jet.
          // The roller is thickest at the crest and thins down the face.
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
          float crestFoam = 0.45 + 0.55 * roller;
          float whitewater = broken * crestFoam * smoothstep(
            0.3,
            0.8,
            foamNoise * 0.5 + lace * 0.25 + roller * 0.15
          );
          float lipTongue =
            broken * plunge * (1.0 - smoothstep(0.0, 0.7, abs(vFacePhase - 0.25))) *
            smoothstep(0.45, 0.9, foamNoise);
          whitewater = clamp(whitewater * 0.58 + lipTongue * 0.22, 0.0, 1.0);
          // Keep the aerated whitewater distinct from wind whitecaps: fade the
          // generic whitecap field inside the break zone, then add the crest
          // foam back in.
          foam *= 1.0 - broken * 0.78;
          foam = max(foam, whitewater);
          foam = max(foam, vSolverFoam * 1.15);
          // Break the advected field into lacy patches at render resolution;
          // the 2 m state grid is too smooth to read as foam on its own.
          // Reuse the foam noise and lace already evaluated above, and keep
          // blue gaps instead of laying down a uniform cream sheet.
          float fieldLace = 0.55 * foamNoise + 0.45 * lace;
          float fieldMask = smoothstep(0.28, 0.72, fieldLace);
          foam = max(foam, vFoamField * fieldMask * 1.15);
          // Meniscus/foam collar hugging the dolphin at the waterline.
          float bodyDist = length(vWorld.xz - uBodyPos.xz);
          float bodyRing = exp(-pow((bodyDist - uBodyRadius) / 0.3, 2.0));
          float bodyFoam = bodyRing * uBodyActive * clamp(uBodySpeed / 7.0, 0.2, 1.1);
          foam = max(foam, bodyFoam * 0.9);
          foam = clamp(foam, 0.0, 1.0);

          // ---- above the surface ----------------------------------------
          float cosView = clamp(dot(view, microN), 0.0, 1.0);
          float fres = 0.02 + 0.98 * pow(1.0 - cosView, 5.0);
          vec3 refl = reflect(-view, microN);
          vec3 sky = skyReflection(refl);

          float shallowMix = smoothstep(0.9, 14.0, pathDepth);
          vec3 shallow = uTopColor * 0.42 + vec3(0.0, 0.065, 0.085);
          vec3 body = mix(shallow, uDeepColor, shallowMix);
          body *= 0.82 + 0.24 * crest;
          body = mix(body, vec3(0.55, 0.72, 0.66), aeration * 0.42);

          // Wave-face legibility: faces tilted toward the sun collect more
          // direct light, faces tilted away sit in their own shadow. This is
          // an artistic scattering term, not a fake slope force; it exists so
          // a surfer can read the face shape from above.
          vec2 sunFlat = normalize(uSunDir.xz);
          float faceSun = clamp(-dot(n.xz, sunFlat) * 2.4, -1.0, 1.0);
          body *= 1.0 + faceSun * 0.16;
          float crestLip = smoothstep(0.42, 0.92, crest);
          body += uTopColor * crestLip * 0.055;

          // Light transmitted through a thin, backlit crest.
          float backlit = pow(max(dot(view, -uSunDir), 0.0), 1.6) * crest * crest;
          body += vec3(0.12, 0.38, 0.3) * backlit * 0.5;
          body += uTopColor * (0.02 + crest * 0.08) * 0.35;

          vec3 above = mix(body, sky, clamp(0.04 + fres * 0.82, 0.0, 0.94));

          float sunAlign = max(dot(refl, uSunDir), 0.0);
          float specPower = mix(1200.0, 70.0, smoothstep(80.0, 1800.0, vDistance));
          float glint = pow(sunAlign, specPower) * mix(2.6, 0.3, smoothstep(100.0, 2200.0, vDistance));
          glint += pow(sunAlign, 55.0) * 0.075;
          float sparkle = smoothstep(0.52, 0.92, vnoise(p * 3.4 + vec2(uTime * 0.22, -uTime * 0.19)));
          glint += pow(sunAlign, 22.0) * (0.012 + 0.025 * sparkle);
          glint *= 0.55 + sparkle * 0.9;
          above += uSunColor * glint;

          vec3 foamColor = mix(vec3(0.6, 0.72, 0.7), vec3(0.96, 0.99, 0.96), smoothstep(0.1, 0.8, foamNoise + lace * 0.25));
          above = mix(above, foamColor, foam * 0.88);

          // ---- below the surface ----------------------------------------
          // Snell's window: refracted sky within the critical angle
          // (48.6°, cos 0.6614), total internal reflection outside it.
          vec3 I = -view; // camera -> surface
          float cosI = clamp(dot(I, microN), 0.0, 1.0);
          float window = smoothstep(0.654, 0.69, cosI);
          float rim = exp(-pow((cosI - 0.6614) / 0.014, 2.0));
          vec3 refr = refract(I, -microN, 1.0 / 1.333);
          vec3 winDir = length(refr) > 0.5 ? normalize(refr) : normalize(I);

          float wav = clamp(vCrest * 0.5 + 0.5, 0.0, 1.0);
          vec3 tir = uDeepColor * 0.42 + uTopColor * 0.08;
          tir *= 0.88 + 0.28 * wav;
          tir += uTopColor * (0.075 + 0.16 * wav) * (0.4 + 0.6 * microHeight);
          tir += uTopColor * pow(max(0.0, 1.0 - cosI), 1.25) * 0.1;
          float undersideSheen = pow(max(dot(reflect(-view, microN), uSunDir), 0.0), 24.0);
          tir += uSunColor * undersideSheen * 0.12;
          // Caustic veins on the underside, modulated by the real wave slope
          // and crest height rather than a flat screen-space pattern.
          float veins = causticNetwork(vWorld.xz * 0.34 + vec2(uTime * 0.02, -uTime * 0.015), uTime * 0.55);
          tir += uTopColor * veins * 0.032 * (0.45 + 0.55 * wav);
          tir += vec3(0.02, 0.075, 0.12) * (0.5 + 0.5 * microHeight) * 0.22;

          vec3 winCol = skyReflection(winDir);
          winCol = mix(winCol, uTopColor * 0.8, 0.29);
          winCol += uSunColor * pow(max(dot(winDir, uSunDir), 0.0), 90.0) * 0.8;
          winCol *= (0.84 + 0.28 * microHeight) * 0.72;

          vec3 below = mix(tir, winCol, window * 0.94);
          below += uTopColor * rim * 0.95;
          below = mix(below, vec3(0.55, 0.7, 0.68), foam * 0.24);
          below = mix(below, vec3(0.5, 0.66, 0.6), aeration * 0.45);
          below = applyWaterFog(below, vDistance, uFogColor, uFogDensity * 0.72);

          vec3 aboveFog = applyWaterFog(above, vDistance, uFogColor, uFogDensity * 0.78);

          // Camera side. A global switch is correct when the camera is clearly
          // above or below water; near the waterline, use the local vertical
          // side so a half-in frame shows both sides. Do not use the tangent
          // plane: at grazing distance a wave normal can put the camera below
          // its own plane and produce a spurious cellular underside.
          float nearSurface = clamp(1.0 - abs(uUnderwater - 0.5) * 2.0, 0.0, 1.0);
          float localAbove = smoothstep(-0.08, 0.08, uCameraPos.y - vWorld.y);
          float aboveWeight = mix(clamp(1.0 - uUnderwater, 0.0, 1.0), localAbove, nearSurface);
          float camGap = uCameraPos.y - vWorld.y;
          float meniscus = exp(-pow(camGap / 0.05, 2.0)) * nearSurface;
          vec3 color = mix(below, aboveFog, aboveWeight);
          color = mix(color, vec3(0.92, 0.99, 0.97), meniscus * 0.22);
          color = mix(color, vec3(0.9, 0.99, 0.95), bodyRing * uBodyActive * 0.22);

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
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.05, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.5));
          col = mix(col, uHorizon * 1.05, exp(-max(h, 0.0) * 10.0) * 0.72);

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
    this.uniforms.uBreakRatio.value = TUNING.water.breakRatio;
    this.uniforms.uBreakSoftness.value = TUNING.water.breakSoftness;
    this.uniforms.uHs.value = this.water.stats.height;
    this.uniforms.uPeakKx.value = this.water.peakKx;
    this.uniforms.uPeakKz.value = this.water.peakKz;
    this.uniforms.uPeakPhase.value = this.water.peakPhaseNow || 0;
    this.uniforms.uBreakerLip.value = TUNING.water.breakerLip;
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
  gpuProbeHeight(x, z) {
    const u = this.uniforms;
    const renderer = this.renderer;
    const oldCenterX = u.uCenter.value.x;
    const oldCenterZ = u.uCenter.value.y;
    const oldSim = u.uSimScale.value;
    u.uCenter.value.set(x, z);
    u.uSimScale.value = 0;

    this.probeCamera.position.set(x, 60, z);
    this.probeCamera.up.set(0, 0, -1);
    this.probeCamera.lookAt(x, 0, z);
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

    const q = this._probePixels[0] * 256 + this._probePixels[1];
    return (q / 65535) * 16 - 8;
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
