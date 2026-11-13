import * as THREE from "three";

/**
 * Live short-wave detail for the sea surface: three cascades of a wind-wave
 * spectrum, evolved with the real dispersion relation and inverse-FFT'd on
 * the GPU every frame (Tessendorf). Each cascade is a tileable patch that
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
 */

const VERT = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// h(k, t) from the initial spectrum, packed as two complex fields whose
// inverse transforms are real: (slope x + i slope z, height + i curvature).
const SPECTRUM_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uH0;
  uniform float uN;
  uniform float uL;
  uniform float uTime;
  vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
  void main() {
    vec2 c = floor(gl_FragCoord.xy);
    vec2 nm = vec2(c.x < uN * 0.5 ? c.x : c.x - uN, c.y < uN * 0.5 ? c.y : c.y - uN);
    vec2 k = 6.28318530718 * nm / uL;
    float kl = length(k);
    vec4 h0 = texture2D(uH0, (c + 0.5) / uN);
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

// One radix-2 Stockham pass of an inverse FFT, on two complex numbers per
// texel at once.
const FFT_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uInput;
  uniform float uN;
  uniform float uSub;
  uniform float uHoriz;
  vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
  void main() {
    vec2 c = floor(gl_FragCoord.xy);
    float index = uHoriz > 0.5 ? c.x : c.y;
    float halfSub = uSub * 0.5;
    float evenIndex = floor(index / uSub) * halfSub + mod(index, halfSub);
    vec2 ce = uHoriz > 0.5 ? vec2(evenIndex, c.y) : vec2(c.x, evenIndex);
    vec2 co = uHoriz > 0.5 ? vec2(evenIndex + uN * 0.5, c.y) : vec2(c.x, evenIndex + uN * 0.5);
    vec4 ev = texture2D(uInput, (ce + 0.5) / uN);
    vec4 od = texture2D(uInput, (co + 0.5) / uN);
    float a = 6.28318530718 * index / uSub;
    vec2 tw = vec2(cos(a), sin(a));
    gl_FragColor = vec4(ev.xy + cmul(tw, od.xy), ev.zw + cmul(tw, od.zw));
  }
`;

const COPY_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uInput;
  uniform float uN;
  void main() {
    gl_FragColor = texture2D(uInput, (floor(gl_FragCoord.xy) + 0.5) / uN);
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
    this.passes = Math.round(Math.log2(size));
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
    this.ping = new THREE.WebGLRenderTarget(size, size, work);
    this.pong = new THREE.WebGLRenderTarget(size, size, work);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.spectrumMat = new THREE.ShaderMaterial({
      uniforms: {
        uH0: { value: null },
        uN: { value: size },
        uL: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: SPECTRUM_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.fftMat = new THREE.ShaderMaterial({
      uniforms: {
        uInput: { value: null },
        uN: { value: size },
        uSub: { value: 2 },
        uHoriz: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FFT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { uInput: { value: null }, uN: { value: size } },
      vertexShader: VERT,
      fragmentShader: COPY_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    const rnd = mulberry32(seed);
    this.cascades = RIPPLE_CASCADES.map((spec) => {
      const target = new THREE.WebGLRenderTarget(size, size, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: true,
        anisotropy: 4,
      });
      target.texture.colorSpace = THREE.NoColorSpace;
      return { ...spec, h0: this._initialSpectrum(spec, rnd), target };
    });
    this.textures = this.cascades.map((c) => c.target.texture);
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
        const m = y < N / 2 ? y : y - N;
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
    tex.needsUpdate = true;
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
    for (const c of this.cascades) {
      const su = this.spectrumMat.uniforms;
      su.uH0.value = c.h0;
      su.uL.value = c.L;
      su.uTime.value = time;
      this._pass(this.spectrumMat, this.ping);
      let src = this.ping;
      let dst = this.pong;
      const fu = this.fftMat.uniforms;
      for (let dir = 0; dir < 2; dir++) {
        fu.uHoriz.value = dir === 0 ? 1 : 0;
        for (let p = 0; p < this.passes; p++) {
          fu.uSub.value = 2 ** (p + 1);
          fu.uInput.value = src.texture;
          this._pass(this.fftMat, dst);
          const t = src;
          src = dst;
          dst = t;
        }
      }
      this.copyMat.uniforms.uInput.value = src.texture;
      this._pass(this.copyMat, c.target);
    }
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.xr.enabled = prevXr;
  }
}
