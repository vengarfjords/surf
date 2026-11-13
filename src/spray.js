import * as THREE from "three";
import { PALETTE } from "./config.js";
import { glslNoise } from "./utils.js";
import { glslSky } from "./atmosphere.js";

/**
 * Photographic water particles and splash sheets.
 *
 * Droplets and bubbles are drawn as camera-space capsules stretched along
 * their motion during a short shutter, so fast spray reads as the fine
 * streaks a camera records instead of round dots. A droplet keeps its true
 * size: when it is smaller than a pixel it stays one pixel wide and its
 * opacity drops with its coverage. Mist and underwater aeration are soft,
 * evolving billboards. Everything is lit by the same sky as the sea.
 *
 * Physics is per particle on the CPU: gravity, quadratic air drag towards
 * the wind (droplets) or linear drag (mist, bubbles), and droplets die when
 * they fall back through the water they came from.
 */

const SHUTTER = 0.009;

const PARTICLE_VERT = /* glsl */ `
  precision highp float;
  attribute vec4 aA; // position, diameter (m)
  attribute vec4 aB; // velocity, alpha
  attribute vec4 aC; // seed, life fraction, spin, streak multiplier
  uniform vec2 uResolution;
  uniform float uShutter;
  uniform vec3 uCamVel;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uSurfaceY;
  uniform float uHorizonFog;
  varying vec2 vLocal;
  varying float vLen;
  varying float vRad;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vSeed;
  varying float vLife;
  ${glslNoise}
  ${glslSky}

  vec3 lightAbove(vec3 p, float mistiness) {
    vec3 vd = normalize(p - cameraPosition);
    vec3 hz = skyHorizonColor(vd, uSunDir);
    vec3 top = mix(SKY_MID, SKY_ZENITH, 0.35);
    // Fine droplets scatter light forward: spray between the camera and
    // the low sun glows; spray with the sun behind the camera is the grey
    // white of the overcast.
    float fwd = pow(max(dot(vd, uSunDir), 0.0), 3.0);
    // Drops pick up the brighter sky above them; fine mist scatters about
    // as much light as the sky behind it, so against the sky it nearly
    // vanishes and against the sea it is a pale veil.
    vec3 col = mix(mix(top, hz, 0.45) * 1.04, hz * 1.02, mistiness);
    col += SKY_HORIZON_SUN * fwd * (0.55 + 0.35 * mistiness);
    float dist = length(p - cameraPosition);
    float hzF = 1.0 - exp(-pow(dist * 0.00021 * uHorizonFog, 1.6));
    return mix(col, hz, clamp(hzF, 0.0, 0.95));
  }

  vec3 lightBelow(vec3 p) {
    // Light reaching a bubble falls off with depth below the surface and
    // takes the colour of the water on the way to the camera.
    float below = max(0.0, uSurfaceY - p.y);
    vec3 lit = mix(vec3(0.78, 0.96, 0.93), uFogColor * 1.9 + 0.04, smoothstep(0.0, 16.0, below));
    float dist = length(p - cameraPosition);
    float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    return mix(lit, uFogColor, clamp(f, 0.0, 1.0));
  }

  void main() {
    vec3 p0 = aA.xyz;
    float size = aA.w;
    vSeed = aC.x;
    vLife = aC.y;
    vec4 c0 = projectionMatrix * viewMatrix * vec4(p0, 1.0);
    if (c0.w < 0.1 || aB.w <= 0.0) {
      gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
      vAlpha = 0.0;
      return;
    }
    float pxPerM = projectionMatrix[1][1] * 0.5 * uResolution.y / c0.w;
    float radTrue = 0.5 * size * pxPerM;
    // Nothing is allowed to drift into the lens as a blurry disc.
    float nearFade = smoothstep(0.35, 1.6, c0.w);
#ifdef STREAK
    float rad = max(radTrue, 0.7);
    float cover = radTrue / rad;
    cover *= cover;
    // Streak relative to the camera, but only partly: nothing else in the
    // frame carries the camera's own motion blur.
    vec3 vel = aB.xyz - uCamVel * 0.5;
    vec3 p1 = p0 - vel * uShutter * aC.w;
    vec4 c1 = projectionMatrix * viewMatrix * vec4(p1, 1.0);
    if (c1.w < 0.1) c1 = c0;
    vec2 s0 = c0.xy / c0.w * 0.5 * uResolution;
    vec2 s1 = c1.xy / c1.w * 0.5 * uResolution;
    vec2 d = s0 - s1;
    float len = min(length(d), 220.0);
    vec2 dir = len > 0.001 ? normalize(d) : vec2(1.0, 0.0);
    s1 = s0 - dir * len;
    vec2 perp = vec2(-dir.y, dir.x);
    float along = mix(-rad - 1.0, len + rad + 1.0, position.x * 0.5 + 0.5);
    float across = position.y * (rad + 1.0);
    vec2 sp = s1 + dir * along + perp * across;
    float zf = clamp(along / max(len, 0.001), 0.0, 1.0);
    float z = mix(c1.z / c1.w, c0.z / c0.w, zf);
    gl_Position = vec4(sp / (0.5 * uResolution), z, 1.0);
    vLocal = vec2(along, across);
    vLen = len;
    vRad = rad;
    // A moving droplet spends only part of the exposure on each pixel of
    // its streak.
    // Energy is conserved for an unresolved drop (exponent 1); a drop large
    // enough to see keeps a little more of its streak, as it does on film
    // where the bright core of the trail clips.
    float spread = (2.0 * rad) / (2.0 * rad + len);
    float blur = pow(spread, mix(1.0, 0.55, smoothstep(0.7, 2.5, radTrue)));
    vAlpha = aB.w * cover * blur * nearFade;
#else
    float rad = max(radTrue, 1.0);
    float ang = aC.x * 6.2831 + aC.z * uTime;
    vec2 cs = vec2(cos(ang), sin(ang));
    vec2 q = position.xy;
    vec2 off = vec2(q.x * cs.x - q.y * cs.y, q.x * cs.y + q.y * cs.x) * rad;
    // Depth is taken half a radius toward the camera so a puff sitting on
    // the water is not sliced by it along a hard line.
    vec3 toCam = normalize(cameraPosition - p0);
    vec4 cz = projectionMatrix * viewMatrix * vec4(p0 + toCam * min(size * 0.5, c0.w * 0.5), 1.0);
    vec2 s0 = c0.xy / c0.w * 0.5 * uResolution + off;
    gl_Position = vec4(s0 / (0.5 * uResolution), clamp(cz.z / cz.w, -1.0, 1.0), 1.0);
    vLocal = q;
    vLen = 0.0;
    vRad = rad;
    vAlpha = aB.w * nearFade * smoothstep(0.8, 1.6, c0.w / max(size, 0.05)) * min(1.0, radTrue);
#endif
#ifdef UNDERWATER
    vColor = lightBelow(p0);
#else
  #ifdef MIST
    vColor = lightAbove(p0, 1.0);
  #elif defined(STREAK)
    // A drop too small to resolve shows no rim or core, only the light it
    // scatters: much like the haze it hangs in, never a dark fleck.
    vColor = lightAbove(p0, 1.0 - smoothstep(0.4, 2.5, radTrue));
  #else
    vColor = lightAbove(p0, 0.0);
  #endif
#endif
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vLocal;
  varying float vLen;
  varying float vRad;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vSeed;
  varying float vLife;
  ${glslNoise}
  void main() {
    if (vAlpha <= 0.002) discard;
    vec3 col = vColor;
    float alpha;
#ifdef STREAK
    float t = clamp(vLocal.x, 0.0, vLen);
    vec2 q = vec2(vLocal.x - t, vLocal.y);
    float d = length(q);
    float a = clamp(vRad + 0.5 - d, 0.0, 1.0);
    if (a <= 0.0) discard;
    float r = d / vRad;
    // Only drops several pixels across show their structure.
    float resolved = smoothstep(1.6, 5.0, vRad) * (1.0 - smoothstep(4.0, 30.0, vLen));
    vec2 hlP = q / vRad - vec2(-0.28, 0.32);
    float glint = resolved * smoothstep(0.32, 0.0, length(hlP));
  #ifdef BUBBLE
    // An air bubble in water: a silver rim from total internal reflection
    // around a clear core, and a small window highlight.
    float rim = smoothstep(0.5, 0.95, r);
    float shade = mix(0.85, 0.35 + 0.95 * rim, resolved);
    col = col * (0.75 + 0.5 * rim) + glint * 0.55;
    alpha = a * vAlpha * (shade + glint);
  #else
    // A water drop: the sky reflected in its rim, the darker sea refracted
    // through its middle, and a glint of the bright sky.
    float body = mix(1.0, 0.62 + 0.55 * smoothstep(0.35, 1.0, r), resolved);
    col = col * body + glint * vec3(1.0, 0.97, 0.93) * 0.55;
    alpha = a * vAlpha * mix(1.0, 0.8 + 0.2 * r, resolved);
  #endif
#else
    float r = length(vLocal);
    if (r > 1.0) discard;
    vec2 p = vLocal * 1.25 + vSeed * 37.0;
    float n = fbm2(p + vec2(vLife * 0.9, -vLife * 0.6));
    float n2 = vnoise(p * 3.3 - vec2(vLife * 1.4, vSeed * 9.0));
    float edge = r + (n - 0.5) * 0.75 + (n2 - 0.5) * 0.22;
    float shape = 1.0 - smoothstep(0.2, 0.95, edge);
    shape *= shape;
    col *= 0.9 + 0.2 * n2;
    alpha = shape * vAlpha;
  #ifdef UNDERWATER
    // A cloud of entrained air is a swarm of bubbles, not smoke: break it
    // into clumps and speckle it.
    float clumps = smoothstep(0.35, 0.75, fbm2(vLocal * 2.4 + vSeed * 11.0 + vLife * 0.6));
    float speck = smoothstep(0.62, 0.9, vnoise(vLocal * 22.0 + vSeed * 50.0));
    alpha *= 0.35 + 0.65 * clumps;
    col += speck * 0.25;
    alpha = min(1.0, alpha * (1.0 + speck * 1.5));
  #endif
#endif
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

const DEFAULT_WIND = { x: 0, y: 0, z: 0 };

/**
 * One pool of particles of one kind. `kind` is "drop", "mist", "bubble" or
 * "cloud" (underwater aeration).
 */
export class FluidParticles {
  constructor(scene, capacity, kind, options = {}) {
    this.kind = kind;
    this.capacity = capacity;
    this.count = 0;
    this.cursor = 0;
    this.time = 0;
    const f = () => new Float32Array(capacity);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.age = f();
    this.life = f();
    this.size = f();
    this.grow = f();
    this.drag = f();
    this.term = f();
    this.grav = f();
    this.wobble = f();
    this.alpha = f();
    this.seed = f();
    this.spin = f();
    this.stretch = f();
    this.floor = f();
    this.floorV = f();
    this.ceil = f();
    this.ax = f();
    this.ay = f();
    this.az = f();

    const base = new THREE.InstancedBufferGeometry();
    base.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)
    );
    base.setIndex([0, 1, 2, 0, 2, 3]);
    this.aA = new Float32Array(capacity * 4);
    this.aB = new Float32Array(capacity * 4);
    this.aC = new Float32Array(capacity * 4);
    this.attrA = new THREE.InstancedBufferAttribute(this.aA, 4).setUsage(THREE.DynamicDrawUsage);
    this.attrB = new THREE.InstancedBufferAttribute(this.aB, 4).setUsage(THREE.DynamicDrawUsage);
    this.attrC = new THREE.InstancedBufferAttribute(this.aC, 4).setUsage(THREE.DynamicDrawUsage);
    base.setAttribute("aA", this.attrA);
    base.setAttribute("aB", this.attrB);
    base.setAttribute("aC", this.attrC);
    base.instanceCount = 0;
    this.geometry = base;

    const defines = {};
    if (kind === "drop" || kind === "bubble") defines.STREAK = "";
    if (kind === "bubble") defines.BUBBLE = "";
    if (kind === "mist") defines.MIST = "";
    if (kind === "bubble" || kind === "cloud") defines.UNDERWATER = "";
    this.uniforms = {
      uResolution: { value: new THREE.Vector2(960, 540) },
      uShutter: { value: SHUTTER },
      uCamVel: { value: new THREE.Vector3() },
      uSunDir: { value: options.sunDir || new THREE.Vector3(0, 1, 0) },
      uTime: { value: 0 },
      uFogColor: { value: new THREE.Color(PALETTE.fogShallow) },
      uFogDensity: { value: 0.03 },
      uSurfaceY: { value: 0 },
      uHorizonFog: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = options.renderOrder ?? 4;
    scene.add(this.mesh);
  }

  /**
   * opts: x y z, vx vy vz, life, size (diameter m), grow (size multiplier
   * over life), drag (1/s, linear), terminal (m/s, quadratic air drag; 0
   * for none), gravity (m/s^2, signed, -9.81 falls), wobble, alpha, air
   * {x,y,z} (what drag relaxes towards), floor (surface y to die below, or
   * undefined), floorV (vertical speed of that surface), ceil (y to die
   * above: a bubble reaching the surface), stretch, spin.
   */
  spawn(o) {
    let i;
    if (this.count < this.capacity) {
      i = this.count++;
    } else {
      i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
    }
    this.px[i] = o.x;
    this.py[i] = o.y;
    this.pz[i] = o.z;
    this.vx[i] = o.vx ?? 0;
    this.vy[i] = o.vy ?? 0;
    this.vz[i] = o.vz ?? 0;
    this.age[i] = 0;
    this.life[i] = o.life ?? 1;
    this.size[i] = o.size ?? 0.004;
    this.grow[i] = o.grow ?? 1;
    this.drag[i] = o.drag ?? 0;
    this.term[i] = o.terminal ?? 0;
    this.grav[i] = o.gravity ?? 0;
    this.wobble[i] = o.wobble ?? 0;
    this.alpha[i] = o.alpha ?? 1;
    this.seed[i] = Math.random();
    this.spin[i] = o.spin ?? (Math.random() - 0.5) * 0.6;
    this.stretch[i] = o.stretch ?? 1;
    this.floor[i] = o.floor ?? -1e9;
    this.floorV[i] = o.floorV ?? 0;
    this.ceil[i] = o.ceil ?? 1e9;
    const air = o.air || DEFAULT_WIND;
    this.ax[i] = air.x;
    this.ay[i] = air.y;
    this.az[i] = air.z;
    return i;
  }

  _kill(i) {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.py[i] = this.py[last];
      this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.vz[i] = this.vz[last];
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
      this.size[i] = this.size[last];
      this.grow[i] = this.grow[last];
      this.drag[i] = this.drag[last];
      this.term[i] = this.term[last];
      this.grav[i] = this.grav[last];
      this.wobble[i] = this.wobble[last];
      this.alpha[i] = this.alpha[last];
      this.seed[i] = this.seed[last];
      this.spin[i] = this.spin[last];
      this.stretch[i] = this.stretch[last];
      this.floor[i] = this.floor[last];
      this.floorV[i] = this.floorV[last];
      this.ceil[i] = this.ceil[last];
      this.ax[i] = this.ax[last];
      this.ay[i] = this.ay[last];
      this.az[i] = this.az[last];
    }
    if (this.cursor > this.count) this.cursor = 0;
  }

  update(dt, env) {
    this.time += dt;
    const t = this.time;
    let i = 0;
    while (i < this.count) {
      const age = this.age[i] + dt;
      if (age >= this.life[i]) {
        this._kill(i);
        continue;
      }
      this.age[i] = age;
      let vx = this.vx[i];
      let vy = this.vy[i];
      let vz = this.vz[i];
      const ax = this.ax[i];
      const ay = this.ay[i];
      const az = this.az[i];
      let rx = vx - ax;
      let ry = vy - ay;
      let rz = vz - az;
      const term = this.term[i];
      if (term > 0) {
        // Quadratic drag, integrated implicitly so a drop flung off a
        // 70 m/s wave slows without overshooting.
        const k = 9.81 / (term * term);
        const s = 1 / (1 + k * Math.hypot(rx, ry, rz) * dt);
        rx *= s;
        ry *= s;
        rz *= s;
      }
      const drag = this.drag[i];
      if (drag > 0) {
        const s = Math.exp(-drag * dt);
        rx *= s;
        ry *= s;
        rz *= s;
      }
      vx = ax + rx;
      vy = ay + ry + this.grav[i] * dt;
      vz = az + rz;
      const wob = this.wobble[i];
      if (wob > 0) {
        const sd = this.seed[i] * 40;
        vx += Math.sin(t * 5.3 + sd) * wob * dt;
        vz += Math.cos(t * 4.7 + sd * 1.3) * wob * dt;
      }
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.px[i] += vx * dt;
      this.py[i] += vy * dt;
      this.pz[i] += vz * dt;
      const fv = this.floorV[i];
      this.floor[i] += fv * dt;
      if (this.py[i] < this.floor[i] && vy < fv) {
        this._kill(i);
        continue;
      }
      // Bubbles burst at the surface.
      if (this.py[i] > this.ceil[i]) {
        this._kill(i);
        continue;
      }
      i++;
    }

    const A = this.aA;
    const B = this.aB;
    const C = this.aC;
    const n = this.count;
    for (let j = 0; j < n; j++) {
      const lifeT = this.age[j] / this.life[j];
      const o = j * 4;
      A[o] = this.px[j];
      A[o + 1] = this.py[j];
      A[o + 2] = this.pz[j];
      A[o + 3] = this.size[j] * (1 + (this.grow[j] - 1) * Math.sqrt(lifeT));
      B[o] = this.vx[j];
      B[o + 1] = this.vy[j];
      B[o + 2] = this.vz[j];
      // Fade in over the first 6% of the life and out over the rest.
      const fadeIn = lifeT < 0.06 ? lifeT / 0.06 : 1;
      B[o + 3] = this.alpha[j] * fadeIn * Math.pow(1 - lifeT, 1.3);
      C[o] = this.seed[j];
      C[o + 1] = lifeT;
      C[o + 2] = this.spin[j];
      C[o + 3] = this.stretch[j];
    }
    this.geometry.instanceCount = n;
    if (n > 0) {
      this.attrA.clearUpdateRanges();
      this.attrB.clearUpdateRanges();
      this.attrC.clearUpdateRanges();
      this.attrA.addUpdateRange(0, n * 4);
      this.attrB.addUpdateRange(0, n * 4);
      this.attrC.addUpdateRange(0, n * 4);
      this.attrA.needsUpdate = true;
      this.attrB.needsUpdate = true;
      this.attrC.needsUpdate = true;
    }
    const u = this.uniforms;
    u.uTime.value = t;
    u.uResolution.value.copy(env.resolution);
    u.uCamVel.value.copy(env.camVel);
    u.uFogColor.value.copy(env.fogColor);
    u.uFogDensity.value = env.fogDensity;
    u.uSurfaceY.value = env.surfaceY;
    u.uHorizonFog.value = env.horizonFog;
    this.mesh.visible = n > 0 && (env.visible ?? true);
  }
}

// --------------------------------------------------------------------------
// Splash sheets: the crown thrown up around a body entering the water and
// the skirt of water that falls off a body leaving it. Each is a thin wall
// of water whose rim flies ballistically, tears into fingers, and is lit as
// a thin sheet: sky reflected at grazing angles, aqua light through it, and
// white where it is aerated.
// --------------------------------------------------------------------------

const SHEET_VERT = /* glsl */ `
  precision highp float;
  uniform vec3 uOrigin;
  uniform vec3 uDrift;
  uniform vec2 uAxis;
  uniform vec4 uShape;  // energy, age, seed, kind (0 crown, 1 skirt)
  uniform vec4 uShape2; // aspect, forward bias, rim speed, spread
  varying vec3 vWorld;
  varying vec2 vSheet; // angle (rad), height fraction
  varying float vRimH;
  ${glslNoise}
  void main() {
    float ang = uv.x * 6.2831853;
    float v = uv.y;
    vec2 radial = vec2(cos(ang), sin(ang));
    vec2 perpAxis = vec2(-uAxis.y, uAxis.x);
    float along = dot(radial, uAxis);
    float E = uShape.x;
    float t = uShape.y;
    float seed = uShape.z;
    float bias = 1.0 + uShape2.y * along;
    float R0 = 0.3 + 0.22 * E;
    float R = R0 + uShape2.w * bias * (1.0 - exp(-t * 2.8));
    // Rim speed varies around the crown, and the rim breaks into fingers.
    float lump = vnoise(vec2(ang * 2.2 + seed * 7.0, seed));
    float Vr = uShape2.z * bias * (0.72 + 0.56 * lump);
    float H = max(0.0, Vr * t - 4.905 * t * t);
    float fing = vnoise(vec2(ang * 6.0 + seed * 3.0, 1.7 + seed));
    float fing2 = vnoise(vec2(ang * 17.0 + seed * 5.0, 4.1));
    float fing3 = vnoise(vec2(ang * 41.0 + seed * 2.0, 7.3));
    float rimH = H * (0.55 + 0.45 * fing * fing + 0.3 * fing2 * fing2 + 0.18 * fing3);
    float lean = uShape.w > 0.5 ? 0.25 : 0.5;
    float y = rimH * v;
    float rr = R * (0.86 + 0.14 * v) + lean * rimH * v * v;
    vec2 off = (uAxis * dot(radial, uAxis) * uShape2.x + perpAxis * dot(radial, perpAxis)) * rr;
    vec3 world = uOrigin + uDrift * t + vec3(off.x, y - 0.06, off.y);
    vWorld = world;
    vSheet = vec2(ang, v);
    vRimH = rimH;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const SHEET_FRAG = /* glsl */ `
  precision highp float;
  uniform vec4 uShape;
  uniform vec3 uSunDir;
  uniform vec3 uTopColor;
  uniform float uLife;
  varying vec3 vWorld;
  varying vec2 vSheet;
  varying float vRimH;
  ${glslNoise}
  ${glslSky}
  void main() {
    if (vRimH < 0.02) discard;
    float ang = vSheet.x;
    float v = vSheet.y;
    float t = uShape.y;
    float seed = uShape.z;
    float lifeT = clamp(t / uLife, 0.0, 1.0);

    vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    vec3 V = normalize(cameraPosition - vWorld);
    if (dot(N, V) < 0.0) N = -N;
    float cosT = clamp(dot(N, V), 0.0, 1.0);
    float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 hz = skyHorizonColor(normalize(R + vec3(0.0, 0.0001, 0.0)), uSunDir);
    vec3 sky = mix(hz, mix(SKY_MID, SKY_ZENITH, 0.4), smoothstep(0.05, 0.8, R.y));
    vec3 ambient = mix(SKY_HORIZON_AWAY, SKY_MID, 0.5);
    // Light through a sheet a few millimetres thick: barely tinted, and
    // glowing when it stands between the camera and the low sun.
    float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
    vec3 through = mix(ambient * 0.95, uTopColor * 1.25 * ambient + 0.04, 0.45);
    through += SKY_HORIZON_SUN * back * 0.7;

    // Aeration: clumps of white water in a clear sheet, more of them near
    // the torn rim and as the sheet ages.
    float clump = vnoise(vec2(ang * 9.0 + seed * 11.0, v * 2.6 - t * 1.4));
    clump = clump * 0.6 + vnoise(vec2(ang * 23.0 + seed * 3.0, v * 5.0 - t * 2.4)) * 0.28
      + vnoise(vec2(ang * 61.0, v * 11.0 + seed)) * 0.12;
    float aer = smoothstep(0.38, 0.72, clump * 0.8 + v * 0.3 + lifeT * 0.2);
    vec3 white = mix(ambient, hz, 0.4) * 1.1 + SKY_HORIZON_SUN * back * 0.35;

    vec3 col = mix(through, sky, fres);
    col = mix(col, white, aer);

    // The sheet tears from the rim down as it falls, and leaves holes.
    float holes = fbm2(vec2(ang * 5.0 + seed * 13.0, v * 2.4 - t * 1.2));
    float tearAt = mix(-0.25, 1.0, smoothstep(0.15, 0.95, lifeT));
    float keep = smoothstep(tearAt, tearAt + 0.14, holes + (1.0 - v) * 0.3);
    // The rim ends in fingers, each throwing off drops.
    float fingers = vnoise(vec2(ang * 7.0 + seed * 3.0, 0.5)) * 0.7 + vnoise(vec2(ang * 19.0 + seed, 2.5)) * 0.3;
    float rimLine = 0.5 + 0.5 * fingers;
    float rim = 1.0 - smoothstep(rimLine - 0.12, rimLine, v);
    // Near its top the sheet has already broken into ligaments.
    float lig = vnoise(vec2(ang * 70.0 + seed * 9.0, v * 1.5 - t));
    rim *= mix(1.0, smoothstep(0.25, 0.6, lig), smoothstep(rimLine - 0.35, rimLine - 0.1, v) * 0.8);
    float baseFade = smoothstep(0.0, 0.15, v);
    float clearA = 0.12 + 0.55 * fres;
    float alpha = mix(clearA, 0.62, aer) * keep * rim * baseFade;
    alpha *= 1.0 - smoothstep(0.75, 1.0, lifeT);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

export class SplashSheets {
  constructor(scene, sunDir, count = 8) {
    this.sheets = [];
    const geometry = new THREE.PlaneGeometry(1, 1, 120, 10);
    for (let i = 0; i < count; i++) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uOrigin: { value: new THREE.Vector3() },
          uDrift: { value: new THREE.Vector3() },
          uAxis: { value: new THREE.Vector2(1, 0) },
          uShape: { value: new THREE.Vector4() },
          uShape2: { value: new THREE.Vector4(1, 0, 3, 1) },
          uSunDir: { value: sunDir },
          uTopColor: { value: new THREE.Color(PALETTE.waterTop) },
          uLife: { value: 1 },
        },
        vertexShader: SHEET_VERT,
        fragmentShader: SHEET_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      mesh.visible = false;
      scene.add(mesh);
      this.sheets.push({ mesh, age: 0, life: 0, active: false, rimSpeed: 0, spread: 0, energy: 0, aspect: 1, bias: 0, kind: 0, x: 0, y: 0, z: 0, dx: 0, dz: 0, drift: new THREE.Vector3() });
    }
  }

  /**
   * kind 0: crown around an entry. kind 1: skirt falling off a body that
   * leaves the water, stretched along its axis.
   */
  spawn({ x, y, z, energy, dirX = 1, dirZ = 0, kind = 0, aspect = 1, bias = 0.35, drift }) {
    let s = this.sheets.find((q) => !q.active);
    if (!s) s = this.sheets.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    const len = Math.hypot(dirX, dirZ) || 1;
    s.active = true;
    s.age = 0;
    s.kind = kind;
    s.energy = energy;
    s.aspect = aspect;
    s.bias = bias;
    s.x = x;
    s.y = y;
    s.z = z;
    s.dx = dirX / len;
    s.dz = dirZ / len;
    s.rimSpeed = kind === 1 ? 1.0 + 1.1 * energy : 1.5 + 1.7 * energy;
    s.spread = kind === 1 ? 0.3 + 0.4 * energy : 0.45 + 0.6 * energy;
    s.life = (2 * s.rimSpeed * (1 + bias) * 1.28) / 9.81 + 0.15;
    s.seed = Math.random() * 10;
    if (drift) s.drift.copy(drift);
    else s.drift.set(0, 0, 0);
    const u = s.mesh.material.uniforms;
    u.uOrigin.value.set(x, y, z);
    u.uDrift.value.copy(s.drift);
    u.uAxis.value.set(s.dx, s.dz);
    u.uShape2.value.set(aspect, bias, s.rimSpeed, s.spread);
    u.uLife.value = s.life;
    s.mesh.visible = true;
    return s;
  }

  update(dt, visible) {
    for (const s of this.sheets) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.active = false;
        s.mesh.visible = false;
        continue;
      }
      s.mesh.material.uniforms.uShape.value.set(s.energy, s.age, s.seed, s.kind);
      s.mesh.visible = visible;
    }
  }
}
