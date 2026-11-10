import * as THREE from "three";
import { TUNING, PALETTE, SUN_DIRECTION } from "./config.js";
import {
  clamp,
  glslCaustics,
  glslFog,
  glslNoise,
  lerp,
  mulberry32,
  sandColor,
  seabedHeight,
  seabedNormal,
  smoothstep,
} from "./utils.js";

/**
 * Granular seabed.
 *
 * The height field is a real CPU simulation: material is carved by the body,
 * piled into a rim, then allowed to slump toward its angle of repose. It also
 * receives quiet pressure valleys from low glides. The same field is uploaded
 * as a floating-point texture and displaces the near-field sand mesh, so the
 * renderer and the physics see the same seabed.
 */
export class SandSimulation {
  constructor() {
    this.n = TUNING.sand.mapResolution;
    this.extent = TUNING.sand.mapExtent;
    this.cell = this.extent / (this.n - 1);
    this.heights = new Float32Array(this.n * this.n);
    this.scratch = new Float32Array(this.n * this.n);
    this.center = new THREE.Vector2(0, 0);
    this.dirty = true;
    this.simClock = 0;
    this.time = 0;
    this.visualHeights = new Float32Array(this.n * this.n);
    this.onSediment = null;
    this.onRipple = null;
    this.displacements = [];
    this.tempNormal = { x: 0, y: 1, z: 0 };

    // One-channel float texture; its data is the smoothed height field. This
    // avoids both RGBA padding and the previous/next texture copy that caused
    // visible stepping at the simulation rate.
    this.texture = new THREE.DataTexture(
      this.visualHeights,
      this.n,
      this.n,
      THREE.RedFormat,
      THREE.FloatType
    );
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
  }

  get cellSize() {
    return this.cell;
  }

  reset(centerX, centerZ) {
    this.center.set(centerX, centerZ);
    this.heights.fill(0);
    this.visualHeights.fill(0);
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  recenterIfNeeded(x, z) {
    const threshold = TUNING.sand.recenterDistance;
    const dx = x - this.center.x;
    const dz = z - this.center.y;
    if (Math.abs(dx) < threshold && Math.abs(dz) < threshold) return false;
    const shiftX = Math.abs(dx) > threshold ? Math.sign(dx) * Math.floor(Math.abs(dx) / this.cell) * this.cell : 0;
    const shiftZ = Math.abs(dz) > threshold ? Math.sign(dz) * Math.floor(Math.abs(dz) / this.cell) * this.cell : 0;
    const cx = Math.round(shiftX / this.cell);
    const cz = Math.round(shiftZ / this.cell);
    const n = this.n;
    this.scratch.fill(0);
    for (let y = 0; y < n; y++) {
      const sy = y - cz;
      if (sy < 0 || sy >= n) continue;
      for (let x0 = 0; x0 < n; x0++) {
        const sx = x0 - cx;
        if (sx < 0 || sx >= n) continue;
        this.scratch[y * n + x0] = this.heights[sy * n + sx];
      }
    }
    this.heights.set(this.scratch);
    this.center.x = Math.round((this.center.x + shiftX) / this.cell) * this.cell;
    this.center.y = Math.round((this.center.y + shiftZ) / this.cell) * this.cell;
    this.visualHeights.set(this.heights);
    this.texture.needsUpdate = true;
    this.dirty = false;
    return true;
  }

  /** Deposit or remove sand in a soft, directionally stretched stamp. */
  stamp(x, z, radius, depth, opts = {}) {
    const dirX = opts.dirX ?? 1;
    const dirZ = opts.dirZ ?? 0;
    const stretch = opts.stretch ?? 1.3;
    const rim = opts.rim ?? 1;
    const speed = opts.speed ?? 1;
    const crater = opts.crater ?? 0;
    const n = this.n;
    const cell = this.cell;
    const lx = (x - this.center.x) / cell + (n - 1) / 2;
    const lz = (z - this.center.y) / cell + (n - 1) / 2;
    const rr = Math.max(1.2, radius / cell);
    const extent = Math.ceil(rr * stretch) + 3;
    const x0 = Math.max(1, Math.floor(lx - extent));
    const x1 = Math.min(n - 2, Math.ceil(lx + extent));
    const y0 = Math.max(1, Math.floor(lz - extent));
    const y1 = Math.min(n - 2, Math.ceil(lz + extent));
    const shape = (gx, gy) => {
      const dx = gx - lx;
      const dz = gy - lz;
      const along = dx * dirX + dz * dirZ;
      const across = -dx * dirZ + dz * dirX;
      const d2 = (along * along) / (stretch * stretch) + across * across;
      const dn = Math.sqrt(d2) / rr;
      if (dn > 1.9) return 0;
      let add = 0;
      if (dn < 1.0) {
        const fall = Math.pow(1 - dn, crater ? 1.15 : 1.65);
        add -= depth * fall;
      }
      if (rim > 0 && dn > (crater ? 0.64 : 0.78) && dn < 1.55) {
        const ridge = Math.sin(((dn - (crater ? 0.64 : 0.78)) / (crater ? 0.91 : 0.77)) * Math.PI);
        const forwardBias = 0.78 + 0.42 * clamp(along / (rr * stretch) + 0.5, 0, 1);
        add += depth * rim * ridge * 0.42 * forwardBias;
      }
      // Loose grains under a fast fish-body wake scatter outward and thin.
      if (speed > 4 && dn > 0.2 && dn < 1.2) {
        add += depth * 0.045 * speed * 0.12;
      }
      return add;
    };

    // First pass: measure the displaced volume and the deposited rim volume.
    // The second pass normalises the rim so a contact pushes material aside
    // instead of silently creating or deleting sand.
    let removed = 0;
    let deposited = 0;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const add = shape(gx, gy);
        if (add < 0) removed -= add;
        else deposited += add;
      }
    }
    let positiveScale = deposited > 1e-7 ? removed / deposited : 0;
    let negativeScale = 1;
    const ejectaMax = TUNING.sand.ejectaScaleMax;
    if (positiveScale > ejectaMax) {
      // Leave the trench shallower rather than creating an absurdly tall
      // ejecta wall; the displaced volume is still conserved.
      negativeScale = (deposited * ejectaMax) / Math.max(removed, 1e-7);
      positiveScale = ejectaMax;
    }

    let displaced = 0;
    let deepest = 0;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        let add = shape(gx, gy);
        if (add > 0) add *= positiveScale;
        else if (add < 0) add *= negativeScale;
        if (add === 0) continue;
        const idx = gy * n + gx;
        const before = this.heights[idx];
        this.heights[idx] = clamp(
          before + add,
          -TUNING.sand.maxCutDepth,
          TUNING.sand.maxPileHeight
        );
        displaced += Math.abs(this.heights[idx] - before);
        if (add < 0) deepest = Math.max(deepest, -add);
      }
    }
    if (displaced > 0.0001) {
      this.dirty = true;
      if (this.onSediment && opts.notify !== false) {
        this.onSediment({ x, z, radius, amount: displaced, depth: deepest, speed });
      }
    }
    return displaced;
  }

  /**
   * Direct contact. A downward-swept nose, belly or fluke cuts a trench and
   * pushes a rim of material out to the sides.
   */
  plow(x, z, radius, depth, dirX, dirZ, speed = 1) {
    return this.stamp(x, z, radius, depth * TUNING.sand.interactionStrength, {
      dirX,
      dirZ,
      stretch: 1.45 + clamp(speed * 0.08, 0, 1.1),
      rim: 1.25,
      speed,
    });
  }

  /** A broad, violent fluke strike throws a crater and a high rim outward. */
  tailSlap(x, z, radius, depth, dirX, dirZ, speed = 1) {
    return this.stamp(x, z, radius, depth * TUNING.sand.interactionStrength, {
      dirX,
      dirZ,
      stretch: 1.08,
      rim: 1.9,
      speed,
      crater: 1,
    });
  }

  /** A fast body/nose impact: shallow, wide crater with a directional ejecta rim. */
  impact(x, z, radius, depth, dirX, dirZ, speed = 1) {
    return this.stamp(x, z, radius, depth * TUNING.sand.interactionStrength, {
      dirX,
      dirZ,
      stretch: 1.2,
      rim: 1.6,
      speed,
      crater: 1,
    });
  }

  /**
   * Indirect hydrodynamic contact. Low passes create a shallow pressure
   * valley and a kicked-up rooster tail without physically touching the sand.
   */
  glideTrail(x, z, radius, altitude, speed, dirX, dirZ, pulse = 1) {
    const strength = TUNING.sand.interactionStrength;
    const closeness = 1 - smoothstep(0.35, 6.0, altitude);
    const depth =
      TUNING.sand.glideDepth *
      strength *
      (0.25 + closeness * 1.8) *
      clamp(speed / 7, 0.2, 2.4) *
      clamp(pulse, 0.35, 1.7);
    this.stamp(x, z, radius, depth, {
      dirX,
      dirZ,
      stretch: 1.85,
      rim: 0.48,
      speed: speed * 0.25,
    });
    // A broader, shallower pressure wash travels with the body ahead of the
    // fluke trough. It is deliberately low amplitude and mass-conserving.
    if (closeness > 0.22) {
      this.stamp(x, z, radius * 1.55, depth * 0.18, {
        dirX,
        dirZ,
        stretch: 2.4,
        rim: 0.12,
        speed: speed * 0.12,
        notify: false,
      });
    }
    if (this.onRipple && closeness > 0.04) {
      this.onRipple({
        x,
        z,
        radius,
        strength: closeness * clamp(speed / 8, 0.2, 1.6) * clamp(pulse, 0.4, 1.5),
      });
    }
  }

  /**
   * Mass-conserving granular slumping toward the angle of repose. Material
   * leaves a cell only when the slope to a neighbour exceeds the repose angle,
   * then flows down all eight surrounding directions. No global shrinkage.
   */
  relax(dt) {
    const n = this.n;
    const h = this.heights;
    const s = this.scratch;
    s.set(h);
    const threshold = TUNING.sand.repose * this.cell;
    const rate = TUNING.sand.relaxation;
    const offsets = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, 0.707], [1, -1, 0.707], [-1, 1, 0.707], [-1, -1, 0.707],
    ];
    let moved = 0;

    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        const center = s[i];
        if (Math.abs(center) < 0.0004) continue;

        let lowest = center;
        let totalWeight = 0;
        for (let k = 0; k < 8; k++) {
          const j = (y + offsets[k][1]) * n + (x + offsets[k][0]);
          if (s[j] < lowest) lowest = s[j];
          const diff = center - s[j] - threshold;
          if (diff > 0) totalWeight += diff * offsets[k][2];
        }
        if (totalWeight <= 0.000001) continue;

        // Leave the high cell above its lowest neighbour; the remaining talus
        // will migrate on subsequent steps, giving a believable slump rate.
        const budget = Math.max(0, center - lowest - threshold) * rate;
        if (budget <= 0) continue;
        for (let k = 0; k < 8; k++) {
          const j = (y + offsets[k][1]) * n + (x + offsets[k][0]);
          const diff = center - s[j] - threshold;
          if (diff <= 0) continue;
          const flow = (budget * diff * offsets[k][2]) / totalWeight;
          h[i] -= flow;
          h[j] += flow;
          moved += flow;
        }
      }
    }
    if (moved > 0.00003) this.dirty = true;
    return moved;
  }

  update(dt, playerPos) {
    this.time += dt;
    this.recenterIfNeeded(playerPos.x, playerPos.z);
    const interval = 1 / TUNING.sand.textureUploadHz;
    this.simClock += dt;
    if (this.simClock >= interval) {
      this.simClock = 0;
      this.relax(interval);
    }

    // The visual sand chases the physical height field with an exponential
    // filter. This runs every rendered frame and removes the simulation-step
    // stutter without adding a full previous/next texture crossfade.
    const alpha = 1 - Math.exp(-TUNING.sand.visualResponse * dt);
    let changed = false;
    const h = this.heights;
    const v = this.visualHeights;
    for (let i = 0; i < v.length; i++) {
      const diff = h[i] - v[i];
      if (Math.abs(diff) > 1e-7) {
        v[i] += diff * alpha;
        changed = true;
      }
    }
    if (changed) this.texture.needsUpdate = true;
  }

  sampleDelta(x, z) {
    const n = this.n;
    const fx = (x - this.center.x) / this.cell + (n - 1) / 2;
    const fy = (z - this.center.y) / this.cell + (n - 1) / 2;
    if (fx < 0 || fy < 0 || fx >= n - 1 || fy >= n - 1) return 0;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const i = y0 * n + x0;
    const a = this.heights[i];
    const b = this.heights[i + 1];
    const c = this.heights[i + n];
    const d = this.heights[i + n + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
  }

  getSurfaceHeight(x, z) {
    return seabedHeight(x, z) + this.sampleDelta(x, z);
  }

  getSurfaceNormal(x, z) {
    const e = this.cell * 0.5;
    const base = seabedNormal(x, z, this.tempNormal);
    const dx = this.sampleDelta(x + e, z) - this.sampleDelta(x - e, z);
    const dz = this.sampleDelta(x, z + e) - this.sampleDelta(x, z - e);
    const nx = base.x - dx * 1.7;
    const ny = 1;
    const nz = base.z - dz * 1.7;
    const l = Math.hypot(nx, ny, nz) || 1;
    base.x = nx / l;
    base.y = ny / l;
    base.z = nz / l;
    return base;
  }
}

const SAND_VERT = /* glsl */ `
  precision highp float;
  attribute vec3 color;
  uniform sampler2D uSand;
  uniform vec2 uSandCenter;
  uniform float uSandExtent;
  uniform float uUseDelta;
  uniform vec3 uCameraPos;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying vec3 vViewDir;
  varying float vDelta;

  float sampleDelta(vec2 world) {
    if (uUseDelta < 0.5) return 0.0;
    vec2 uv = (world - uSandCenter) / uSandExtent + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return texture2D(uSand, uv).r;
  }

  void main() {
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    float d = sampleDelta(world.xz);
    world.y += d;

    vec3 n = normalize(mat3(modelMatrix) * normal);
    float e = 0.55;
    float dx = sampleDelta(world.xz + vec2(e, 0.0)) - sampleDelta(world.xz - vec2(e, 0.0));
    float dz = sampleDelta(world.xz + vec2(0.0, e)) - sampleDelta(world.xz - vec2(0.0, e));
    n = normalize(n + vec3(-dx * 1.75, 0.0, -dz * 1.75));

    vWorld = world;
    vNormal = n;
    vColor = color;
    vDelta = d;
    vViewDir = normalize(uCameraPos - world);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const SAND_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec3 uCameraPos;
  uniform float uCausticStrength;
  uniform float uUnderwater;
  uniform vec2 uHoleCenter;
  uniform float uHoleRadius;
  uniform float uHasHole;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying vec3 vViewDir;
  varying float vDelta;

  ${glslNoise}
  ${glslCaustics}
  ${glslFog}

  // Cellular caustic web: bright seams between drifting Voronoi cells. This
  // reads as the net of focused sunlight crossing a rippled surface.
  float causticWeb(vec2 p, float t) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 cell = n + g;
        float h1 = hash21(cell + 0.17);
        float h2 = hash21(cell + 7.71);
        vec2 o = 0.5 + 0.4 * vec2(sin(t * 0.4 + h1 * 6.283), cos(t * 0.33 + h2 * 6.283));
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) {
          d2 = d1;
          d1 = d;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    float edge = sqrt(d2) - sqrt(d1);
    return 1.0 - smoothstep(0.015, 0.16, edge);
  }

  void main() {
    // The coarse whole-shelf mesh has a hole under the dense local sand mesh.
    // Without it, the static base would poke through deep negative trenches
    // and hide the actual deformable surface.
    if (uHasHole > 0.5 && distance(vWorld.xz, uHoleCenter) < uHoleRadius) discard;
    vec3 n = normalize(vNormal);
    float dist = length(vWorld - uCameraPos);
    float height = vWorld.y;

    // Wind-aligned sand ripples, plus granular breakup.
    vec2 rp = vWorld.xz * 1.62 + vec2(uTime * 0.012, uTime * 0.005);
    float ripple = sin(dot(rp, vec2(0.72, 0.69)) * 3.0 + fbm2(rp * 0.6) * 4.5);
    float micro = fbm2(vWorld.xz * 11.0) - 0.5;
    float rippleGrad = cos(dot(rp, vec2(0.72, 0.69)) * 3.0 + fbm2(rp * 0.6) * 4.5) * 0.19;
    vec3 detailN = normalize(n + vec3(rippleGrad * 0.3, 0.0, rippleGrad * 0.19) + vec3(micro) * 0.055);
    float ndl = max(dot(detailN, uSunDir), 0.0);
    float ambient = 0.17 + 0.18 * smoothstep(-5.0, -24.0, height);

    float webA = causticWeb(vWorld.xz * 1.12 + vec2(uTime * 0.055, -uTime * 0.037), uTime);
    float webB = causticWeb(vWorld.xz * 1.57 - vec2(uTime * 0.031, uTime * 0.047), uTime * 1.17 + 13.0);
    float webMask = smoothstep(0.33, 0.76, fbm2(vWorld.xz * 0.11 + uTime * 0.006));
    float caustics = clamp(webA * 0.3 + webB * 0.14, 0.0, 0.6) * (0.25 + webMask * 1.1);
    float causticMask = smoothstep(-16.0, -1.4, height) * (0.4 + 0.6 * smoothstep(0.05, 0.9, detailN.y));
    vec3 causticTint = uSunColor * caustics * uCausticStrength * causticMask * 0.72;

    float grain = hash21(floor(vWorld.xz * 24.0) + floor(uTime * 0.7));
    float grainMask = smoothstep(0.93, 1.0, grain) * (0.15 + ndl * 0.4);

    float patches = fbm2(vWorld.xz * 0.27 + 4.1);
    float siltStain = smoothstep(0.55, 0.82, patches);
    vec3 sand = vColor;
    sand *= 0.29 + ndl * 0.52 + ambient * 0.18;
    sand += causticTint * vec3(0.82, 0.98, 0.76);
    sand += uSunColor * grainMask * 0.09;
    sand *= 0.76 + micro * 0.34 + (0.5 + 0.5 * ripple) * 0.07;
    sand *= 0.8 + patches * 0.34;

    // A scatter of shell hash, dark organic flecks and small pebbles. Close to
    // the lens this carries the seabed; farther out it fades before it aliases.
    float nearDetail = 1.0 - smoothstep(7.0, 34.0, dist);
    float shellPatch = smoothstep(0.35, 0.75, fbm2(vWorld.xz * 0.85 + 7.0));
    float shellHash = hash21(floor(vWorld.xz * 32.0) + vec2(17.0, 3.0));
    float shell = smoothstep(0.968, 1.0, shellHash) * nearDetail * shellPatch;
    float pebbleHash = hash21(floor(vWorld.xz * 12.0) + vec2(5.0, 11.0));
    float pebble = smoothstep(0.985, 1.0, pebbleHash) * nearDetail;
    float detritusHash = hash21(floor(vWorld.xz * 21.0) + vec2(9.0, 2.0));
    float detritus = smoothstep(0.989, 1.0, detritusHash) * nearDetail;
    sand = mix(sand, vec3(0.7, 0.65, 0.51) * (0.55 + ndl * 0.5), shell * 0.25);
    sand *= 1.0 - pebble * 0.12;
    sand = mix(sand, vec3(0.17, 0.15, 0.09), detritus * 0.28);
    sand = mix(sand, sand * vec3(0.56, 0.68, 0.48), siltStain * 0.24);

    // The water quickly eats warm wavelengths with depth.
    float absorb = smoothstep(2.0, 20.0, -height);
    sand = mix(sand, sand * vec3(0.45, 0.75, 0.7), absorb * 0.42);

    // Freshly pushed ridges catch light; damp furrows and caves read darker
    // and a little cooler.
    sand *= 1.0 - clamp(-vDelta * 0.3, 0.0, 0.34);
    sand += vec3(0.035, 0.028, 0.012) * clamp(vDelta * 1.3, 0.0, 0.26);

    vec3 halfV = normalize(uSunDir + vViewDir);
    float spec = pow(max(dot(detailN, halfV), 0.0), 32.0) * 0.05;
    sand += uSunColor * spec;

    // Water column absorption and depth fog.
    vec3 fog = applyWaterFog(sand, dist, uFogColor, uFogDensity);
    gl_FragColor = vec4(fog, 1.0);
  }
`;

class SandSurface {
  constructor(scene, sim, useDelta, extent, segments, center) {
    this.scene = scene;
    this.sim = sim;
    this.useDelta = useDelta;
    this.extent = extent;
    this.segments = segments;
    this.center = center.clone();
    this.material = this._makeMaterial(useDelta);
    this.mesh = this._makeMesh();
    this.scene.add(this.mesh);

    // Only the dense near mesh recenters. Rebuilding its 148k vertices on the
    // main thread produced a 200-300 ms stall every 34 m; the worker computes
    // the new static height/colour/normal buffers off-thread instead.
    this.worker = null;
    this.workerBusy = false;
    this.workerRequestId = 0;
    this.pendingCenter = null;
    if (useDelta) this._initWorker();
  }

  _initWorker() {
    try {
      this.worker = new Worker(new URL("./sand-worker.js", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = (event) => this._onWorkerMessage(event.data);
      this.worker.onerror = (error) => {
        console.warn("sand recenter worker failed; using synchronous rebuild", error);
        this.worker = null;
        this.workerBusy = false;
      };
      const positions = this.mesh.geometry.attributes.position.array.slice();
      const index = this.mesh.geometry.index.array.slice();
      this.worker.postMessage(
        {
          type: "init",
          segments: this.segments,
          extent: this.extent,
          positions,
          index,
        },
        [positions.buffer, index.buffer]
      );
    } catch (error) {
      console.warn("sand recenter worker unavailable; using synchronous rebuild", error);
      this.worker = null;
    }
  }

  requestRecenter(x, z) {
    if (!this.worker) {
      this.recenter(x, z);
      return;
    }
    this.pendingCenter = { x, z };
    if (!this.workerBusy) this._dispatchRecenter();
  }

  _dispatchRecenter() {
    if (!this.worker || !this.pendingCenter) return;
    const target = this.pendingCenter;
    this.pendingCenter = null;
    this.workerBusy = true;
    this.workerRequestId++;
    this.worker.postMessage({
      type: "recenter",
      id: this.workerRequestId,
      centerX: target.x,
      centerZ: target.z,
    });
  }

  _onWorkerMessage(message) {
    if (!message || message.type !== "recenter") return;
    if (message.id !== this.workerRequestId) return;
    this.workerBusy = false;
    const positions = this.mesh.geometry.attributes.position;
    const colors = this.mesh.geometry.attributes.color;
    const normals = this.mesh.geometry.attributes.normal;
    const positionArray = positions.array;
    for (let i = 0; i < message.heights.length; i++) {
      positionArray[i * 3 + 1] = message.heights[i];
    }
    positions.needsUpdate = true;
    colors.array.set(message.colors);
    colors.needsUpdate = true;
    normals.array.set(message.normals);
    normals.needsUpdate = true;

    this.center.set(message.centerX, message.centerZ);
    this.mesh.position.set(this.center.x, this.useDelta ? 0.025 : 0, this.center.y);
    this.mesh.updateMatrix();
    if (this.pendingCenter) this._dispatchRecenter();
  }

  _makeMaterial(useDelta) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSand: { value: this.sim.texture },
        uSandCenter: { value: this.sim.center },
        uSandExtent: { value: this.sim.extent },
        uUseDelta: { value: useDelta ? 1 : 0 },
        uSunDir: { value: new THREE.Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize() },
        uSunColor: { value: new THREE.Color(PALETTE.sunColor) },
        uFogColor: { value: new THREE.Color(PALETTE.fogDeep) },
        uFogDensity: { value: TUNING.visuals.underwaterDensity },
        uCameraPos: { value: new THREE.Vector3() },
        uCausticStrength: { value: TUNING.visuals.causticStrength },
        uUnderwater: { value: 1 },
        uHoleCenter: { value: new THREE.Vector2() },
        uHoleRadius: { value: 0 },
        uHasHole: { value: 0 },
      },
      vertexShader: SAND_VERT,
      fragmentShader: SAND_FRAG,
      fog: false,
    });
  }

  _makeMesh() {
    const segments = this.segments;
    const size = this.extent;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + this.center.x;
      const z = pos.getZ(i) + this.center.y;
      const y = seabedHeight(x, z);
      pos.setY(i, y);
      sandColor(x, z, y, c);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    if (this.useDelta) {
      // The worker replaces these buffers when the local window moves.
      for (const name of ["position", "color", "normal"]) {
        geo.attributes[name].setUsage(THREE.DynamicDrawUsage);
      }
    }
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(this.center.x, 0, this.center.y);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    return mesh;
  }

  recenter(x, z) {
    this.center.set(x, z);
    const pos = this.mesh.geometry.attributes.position;
    const colors = this.mesh.geometry.attributes.color;
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + this.center.x;
      const wz = pos.getZ(i) + this.center.y;
      const wy = seabedHeight(wx, wz);
      pos.setY(i, wy);
      sandColor(wx, wz, wy, c);
      colors.setXYZ(i, c.r, c.g, c.b);
    }
    pos.needsUpdate = true;
    colors.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.position.set(this.center.x, this.useDelta ? 0.025 : 0, this.center.y);
    this.mesh.updateMatrix();
  }

  update(camera, fogColor, fogDensity, time) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uCameraPos.value.copy(camera.position);
    u.uSand.value = this.sim.texture;
    u.uSandCenter.value.copy(this.sim.center);
    u.uSandExtent.value = this.sim.extent;
    u.uFogColor.value.copy(fogColor);
    u.uFogDensity.value = fogDensity;
    u.uCausticStrength.value = TUNING.visuals.causticStrength;
  }
}

export class Seabed {
  constructor(scene, camera) {
    this.scene = scene;
    this.sim = new SandSimulation();
    this.sim.reset(TUNING.world.start.x, TUNING.world.start.z);
    this.time = 0;

    // A low-resolution whole-shelf mesh is always present; the dense, dynamic
    // patch overlaps it. The base also follows the dynamic texture (at low
    // resolution) and sits slightly lower, so a deep trench cannot be hidden
    // by the static base surface poking through it.
    this.base = new SandSurface(scene, this.sim, false, TUNING.world.size, 260, new THREE.Vector2(0, 0));
    this.base.mesh.position.set(0, 0, 0);
    this.base.mesh.updateMatrix();
    this.base.material.uniforms.uHasHole.value = 1;
    this.base.material.uniforms.uHoleRadius.value =
      TUNING.sand.nearMeshExtent * 0.5 - 2;

    const nearCenter = new THREE.Vector2(TUNING.world.start.x, TUNING.world.start.z);
    this.near = new SandSurface(
      scene,
      this.sim,
      true,
      TUNING.sand.nearMeshExtent,
      TUNING.sand.nearMeshSegments,
      nearCenter
    );
    this.near.mesh.position.y = 0.025;
    this.near.mesh.updateMatrix();
    this.lodClock = 0;
    this.lastNearCenter = nearCenter.clone();

    this.tempColor = new THREE.Color();
    this.tempColor2 = new THREE.Color();
  }

  getSurfaceHeight(x, z) {
    return this.sim.getSurfaceHeight(x, z);
  }

  getSurfaceNormal(x, z) {
    return this.sim.getSurfaceNormal(x, z);
  }

  update(dt, player, camera, fogColor, fogDensity) {
    this.time += dt;
    this.sim.update(dt, player.position);
    this.base.update(camera, fogColor, fogDensity, this.time);
    this.base.material.uniforms.uHoleCenter.value.set(this.near.center.x, this.near.center.y);
    this.near.update(camera, fogColor, fogDensity, this.time);

    this.lodClock += dt;
    const recenter = TUNING.sand.recenterDistance;
    const nearX = this.near.center.x - player.position.x;
    const nearZ = this.near.center.y - player.position.z;
    if (nearX * nearX + nearZ * nearZ > recenter * recenter) {
      this.near.requestRecenter(
        Math.round(player.position.x / 20) * 20,
        Math.round(player.position.z / 20) * 20
      );
    }
  }

  plow(x, z, radius, depth, dirX, dirZ, speed) {
    return this.sim.plow(x, z, radius, depth, dirX, dirZ, speed);
  }

  tailSlap(x, z, radius, depth, dirX, dirZ, speed) {
    return this.sim.tailSlap(x, z, radius, depth, dirX, dirZ, speed);
  }

  impact(x, z, radius, depth, dirX, dirZ, speed) {
    return this.sim.impact(x, z, radius, depth, dirX, dirZ, speed);
  }

  glide(x, z, radius, altitude, speed, dirX, dirZ, pulse) {
    return this.sim.glideTrail(x, z, radius, altitude, speed, dirX, dirZ, pulse);
  }

  sampleDelta(x, z) {
    return this.sim.sampleDelta(x, z);
  }
}
