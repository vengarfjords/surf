import * as THREE from "three";
import { TUNING, PALETTE, SUN_DIRECTION } from "./config.js";
import {
  clamp,
  glslFog,
  glslNoise,
  lerp,
  mulberry32,
  sandColor,
  seabedHeight,
  seabedNormal,
  smoothstep,
} from "./utils.js";
import { GLSL_RIPPLES, SandSwell } from "./sand-swell.js";

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
    // Where contact has wiped out the swell's ripples (0 = ripples at their
    // natural height, 1 = flat). They grow back at the swell's pace.
    this.erase = new Float32Array(this.n * this.n);
    this.visualErase = new Float32Array(this.n * this.n);
    this.texData = new Float32Array(this.n * this.n * 2);
    // Rows changed since the texture was last sent to the GPU (texLo >
    // texHi: none); see flushTexture.
    this.texLo = this.n;
    this.texHi = -1;
    this.swell = null;
    this.smoothClock = 0;
    // Rows [rowMin, rowMax] that hold any dug, piled or wiped sand (rowMin >
    // rowMax: none). Settling, surge smoothing and the visual chase only
    // walk these rows: the marks are local, and walking all 384 rows
    // several times a frame cost a few ms on a flat bed.
    this.rowMin = this.n;
    this.rowMax = -1;
    this.onSediment = null;
    this.onRipple = null;
    this.displacements = [];
    this.tempNormal = { x: 0, y: 1, z: 0 };

    // Two-channel float texture: the smoothed height field and the ripple
    // erase. No previous/next texture copy, which caused visible stepping at
    // the simulation rate.
    this.texture = new THREE.DataTexture(
      this.texData,
      this.n,
      this.n,
      THREE.RGFormat,
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
    this.erase.fill(0);
    this.visualErase.fill(0);
    this.texData.fill(0);
    this.texture.needsUpdate = true;
    this.dirty = false;
    this.rowMin = this.n;
    this.rowMax = -1;
  }

  _markRows(y0, y1) {
    this.rowMin = Math.max(0, Math.min(this.rowMin, y0));
    this.rowMax = Math.min(this.n - 1, Math.max(this.rowMax, y1));
  }

  _packTexture() {
    const d = this.texData;
    const v = this.visualHeights;
    const e = this.visualErase;
    for (let i = 0, o = 0; i < v.length; i++, o += 2) {
      d[o] = v[i];
      d[o + 1] = e[i];
    }
    this.texture.needsUpdate = true;
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
    // The centre moved (cx, cz) cells: new cell (x, y) is old cell
    // (x + cx, y + cz). Each kept row moves as one block copy.
    const xa = Math.max(0, -cx);
    const xb = Math.min(n, n - cx);
    const ya = Math.max(0, -cz);
    const yb = Math.min(n, n - cz);
    const shiftField = (field) => {
      const s = this.scratch;
      s.fill(0);
      if (xb > xa) {
        for (let y = ya; y < yb; y++) {
          const from = (y + cz) * n + cx;
          s.set(field.subarray(from + xa, from + xb), y * n + xa);
        }
      }
      field.set(s);
    };
    shiftField(this.heights);
    shiftField(this.erase);
    this.center.x = Math.round((this.center.x + shiftX) / this.cell) * this.cell;
    this.center.y = Math.round((this.center.y + shiftZ) / this.cell) * this.cell;
    this.visualHeights.set(this.heights);
    this.visualErase.set(this.erase);
    this._packTexture();
    this.dirty = false;
    if (this.rowMin <= this.rowMax) {
      const lo = Math.max(0, this.rowMin - cz);
      const hi = Math.min(n - 1, this.rowMax - cz);
      this.rowMin = lo <= hi ? lo : n;
      this.rowMax = lo <= hi ? hi : -1;
    }
    return true;
  }

  /** Deposit or remove sand in a soft, directionally stretched stamp. */
  stamp(x, z, radius, depth, opts = {}) {
    const dirX = opts.dirX ?? 1;
    const dirZ = opts.dirZ ?? 0;
    const stretch = opts.stretch ?? 1.3;
    const rim = opts.rim ?? 1;
    // How much this stamp wipes the swell ripples (direct contact: fully;
    // a low glide's pressure wash: barely).
    const eraseScale = opts.erase ?? 1;
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
        const change = Math.abs(this.heights[idx] - before);
        displaced += change;
        // Disturbed sand loses its ripples.
        if (change > 0 && eraseScale > 0) {
          this.erase[idx] = Math.min(1, this.erase[idx] + (change * eraseScale) / TUNING.sandSwell.eraseDepth);
        }
        if (add < 0) deepest = Math.max(deepest, -add);
      }
    }
    if (displaced > 0) this._markRows(y0, y1);
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
      erase: 0.08,
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
        erase: 0,
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
    if (this.rowMin > this.rowMax) return 0;
    // Talus can spill one row past the marked band per step.
    const yA = Math.max(1, this.rowMin - 1);
    const yB = Math.min(n - 2, this.rowMax + 1);
    let touchA = n;
    let touchB = -1;

    for (let y = yA; y <= yB; y++) {
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
          if (y - 1 < touchA) touchA = y - 1;
          if (y + 1 > touchB) touchB = y + 1;
        }
      }
    }
    if (touchA <= touchB) this._markRows(touchA, touchB);
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
      this.smoothClock += interval;
      if (this.swell && this.smoothClock >= 0.1) {
        this.weather(this.smoothClock);
        this.smoothClock = 0;
      }
    }

    // The visual sand chases the physical height field with an exponential
    // filter. This runs every rendered frame and removes the simulation-step
    // stutter without adding a full previous/next texture crossfade.
    const alpha = 1 - Math.exp(-TUNING.sand.visualResponse * dt);
    // Ripples flatten over about a third of a second where sand is pushed,
    // instead of vanishing in a frame.
    const alphaErase = 1 - Math.exp(-3 * dt);
    const n = this.n;
    const h = this.heights;
    const v = this.visualHeights;
    const e = this.erase;
    const ve = this.visualErase;
    const tex = this.texData;
    // Outside the marked rows height and erase are zero and so is the
    // visual copy (recentering and reset sync them).
    let lo = n;
    let hi = -1;
    for (let y = this.rowMin; y <= this.rowMax; y++) {
      let changed = false;
      for (let i = y * n, end = i + n; i < end; i++) {
        const diff = h[i] - v[i];
        if (diff > 1e-7 || diff < -1e-7) {
          v[i] += diff * alpha;
          tex[i * 2] = v[i];
          changed = true;
        }
        const de = e[i] - ve[i];
        if (de > 1e-5 || de < -1e-5) {
          ve[i] += de * alphaErase;
          tex[i * 2 + 1] = ve[i];
          changed = true;
        }
      }
      if (changed) {
        if (y < lo) lo = y;
        hi = y;
      }
    }
    if (hi >= lo) {
      this.texLo = Math.min(this.texLo, lo);
      this.texHi = Math.max(this.texHi, hi);
    }
  }

  /**
   * Sends the rows of the texture that changed since the last upload to the
   * GPU, as one block, instead of the whole 1.2 MB texture every frame. The
   * sand meshes call it just before they draw.
   */
  flushTexture(renderer) {
    if (this.texHi < this.texLo) return;
    const lo = this.texLo;
    const hi = this.texHi;
    this.texLo = this.n;
    this.texHi = -1;
    const texture = this.texture;
    const props = renderer.properties.get(texture);
    // Not on the GPU yet, or a whole upload is due anyway (it reads the
    // same array, so it carries these rows too).
    if (!props.__webglTexture || props.__version !== texture.version) {
      texture.needsUpdate = true;
      return;
    }
    const gl = renderer.getContext();
    const state = renderer.state;
    state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
    state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    state.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    state.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    state.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    const n = this.n;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, lo, n, hi - lo + 1, gl.RG, gl.FLOAT, this.texData, lo * n * 2);
  }

  /**
   * What the swell does to the field between visits: surge rounds off
   * trenches and rims (mass-conserving diffusion, fast where the bed speed
   * is high), wiped ripples grow back, and breaking water wipes them.
   */
  weather(dt) {
    const sw = this.swell;
    const cfg = TUNING.sandSwell;
    const n = this.n;
    const h = this.heights;
    const e = this.erase;
    const s = this.scratch;
    const cell = this.cell;
    const fn = sw.flowN;
    const fCell = sw.flowCell;
    const fx0 = sw.flowCenter.x - sw.extentHalf();
    const fz0 = sw.flowCenter.y - sw.extentHalf();
    const ox = this.center.x - ((n - 1) / 2) * cell;
    const oz = this.center.y - ((n - 1) / 2) * cell;
    const regrow = dt / Math.max(1, cfg.regrowTime);
    const smoothK = (cfg.smoothRate * dt) / (cell * cell);
    const col = this._flowCol || (this._flowCol = new Int32Array(n));
    for (let x = 0; x < n; x++) {
      const fi = Math.floor((ox + x * cell - fx0) / fCell);
      col[x] = fi >= 0 && fi < fn ? fi : -1;
    }
    if (this.rowMin > this.rowMax) return 0;
    s.set(h);
    let moved = 0;
    let erased = false;
    // Diffusion reaches one row past the marked band per step.
    const yA = Math.max(1, this.rowMin - 1);
    const yB = Math.min(n - 2, this.rowMax + 1);
    let touchA = n;
    let touchB = -1;
    for (let y = yA; y <= yB; y++) {
      const wz = oz + y * cell;
      const fj = Math.floor((wz - fz0) / fCell);
      const rowOk = fj >= 0 && fj < fn;
      for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        const hc = s[i];
        const er = e[i];
        const quiet =
          Math.abs(hc) < 1e-4 &&
          Math.abs(s[i - 1]) < 1e-4 &&
          Math.abs(s[i + 1]) < 1e-4 &&
          Math.abs(s[i - n]) < 1e-4 &&
          Math.abs(s[i + n]) < 1e-4;
        let mobility = 0;
        const fi = col[x];
        if (rowOk && fi >= 0) mobility = sw.mobility[fj * fn + fi];
        if (er > 1e-4) {
          // Ripples need moving water to grow back. (Breakers are not wiped
          // in here: the field only covers the dense mesh, so a wipe ended
          // in a hard edge that jumped when the mesh recentered. Breaking
          // flattens ripples through the depth table instead.)
          const next = er * (1 - regrow * mobility);
          e[i] = next < 1e-4 ? 0 : next;
          erased = true;
        }
        if (quiet || mobility <= 0.02) continue;
        // Explicit diffusion; the step is far below the stability limit.
        const k = Math.min(0.2, smoothK * mobility * mobility);
        const lap = s[i - 1] + s[i + 1] + s[i - n] + s[i + n] - 4 * hc;
        const d = k * lap;
        if (d === 0) continue;
        h[i] += d;
        moved += Math.abs(d);
        if (y < touchA) touchA = y;
        if (y > touchB) touchB = y;
      }
    }
    if (touchA <= touchB) this._markRows(touchA, touchB);
    if (moved > 1e-5 || erased) this.dirty = true;
    return moved;
  }

  sampleErase(x, z) {
    const n = this.n;
    const fx = (x - this.center.x) / this.cell + (n - 1) / 2;
    const fy = (z - this.center.y) / this.cell + (n - 1) / 2;
    if (fx < 0 || fy < 0 || fx >= n - 1 || fy >= n - 1) return 0;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const i = y0 * n + x0;
    const e = this.erase;
    return lerp(lerp(e[i], e[i + 1], tx), lerp(e[i + n], e[i + n + 1], tx), ty);
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
    const h = this.heights;
    return lerp(lerp(h[i], h[i + 1], tx), lerp(h[i + n], h[i + n + 1], tx), ty);
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
  varying float vErase;
  varying float vBaseY;

  float sampleDelta(vec2 world) {
    if (uUseDelta < 0.5) return 0.0;
    vec2 uv = (world - uSandCenter) / uSandExtent + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return texture2D(uSand, uv).r;
  }
  float sampleErase(vec2 world) {
    if (uUseDelta < 0.5) return 0.0;
    vec2 uv = (world - uSandCenter) / uSandExtent + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return texture2D(uSand, uv).g;
  }

  void main() {
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    vBaseY = world.y;
    float d = sampleDelta(world.xz);
    float er = sampleErase(world.xz);
    world.y += d;
    vErase = er;

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
  varying float vErase;
  varying float vBaseY;

  ${glslNoise}
  ${glslFog}
  ${GLSL_RIPPLES}

  void main() {
    // The coarse whole-shelf mesh has a hole under the dense local sand mesh.
    // Without it, the static base would poke through deep negative trenches
    // and hide the actual deformable surface.
    // The hole is the dense mesh's square less a 3 m overlap, where the dense
    // mesh's ripple relief has already faded to nothing; a round hole left
    // its corners drawn twice, a few centimetres apart.
    // Only the coarse mesh is compiled with the hole: a shader that can
    // discard cannot have its hidden pixels skipped before shading (Apple's
    // GPUs shade every such pixel, even one the water covers later).
#ifdef SAND_HOLE
    vec2 holeD = abs(vWorld.xz - uHoleCenter);
    if (uHasHole > 0.5 && max(holeD.x, holeD.y) < uHoleRadius) discard;
#endif
    vec3 n = normalize(vNormal);
    float dist = length(vWorld - uCameraPos);
    float height = vWorld.y;

    // World size of one pixel here (the larger of the two screen axes, so
    // grazing views count too). Every pattern finer than about two pixels
    // fades to its mean instead of aliasing into lines and moire.
    vec2 wdx = dFdx(vWorld.xz);
    vec2 wdy = dFdy(vWorld.xz);
    float footprint = max(length(wdx), length(wdy));

    float micro = (fbmR(vWorld.xz * 11.0) - 0.5) * (1.0 - smoothstep(0.03, 0.08, footprint));

    // Swell ripples (sand-swell.js): ridges lying across the swell, as tall
    // as the bed speed at this depth allows, wiped where the dolphin has
    // disturbed the sand and growing back after. Sharp crests catch the
    // light, the broad troughs fall into shade.
    float ripEqHere = ripEq(-vBaseY) * uRipShape.w;
    float ripAmp = uRipShape.x * ripEqHere * ripPatch(vWorld.xz) * (1.0 - clamp(vErase, 0.0, 1.0));
    vec3 rip = ripples(vWorld.xz, ripAmp, wdx, wdy);
    vec3 detailN = normalize(n - vec3(rip.y, 0.0, rip.z) + vec3(micro) * 0.03);
    // Fine dark grains and shell grit settle in the troughs, the crests are
    // swept clean: a tone that follows the height of the ripple.
    float ripTone = ripAmp > 1e-4 ? clamp(rip.x / max(ripAmp, 1e-4), -0.35, 0.7) : 0.0;
    // How the ripple faces the light, relative to flat sand: the flank
    // toward the sun is lit, the lee flank falls into shade. The water
    // bends daylight steeply down, so a ripple reads from this and from the
    // shade in its trough rather than from long shadows.
    vec2 sunFlat = uSunDir.xz / 1.333;
    vec3 lightDir = vec3(sunFlat.x, sqrt(max(1.0 - dot(sunFlat, sunFlat), 0.0)), sunFlat.y);
    vec3 ripN = normalize(vec3(-rip.y, 1.0, -rip.z));
    // Light under water is soft: much of it is scattered, so no flank
    // falls into deep shade. The shading also eases off as the ripples get
    // small on screen (seen from high above or far off), where a pixel
    // averages a lit flank with a shaded one.
    float ripPix = max(max(abs(dot(wdx, uRipDir.xy)), abs(dot(wdy, uRipDir.xy))), 0.4 * footprint) * uRipK.x;
    float ripShadeK = mix(1.0, 0.6, smoothstep(0.2, 1.1, ripPix));
    float ripLit = clamp(1.0 + (dot(ripN, lightDir) / max(lightDir.y, 0.3) - 1.0) * 1.2 * ripShadeK, 0.7, 1.35);

    // Stirred sand: the cloud the surge lifts off the bed.
    vec4 flow = flowAt(vWorld.xz);
    float cloud = flow.b;
    float ndl = max(dot(normalize(n + vec3(micro) * 0.03), uSunDir), 0.0);
    float ambient = 0.17 + 0.18 * smoothstep(-5.0, -24.0, height);

    // Light focused by the wave groups overhead: broad, soft and slow. (The
    // net of bright lines is laid over every surface in post.)
    float webMask = smoothstep(0.33, 0.76, fbmR(vWorld.xz * 0.11 + uTime * 0.006));
    float caustics = 0.6 * (0.5 + webMask * 0.6);
    float causticMask = smoothstep(-16.0, -1.4, height) * (0.4 + 0.6 * smoothstep(0.05, 0.9, detailN.y));
    vec3 causticTint = uSunColor * caustics * uCausticStrength * causticMask * 0.72;

    float patches = fbmR(vWorld.xz * 0.27 + 4.1);
    vec3 sand = vColor;
    sand *= 0.29 + ndl * 0.52 + ambient * 0.18;
    sand += causticTint * vec3(0.82, 0.98, 0.76);
    sand *= 0.93 + micro * 0.12;
    // Under water most of the light comes from the bright window straight
    // overhead, so a flank that tilts away from it is dimmer whichever way
    // it faces: steep flanks either side of each crest read as dark lines
    // even when the sun runs along the crests.
    float ripSky = 1.0 + (pow(ripN.y, 2.0) - 1.0) * ripShadeK;
    sand *= ripLit * ripSky * (1.0 + ripTone * 0.2 * ripShadeK);
    // Sand is a mix of grains of different colours: a speckle at the scale
    // of grain clusters, fading to its mean before it is smaller than a
    // pixel.
    float speckA = (vnoise(vWorld.xz * 260.0) - 0.5) * (1.0 - smoothstep(0.0015, 0.004, footprint));
    float speckB = (vnoise(vWorld.xz * 70.0 + 3.0) - 0.5) * (1.0 - smoothstep(0.006, 0.016, footprint));
    float speckC = (vnoise(vWorld.xz * 19.0 + 7.0) - 0.5) * (1.0 - smoothstep(0.02, 0.06, footprint));
    sand *= 1.0 + speckA * 0.3 + speckB * 0.14 + speckC * 0.05;
    // Clean, sorted sand: only a faint broad shift in tone across the bed.
    sand *= 0.92 + patches * 0.16;

    // Sand hanging in the water over the bed veils it: a little paler and
    // flatter, lit like the bed under it (applied before the depth loss, so
    // a deep cloud is as dim as the deep sand).
    float veil = clamp(cloud * 0.35, 0.0, 0.25);
    float sandLum = dot(sand, vec3(0.333));
    sand = mix(sand, vec3(sandLum) * vec3(1.12, 1.06, 0.9) * 1.12, veil);

    // The water quickly eats warm wavelengths with depth.
    float absorb = smoothstep(2.0, 20.0, -height);
    sand = mix(sand, sand * vec3(0.45, 0.75, 0.7), absorb * 0.42);
    // Below the sunlit shelf the daylight itself runs out, the red and the
    // green first: the deep floor is dim and blue, whatever the lens does.
    float deepLoss = 1.0 - exp(-max(-height - 10.0, 0.0) * 0.045);
    sand *= mix(vec3(1.0), vec3(0.3, 0.52, 0.8), deepLoss);

    // Freshly pushed ridges catch light; damp furrows and caves read darker
    // and a little cooler.
    sand *= 1.0 - clamp(-vDelta * 0.3, 0.0, 0.34);
    sand += vec3(0.035, 0.028, 0.012) * clamp(vDelta * 1.3, 0.0, 0.26);

    vec3 halfV = normalize(uSunDir + vViewDir);
    // Wet sand is matte: a faint, broad sheen only.
    float spec = pow(max(dot(detailN, halfV), 0.0), 12.0) * 0.012;
    sand += uSunColor * spec * ripLit;

    // Water column absorption and depth fog.
    vec3 fog = applyWaterFog(sand, dist, uFogColor, uFogDensity);
    // Never hand a NaN or a huge value to the post chain (max/min drop NaN
    // on Metal): one bad pixel turns the whole bloomed frame black.
    gl_FragColor = vec4(min(max(fog, vec3(0.0)), vec3(16.0)), 1.0);
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
    this.targetCenter = this.center.clone();
    // The new window goes into a second, hidden copy of the mesh, a slice of
    // its 5 MB of vertex data per frame, and takes over once all of it is on
    // the GPU: sending it in one frame cost that frame several milliseconds.
    this.spare = null;
    this.uploadSteps = null;
    this.swapCenter = null;
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
        this.uploadSteps = null;
        this.swapCenter = null;
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
      this.spare = this._makeSpare();
    } catch (error) {
      console.warn("sand recenter worker unavailable; using synchronous rebuild", error);
      this.worker = null;
    }
  }

  // A second mesh over the same index and uv buffers, with its own position,
  // colour and normal buffers. Its material is invisible, but the renderer
  // still sends its changed buffers to the GPU every frame it is in the scene.
  _makeSpare() {
    const geo = this.mesh.geometry;
    const spareGeo = new THREE.BufferGeometry();
    spareGeo.setIndex(geo.index);
    for (const name of Object.keys(geo.attributes)) {
      const attr = geo.attributes[name];
      if (name === "position" || name === "color" || name === "normal") {
        const copy = new THREE.BufferAttribute(attr.array.slice(), attr.itemSize);
        copy.setUsage(THREE.DynamicDrawUsage);
        spareGeo.setAttribute(name, copy);
      } else {
        spareGeo.setAttribute(name, attr);
      }
    }
    this.hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });
    const spare = new THREE.Mesh(spareGeo, this.hiddenMaterial);
    spare.onBeforeRender = this.mesh.onBeforeRender;
    spare.matrixAutoUpdate = false;
    spare.frustumCulled = false;
    spare.receiveShadow = false;
    spare.renderOrder = this.mesh.renderOrder;
    this.scene.add(spare);
    return spare;
  }

  requestRecenter(x, z) {
    if (!this.worker) {
      this.recenter(x, z);
      return;
    }
    // Asked every frame until the new window is shown: ignore repeats of
    // the window already on its way.
    if (x === this.targetCenter.x && z === this.targetCenter.y) {
      this.pendingCenter = null;
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
    this.targetCenter.set(target.x, target.z);
    this.worker.postMessage({
      type: "recenter",
      id: this.workerRequestId,
      centerX: target.x,
      centerZ: target.z,
    });
  }

  _onWorkerMessage(message) {
    if (!message || message.type !== "recenter") return;
    if (message.id !== this.workerRequestId || !this.spare) return;
    const geo = this.spare.geometry;
    const attrs = [geo.attributes.position, geo.attributes.normal, geo.attributes.color];
    // The spare's old buffers go back to the worker for the next window.
    const old = {
      type: "recycle",
      positions: attrs[0].array,
      normals: attrs[1].array,
      colors: attrs[2].array,
    };
    attrs[0].array = message.positions;
    attrs[1].array = message.normals;
    attrs[2].array = message.colors;
    this.worker.postMessage(old, [old.positions.buffer, old.normals.buffer, old.colors.buffer]);
    // Two slices per buffer, one slice per frame.
    this.uploadSteps = [];
    for (const attr of attrs) {
      const half = Math.ceil(attr.count / 2) * attr.itemSize;
      this.uploadSteps.push([attr, 0, half], [attr, half, attr.array.length - half]);
    }
    this.swapCenter = { x: message.centerX, z: message.centerZ };
  }

  // One step of a pending window change per frame, before the frame renders.
  _advanceUpload() {
    if (!this.uploadSteps) return;
    const step = this.uploadSteps.shift();
    if (step) {
      const [attr, start, count] = step;
      attr.addUpdateRange(start, count);
      attr.needsUpdate = true;
      return;
    }
    // Every slice went out with an earlier frame: show the new window.
    const shown = this.mesh;
    this.mesh = this.spare;
    this.spare = shown;
    this.mesh.material = this.material;
    this.spare.material = this.hiddenMaterial;
    this.center.set(this.swapCenter.x, this.swapCenter.z);
    this.mesh.position.set(this.center.x, this.useDelta ? 0.025 : 0, this.center.y);
    this.mesh.updateMatrix();
    this.uploadSteps = null;
    this.swapCenter = null;
    this.workerBusy = false;
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
        ...this.sim.swell.uniforms(),
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
    // The first sand mesh drawn in a frame sends the texture's changed rows.
    mesh.onBeforeRender = (renderer) => this.sim.flushTexture(renderer);
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
    this._advanceUpload();
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
    // What the swell does to the bed: ripples, stirred sand, smoothing.
    this.swell = new SandSwell(this.sim);
    this.sim.swell = this.swell;
    this.ocean = null;
    this.time = 0;

    // A low-resolution whole-shelf mesh is always present; the dense, dynamic
    // patch overlaps it. The base also follows the dynamic texture (at low
    // resolution) and sits slightly lower, so a deep trench cannot be hidden
    // by the static base surface poking through it.
    this.base = new SandSurface(scene, this.sim, false, TUNING.world.size, 260, new THREE.Vector2(0, 0));
    this.base.mesh.position.set(0, 0, 0);
    this.base.mesh.updateMatrix();
    this.base.material.defines = { ...(this.base.material.defines || {}), SAND_HOLE: 1 };
    this.base.material.uniforms.uHasHole.value = 1;
    this.base.material.uniforms.uHoleRadius.value =
      TUNING.sand.nearMeshExtent * 0.5 - 3;

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
    if (this.ocean) this.swell.update(dt, this.ocean, player.position);
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
