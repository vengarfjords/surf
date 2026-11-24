import * as THREE from "three";

/**
 * Live short-wave detail for the sea surface: three cascades of a wind-wave
 * spectrum, evolved with the real dispersion relation and inverse-transformed
 * on the GPU every frame (Tessendorf). Each cascade is a tileable patch that
 * holds slope x, slope z, height and curvature for one band of wavelengths:
 *
 *   cascade 0: 12 m to 0.9 m   (wind chop riding on the swell)
 *   cascade 1: 0.9 m to 14 cm  (short gravity waves)
 *   cascade 2: 14 cm to 2 cm   (capillary ripples, seen only up close)
 *
 * Unlike scrolled noise textures, every ripple moves at its own phase speed,
 * so the surface evolves rather than slides. Purely visual: the ocean
 * fragment shader reads these for its shading normal; the geometry and the
 * physics never see them.
 *
 * The three cascades are evolved side by side in one 3N x N texture and
 * transformed together, three draws a frame: the spectrum at time t, the
 * inverse transform along rows, then along columns straight into the three
 * cascade textures (one target with three colour attachments). Each output
 * texel sums its whole row or column, which is the same inverse DFT the
 * radix-2 FFT computed in 14 passes per cascade (42 draws, plus a spectrum
 * and a copy pass each): the result is the same to float precision, and
 * the 45 extra render passes a frame, each with its own GPU pass and
 * three.js render call, are gone.
 */

const VERT = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// h(k, t) from the initial spectrum, packed as two complex fields whose
// inverse transforms are real: (slope x + i slope z, height + i curvature).
// One N x N tile per cascade, side by side.
const SPECTRUM_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uH0;
  uniform float uN;
  uniform vec3 uL;
  uniform float uTime;
  vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
  void main() {
    vec2 px = floor(gl_FragCoord.xy);
    float tile = floor(px.x / uN);
    vec2 c = vec2(px.x - tile * uN, px.y);
    float L = tile < 0.5 ? uL.x : (tile < 1.5 ? uL.y : uL.z);
    vec2 nm = vec2(c.x < uN * 0.5 ? c.x : c.x - uN, c.y < uN * 0.5 ? c.y : c.y - uN);
    vec2 k = 6.28318530718 * nm / L;
    float kl = length(k);
    vec4 h0 = texelFetch(uH0, ivec2(px), 0);
    // Gravity-capillary dispersion.
    float w = sqrt(9.81 * kl * (1.0 + kl * kl / (370.0 * 370.0)));
    float ph = w * uTime;
    vec2 e = vec2(cos(ph), sin(ph));
    vec2 h = cmul(h0.xy, e) + cmul(vec2(h0.z, -h0.w), vec2(e.x, -e.y));
    vec2 sx = vec2(-k.x * h.y, k.x * h.x);
    vec2 sz = vec2(-k.y * h.y, k.y * h.x);
    vec2 lap = -kl * kl * h;
    gl_FragColor = vec4(sx.x - sz.y, sx.y + sz.x, h.x - lap.y, h.y + lap.x);
  }
`;

// Inverse DFT along each row of a tile, two complex numbers per texel:
// X[n] = sum_k x[k] e^(+2 pi i k n / N). uTw holds e^(2 pi i m / N).
const ROWS_FRAG = (N) => /* glsl */ `
  precision highp float;
  #define N ${N}
  uniform sampler2D uInput;
  uniform vec2 uTw[N];
  void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    int tile = px.x / N;
    int n = px.x - tile * N;
    int base = tile * N;
    vec4 acc = vec4(0.0);
    for (int k = 0; k < N; k++) {
      vec4 v = texelFetch(uInput, ivec2(base + k, px.y), 0);
      vec2 w = uTw[(k * n) & (N - 1)];
      acc += vec4(
        v.x * w.x - v.y * w.y, v.x * w.y + v.y * w.x,
        v.z * w.x - v.w * w.y, v.z * w.y + v.w * w.x
      );
    }
    gl_FragColor = acc;
  }
`;

// The same along each column, for all three tiles at once, written to the
// three cascade textures.
const COLUMNS_FRAG = (N) => /* glsl */ `
  precision highp float;
  #define N ${N}
  uniform sampler2D uInput;
  uniform vec2 uTw[N];
  layout(location = 0) out vec4 outCascade0;
  layout(location = 1) out vec4 outCascade1;
  layout(location = 2) out vec4 outCascade2;
  vec4 twiddle(vec4 v, vec2 w) {
    return vec4(
      v.x * w.x - v.y * w.y, v.x * w.y + v.y * w.x,
      v.z * w.x - v.w * w.y, v.z * w.y + v.w * w.x
    );
  }
  void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    int m = px.y;
    vec4 a0 = vec4(0.0);
    vec4 a1 = vec4(0.0);
    vec4 a2 = vec4(0.0);
    for (int l = 0; l < N; l++) {
      vec2 w = uTw[(l * m) & (N - 1)];
      a0 += twiddle(texelFetch(uInput, ivec2(px.x, l), 0), w);
      a1 += twiddle(texelFetch(uInput, ivec2(px.x + N, l), 0), w);
      a2 += twiddle(texelFetch(uInput, ivec2(px.x + 2 * N, l), 0), w);
    }
    outCascade0 = a0;
    outCascade1 = a1;
    outCascade2 = a2;
  }
`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const RIPPLE_CASCADES = [
  // patch size (m), band (wavelength, m), rms slope along one axis,
  // how isotropic the short waves are.
  { L: 48, longest: 12, shortest: 0.9, slope: 0.075, isotropy: 0.25 },
  { L: 7.5, longest: 0.9, shortest: 0.14, slope: 0.085, isotropy: 0.4 },
  { L: 1.15, longest: 0.14, shortest: 0.022, slope: 0.06, isotropy: 0.6 },
];

export class OceanRipples {
  constructor(renderer, { size = 128, seed = 9127 } = {}) {
    this.renderer = renderer;
    this.size = size;
    const N = size;
    const count = RIPPLE_CASCADES.length;
    const gl = renderer.getContext();
    const floatOk = !!gl.getExtension("EXT_color_buffer_float");
    const workType = floatOk ? THREE.FloatType : THREE.HalfFloatType;
    const work = {
      type: workType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    // The cascades side by side: spectrum, then rows transformed.
    this.spectrumTarget = new THREE.WebGLRenderTarget(N * count, N, work);
    this.rowsTarget = new THREE.WebGLRenderTarget(N * count, N, work);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    // e^(2 pi i m / N), exact to float precision.
    const twiddles = Array.from({ length: N }, (_, m) => {
      const a = (2 * Math.PI * m) / N;
      return new THREE.Vector2(Math.cos(a), Math.sin(a));
    });

    this.spectrumMat = new THREE.ShaderMaterial({
      uniforms: {
        uH0: { value: null },
        uN: { value: N },
        uL: { value: new THREE.Vector3(...RIPPLE_CASCADES.map((c) => c.L)) },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: SPECTRUM_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.rowsMat = new THREE.ShaderMaterial({
      uniforms: { uInput: { value: this.spectrumTarget.texture }, uTw: { value: twiddles } },
      vertexShader: VERT,
      fragmentShader: ROWS_FRAG(N),
      depthTest: false,
      depthWrite: false,
    });
    this.columnsMat = new THREE.ShaderMaterial({
      uniforms: { uInput: { value: this.rowsTarget.texture }, uTw: { value: twiddles } },
      vertexShader: VERT,
      fragmentShader: COLUMNS_FRAG(N),
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
    });

    // The three cascades, mip-filtered and tiling, as the ocean reads them.
    this.output = new THREE.WebGLRenderTarget(N, N, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
      anisotropy: 16,
      count,
    });
    for (const t of this.output.textures) t.colorSpace = THREE.NoColorSpace;

    const rnd = mulberry32(seed);
    this.cascades = RIPPLE_CASCADES.map((spec, i) => ({
      ...spec,
      h0: this._initialSpectrum(spec, rnd),
      target: this.output,
      texture: this.output.textures[i],
    }));
    // All initial spectra in one texture, in the same layout as the work
    // targets.
    const h0 = new Float32Array(N * count * N * 4);
    this.cascades.forEach((c, i) => {
      const src = c.h0.image.data;
      for (let y = 0; y < N; y++) {
        h0.set(src.subarray(y * N * 4, (y + 1) * N * 4), (y * N * count + i * N) * 4);
      }
    });
    this.h0 = new THREE.DataTexture(h0, N * count, N, THREE.RGBAFormat, THREE.FloatType);
    this.h0.minFilter = this.h0.magFilter = THREE.NearestFilter;
    this.h0.needsUpdate = true;
    this.spectrumMat.uniforms.uH0.value = this.h0;
    this.textures = this.output.textures;
    this.time = -1;
  }

  // Random initial amplitudes for one band, wind along +x. The spectrum is
  // a Phillips-like k^-4 shape with soft band edges and a directional
  // spread that is broader for shorter waves; it is then scaled so the
  // band's rms slope matches its target.
  _initialSpectrum(spec, rnd) {
    const N = this.size;
    const data = new Float32Array(N * N * 4);
    const kLo = (2 * Math.PI) / spec.longest;
    const kHi = (2 * Math.PI) / spec.shortest;
    const gauss = () => {
      const u = Math.max(rnd(), 1e-9);
      const v = rnd();
      const r = Math.sqrt(-2 * Math.log(u));
      return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
    };
    const smooth = (a, b, x) => {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const amp = (kx, kz) => {
      const k = Math.hypot(kx, kz);
      if (k < 1e-6) return 0;
      const band = smooth(kLo * 0.8, kLo * 1.2, k) * (1 - smooth(kHi * 0.8, kHi * 1.15, k));
      if (band <= 0) return 0;
      const c = kx / k;
      const dir = (c > 0 ? 1 : 0.3) * (spec.isotropy + (1 - spec.isotropy) * c * c);
      return Math.sqrt((band * dir) / (k * k * k * k));
    };
    const h0 = new Float32Array(N * N * 2);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const n = x < N / 2 ? x : x - N;
        const m = y < N / 2 ? y : y - N;
        const kx = (2 * Math.PI * n) / spec.L;
        const kz = (2 * Math.PI * m) / spec.L;
        const a = amp(kx, kz) / Math.SQRT2;
        const [gr, gi] = gauss();
        h0[(y * N + x) * 2] = gr * a;
        h0[(y * N + x) * 2 + 1] = gi * a;
      }
    }
    let slope2 = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const n = x < N / 2 ? x : x - N;
        const kx = (2 * Math.PI * n) / spec.L;
        // conj(h0(-k)) lives at the mirrored index.
        const mx = (N - x) % N;
        const my = (N - y) % N;
        const i = (y * N + x) * 2;
        const j = (my * N + mx) * 2;
        const p = (y * N + x) * 4;
        data[p] = h0[i];
        data[p + 1] = h0[i + 1];
        data[p + 2] = h0[j];
        data[p + 3] = h0[j + 1];
        slope2 += kx * kx * (h0[i] ** 2 + h0[i + 1] ** 2 + h0[j] ** 2 + h0[j + 1] ** 2);
      }
    }
    const scale = slope2 > 0 ? spec.slope / Math.sqrt(slope2) : 0;
    for (let i = 0; i < data.length; i++) data[i] *= scale;
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  update(time) {
    if (time === this.time) return;
    this.time = time;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.autoClear = false;
    this.spectrumMat.uniforms.uTime.value = time;
    this._pass(this.spectrumMat, this.spectrumTarget);
    this._pass(this.rowsMat, this.rowsTarget);
    this._pass(this.columnsMat, this.output);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.xr.enabled = prevXr;
  }
}
