import * as THREE from "three";
import { TUNING, PALETTE, SUN_DIRECTION } from "./config.js";
import { clamp, glslCaustics, glslFog, glslNoise } from "./utils.js";
import { OceanRipples, RIPPLE_CASCADES } from "./ripples.js";
import { WaveField } from "./water/field.js";
import { SurfSolver } from "./water/solver.js";
import { FoamField } from "./water/foam.js";
import { makeBathymetry } from "./water/bathymetry.js";
import { MAX_WAVES, probeFragmentShader, waterVertexShader } from "./water/shaders.js";
import { glslSky } from "./atmosphere.js";

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Small GPU heightfield for surface contact and propagating wakes, plus the
 * foam the dolphin leaves on the water. The large sea is the analytic
 * WaveField; this only parts the surface around the body.
 *
 * State: r = height, g = vertical speed, b = foam (lace that lingers and
 * thins), a = fresh whitewater (dense, turns into foam within a second).
 *
 * The grid rides with the water under the player: its origin moves with
 * the local surface velocity each step (a wake on a 70 m/s mega face is
 * carried along with that water), and it is shifted by whole texels to
 * stay centred on the player, so nothing is resampled between texels.
 */
const MAX_SPLATS = 24;

class SurfaceSimulation {
  constructor(renderer) {
    this.renderer = renderer;
    this.size = TUNING.waves.simResolution;
    this.extent = TUNING.waves.simExtent;
    this.texel = this.extent / this.size;
    this.center = new THREE.Vector2(99999, 99999);
    this.splats = [];
    this.enabled = true;
    this.accumulator = 0;
    this.drift = new THREE.Vector2();
    this._shift = new THREE.Vector2();

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
    this._clear();

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.splatData = Array.from({ length: MAX_SPLATS }, () => new THREE.Vector4());
    this.splatFoam = Array.from({ length: MAX_SPLATS }, () => new THREE.Vector4());
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        #define MAX_SPLATS ${MAX_SPLATS}
        varying vec2 vUv;
        uniform sampler2D uState;
        uniform vec2 uTexel;
        uniform vec2 uShift;
        uniform float uDamping;
        uniform float uWaveSpeed;
        uniform float uDt;
        uniform float uFoamLife;
        uniform int uSplatCount;
        uniform vec4 uSplats[MAX_SPLATS];
        uniform vec4 uSplatFoam[MAX_SPLATS];

        vec4 stateAt(vec2 uv) {
          // Water that scrolls in from outside the grid is undisturbed.
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
          return texture2D(uState, uv);
        }

        void main() {
          vec2 uv = vUv + uShift;
          vec4 st = stateAt(uv);
          float h = st.r;
          float v = st.g;
          float foam = st.b;
          float fresh = st.a;

          vec4 n = stateAt(uv + vec2(0.0, uTexel.y));
          vec4 s = stateAt(uv - vec2(0.0, uTexel.y));
          vec4 e = stateAt(uv + vec2(uTexel.x, 0.0));
          vec4 w = stateAt(uv - vec2(uTexel.x, 0.0));
          float laplacian = n.r + s.r + e.r + w.r - 4.0 * h;

          v += laplacian * uWaveSpeed;
          v *= uDamping;
          h += v;
          // Water fills a hole: a body held at the surface parts it, but it
          // does not dig a trench that follows it around.
          h -= h * 0.018;

          // Foam spreads a little, is torn thin where the ripples stretch
          // the surface, and slowly bursts. Whitewater turns into foam.
          float spread = (n.b + s.b + e.b + w.b) * 0.25;
          foam = mix(foam, spread, 0.05);
          float freshSpread = (n.a + s.a + e.a + w.a) * 0.25;
          fresh = mix(fresh, freshSpread, 0.08);
          float conv = clamp(-laplacian * 4.0, -0.5, 0.5);
          float settle = 1.0 - exp(-uDt / 0.7);
          foam += fresh * settle * 0.8;
          fresh -= fresh * settle;
          foam *= exp(-uDt / uFoamLife) * (1.0 + conv * uDt);

          for (int i = 0; i < MAX_SPLATS; i++) {
            if (i >= uSplatCount) break;
            vec4 sp = uSplats[i];
            vec2 d = vUv - sp.xy;
            float r = sp.w;
            float fall = exp(-dot(d, d) / max(r * r, 0.000001) * 2.6);
            float ring = exp(-pow((length(d) - r * 1.5) / (r * 0.75), 2.0));
            h += sp.z * (fall - ring * 0.3);
            v += sp.z * 0.025 * fall;
            vec4 sf = uSplatFoam[i];
            // Foam is stamped with a ragged edge, never a clean disc.
            foam += sf.x * fall;
            fresh += sf.y * fall;
          }

          h = clamp(h, -0.7, 0.7);
          v = clamp(v, -1.2, 1.2);
          gl_FragColor = vec4(h, v, clamp(foam, 0.0, 1.6), clamp(fresh, 0.0, 1.6));
        }
      `,
      uniforms: {
        uState: { value: null },
        uTexel: { value: new THREE.Vector2(1 / this.size, 1 / this.size) },
        uShift: { value: new THREE.Vector2() },
        uDamping: { value: TUNING.waves.simDamping },
        uWaveSpeed: { value: TUNING.waves.simWaveSpeed },
        uDt: { value: 1 / 60 },
        uFoamLife: { value: 7 },
        uSplatCount: { value: 0 },
        uSplats: { value: this.splatData },
        uSplatFoam: { value: this.splatFoam },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.renderer.getContext().canvas.addEventListener("webglcontextlost", () => {
      this.enabled = false;
    });
  }

  _clear() {
    for (const t of this.targets) {
      this.renderer.setRenderTarget(t);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);
  }

  addSplat(x, z, strength, radius, foam = 0, fresh = 0) {
    if (this.splats.length >= MAX_SPLATS) return;
    this.splats.push({ x, z, strength, radius, foam, fresh });
  }

  /** drift: horizontal surface velocity of the water under the player. */
  update(dt, playerPos, drift) {
    if (!this.enabled) return;
    const px = playerPos.x;
    const pz = playerPos.z;
    if (this.center.x > 9999 || Math.hypot(this.center.x - px, this.center.y - pz) > this.extent * 0.6) {
      // Teleport or first frame: start from calm water.
      this.center.set(px, pz);
      this._clear();
    }
    if (drift) this.drift.set(drift.x || 0, drift.z || 0);

    this.accumulator = Math.min(this.accumulator + dt, 1 / 20);
    const step = 1 / 60;
    while (this.accumulator >= step) {
      this.accumulator -= step;
      // The water carries the field.
      this.center.x += this.drift.x * step;
      this.center.y += this.drift.y * step;
      // Shift by whole texels toward the player.
      const sx = Math.round((px - this.center.x) / this.texel);
      const sz = Math.round((pz - this.center.y) / this.texel);
      this._shift.set(sx / this.size, sz / this.size);
      this.center.x += sx * this.texel;
      this.center.y += sz * this.texel;
      this._step(step);
    }
  }

  _step(dt) {
    const src = this.targets[this.index];
    const dst = this.targets[1 - this.index];
    const mat = this.material;
    mat.uniforms.uState.value = src.texture;
    mat.uniforms.uShift.value.copy(this._shift);
    mat.uniforms.uDt.value = dt;
    mat.uniforms.uDamping.value = TUNING.waves.simDamping;
    mat.uniforms.uWaveSpeed.value = TUNING.waves.simWaveSpeed;

    const count = Math.min(this.splats.length, MAX_SPLATS);
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
      this.splatFoam[i].set(clamp(s.foam, 0, 1.5), clamp(s.fresh, 0, 1.5), 0, 0);
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
    this.ripples = new OceanRipples(renderer);
    this.lastSample = {};
    this._surfaceSample = {};
    this._bodySample = {};
    this._solverSample = {};
    this._solverSurface = {};
    this._solver3D = {};
    this._foamSample = {};
    this._driftSample = {};
    this._drift = { x: 0, z: 0 };
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
      uRipple0: { value: this.ripples.textures[0] },
      uRipple1: { value: this.ripples.textures[1] },
      uRipple2: { value: this.ripples.textures[2] },
      uRippleL: { value: new THREE.Vector3(...RIPPLE_CASCADES.map((c) => c.L)) },
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
      uBreakFloor: { value: TUNING.water.breakFloor ?? 2.4 },
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
      uMilkColor: { value: new THREE.Color(PALETTE.seaMilk) },
      uSeaLook: { value: new THREE.Vector4(TUNING.visuals.seaMilk, TUNING.visuals.seaGlow, TUNING.visuals.foamWhite, TUNING.visuals.sunGlitter) },
      uRefrColor: { value: null },
      uRefrDepth: { value: null },
      uRefrOn: { value: 0 },
      uViewport: { value: new THREE.Vector2(1, 1) },
      uCamNF: { value: new THREE.Vector2(0.1, 1000) },
    };

    this.material = this._buildMaterial();
    this.geometry = this._buildGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    // The refraction lookup needs the size of the target being drawn into
    // (the composer renders below screen resolution).
    const viewport = new THREE.Vector4();
    this.mesh.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(viewport);
      this.uniforms.uViewport.value.set(viewport.z, viewport.w);
    };
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
        uniform sampler2D uRipple0;
        uniform sampler2D uRipple1;
        uniform sampler2D uRipple2;
        uniform vec3 uRippleL;
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
        uniform vec3 uMilkColor;
        uniform vec4 uSeaLook; // milk, glow, foam whiteness, sun glitter
        uniform sampler2D uRefrColor;
        uniform sampler2D uRefrDepth;
        uniform float uRefrOn;
        uniform vec2 uViewport;
        uniform vec2 uCamNF;
        float perspDepthToViewZ(float d) {
          return (uCamNF.x * uCamNF.y) / ((uCamNF.y - uCamNF.x) * d - uCamNF.y);
        }
        uniform sampler2D uSimState;
        uniform vec2 uSimCenter;
        uniform float uSimExtent;
        uniform float uSimScale;

        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying float vWaveHeight;
        varying float vCrest;
        varying float vJacobian;
        varying float vDistance;
        varying vec2 vSlope;
        varying float vBreak;
        varying float vBreakZone;
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

        // Distance from the nearest Voronoi cell wall: 0 on a wall, about
        // 0.5 in the middle of a cell.
        float foamEdge(vec2 p) {
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
          return sqrt(d2) - sqrt(d1);
        }

        // One layer of a bubble raft seen up close. Each Voronoi cell may hold
        // a bubble: a clear dome with a thin wall, a bright window highlight
        // toward the sky and a darker, see-through middle. Empty cells are
        // gaps where the water shows. Returns a brightness factor around 1.
        float bubbleLayer(vec2 p, float fill) {
          vec2 n = floor(p);
          vec2 f = fract(p);
          float d1 = 8.0;
          float d2 = 8.0;
          vec2 r1 = vec2(0.0);
          vec2 c1 = vec2(0.0);
          for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
              vec2 g = vec2(float(i), float(j));
              vec2 o = vec2(hash21(n + g), hash21(n + g + 19.7));
              vec2 r = g + o - f;
              float d = dot(r, r);
              if (d < d1) { d2 = d1; d1 = d; r1 = r; c1 = n + g; } else if (d < d2) { d2 = d; }
            }
          }
          float edge = sqrt(d2) - sqrt(d1);
          float h = hash21(c1 + 3.3);
          if (h > fill) return 0.86;
          float size = 0.25 + 0.3 * hash21(c1 + 8.1);
          float wall = 1.0 - smoothstep(0.0, 0.07, edge);
          float core = 1.0 - smoothstep(0.0, size, length(r1));
          float hl = 1.0 - smoothstep(0.0, size * 0.28, length(r1 - vec2(-0.3, 0.35) * size));
          return 1.0 - 0.1 * wall - 0.14 * core + 0.45 * hl;
        }

        // Foam as a raft of bubbles. Thin foam is a translucent, marbled
        // lace of bubble walls that wind and break; thicker foam fills the
        // cells in until it is an opaque white sheet with a few holes.
        // Returns coverage and a shading term (bright where it is thick).
        vec2 foamPattern(vec2 p, float density, float dist) {
          // Pixel footprint in metres, taken before any branch.
          float foot = length(fwidth(p));
          if (density < 0.01) return vec2(0.0, 0.5);
          float near = 1.0 - smoothstep(30.0, 170.0, dist);
          float patchN = fbm2(p * 0.45 + vec2(uTime * 0.02, -uTime * 0.015));
          float d = density * (0.45 + 1.1 * patchN);
          // Far off, where the lace is finer than a pixel, a sheet of spent
          // foam still is not one flat plate: it lies in ragged pieces a few
          // metres across with water between them, which a low camera sees
          // as broken white lines.
          float farBreak = 0.25 + 1.1 * smoothstep(0.32, 0.68, fbm2(p * 0.17 + vec2(3.0, uTime * 0.01)));
          d *= mix(farBreak, 1.0, near);
          float s = 0.5 + 0.3 * patchN;
          if (near > 0.01) {
            // Large, slow domain warp so nothing lines up.
            vec2 q = p + vec2(fbm2(p * 0.32 + 1.7), fbm2(p * 0.32 - 4.3)) * 2.6;
            q += vec2(vnoise(q * 1.9 + 3.0), vnoise(q * 1.9 - 5.0)) * 0.45;
            // Blotches: foam gathers in irregular patches.
            float blotch = fbm2(q * 1.15 + vec2(uTime * 0.03, 2.0)) * 0.6 + fbm2(q * 3.6 - vec2(1.0, uTime * 0.04)) * 0.4;
            // Thin foam is drawn out into marbled strings: the winding,
            // branching lines along which a dying raft of bubbles gathers.
            // Ridges of a warped noise give open, curving lines rather than
            // the closed polygons of a cell net.
            vec2 sq = q * 0.9 + vec2(uTime * 0.03, -uTime * 0.02);
            sq += vec2(vnoise(sq * 2.7 + 9.0), vnoise(sq * 2.7 - 2.0)) * 0.55;
            float r1 = 1.0 - abs(2.0 * vnoise(sq) - 1.0);
            float r2 = 1.0 - abs(2.0 * vnoise(sq * 2.6 + 4.1) - 1.0);
            float aw = clamp(foot * 5.0, 0.0, 0.2);
            float strings = smoothstep(0.82 - aw, 0.97, r1) * 0.85;
            strings = max(strings, smoothstep(0.88 - aw, 0.985, r2) * 0.55 * smoothstep(0.35, 0.75, r1));
            float thin = 1.0 - smoothstep(0.2, 0.6, d);
            float pattern = mix(blotch, max(blotch * 0.5, strings), thin * 0.8);
            // Up close the foam is visibly made of bubbles of every size, most
            // a few millimetres across and a few up to two centimetres, in
            // clumps with gaps of water between. Each size fades to its mean
            // before it is smaller than about five pixels, so it never turns
            // into a mesh or a shimmer.
            if (dist < 10.0) {
              vec2 bq = q + vec2(vnoise(q * 9.0), vnoise(q * 9.0 + 4.0)) * 0.03;
              float clump = smoothstep(0.3, 0.75, fbm2(q * 7.0 + 2.0));
              float fillB = 0.35 * clump;
              float fillM = 0.4 + 0.5 * clump;
              // Mean of a layer: about 0.86 for a gap, 0.97 for a bubble.
              float mB = 0.86 + 0.11 * fillB;
              float mM = 0.86 + 0.11 * fillM;
              float mF = 0.86 + 0.11 * 0.85;
              float big = mix(mB, bubbleLayer(bq * 48.0 + 7.0, fillB), 1.0 - smoothstep(0.003, 0.0055, foot));
              float mid = mix(mM, bubbleLayer(bq * 130.0 - 3.0, fillM), 1.0 - smoothstep(0.0011, 0.002, foot));
              float fine = mix(mF, bubbleLayer(bq * 330.0 + 11.0, 0.85), 1.0 - smoothstep(0.00045, 0.0008, foot));
              float bub = (big / mB) * (mid / mM) * (fine / mF);
              pattern *= mix(1.0, bub, 1.0 - smoothstep(4.0, 10.0, dist));
            }
            s = mix(s, pattern, near);
          }
          float cover = clamp(d * (0.3 + 0.95 * s) + d * d * 0.55, 0.0, 1.0);
          cover = smoothstep(0.12, 0.9, cover);
          // Even thick foam keeps some open holes and darker hollows between
          // the bubble ridges.
          float holes = (1.0 - s) * smoothstep(0.55, 0.85, vnoise(p * 3.1 + uTime * 0.1));
          cover *= 1.0 - 0.35 * holes * near;
          float shade = clamp(0.25 + 0.4 * smoothstep(0.2, 1.0, d) + 0.45 * s - 0.2 * holes, 0.0, 1.0);
          return vec2(cover, shade);
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

        // Foam (b) and whitewater (a) the dolphin has left on the water.
        vec2 simFoamAt(vec2 world) {
          vec2 uv0 = (world - uSimCenter) / uSimExtent + 0.5;
          if (uv0.x < -0.02 || uv0.x > 1.02 || uv0.y < -0.02 || uv0.y > 1.02) return vec2(0.0);
          // A warp of up to a metre gives every patch and trail a ragged,
          // irregular edge instead of the round shape it was stamped with.
          vec2 warp = vec2(vnoise(world * 0.55 + 3.1), vnoise(world * 0.55 - 7.7)) - 0.5;
          warp += (vec2(vnoise(world * 2.3), vnoise(world * 2.3 + 5.0)) - 0.5) * 0.4;
          vec2 uv = (world + warp * 2.2 - uSimCenter) / uSimExtent + 0.5;
          vec2 edge = min(uv, 1.0 - uv);
          float m = smoothstep(0.0, 0.08, min(edge.x, edge.y));
          if (m <= 0.0) return vec2(0.0);
          return texture2D(uSimState, uv).ba * m * uSimScale;
        }

        vec3 skyReflection(vec3 d, float detail) {
          // A ray reflected downward meets the next wave, not the sky: it
          // sees sea and haze, about the colour of the horizon.
          float down = smoothstep(0.0, -0.05, d.y);
          d.y = abs(d.y);
          vec3 c = skyColor(d, uSunDir, uTime, detail);
          c = mix(c, skyHorizonColor(d, uSunDir) * 0.95, down);
          return c * 0.9;
        }

        // Short-wave detail from the live spectrum (src/ripples.js): three
        // cascades of real, dispersive wind waves in the wind's frame, holding
        // slope x, slope z, height and curvature. Slopes are physical.
        float gRippleVar = 0.0;
        vec2 rippleFrame(vec2 p) {
          return vec2(dot(p, uWindDir), dot(p, vec2(-uWindDir.y, uWindDir.x)));
        }
        vec2 rippleWorld(vec2 s) {
          return s.x * uWindDir + s.y * vec2(-uWindDir.y, uWindDir.x);
        }

        // Returns minus the ripple slope (the tilt it adds to the normal).
        // Each cascade fades once a pixel spans a good part of its waves,
        // where mip filtering can no longer average them (a pixel at a
        // grazing angle covers a long strip of sea). The variance it would
        // have added is kept as roughness for the reflection.
        vec2 detailSlope(vec2 p, float dist, float foot) {
          vec2 pw = rippleFrame(p);
          float gain = uDetailStrength / 0.55;
          vec3 fr = 1.0 - smoothstep(uRippleL / 40.0, uRippleL / 8.0, vec3(foot));
          vec4 c0 = texture2D(uRipple0, pw / uRippleL.x);
          vec4 c1 = texture2D(uRipple1, pw / uRippleL.y + 0.37);
          vec4 c2 = texture2D(uRipple2, pw / uRippleL.z + 0.71);
          vec2 s = c0.xy * fr.x + c1.xy * fr.y + c2.xy * fr.z;
          // Larger versions of the chop carry texture onto a 500 m face seen
          // from a kilometre away. A self-similar sea keeps its slopes when
          // scaled, so they reuse the first cascade's slopes as they are.
          float fadeBig = smoothstep(60.0, 600.0, dist);
          float f3 = 1.0 - smoothstep(210.0 / 40.0, 210.0 / 8.0, foot);
          float f4 = 1.0 - smoothstep(640.0 / 40.0, 640.0 / 8.0, foot);
          vec2 s3 = texture2D(uRipple0, pw / 210.0 + 0.19).xy;
          vec2 s4 = texture2D(uRipple0, pw / 640.0 + 0.53).xy;
          s += (s3 * 0.7 * f3 + s4 * 0.5 * f4) * fadeBig;
          // Mean square slope of what was filtered away (the bands' rms
          // slopes are 0.075, 0.085 and 0.06 per axis).
          vec3 lost = (1.0 - fr) * vec3(0.0113, 0.0145, 0.0072);
          gRippleVar = (lost.x + lost.y + lost.z) * gain * gain;
          return -rippleWorld(s) * gain;
        }

        // Ripple height around 0.5 for the shading terms that want it.
        float detailHeight(vec2 p, float dist) {
          float fade = 1.0 - smoothstep(150.0, 900.0, dist);
          vec2 pw = rippleFrame(p);
          float h0 = texture2D(uRipple0, pw / uRippleL.x).z;
          float h1 = texture2D(uRipple1, pw / uRippleL.y + 0.37).z;
          return clamp(0.5 + h0 * 2.5 + h1 * 9.0, 0.0, 1.0) * fade;
        }

        void main() {
          vec3 n = normalize(vNormalW);
          vec3 view = normalize(uCameraPos - vWorld);
          float footW = length(fwidth(vWorld.xz));
          vec2 detail = detailSlope(vWorld.xz, vDistance, footW);
          float microHeight = detailHeight(vWorld.xz, vDistance);
          vec3 microN = normalize(vec3(n.x + detail.x, n.y, n.z + detail.y));
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
          float capSum = capCell * 0.6 + capLife * 0.55 + slopeEnergy * 0.25;
          float windCaps = smoothstep(0.7, 0.92, capSum)
            * smoothstep(-0.2, 0.5, vCrest + microHeight * 0.4);
          // A whitecap is not a round raft. Its downwind edge is the active
          // crest, dense and white; behind it the foam is already spent, a
          // thin patch that the lace below draws out into strings and webs.
          vec2 capAhead = vec2(perpA + 3.5, perpB);
          float capSumAhead = vnoise(vec2(capAhead.x * 0.045 - uTime * 0.11, capAhead.y * 0.09) + 3.1) * 0.6
            + vnoise(vec2(capAhead.x * 0.11, capAhead.y * 0.11) + uTime * 0.21) * 0.55 + slopeEnergy * 0.25;
          float capFront = smoothstep(0.0, 0.035, capSum - capSumAhead);
          windCaps *= 0.3 + 0.7 * capFront;
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
          // The foam field is coarse (two-metre cells) and on its own draws
          // soft round rafts. Tear it into ragged pieces and connected
          // strands a few metres apart, as spent foam lies on the water.
          vec2 fw = p + (vec2(fbm2(p * 0.13 + 3.0), fbm2(p * 0.13 - 9.0)) - 0.5) * 14.0;
          float tearN = fbm2(fw * 0.19 + vec2(uTime * 0.01, 0.0));
          float strand = 1.0 - abs(2.0 * vnoise(fw * 0.42 + 5.0) - 1.0);
          float fieldShape = smoothstep(0.3, 0.75, tearN) * 0.7 + smoothstep(0.6, 0.96, strand) * 0.5;
          foam = max(foam, vFoamField * fieldMask * (0.3 + 0.95 * fieldShape));
          // Residual foam: across a surf zone every bore leaves a sheet of
          // foam behind it that thins into patches and lace until the next
          // one comes through. age is 0 just behind a crest, 1 at the next.
          float foamAge = vFacePhase < 0.0 ? -vFacePhase / 6.2832 : 1.0 - vFacePhase / 6.2832;
          float residual = smoothstep(0.35, 0.9, vBreakZone) * (1.0 - 0.65 * foamAge);
          // Rafts and patches tens of metres across, not lined up with the wind.
          float resPat = fbm2(p * 0.06 + vec2(foamNoise * 0.8, uTime * 0.008)) * 0.65 + foamNoise * 0.35;
          // Dense only just behind the bore. The rest is thin enough that
          // the bubble lace shows it as webs and strings with open water
          // between them, the way spent foam lies in an aerial photograph.
          residual *= smoothstep(0.3 + 0.14 * foamAge, 0.78 + 0.14 * foamAge, resPat);
          residual *= 0.42 + 0.5 * (1.0 - smoothstep(0.0, 0.3, foamAge));
          foam = max(foam, residual * 0.75 * clamp(0.4 + uFoamAmount * 0.5, 0.0, 1.0));

          // Foam streaks: old whitecap foam stretched into long lines along
          // the wind, lying over the backs of the waves, and on a mega face
          // the scars of foam that pour down from the lip.
          // The lines wander a few metres across the wind and break up along
          // it into flecks and patches, so they read as foam, not as ruled
          // lines.
          float streakB0 = perpB + (fbm2(vec2(perpA * 0.05, perpB * 0.11) + 4.0) - 0.5) * 9.0;
          // Short, curving threads a few metres long, many of them and
          // faint: from the air they are a soft grain along the wind, never
          // ruled lines or bright dashes.
          float streakA = vnoise(vec2(perpA * 0.11 + uTime * 0.03, streakB0 * 0.95));
          float streakB = vnoise(vec2(perpA * 0.28 - uTime * 0.02, streakB0 * 2.4) + 7.0);
          float streaks = smoothstep(0.52, 0.95, streakA * 0.6 + streakB * 0.45);
          streaks *= smoothstep(0.25, 0.7, vnoise(vec2(perpA * 0.22, streakB0 * 0.7) + 21.0));
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
          foam = max(foam, streaks * 0.17 * uFoamStreaks);

          // Wake foam (b) and fresh whitewater (a) from the dolphin. Fresh
          // whitewater is dense and lumpy; as it settles it becomes foam that
          // thins into bubble walls and fragments before it is gone.
          vec2 wake = vDistance < 120.0 ? simFoamAt(p) : vec2(0.0);
          float freshCover = smoothstep(0.1, 0.55, wake.y);
          float foamDensity = max(foam, max(wake.x * 1.05, wake.y * 1.7));
          vec2 fp = foamPattern(p, foamDensity, vDistance);
          float foamCover = fp.x;
          float foamTex = fp.y;
          // Fresh whitewater is not a sheet: it is a heap of churned clots
          // that fray at the edge into tongues and lumps, with holes of
          // aerated turquoise water between them, and it boils.
          if (freshCover > 0.01 && vDistance < 80.0) {
            vec2 cp = p + (vec2(vnoise(p * 1.3 + 2.0), vnoise(p * 1.3 - 6.0)) - 0.5) * 0.9;
            float c1 = fbm2(cp * 2.2 + vec2(uTime * 0.3, -uTime * 0.22));
            float c2 = vnoise(cp * 6.5 - vec2(uTime * 0.7, uTime * 0.45));
            float c3 = vnoise(cp * 17.0 + vec2(uTime * 1.1, -uTime * 0.8));
            float churnN = c1 * 0.6 + c2 * 0.28 + c3 * 0.12;
            float heap = clamp(wake.y, 0.0, 1.4) * (0.45 + 1.1 * churnN);
            float wwCover = smoothstep(0.32, 0.7, heap);
            float hole = smoothstep(0.4, 0.24, churnN) * (1.0 - smoothstep(0.9, 1.4, wake.y));
            wwCover *= 1.0 - 0.8 * hole;
            float keep = freshCover * (1.0 - smoothstep(40.0, 80.0, vDistance));
            foamCover = mix(foamCover, wwCover, keep);
            foamTex = mix(foamTex, clamp(0.2 + 1.1 * (churnN - 0.3), 0.0, 1.0), keep);
          }
          // Far foam is unresolved: softer and thinner, never paint flecks.
          foamCover *= 1.0 - 0.45 * smoothstep(200.0, 1200.0, vDistance);
          if (wake.x + wake.y > 0.004) {
            float f = clamp(wake.y, 0.0, 1.4);
            float d = clamp(wake.x, 0.0, 1.4);
            aeration = max(aeration, clamp(f * 0.9 + d * 0.3, 0.0, 0.9));
            // Whitewater is a churned, lumpy surface, not a mirror.
            vec2 wp = p * 5.0;
            vec2 bump = vec2(
              vnoise(wp + uTime * 0.6) - vnoise(wp + vec2(0.37, 0.0) + uTime * 0.6),
              vnoise(wp + vec2(5.1, 2.3) - uTime * 0.5) - vnoise(wp + vec2(5.1, 2.67) - uTime * 0.5)
            );
            microN = normalize(microN + vec3(bump.x, 0.0, bump.y) * 2.2 * clamp(f + d * 0.4, 0.0, 1.0));
          }

          float nearSurface = clamp(1.0 - abs(uUnderwater - 0.5) * 2.0, 0.0, 1.0);
          // Which side of the surface the camera sees here. The rendered
          // triangle knows: its upper side is its front face. The shading
          // normal carries chop the mesh cannot resolve, so far ripples seen
          // at a grazing angle often face away from the camera although their
          // triangle faces it, and testing the normal turned them into dark
          // flecks of underside. A back face is the underside, unless it is a
          // sliver folded over by the crest's sideways displacement: those
          // still face the camera, or lie below it, and stay lit from above.
          float facing = smoothstep(-0.04, 0.04, dot(view, n));
          float lower = smoothstep(-0.06, 0.06, uCameraPos.y - vWorld.y);
          float localAbove = gl_FrontFacing ? 1.0 : max(facing, lower);
          float aboveWeight = mix(clamp(1.0 - uUnderwater, 0.0, 1.0), localAbove, nearSurface);

          // ---- above the surface ----------------------------------------
          // Only the side the camera can see is shaded.
          vec3 above = vec3(0.0);
          vec3 aboveFog = vec3(0.0);
          if (aboveWeight > 0.001) {
            // Ripple slopes that face away from the eye are hidden behind the
            // ripples in front of them, so they are never seen. At a grazing
            // view (riding low on the water) they used to reflect the wrong
            // part of the sky as dark flecks; tip them back until they just
            // face the camera, where they reflect the horizon behind them.
            vec3 shadeN = microN;
            float nv = dot(view, shadeN);
            // How far it had to be tipped: such a facet stands for the hidden
            // back of a ripple, which shows the haze over the next ripple,
            // never a crisp piece of the coast.
            float tipped = smoothstep(0.0, 0.1, 0.06 - nv);
            if (nv < 0.06) shadeN = normalize(shadeN + view * (0.06 - nv));
            vec3 microN = shadeN;
            float cosView = clamp(dot(view, microN), 0.0, 1.0);
            float fres = 0.02 + 0.98 * pow(1.0 - cosView, 5.0);
            // Where the ripples are resolved each facet has its own Fresnel,
            // up to near-mirror at grazing angles. Where they are filtered
            // away (far off, or seen very flat) the pixel averages many
            // facets, some hidden and some facing up, and the sea never
            // reaches mirror reflectance.
            float rough = smoothstep(0.0, 0.025, gRippleVar);
            fres = min(fres, mix(0.92, 0.5, rough));
            vec3 refl = reflect(-view, microN);
            // A smooth patch reflects the clouds; a rough one a blur of them.
            vec3 sky = skyReflection(refl, mix(0.85, 0.35, rough) * (1.0 - tipped));
            vec3 haze = skyHorizonColor(normalize(vec3(refl.x, 0.0, refl.z) + vec3(1e-4, 0.0, 0.0)), uSunDir) * 0.86;
            sky = mix(sky, haze, tipped);
            vec3 viewFlat = normalize(vec3(-view.x, 0.0, -view.z) + vec3(1e-4, 0.0, 0.0));
            vec3 horizon = skyHorizonColor(viewFlat, uSunDir);

            // Diffuse light under the overcast: mostly sky, a little sun.
            float skyLight = 0.62 + 0.38 * microN.y;
            vec3 ambient = mix(SKY_HORIZON_AWAY, SKY_MID, 0.5) * skyLight;

            float shallowMix = smoothstep(0.9, 14.0, pathDepth);
            vec3 shallow = uTopColor * 0.55 + vec3(0.03, 0.05, 0.02);
            // A storm sea is not clear dark water. It is full of air and
            // stirred sediment that scatter the daylight straight back, so
            // the whole sea has a pale, milky turquoise-green body, a little
            // darker in the troughs than on the crests.
            vec3 milk = uMilkColor * (0.78 + 0.3 * smoothstep(-0.6, 0.9, vCrest));
            vec3 deepBody = mix(uDeepColor, milk, uSeaLook.x);
            shallow = mix(shallow, milk * 1.08, uSeaLook.x * 0.6);
            vec3 body = mix(shallow, deepBody, shallowMix) * ambient * uSeaLook.y;

            // Subsurface light. The water near a crest is thin, and the face
            // tilted toward the viewer shows light coming through it: the
            // translucent turquoise of the reference sea. Looking toward the
            // sun the whole crest glows.
            float thin = max(smoothstep(-0.15, 0.9, vCrest), smoothstep(0.45, 1.0, megaRise));
            // Light through the water follows the wave's shape, not each
            // ripple on it: take the facing from the wave normal.
            vec2 nH = mix(n.xz, microN.xz, 0.25);
            vec2 vH = view.xz / max(length(view.xz), 1e-4);
            float faceView = clamp(dot(nH, vH) * 3.0, 0.0, 1.0);
            float towardSun = pow(clamp(dot(-view, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
            float sss = thin * (0.35 + faceView * 0.9 + towardSun * 0.8);
            sss += faceView * 0.18;
            // In milky water the light coming through a crest is the same
            // pale green as the body, only brighter, never a neon teal.
            vec3 sssColor = mix(uTopColor * vec3(0.85, 1.05, 0.95), uMilkColor * 1.2, uSeaLook.x * 0.95);
            body += sssColor * sss * 0.42 * (0.7 + 0.3 * microHeight) * mix(1.0, 0.75, uSeaLook.x);
            // Wave-face legibility from the sun side.
            vec2 sunFlat = normalize(uSunDir.xz);
            float faceSun = clamp(-dot(n.xz, sunFlat) * 2.0, -1.0, 1.0);
            body *= 1.0 + faceSun * 0.14;
            // Bubbles below the foam scatter the light: pale turquoise.
            body = mix(body, sssColor * 0.95 + 0.08, clamp(aeration * 0.75 + foam * 0.3, 0.0, 0.85));

            // What is under the surface (the dolphin), seen through it: bent
            // by the ripples, dimmed and tinted by the water in between, and
            // veiled by the light the water itself scatters toward the eye.
            if (uRefrOn > 0.5) {
              vec2 suv = gl_FragCoord.xy / uViewport;
              float zWater = -perspDepthToViewZ(gl_FragCoord.z);
              // Bend the view by the slope of the waves a body's width or
              // more across (the longest ripple cascade). A ray crossing the
              // surface turns by about a quarter of the slope, so the image
              // shifts by that times the water's thickness; in screen terms
              // the shift shrinks with distance. The centimetre ripples only
              // shimmer the image, which the soft lookup below stands for.
              vec2 pw = rippleFrame(p);
              vec2 sLong = texture2D(uRipple0, pw / uRippleL.x).xy
                + texture2D(uRipple1, pw / uRippleL.y + 0.37).xy * 0.6;
              vec2 tilt = -rippleWorld(sLong) * (uDetailStrength / 0.55);
              vec3 nv = (viewMatrix * vec4(tilt.x, 0.0, tilt.y, 0.0)).xyz;
              float thick0 = -perspDepthToViewZ(texture2D(uRefrDepth, suv).r) - zWater;
              vec2 shift = nv.xy * clamp(thick0, 0.0, 3.0) * 0.14 / max(zWater, 1.0);
              float sl = length(shift);
              if (sl > 0.035) shift *= 0.035 / sl;
              vec2 bent = suv + shift;
              float thick = -perspDepthToViewZ(texture2D(uRefrDepth, bent).r) - zWater;
              // The water scatters the image more the further it travels.
              vec2 blur = vec2(1.0, uViewport.x / uViewport.y) * (0.0015 + 0.004 * clamp(thick, 0.0, 4.0) / max(zWater, 1.0));
              vec4 rc = texture2D(uRefrColor, bent) * 0.4
                + texture2D(uRefrColor, bent + vec2(blur.x, 0.0)) * 0.15
                + texture2D(uRefrColor, bent - vec2(blur.x, 0.0)) * 0.15
                + texture2D(uRefrColor, bent + vec2(0.0, blur.y)) * 0.15
                + texture2D(uRefrColor, bent - vec2(0.0, blur.y)) * 0.15;
              if (rc.a > 0.002) {
                thick = thick > 0.0 ? thick : max(thick0, 0.3);
                // The light that shows the body came down through the water
                // before it came back up: about half again the view path.
                vec3 T = exp(-vec3(0.45, 0.16, 0.14) * thick * 1.6);
                vec3 seen = (rc.rgb / rc.a) * T + body * (1.0 - T);
                float clear = rc.a * (1.0 - clamp(aeration * 1.2 + foam * 0.6, 0.0, 1.0));
                body = mix(body, seen, clear);
              }
            }

            above = mix(body, sky, fres);

            // The hidden sun on the water. Each ripple facet mirrors the
            // bright patch of thin cloud in front of the sun (a few degrees
            // across); where the facets are resolved that is a scatter of
            // hard sparkles, and where a pixel averages many of them it is a
            // silver sheen spread over the angle the ripples tilt it through,
            // dimmer by the same factor, so the path keeps its energy from
            // the sparkle at the lens to the glare far off.
            float sunAlign = max(dot(refl, uSunDir), 0.0);
            float ang2 = 2.0 * (1.0 - sunAlign);
            float lobe = 0.0026 + 4.0 * gRippleVar;
            float glint = exp(-ang2 / (2.0 * lobe)) * (0.0026 / lobe);
            // Wider, fainter light from the glow around the patch.
            float sheen = pow(sunAlign, 18.0) * 0.1 + pow(sunAlign, 120.0) * 0.22;
            vec3 sunPatch = mix(SKY_HORIZON_SUN, vec3(1.0, 0.975, 0.93), 0.6);
            above += sunPatch * (sheen + glint * 5.5) * uSeaLook.w * (1.0 - foamCover);

            // Foam: it scatters the whole sky, the bright overhead part of
            // it too, so it is the brightest thing on the sea, well above the
            // haze at the horizon; a little shadowed in its own cell walls.
            vec3 foamLit = mix(ambient * 0.8, ambient * 1.12 + SKY_HORIZON_SUN * 0.06, foamTex) * uSeaLook.z;
            foamLit *= 1.0 + faceSun * 0.08;
            // Fresh whitewater is brighter than settled foam, and foam is
            // never darker than the water it floats on (it scatters the same
            // bright sky the water reflects).
            foamLit *= 1.0 + 0.12 * freshCover;
            // Fresh whitewater is a heap of churned lumps: tops that face the
            // sky are brighter, creases between them darker and greyer.
            if (freshCover > 0.01 && vDistance < 60.0) {
              float lump = fbm2(p * 2.4 + vec2(uTime * 0.35, -uTime * 0.2)) * 0.55
                + vnoise(p * 7.5 - vec2(uTime * 0.6, uTime * 0.4)) * 0.3
                + vnoise(p * 19.0 + uTime * 0.9) * 0.15;
              float crease = smoothstep(0.42, 0.18, lump);
              float lumpShade = 0.84 + 0.34 * smoothstep(0.3, 0.8, lump) - 0.12 * crease;
              foamLit *= mix(1.0, lumpShade, freshCover * (1.0 - smoothstep(25.0, 60.0, vDistance)));
            }
            foamLit = max(foamLit, above * mix(0.95, 1.1, foamTex));
            above = mix(above, foamLit, foamCover * 0.94);


            // Above-water distance fog fades to the horizon colour in that
            // direction, so the far sea dissolves into the sea mist.
            // Clear for the first few hundred metres, then thickening, so a
            // nearby face stays crisp while the far sea melts away.
            float hz = seaHaze(vDistance, uHorizonFog);
            hz = max(hz, seaHaze(vDistance, uHorizonFog * 1.7) * (1.0 - smoothstep(0.0, 0.15, abs(view.y))));
            aboveFog = mix(above, horizon, clamp(hz, 0.0, 0.97));

          }

          // ---- below the surface ----------------------------------------
          vec3 below = vec3(0.0);
          if (aboveWeight < 0.999) {
            // Snell's window: refracted sky within the critical angle
            // (48.6°, cos 0.6614), total internal reflection outside it.
            vec3 I = -view; // camera -> surface
            // Under foam and whitewater the light has been scattered by the
            // bubbles before it arrives: there is no sharp Snell window to
            // see through the churned surface, only a soft glow. Take the
            // window from the smoothed surface there, and blur its edge.
            float churn = clamp(aeration * 1.2 + freshCover + foamCover * 0.5, 0.0, 1.0);
            vec3 calmN = normalize(mix(microN, n, churn));
            vec3 microN = calmN;
            float cosI = clamp(dot(I, microN), 0.0, 1.0);
            float window = smoothstep(0.654 - 0.12 * churn, 0.69 + 0.12 * churn, cosI);
            float rim = exp(-pow((cosI - 0.6614) / 0.014, 2.0)) * (1.0 - churn);
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
            // Whitewater seen from below glows with the light it diffuses:
            // brightest where it is thickest, with soft, uneven density.
            float glowN = 0.8 + 0.4 * fbm2(p * 1.3 + uTime * 0.05);
            below = mix(below, vec3(0.6, 0.76, 0.74) * glowN, freshCover * 0.55);
            below = applyWaterFog(below, vDistance, uFogColor, uFogDensity * 0.72);
          }

          float camGap = uCameraPos.y - vWorld.y;
          float meniscus = exp(-pow(camGap / 0.05, 2.0)) * nearSurface;
          vec3 color = mix(below, aboveFog, aboveWeight);
          color = mix(color, vec3(0.92, 0.99, 0.97), meniscus * 0.22);
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
    this.uniforms.uBreakFloor.value = TUNING.water.breakFloor ?? 2.4;
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

  /** Stamp foam (lingering lace) and fresh whitewater onto the surface. */
  addFoam(x, z, radius, foam, fresh = 0) {
    this.sim.addSplat(x, z, 0, radius, foam, fresh);
  }

  /** Hand the shader what lies under the surface (see refraction.js). */
  setRefraction(refraction, on, camera) {
    const u = this.uniforms;
    u.uRefrOn.value = on ? 1 : 0;
    u.uRefrColor.value = refraction.target.texture;
    u.uRefrDepth.value = refraction.target.depthTexture;
    u.uCamNF.value.set(camera.near, camera.far);
  }

  update(dt, playerPos, camera, underwater, wetness, context = {}) {
    this.time += dt * TUNING.water.timeScale;
    this.solver.enabled = TUNING.water.solverEnabled;
    this.solver.update(dt, this.time);
    this.foamField.enabled = TUNING.water.foamFieldEnabled;
    this.foamField.follow(camera.position.x, camera.position.z);
    this.foamField.update(dt, this.time);
    const u = this.uniforms;
    u.uFoamCenter.value.set(this.foamField.centerX, this.foamField.centerZ);
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

    // The contact field rides with the surface water under the player.
    const drift = this.water.sampleForForces(playerPos.x, bodySurf.height - 0.05, playerPos.z, this._driftSample);
    this._drift.x = Number.isFinite(drift.velocityX) ? drift.velocityX : 0;
    this._drift.z = Number.isFinite(drift.velocityZ) ? drift.velocityZ : 0;
    this.sim.update(dt, playerPos, this._drift);
    this.ripples.update(this.time);
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
    u.uSeaLook.value.set(TUNING.visuals.seaMilk, TUNING.visuals.seaGlow, TUNING.visuals.foamWhite, TUNING.visuals.sunGlitter);

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
