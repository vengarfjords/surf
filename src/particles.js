import * as THREE from "three";
import { TUNING } from "./config.js";
import { clamp, glslFog, glslNoise } from "./utils.js";

const POINT_VERT = /* glsl */ `
  precision highp float;
  attribute float aAlpha;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aSeed;
  uniform float uPixelRatio;
  uniform float uScale;
  uniform float uTime;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vSeed;
  varying float vFogDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float perspective = uScale / max(0.1, -mv.z);
    gl_PointSize = clamp(aSize * perspective, 1.0, 110.0);
    vAlpha = aAlpha;
    vColor = aColor;
    vSeed = aSeed;
    vFogDepth = -mv.z;
  }
`;

const POINT_FRAG = /* glsl */ `
  precision highp float;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vSeed;
  varying float vFogDepth;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uSoftness;
  uniform float uRing;
  uniform float uOpacity;
  ${glslNoise}
  ${glslFog}
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float dist = length(uv);
    if (dist > 0.5) discard;
    float soft = smoothstep(0.5, 0.5 - uSoftness, dist);
    float n = vnoise(gl_PointCoord * 7.0 + vSeed * 31.0);
    soft *= 0.68 + n * 0.5;
    float ring = 0.0;
    if (uRing > 0.5) {
      ring = smoothstep(0.49, 0.40, dist) * smoothstep(0.20, 0.35, dist);
      float spec = smoothstep(0.16, 0.0, length(uv + vec2(0.12, -0.13)));
      soft = ring * 0.7 + spec * 0.5;
    }
    float alpha = soft * vAlpha * uOpacity;
    if (alpha < 0.004) discard;
    vec3 col = applyWaterFog(vColor, vFogDepth, uFogColor, uFogDensity);
    gl_FragColor = vec4(col, alpha);
  }
`;

export class CPUParticles {
  constructor(scene, capacity, options = {}) {
    this.scene = scene;
    this.capacity = capacity;
    this.cursor = 0;
    this.particles = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.particles[i] = {
        alive: false,
        x: 0,
        y: -999,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        age: 0,
        life: 1,
        size: 0.1,
        drag: 0.7,
        gravity: 0,
        wobble: 0,
        seed: Math.random(),
        r: 1,
        g: 1,
        b: 1,
        alpha: 1,
      };
    }
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.alphas = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);
    this.seeds = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.positions[i * 3 + 1] = -999;
      this.seeds[i] = Math.random();
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("aColor", new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute("aAlpha", new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute("aSeed", new THREE.BufferAttribute(this.seeds, 1));
    this.geometry.setDrawRange(0, capacity);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: 1 },
        uScale: { value: 620 },
        uTime: { value: 0 },
        uFogColor: { value: new THREE.Color(0x1b5a5b) },
        uFogDensity: { value: TUNING.visuals.underwaterDensity },
        uSoftness: { value: options.softness ?? 0.38 },
        uRing: { value: options.ring ? 1 : 0 },
        uOpacity: { value: options.opacity ?? 1 },
      },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.scene.add(this.points);
    this.time = 0;
    this.tmpColor = new THREE.Color();
  }

  spawn(opts) {
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % this.capacity;
    p.alive = true;
    p.x = opts.x;
    p.y = opts.y;
    p.z = opts.z;
    p.vx = opts.vx ?? 0;
    p.vy = opts.vy ?? 0;
    p.vz = opts.vz ?? 0;
    p.age = 0;
    p.life = opts.life ?? 1;
    p.size = opts.size ?? 0.3;
    p.drag = opts.drag ?? 0.9;
    p.gravity = opts.gravity ?? 0;
    p.wobble = opts.wobble ?? 0;
    p.alpha = opts.alpha ?? 1;
    p.seed = Math.random();
    p.r = opts.r ?? 0.8;
    p.g = opts.g ?? 0.8;
    p.b = opts.b ?? 0.75;
    return p;
  }

  update(dt, camera, fogColor, fogDensity, current) {
    this.time += dt;
    const pos = this.positions;
    const col = this.colors;
    const al = this.alphas;
    const sz = this.sizes;
    const n = this.capacity;
    const cx = current?.x ?? 0;
    const cy = current?.y ?? 0;
    const cz = current?.z ?? 0;
    let any = false;

    for (let i = 0; i < n; i++) {
      const p = this.particles[i];
      if (!p.alive) {
        al[i] = 0;
        pos[i * 3 + 1] = -999;
        continue;
      }
      any = true;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        al[i] = 0;
        pos[i * 3 + 1] = -999;
        continue;
      }
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag;
      p.vy *= drag;
      p.vz *= drag;
      p.vy += p.gravity * dt;
      if (p.wobble > 0) {
        p.vx += Math.sin(this.time * 4.1 + p.seed * 18.0) * p.wobble * dt;
        p.vz += Math.cos(this.time * 3.4 + p.seed * 13.0) * p.wobble * dt;
      }
      p.vx += (cx - p.vx) * 0.14 * dt;
      p.vz += (cz - p.vz) * 0.14 * dt;
      p.vy += cy * 0.05 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      const lifeT = p.age / p.life;
      const alpha = p.alpha * Math.pow(1 - lifeT, 1.4) * smoothFadeIn(lifeT);
      const idx = i * 3;
      pos[idx] = p.x;
      pos[idx + 1] = p.y;
      pos[idx + 2] = p.z;
      col[idx] = p.r;
      col[idx + 1] = p.g;
      col[idx + 2] = p.b;
      al[i] = alpha;
      sz[i] = p.size * (0.7 + lifeT * 0.6);
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aSeed.needsUpdate = true;
    this.material.uniforms.uTime.value = this.time;
    this.material.uniforms.uFogColor.value.copy(fogColor);
    this.material.uniforms.uFogDensity.value = fogDensity;
    const h = this.scene.userData.renderHeight || 900;
    this.material.uniforms.uScale.value = h * 0.65;
    this.material.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 1.5);
    this.points.visible = any;
  }
}

function smoothFadeIn(t) {
  return t < 0.08 ? t / 0.08 : 1;
}

function colorTint(base, variance) {
  const c = new THREE.Color(base);
  c.offsetHSL((Math.random() - 0.5) * 0.03, (Math.random() - 0.5) * variance, (Math.random() - 0.5) * variance);
  return c;
}

export class ParticleFX {
  constructor(scene) {
    this.scene = scene;
    this.sediment = new CPUParticles(scene, TUNING.sand.particleBudget, {
      softness: 0.5,
      opacity: 0.52,
    });
    this.splash = new CPUParticles(scene, 760, {
      softness: 0.32,
      additive: false,
      opacity: 0.8,
    });
    this.bubbles = new CPUParticles(scene, 380, {
      softness: 0.42,
      ring: true,
      additive: true,
      opacity: 0.7,
    });
    this.tmp = new THREE.Color();
  }

  sandPlume(x, z, amount, radius, surfaceY) {
    const count = clamp(Math.floor(amount * 14), 1, 34);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.55) * radius;
      const c = colorTint(0xc6b68f, 0.12);
      this.sediment.spawn({
        x: x + Math.cos(a) * r,
        y: surfaceY + 0.06 + Math.random() * 0.28,
        z: z + Math.sin(a) * r,
        vx: Math.cos(a) * (0.1 + Math.random() * 0.8),
        vy: 0.08 + Math.random() * 0.4,
        vz: Math.sin(a) * (0.1 + Math.random() * 0.8),
        life: 2.4 + Math.random() * 3.6,
        size: 0.12 + Math.random() * 0.62,
        drag: 0.72,
        gravity: -0.014,
        wobble: 0.045,
        alpha: 0.2 + Math.random() * 0.34,
        r: c.r,
        g: c.g,
        b: c.b,
      });
    }
    // A slower, much larger cloud fraction gives the plume a settling body
    // instead of a handful of sharp specks.
    const cloudCount = clamp(Math.floor(amount * 2.2), 0, 8);
    for (let i = 0; i < cloudCount; i++) {
      const c = colorTint(0xb9a985, 0.08);
      this.sediment.spawn({
        x: x + (Math.random() - 0.5) * radius * 1.6,
        y: surfaceY + 0.15 + Math.random() * 0.55,
        z: z + (Math.random() - 0.5) * radius * 1.6,
        vx: (Math.random() - 0.5) * 0.32,
        vy: 0.05 + Math.random() * 0.16,
        vz: (Math.random() - 0.5) * 0.32,
        life: 3.6 + Math.random() * 4.5,
        size: 0.65 + Math.random() * 1.1,
        drag: 0.42,
        gravity: -0.006,
        wobble: 0.02,
        alpha: 0.055 + Math.random() * 0.1,
        r: c.r,
        g: c.g,
        b: c.b,
      });
    }
  }

  rippleDust(x, z, strength, surfaceY) {
    if (Math.random() > 0.5) return;
    const count = 1 + Math.floor(strength * 3.5);
    for (let i = 0; i < count; i++) {
      const c = colorTint(0xb9aa84, 0.08);
      this.sediment.spawn({
        x: x + (Math.random() - 0.5) * 2.8,
        y: surfaceY + 0.06 + Math.random() * 0.24,
        z: z + (Math.random() - 0.5) * 2.8,
        vx: (Math.random() - 0.5) * 0.46,
        vy: 0.03 + Math.random() * 0.16,
        vz: (Math.random() - 0.5) * 0.46,
        life: 2.0 + Math.random() * 3.2,
        size: 0.08 + Math.random() * 0.36,
        drag: 1.05,
        gravity: -0.005,
        wobble: 0.028,
        alpha: 0.1 + Math.random() * 0.22,
        r: c.r,
        g: c.g,
        b: c.b,
      });
    }
  }

  bubbleBurst(x, y, z, count = 6, spread = 0.4, rise = 0.7) {
    for (let i = 0; i < count; i++) {
      const c = colorTint(0xb6f1e2, 0.05);
      this.bubbles.spawn({
        x: x + (Math.random() - 0.5) * spread,
        y: y + (Math.random() - 0.5) * spread,
        z: z + (Math.random() - 0.5) * spread,
        vx: (Math.random() - 0.5) * 0.18,
        vy: rise * (0.5 + Math.random()),
        vz: (Math.random() - 0.5) * 0.18,
        life: 1.8 + Math.random() * 4.5,
        size: 0.035 + Math.random() * 0.12,
        drag: 0.25,
        gravity: -0.02,
        wobble: 0.16,
        alpha: 0.7,
        r: c.r,
        g: c.g,
        b: c.b,
      });
    }
  }

  splashBurst(x, y, z, intensity, directionX = 0, directionZ = 0) {
    const count = clamp(Math.floor(14 + intensity * 38), 8, 110);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const outward = (0.4 + Math.random() * 2.6) * (0.6 + intensity * 0.4);
      this.splash.spawn({
        x: x + (Math.random() - 0.5) * 0.8,
        y: y + Math.random() * 0.35,
        z: z + (Math.random() - 0.5) * 0.8,
        vx: Math.cos(a) * outward + directionX * 0.5,
        vy: (1.2 + Math.random() * 3.8) * (0.6 + intensity * 0.32),
        vz: Math.sin(a) * outward + directionZ * 0.5,
        life: 0.6 + Math.random() * 1.25,
        size: 0.06 + Math.random() * 0.3,
        drag: 0.6,
        gravity: 7.5,
        alpha: 0.5 + Math.random() * 0.5,
        r: 0.72,
        g: 0.92,
        b: 0.88,
      });
    }
    for (let i = 0; i < count * 0.4; i++) {
      const c = colorTint(0xc6b68f, 0.08);
      this.sediment.spawn({
        x: x + (Math.random() - 0.5) * 2.2,
        y: y - 0.2 + Math.random() * 0.7,
        z: z + (Math.random() - 0.5) * 2.2,
        vx: (Math.random() - 0.5) * 1.6,
        vy: 0.2 + Math.random() * 1.1,
        vz: (Math.random() - 0.5) * 1.6,
        life: 2 + Math.random() * 3,
        size: 0.15 + Math.random() * 0.6,
        drag: 1.0,
        gravity: -0.02,
        wobble: 0.06,
        alpha: 0.2,
        r: c.r,
        g: c.g,
        b: c.b,
      });
    }
  }

  update(dt, camera, fogColor, fogDensity, current) {
    this.scene.userData.renderHeight =
      window.innerHeight * Math.min(window.devicePixelRatio || 1, 1.5);
    this.sediment.update(dt, camera, fogColor, fogDensity, current);
    this.splash.update(dt, camera, fogColor, fogDensity, current);
    this.bubbles.update(dt, camera, fogColor, fogDensity, current);
  }
}

export class NearMotes {
  constructor(scene, count = 180) {
    this.scene = scene;
    this.count = count;
    this.time = 0;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const size = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const box = new THREE.Vector3(15, 9, 15);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * box.x;
      pos[i * 3 + 1] = (Math.random() - 0.5) * box.y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * box.z;
      seed[i] = Math.random();
      size[i] = 0.025 + Math.pow(Math.random(), 2.4) * 0.12;
      const c = new THREE.Color(Math.random() < 0.35 ? 0xe0d7b5 : 0xb7d5c0);
      color[i * 3] = c.r;
      color[i * 3 + 1] = c.g;
      color[i * 3 + 2] = c.b;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    this.geometry.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
    this.uniforms = {
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: box },
      uTime: { value: 0 },
      uScale: { value: 800 },
      uUnderwater: { value: 1 },
      uFogColor: { value: new THREE.Color(0x17585b) },
      uFogDensity: { value: 0.026 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSeed;
        attribute float aSize;
        uniform vec3 uCenter;
        uniform vec3 uBox;
        uniform float uTime;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDepth;
        varying float vSeed;
        void main() {
          vec3 drift = vec3(
            sin(uTime * 0.16 + aSeed * 18.0) * 0.35,
            -uTime * (0.012 + aSeed * 0.026),
            cos(uTime * 0.12 + aSeed * 12.0) * 0.3
          );
          vec3 base = position + drift;
          vec3 rel = mod(base - uCenter + uBox * 0.5, uBox) - uBox * 0.5;
          vec3 world = uCenter + rel;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = length(mv.xyz);
          gl_PointSize = clamp(aSize * uScale / max(0.2, dist), 2.0, 54.0);
          vColor = aColor;
          vDepth = dist;
          vSeed = aSeed;
          vAlpha = smoothstep(14.0, 1.0, dist) * (0.18 + aSeed * 0.48);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uUnderwater;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDepth;
        varying float vSeed;
        ${glslNoise}
        ${glslFog}
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p);
          if (d > 0.5) discard;
          float halo = smoothstep(0.5, 0.1, d);
          float inner = smoothstep(0.22, 0.0, length(p + vec2(0.09, -0.08)));
          float a = (halo * 0.32 + inner * 0.52) * vAlpha;
          vec3 col = applyWaterFog(vColor, vDepth, uFogColor, uFogDensity);
          gl_FragColor = vec4(col, a * uUnderwater);
        }
      `,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.scene.add(this.points);
  }

  update(dt, camera, fogColor, fogDensity, underwater) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uCenter.value.copy(camera.position);
    this.uniforms.uFogColor.value.copy(fogColor);
    this.uniforms.uFogDensity.value = fogDensity;
    this.uniforms.uUnderwater.value = underwater;
    this.uniforms.uScale.value = window.innerHeight * Math.min(window.devicePixelRatio || 1, 1.5) * 0.9;
    this.points.visible = underwater > 0.05;
  }
}

export class MarineSnow {
  constructor(scene, count = 2400) {
    this.scene = scene;
    this.count = count;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const size = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const box = new THREE.Vector3(105, 42, 105);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * box.x;
      pos[i * 3 + 1] = (Math.random() - 0.5) * box.y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * box.z;
      seed[i] = Math.random();
      size[i] = 0.014 + Math.pow(Math.random(), 3.2) * 0.17;
      const c = Math.random() < 0.24 ? new THREE.Color(0xc8f0dc) : new THREE.Color(0x93b9a5);
      color[i * 3] = c.r;
      color[i * 3 + 1] = c.g;
      color[i * 3 + 2] = c.b;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    this.geometry.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
    this.box = box;
    this.time = 0;
    this.uniforms = {
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: box },
      uTime: { value: 0 },
      uScale: { value: 700 },
      uUnderwater: { value: 1 },
      uFogColor: { value: new THREE.Color(0x17585b) },
      uFogDensity: { value: 0.026 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSeed;
        attribute float aSize;
        uniform vec3 uCenter;
        uniform vec3 uBox;
        uniform float uTime;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDepth;
        varying float vSeed;
        void main() {
          vec3 drift = vec3(
            sin(uTime * 0.11 + aSeed * 21.0) * 0.65,
            -uTime * (0.025 + aSeed * 0.045),
            cos(uTime * 0.085 + aSeed * 17.0) * 0.55
          );
          vec3 base = position + drift;
          vec3 center = uCenter + vec3(0.0, -6.0, 0.0);
          vec3 rel = mod(base - center + uBox * 0.5, uBox) - uBox * 0.5;
          vec3 world = center + rel;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = length(mv.xyz);
          gl_PointSize = clamp(aSize * uScale / max(0.2, dist), 0.5, 12.0);
          vColor = aColor;
          vDepth = dist;
          vSeed = aSeed;
          vAlpha = smoothstep(90.0, 20.0, dist) * (0.2 + aSeed * 0.4);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uUnderwater;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDepth;
        varying float vSeed;
        ${glslNoise}
        ${glslFog}
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p);
          if (d > 0.5) discard;
          float grain = vnoise(gl_PointCoord * 5.0 + vSeed * 30.0);
          float a = smoothstep(0.5, 0.16, d) * (0.38 + grain * 0.62) * vAlpha;
          a *= 0.55 + 0.45 * sin(vSeed * 60.0 + vDepth);
          vec3 col = applyWaterFog(vColor, vDepth, uFogColor, uFogDensity);
          gl_FragColor = vec4(col, a * 0.55 * uUnderwater);
        }
      `,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.scene.add(this.points);
  }

  update(dt, camera, fogColor, fogDensity, underwater) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uCenter.value.copy(camera.position);
    this.uniforms.uFogColor.value.copy(fogColor);
    this.uniforms.uFogDensity.value = fogDensity;
    this.uniforms.uUnderwater.value = underwater;
    this.uniforms.uScale.value = window.innerHeight * Math.min(window.devicePixelRatio || 1, 1.5) * 0.55;
    this.points.visible = underwater > 0.05;
  }
}
