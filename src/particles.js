import * as THREE from "three";
import { TUNING, SUN_DIRECTION } from "./config.js";
import { FluidParticles, SplashSheets } from "./spray.js";
import { clamp, glslFog, glslNoise, seabedHeight, smoothstep } from "./utils.js";

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
    // Fade sprites that drift right up to the lens instead of letting them
    // fill the frame as soft white blobs (spray behind a surfing dolphin).
    vAlpha = aAlpha * smoothstep(0.5, 2.2, -mv.z);
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
        bx: 0,
        by: 0,
        bz: 0,
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
    // Drag acts relative to this base velocity: spray and foam thrown off
    // a wave moving at 70 m/s keep moving with that water instead of
    // hanging in the air for the camera to fly through.
    p.bx = opts.bx ?? 0;
    p.by = opts.by ?? 0;
    p.bz = opts.bz ?? 0;
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
      p.vx = p.bx + (p.vx - p.bx) * drag;
      p.vy = p.by + (p.vy - p.by) * drag;
      p.vz = p.bz + (p.vz - p.bz) * drag;
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

const rand = (a, b) => a + Math.random() * (b - a);

/** Terminal fall speed of a water drop of diameter d (m) in air. */
function dropTerminal(d) {
  return clamp(2.5 + 900 * d, 2.5, 9.2);
}

/** Splash drop diameters: mostly a few millimetres, a few torn-off blobs. */
function dropSize(scale = 1) {
  const r = Math.random();
  if (r < 0.1) return rand(0.014, 0.035) * scale;
  if (r < 0.4) return rand(0.006, 0.014) * scale;
  return rand(0.0025, 0.006) * scale;
}

export class ParticleFX {
  constructor(scene) {
    this.scene = scene;
    this.sediment = new CPUParticles(scene, TUNING.sand.particleBudget, {
      softness: 0.5,
      opacity: 0.52,
    });
    const sunDir = new THREE.Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize();
    this.sunDir = sunDir;
    // Splash droplets, spray mist, bubbles and underwater aeration.
    this.drops = new FluidParticles(scene, 9000, "drop", { sunDir, renderOrder: 4 });
    this.mist = new FluidParticles(scene, 700, "mist", { sunDir, renderOrder: 5 });
    this.bubbles = new FluidParticles(scene, 4000, "bubble", { sunDir, renderOrder: 4 });
    this.clouds = new FluidParticles(scene, 260, "cloud", { sunDir, renderOrder: 5 });
    this.sheets = new SplashSheets(scene, sunDir, 10);
    this.pools = [this.drops, this.mist, this.bubbles, this.clouds];
    const viewport = new THREE.Vector4();
    for (const pool of this.pools) {
      // The scene is drawn into the composer's scaled target; streak widths
      // are in that target's pixels.
      pool.mesh.onBeforeRender = (renderer) => {
        renderer.getCurrentViewport(viewport);
        pool.uniforms.uResolution.value.set(viewport.z, viewport.w);
      };
    }
    this.env = {
      resolution: new THREE.Vector2(960, 540),
      camVel: new THREE.Vector3(),
      fogColor: new THREE.Color(),
      fogDensity: 0.03,
      surfaceY: 0,
      horizonFog: 1,
      visible: true,
    };
    this._camLast = new THREE.Vector3();
    this._camInit = false;
    this._air = { x: 0, y: 0, z: 0 };
    this._still = { x: 0, y: 0, z: 0 };
    this._windAccum = 0;
    this._windSample = {};
    this._windForward = new THREE.Vector3();
    this._shedAccum = 0;
    this._airTime = 0;
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpC = new THREE.Vector3();
    this.tmp = new THREE.Color();
    this.ocean = null;
    this.stats = { spray: 0, foam: 0, bubbles: 0, crowns: 0, tails: 0, surfSpray: 0, surfBubbles: 0, surfAeration: 0 };
  }

  resetStats() {
    this.stats.spray = 0;
    this.stats.foam = 0;
    this.stats.bubbles = 0;
    this.stats.crowns = 0;
    this.stats.tails = 0;
    this.stats.surfSpray = 0;
    this.stats.surfBubbles = 0;
    this.stats.surfAeration = 0;
  }

  /** Local water velocity at a spawn point, used to advect droplets/foam. */
  waterVel(x, y, z, scale = 0.55) {
    if (!this.ocean) return null;
    const s = this.ocean.water.sampleForForces(x, y, z, this._waterSample || (this._waterSample = {}));
    return {
      x: s.velocityX * scale,
      y: s.velocityY * scale,
      z: s.velocityZ * scale,
      height: s.height,
      depth: s.depth,
    };
  }

  /** The wind the spray is blown along. */
  airVelocity(speed = 6) {
    const dir = TUNING.water.windSeaDirection;
    this._air.x = Math.cos(dir) * speed;
    this._air.z = Math.sin(dir) * speed;
    this._air.y = 0;
    return this._air;
  }

  /** Foam and whitewater stamped into the surface itself. */
  _stampFoam(x, z, radius, foam, fresh) {
    if (this.ocean && this.ocean.addFoam) this.ocean.addFoam(x, z, radius, foam, fresh);
    this.stats.foam++;
  }

  _drop(x, y, z, vx, vy, vz, floorY, floorV, size = dropSize(), alpha = 0.9, life = rand(1.2, 2.4)) {
    this.drops.spawn({
      x,
      y,
      z,
      vx,
      vy,
      vz,
      size,
      life,
      terminal: dropTerminal(size),
      gravity: -9.81,
      alpha,
      air: this._air,
      floor: floorY,
      floorV,
    });
    this.stats.spray++;
  }

  _mist(x, y, z, vx, vy, vz, size, alpha, life = rand(1.4, 3.2)) {
    this.mist.spawn({
      x,
      y,
      z,
      vx,
      vy,
      vz,
      size,
      grow: rand(2.2, 3.6),
      life,
      drag: 1.6,
      gravity: -0.35,
      wobble: 0.35,
      alpha,
      air: this._air,
    });
  }

  /**
   * A burst of droplets thrown from where a body cuts or leaves the surface.
   * (vx, vz) is the body's velocity.
   */
  splashBurst(x, y, z, intensity, vx = 0, vz = 0) {
    const I = clamp(intensity, 0, 2.2);
    const water = this.waterVel(x, y - 0.2, z, 1);
    const wx = water ? water.x : 0;
    const wy = water ? water.y : 0;
    const wz = water ? water.z : 0;
    const floorY = water ? water.height : y;
    this.airVelocity();
    const relX = vx - wx;
    const relZ = vz - wz;
    const count = Math.round(clamp(30 + I * 260, 20, 560));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = rand(0.3, 2.8) * (0.55 + 0.5 * I);
      const up = rand(1.2, 5.2) * (0.5 + 0.42 * I);
      const carry = rand(0.25, 0.75);
      this._drop(
        x + rand(-0.45, 0.45),
        y + Math.random() * 0.2,
        z + rand(-0.45, 0.45),
        wx + Math.cos(a) * out + relX * carry,
        wy + up,
        wz + Math.sin(a) * out + relZ * carry,
        floorY,
        wy
      );
    }
    const puffs = Math.round(1 + I * 3);
    for (let i = 0; i < puffs; i++) {
      this._mist(
        x + rand(-0.5, 0.5),
        y + rand(0.2, 0.6),
        z + rand(-0.5, 0.5),
        wx + relX * 0.3 + rand(-0.6, 0.6),
        rand(0.6, 1.8) * (0.5 + 0.5 * I),
        wz + relZ * 0.3 + rand(-0.6, 0.6),
        rand(0.35, 0.8) * (0.7 + 0.4 * I),
        rand(0.08, 0.16) * Math.min(1, 0.4 + I)
      );
    }
    this._stampFoam(x, z, 0.55 + 0.45 * I, 0.25 * I, 0.65 * I);
    // Sand only clouds up where the splash is close to the bottom; a splash
    // at the surface over open water should not trail a beige haze.
    const sandReach = 1 - smoothstep(1.2, 3.0, y - seabedHeight(x, z));
    const sandCount = Math.floor(clamp(14 + I * 38, 8, 110) * 0.4 * sandReach);
    for (let i = 0; i < sandCount; i++) {
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

  /** Entry splash: a crown sheet that sheds droplets from its rim. */
  splashCrown(x, y, z, intensity, vx = 0, vz = 0) {
    const I = clamp(intensity, 0, 2);
    const water = this.waterVel(x, y, z, 1);
    const drift = new THREE.Vector3(water ? water.x : 0, water ? water.y : 0, water ? water.z : 0);
    const relX = vx - drift.x;
    const relZ = vz - drift.z;
    // A fast, shallow entry throws its splash forward along its path; a
    // steep, slow one throws a round crown.
    const relSpeed = Math.hypot(relX, relZ);
    const s = this.sheets.spawn({
      x,
      y,
      z,
      energy: 0.25 + I * 0.55,
      dirX: relX || 1,
      dirZ: relZ,
      kind: 0,
      aspect: 1.15 + Math.min(1.3, relSpeed * 0.11),
      bias: clamp(relSpeed * 0.05, 0.1, 0.55),
      drift,
    });
    s.shed = 0;
    s.floorY = water ? water.height : y;
    this.airVelocity();
    const puffs = Math.round(4 + I * 7);
    for (let i = 0; i < puffs; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0.6, 1.6) * (0.6 + 0.4 * I);
      this._mist(
        x + Math.cos(a) * r,
        y + rand(0.3, 1.2) * (0.6 + 0.4 * I),
        z + Math.sin(a) * r,
        drift.x + Math.cos(a) * rand(0.5, 1.6),
        rand(0.6, 2.2),
        drift.z + Math.sin(a) * rand(0.5, 1.6),
        rand(0.5, 1.1) * (0.7 + 0.35 * I),
        rand(0.07, 0.15)
      );
    }
    this._stampFoam(x, z, 1.0 + 0.7 * I, 0.6, 1.0);
    this.stats.crowns++;
  }

  /** The fluke slapping down onto the surface. */
  tailSlap(x, y, z, power, dirX, dirZ) {
    // A fluke cutting down through the surface throws a low fan of spray
    // off its trailing edge, not a crown.
    const P = clamp(power, 0, 1.4);
    const water = this.waterVel(x, y, z, 1);
    const wx = water ? water.x : 0;
    const wy = water ? water.y : 0;
    const wz = water ? water.z : 0;
    const floorY = water ? water.height : y;
    this.airVelocity();
    const count = Math.round(30 + P * 110);
    for (let i = 0; i < count; i++) {
      const side = rand(-1, 1);
      this._drop(
        x - dirZ * side * 0.35 + rand(-0.15, 0.15),
        y + 0.04,
        z + dirX * side * 0.35 + rand(-0.15, 0.15),
        wx - dirZ * side * rand(0.4, 1.6) * P - dirX * rand(0.2, 1.2),
        wy + rand(0.8, 2.6) * P,
        wz + dirX * side * rand(0.4, 1.6) * P - dirZ * rand(0.2, 1.2),
        floorY,
        wy
      );
    }
    this._mist(x, y + 0.25, z, wx, rand(0.4, 0.9), wz, rand(0.35, 0.6), 0.07);
    this._stampFoam(x, z, 0.6 + 0.35 * P, 0.25 * P, 0.5 * P);
    this.stats.tails++;
  }

  /**
   * A body leaving the water: a skirt of water falls off along its length,
   * and the water it drags up streams off it.
   */
  spraySheet(points, intensity, vx, vy, vz) {
    const I = clamp(intensity, 0, 1.4);
    const mid = points[1] || points[0];
    const head = points[0];
    const tail = points[points.length - 1];
    const water = this.waterVel(mid.x, mid.y, mid.z, 1);
    const drift = new THREE.Vector3(water ? water.x : 0, water ? water.y : 0, water ? water.z : 0);
    const floorY = water ? water.height : mid.y;
    const s = this.sheets.spawn({
      x: mid.x,
      y: floorY,
      z: mid.z,
      energy: 0.3 + I * 0.7,
      dirX: head.x - tail.x || 1,
      dirZ: head.z - tail.z,
      kind: 1,
      aspect: 2.3,
      bias: 0.2,
      drift,
    });
    s.shed = 0;
    s.floorY = floorY;
    this.airVelocity();
    const count = Math.round(80 + I * 320);
    for (let i = 0; i < count; i++) {
      const t = Math.random();
      const p = t < 0.5 ? this._tmpA.lerpVectors(head, mid, t * 2) : this._tmpA.lerpVectors(mid, tail, t * 2 - 1);
      // Water clings to the body and leaves it a little slower.
      const keep = rand(0.55, 0.95);
      this._drop(
        p.x + rand(-0.25, 0.25),
        Math.max(floorY, p.y - rand(0.0, 0.25)),
        p.z + rand(-0.25, 0.25),
        drift.x + (vx - drift.x) * keep + rand(-1, 1),
        drift.y + (vy - drift.y) * keep * rand(0.6, 1.0) + rand(-0.5, 0.8),
        drift.z + (vz - drift.z) * keep + rand(-1, 1),
        floorY,
        drift.y,
        dropSize(1.2)
      );
    }
    for (let i = 0; i < 4; i++) {
      const p = this._tmpA.lerpVectors(head, tail, Math.random());
      this._mist(p.x, floorY + rand(0.2, 0.6), p.z, drift.x + vx * 0.2, rand(0.6, 1.6), drift.z + vz * 0.2, rand(0.5, 1.0), 0.1);
    }
    this._stampFoam(mid.x, mid.z, 1.2 + 0.6 * I, 0.5, 0.9);
  }

  /**
   * The bow wave of a body running just under the surface: whitewater
   * pushed aside by the head, and at speed a fan of spray off it.
   */
  bowWave(x, z, surfaceY, strength, rightX, rightZ, dirX, dirZ) {
    if (strength <= 0.02) return;
    const S = clamp(strength, 0, 1.6);
    this._stampFoam(x + rightX * 0.4, z + rightZ * 0.4, 0.42, 0.1 * S, 0.22 * S);
    this._stampFoam(x - rightX * 0.4, z - rightZ * 0.4, 0.42, 0.1 * S, 0.22 * S);
    if (S < 0.55) return;
    const water = this.waterVel(x, surfaceY, z, 1);
    const wx = water ? water.x : 0;
    const wy = water ? water.y : 0;
    const wz = water ? water.z : 0;
    this.airVelocity();
    const n = Math.round((S - 0.5) * 14);
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? 1 : -1;
      const out = rand(0.8, 2.6) * S;
      this._drop(
        x + rightX * side * rand(0.25, 0.5),
        surfaceY + 0.05,
        z + rightZ * side * rand(0.25, 0.5),
        wx + rightX * side * out + dirX * rand(0.2, 1.2),
        wy + rand(0.8, 2.6) * S,
        wz + rightZ * side * out + dirZ * rand(0.2, 1.2),
        surfaceY,
        wy
      );
    }
  }

  /** Whitewater and foam left in the wake behind the flukes. */
  wakeTrail(x, z, surfaceY, strength, dirX, dirZ, width = 1.0) {
    if (strength <= 0.01) return;
    const S = clamp(strength, 0, 1.6);
    this._stampFoam(x - dirX * 0.3, z - dirZ * 0.3, 0.3 + 0.35 * width, 0.14 * S, 0.12 * S);
  }

  /** The boil the fluke stroke pushes up behind the animal. */
  tailBoil(x, z, surfaceY, strength, dirX, dirZ, stroke) {
    if (strength <= 0.02) return;
    const S = clamp(strength, 0, 1.6);
    const side = Math.sin(stroke) > 0 ? 1 : 0.75;
    this._stampFoam(x, z, 0.55 + 0.25 * S, 0.08 * S * side, 0.16 * S * side);
  }

  /**
   * Breaker mist at the surf line: fine spray carried onshore by the wave
   * and the local surface velocity.
   */
  surfMist(x, y, z, strength, dirX, dirZ) {
    const water = this.waterVel(x, y, z, 1);
    const wx = water ? water.x : 0;
    const wy = water ? water.y : 0;
    const wz = water ? water.z : 0;
    this.airVelocity();
    this._mist(
      x + rand(-0.6, 0.6),
      y + rand(0.2, 0.6),
      z + rand(-0.6, 0.6),
      wx * 0.5 + dirX * rand(0.5, 1.6),
      rand(0.8, 2.0) * (0.6 + 0.6 * strength),
      wz * 0.5 + dirZ * rand(0.5, 1.6),
      rand(0.6, 1.4),
      0.06 + strength * 0.1
    );
    const n = Math.round(4 + strength * 10);
    for (let i = 0; i < n; i++) {
      this._drop(
        x + rand(-0.8, 0.8),
        y + Math.random() * 0.2,
        z + rand(-0.8, 0.8),
        wx + dirX * rand(0.5, 2.0) + rand(-0.6, 0.6),
        wy + rand(1.5, 4.0) * (0.6 + 0.6 * strength),
        wz + dirZ * rand(0.5, 2.0) + rand(-0.6, 0.6),
        y,
        wy
      );
    }
    this.stats.surfSpray += 1 + n;
  }

  /**
   * Spray torn off crests by the wind, in a cone in front of the camera:
   * a short downwind puff of mist and a scatter of drops.
   */
  updateWindSpray(dt, camera, underwater) {
    const strength = TUNING.visuals.whitecaps;
    if (!this.ocean || underwater > 0.5 || strength <= 0) {
      this._windAccum = 0;
      return;
    }
    const water = this.ocean.water;
    const wdir = TUNING.water.windSeaDirection;
    const wx = Math.cos(wdir);
    const wz = Math.sin(wdir);
    camera.getWorldDirection(this._windForward);
    const f = this._windForward;
    const fl = Math.hypot(f.x, f.z) || 1;
    const fx = f.x / fl;
    const fz = f.z / fl;
    this._windAccum = Math.min(this._windAccum + dt, 0.1);
    const period = 1 / (26 * strength);
    let tries = 0;
    this.airVelocity(7);
    while (this._windAccum >= period && tries < 8) {
      this._windAccum -= period;
      tries++;
      const dist = 8 + Math.pow(Math.random(), 0.7) * 150;
      const lateral = (Math.random() - 0.5) * dist * 1.3;
      const x = camera.position.x + fx * dist - fz * lateral;
      const z = camera.position.z + fz * dist + fx * lateral;
      const s = water.sampleSurface(x, z, this._windSample);
      const crest = s.crest || 0;
      const brk = s.breakMask || 0;
      const score = Math.max(crest * 0.9 + (Math.random() - 0.5) * 0.5, brk * 1.4);
      if (score < 0.55) continue;
      const vel = this.waterVel(x, s.height, z, 1);
      const bx = vel ? vel.x : 0;
      const bz = vel ? vel.z : 0;
      const by = vel ? vel.y : 0;
      const gust = rand(3, 8);
      this._mist(
        x + rand(-0.8, 0.8),
        s.height + rand(0.15, 0.45),
        z + rand(-0.8, 0.8),
        bx + wx * gust,
        rand(0.6, 1.8),
        bz + wz * gust,
        rand(0.5, 1.1) * (1 + dist * 0.004),
        // A thin veil, never a cloud sitting on the whitecap.
        rand(0.035, 0.08),
        rand(0.9, 2.0)
      );
      // Beyond ~60 m single drops are far below a pixel and invisible; only
      // the mist they are torn off with reads, so the pool is kept for the
      // spray close to the camera.
      const near = Math.max(0, Math.min(1, (70 - dist) / 25));
      const n = Math.round((4 + Math.floor(Math.random() * 6 + brk * 8)) * near);
      for (let i = 0; i < n; i++) {
        this._drop(
          x + rand(-0.8, 0.8),
          s.height + 0.1 + Math.random() * 0.25,
          z + rand(-0.8, 0.8),
          bx + wx * rand(2, 7) + rand(-0.5, 0.5),
          by + rand(1.0, 3.2),
          bz + wz * rand(2, 7) + rand(-0.5, 0.5),
          s.height,
          by
        );
      }
    }
  }

  /** Subsurface bubble plume under a breaking crest. */
  surfBubbleBurst(x, surfaceY, z, depth, strength) {
    const n = Math.round(6 + strength * 10);
    for (let i = 0; i < n; i++) this._bubble(x + rand(-0.6, 0.6), surfaceY - 0.3 - Math.random() * depth, z + rand(-0.6, 0.6), rand(0.15, 0.45), surfaceY);
    this.stats.surfBubbles += n;
    // Entrained air under the breaker reads as a pale, turbid cloud rather
    // than as separate bubbles.
    this.clouds.spawn({
      x: x + rand(-1.2, 1.2),
      y: surfaceY - rand(0.5, 2.0),
      z: z + rand(-1.2, 1.2),
      vx: rand(-0.15, 0.15),
      vy: rand(0.05, 0.2),
      vz: rand(-0.15, 0.15),
      size: rand(1.2, 2.6),
      grow: rand(1.4, 2.0),
      life: rand(2.4, 4.2),
      drag: 0.6,
      wobble: 0.04,
      alpha: 0.08 + strength * 0.08,
    });
    this.stats.surfAeration++;
  }

  _bubble(x, y, z, rise, surfaceY = 1e9, size = rand(0.0025, 0.009)) {
    this.bubbles.spawn({
      ceil: surfaceY - 0.03,
      x,
      y,
      z,
      vx: rand(-0.12, 0.12),
      vy: rise,
      vz: rand(-0.12, 0.12),
      size,
      life: rand(2.0, 5.5),
      // Bubbles rise at their terminal speed and zig-zag.
      air: { x: 0, y: 0.18 + size * 40, z: 0 },
      drag: 1.2,
      wobble: 0.5,
      alpha: rand(0.55, 0.9),
      stretch: 0.6,
    });
  }

  bubbleBurst(x, y, z, count = 6, spread = 0.4, rise = 0.7) {
    this.stats.bubbles += count;
    const n = Math.round(count * 6);
    const surfaceY = this.ocean ? this.ocean.getWaterHeight(x, z) : 1e9;
    for (let i = 0; i < n; i++) {
      this._bubble(
        x + (Math.random() - 0.5) * spread,
        y + (Math.random() - 0.5) * spread,
        z + (Math.random() - 0.5) * spread,
        rise * rand(0.4, 1.4),
        surfaceY
      );
    }
    // A big entry drags down a cloud of air with it.
    if (count >= 10) {
      const puffs = Math.round(count / 5);
      for (let i = 0; i < puffs; i++) {
        this.clouds.spawn({
          x: x + (Math.random() - 0.5) * spread * 1.5,
          y: y + (Math.random() - 0.5) * spread,
          z: z + (Math.random() - 0.5) * spread * 1.5,
          vx: rand(-0.2, 0.2),
          vy: rand(0.1, 0.4),
          vz: rand(-0.2, 0.2),
          size: rand(0.35, 0.8),
          grow: rand(1.8, 2.8),
          life: rand(1.4, 2.8),
          drag: 1.0,
          wobble: 0.08,
          alpha: rand(0.07, 0.14),
        });
      }
    }
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

  /**
   * Water streaming off the animal while it is in the air: drips from the
   * flukes, flippers and belly, heaviest just after it leaves the water.
   * Reads the dolphin's state only.
   */
  updateBodyShed(dt, dolphin) {
    if (!this.ocean || !dolphin) return;
    const p = dolphin.position;
    const surf = this.ocean.getWaterHeight(p.x, p.z);
    if (p.y > surf + 0.25) this._airTime += dt;
    else {
      this._airTime = 0;
      this._shedAccum = 0;
      return;
    }
    const rate = 420 * Math.exp(-this._airTime / 0.55) + 50 * Math.exp(-this._airTime / 2.5);
    this._shedAccum += rate * dt;
    if (this._shedAccum < 1) return;
    const parts = dolphin.bodyParts;
    const q = dolphin.orientation;
    const v = dolphin.velocity;
    const head = this._tmpA.copy(parts[0].offset).applyQuaternion(q).add(p);
    const tail = this._tmpB.copy(parts[2].offset).applyQuaternion(q).add(p);
    const joints = dolphin.spine && dolphin.spine.joints;
    const fluke = joints && joints.length ? joints[joints.length - 1] : tail;
    this.airVelocity();
    let n = Math.min(60, Math.floor(this._shedAccum));
    this._shedAccum -= n;
    const pt = this._tmpC;
    while (n-- > 0) {
      const r = Math.random();
      if (r < 0.3) {
        pt.copy(fluke);
        pt.x += rand(-0.3, 0.3);
        pt.z += rand(-0.3, 0.3);
      } else if (r < 0.45) {
        const fin = parts[Math.random() < 0.5 ? 3 : 4];
        pt.copy(fin.offset).applyQuaternion(q).add(p);
      } else {
        pt.lerpVectors(head, tail, Math.random());
        pt.y -= rand(0.1, 0.25);
        pt.x += rand(-0.15, 0.15);
        pt.z += rand(-0.15, 0.15);
      }
      const keep = rand(0.9, 0.99);
      this._drop(
        pt.x,
        pt.y,
        pt.z,
        v.x * keep + rand(-0.3, 0.3),
        v.y * keep - rand(0.1, 0.6),
        v.z * keep + rand(-0.3, 0.3),
        surf,
        0,
        rand(0.002, 0.007),
        0.85,
        rand(0.8, 1.6)
      );
    }
  }

  update(dt, camera, fogColor, fogDensity, current) {
    this.scene.userData.renderHeight =
      window.innerHeight * Math.min(window.devicePixelRatio || 1, 1.5);
    this.sediment.update(dt, camera, fogColor, fogDensity, current);

    const env = this.env;
    if (!this._camInit) {
      this._camLast.copy(camera.position);
      this._camInit = true;
    }
    const cv = this._tmpA.copy(camera.position).sub(this._camLast).divideScalar(Math.max(dt, 1e-4));
    this._camLast.copy(camera.position);
    if (cv.length() > 160) cv.set(0, 0, 0);
    env.camVel.lerp(cv, 1 - Math.exp(-dt * 20));
    env.fogColor.copy(fogColor);
    env.fogDensity = fogDensity;
    env.horizonFog = TUNING.visuals.horizonFog;
    const camSurf = this.ocean ? this.ocean.getWaterHeight(camera.position.x, camera.position.z) : 0;
    env.surfaceY = camSurf;
    const camUnder = camera.position.y < camSurf;

    // Crown and skirt rims shed droplets while they rise.
    this.airVelocity();
    for (const s of this.sheets.sheets) {
      if (!s.active || s.shed === undefined) continue;
      const t = s.age;
      const apex = (s.rimSpeed * (1 + s.bias)) / 9.81;
      if (t > apex * 1.1) continue;
      s.shed += dt * (s.kind === 1 ? 500 : 900) * s.energy * (1 - t / (apex * 1.1));
      let n = Math.min(160, Math.floor(s.shed));
      s.shed -= n;
      const R0 = 0.3 + 0.22 * s.energy;
      const ex = Math.exp(-t * 2.8);
      const lean = s.kind === 1 ? 0.25 : 0.5;
      while (n-- > 0) {
        const a = Math.random() * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const along = ca * s.dx + sa * s.dz;
        const bias = 1 + s.bias * along;
        const Vr = s.rimSpeed * bias * rand(0.72, 1.28);
        const H = Math.max(0.05, Vr * t - 4.905 * t * t);
        const dH = Vr - 9.81 * t;
        const R = R0 + s.spread * bias * (1 - ex);
        const dR = s.spread * bias * 2.8 * ex;
        const rr = R + lean * H;
        // Elliptical crown: stretch along the axis.
        const across = sa * s.dx - ca * s.dz;
        const ox = (s.dx * along * s.aspect - s.dz * across) * rr;
        const oz = (s.dz * along * s.aspect + s.dx * across) * rr;
        const len = Math.hypot(ox, oz) || 1;
        const outV = dR + lean * Math.max(0, dH);
        this._drop(
          s.x + s.drift.x * t + ox,
          s.y + s.drift.y * t + H * rand(0.85, 1.05),
          s.z + s.drift.z * t + oz,
          s.drift.x + (ox / len) * outV * rand(0.8, 1.5) + rand(-0.3, 0.3),
          s.drift.y + Math.max(0, dH) * rand(0.6, 1.15) + rand(0, 0.8),
          s.drift.z + (oz / len) * outV * rand(0.8, 1.5) + rand(-0.3, 0.3),
          s.floorY,
          s.drift.y,
          dropSize(1.1)
        );
      }
    }
    this.sheets.update(dt, !camUnder);

    env.visible = !camUnder;
    this.drops.update(dt, env);
    this.mist.update(dt, env);
    env.visible = true;
    this.bubbles.update(dt, env);
    this.clouds.update(dt, env);
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
      uLight: { value: new THREE.Color(1, 1, 1) },
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
        uniform vec3 uLight;
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
          // A speck only shows the daylight that reaches it: bright in the
          // shallows, a dim blue fleck at depth (never a glowing orb).
          vec3 col = applyWaterFog(vColor * uLight, vDepth, uFogColor, uFogDensity);
          gl_FragColor = vec4(col, a * uUnderwater);
        }
      `,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.scene.add(this.points);
  }

  update(dt, camera, fogColor, fogDensity, underwater, light) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uCenter.value.copy(camera.position);
    this.uniforms.uFogColor.value.copy(fogColor);
    this.uniforms.uFogDensity.value = fogDensity;
    this.uniforms.uUnderwater.value = underwater;
    if (light) this.uniforms.uLight.value.copy(light);
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
      uLight: { value: new THREE.Color(1, 1, 1) },
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
        uniform vec3 uLight;
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
          // A speck only shows the daylight that reaches it: bright in the
          // shallows, a dim blue fleck at depth (never a glowing orb).
          vec3 col = applyWaterFog(vColor * uLight, vDepth, uFogColor, uFogDensity);
          gl_FragColor = vec4(col, a * 0.55 * uUnderwater);
        }
      `,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.scene.add(this.points);
  }

  update(dt, camera, fogColor, fogDensity, underwater, light) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uCenter.value.copy(camera.position);
    this.uniforms.uFogColor.value.copy(fogColor);
    this.uniforms.uFogDensity.value = fogDensity;
    this.uniforms.uUnderwater.value = underwater;
    if (light) this.uniforms.uLight.value.copy(light);
    this.uniforms.uScale.value = window.innerHeight * Math.min(window.devicePixelRatio || 1, 1.5) * 0.55;
    this.points.visible = underwater > 0.05;
  }
}
