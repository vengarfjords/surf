import { TUNING } from "../config.js";
import { clamp, seabedHeight, smoothstep } from "../utils.js";
import { applyPreset, buildSpectrum } from "./spectrum.js";
import { bakePhaseDelay } from "./bathymetry.js";

const G = 9.81;
const RHO = 1025;

/**
 * CPU-authoritative surface. The exact same component data is uploaded to the
 * vertex shader, so the height read here is the height the renderer draws
 * (modulo mesh interpolation). Everything is SI: metres, seconds, kg.
 *
 * The surface is a sum of Gerstner waves:
 *   eta(p,t) = sum A_i sin(k_i . p - omega_i t + phase_i)
 *   D(p,t)   = sum Q A_i d_i cos(...)
 *   P        = p + D, y = eta
 * Because the rendered grid is displaced horizontally, a world-space query
 * has to invert D with a few fixed-point iterations. The shader receives the
 * same Q, so both sides agree.
 */
/**
 * Face phase of a skewed wave (WaveField.sampleSurface): the linear phase
 * fp = t - pi/2 is remapped piecewise so the leaning crest
 * (t = pi/2 + asin s) reads 0, the trough reads +-pi, and the short front
 * face spans 0..pi. Mirrored in the vertex shader.
 */
export function skewPhase(fp, s) {
  if (!(s > 0)) return fp;
  const a = Math.asin(s);
  const front = Math.PI - 2 * a;
  // Phase after the crest, in [0, 2 pi).
  let d = fp - a;
  d -= 2 * Math.PI * Math.floor(d / (2 * Math.PI));
  let mapped = d < front ? (d * Math.PI) / front : Math.PI + ((d - front) * Math.PI) / (2 * Math.PI - front);
  if (mapped > Math.PI) mapped -= 2 * Math.PI;
  return mapped;
}

export class WaveField {
  constructor(cfg = TUNING.water, bathy = null) {
    this.time = 0;
    this.lastSample = {};
    this.bathy = bathy;
    this._depthScratch = {};
    this._megaD = {};
    this._megaS = {};
    this.megaCrestMod = 0;
    this.megaIndex = 0;
    this.megaSpeed = 0;
    // Start in the configured sea state with all of its settings.
    if (cfg.preset) applyPreset(cfg, cfg.preset);
    this.rebuild(cfg);
  }

  get config() {
    return TUNING.water;
  }

  rebuild(cfg = TUNING.water) {
    const { components, chop, stats } = buildSpectrum(cfg);
    this.components = components;
    this.count = components.length;
    this.chop = chop;
    this.stats = stats;
    this.maxCrest = stats.amplitudeSum;
    // Components are ordered swell first; the per-wave breaking envelope is
    // read from the swell train only (the wind sea is too short and steep to
    // define a coherent breaker).
    this.swellCount = stats.swellComponents;

    const n = this.count;
    this.kx = new Float64Array(n);
    this.kz = new Float64Array(n);
    this.amp = new Float64Array(n);
    this.omega = new Float64Array(n);
    this.phase0 = new Float64Array(n);
    this.dirX = new Float64Array(n);
    this.dirZ = new Float64Array(n);
    this.k = new Float64Array(n);
    this.phase = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const c = components[i];
      this.kx[i] = c.kx;
      this.kz[i] = c.kz;
      this.amp[i] = c.amp;
      this.omega[i] = c.omega;
      this.phase0[i] = c.phase0;
      this.dirX[i] = c.dx;
      this.dirZ[i] = c.dz;
      this.k[i] = c.k;
    }

    // Dominant swell component: used for phase-speed and direction readouts.
    let peak = null;
    for (const c of components) {
      if (c.layer !== 0) continue;
      if (!peak || c.amp > peak.amp) peak = c;
    }
    this.peak = peak;
    this.peakIndex = peak ? components.indexOf(peak) : -1;
    this.peakK = peak ? peak.k : 1;
    this.peakKx = peak ? peak.kx : 1;
    this.peakKz = peak ? peak.kz : 0;
    this.peakOmega = peak ? peak.omega : 1;
    this.peakPhase = peak ? peak.phase0 : 0;
    this.peakDirX = peak ? peak.dx : 1;
    this.peakDirZ = peak ? peak.dz : 0;
    this.bakeDelay();
    this.setTime(this.time);
  }

  /** Re-integrate the shoaling phase delay for the current peak and depth mode. */
  bakeDelay() {
    if (!this.bathy) return false;
    return bakePhaseDelay(
      this.bathy,
      this.peakK,
      this.peakDirX,
      this.peakDirZ,
      !!TUNING.water.depthResponse
    );
  }

  /**
   * Refraction focusing over the big-wave reef canyon. Long-period swell
   * bends over the canyon walls and converges on the reef, so wave height
   * builds over the last few hundred metres up-swell of the reef and peaks
   * on its centre line, falling off to the shoulders. A heightfield cannot
   * refract, so this is applied as a smooth amplitude gain on top of Green's
   * law (mirrored in the vertex shader and the foam field).
   */
  focusAt(x, z) {
    const cfg = TUNING.water;
    if (!cfg.depthResponse || !(cfg.reefFocus > 0)) return 1;
    const ox = x - cfg.surfZoneX;
    const oz = z - cfg.surfZoneZ;
    const s = ox * this.peakDirX + oz * this.peakDirZ;
    const c = -ox * this.peakDirZ + oz * this.peakDirX;
    const along = smoothstep(-cfg.reefFocusReach, -30, s) * (1 - smoothstep(150, 360, s));
    if (along <= 0) return 1;
    const sigma = cfg.reefFocusCross;
    return 1 + cfg.reefFocus * along * Math.exp(-(c * c) / (2 * sigma * sigma));
  }

  /** Local depth, finite-depth wavenumber scale and Green's-law shoaling. */
  depthState(x, z, out = this._depthScratch) {
    const cfg = TUNING.water;
    // The mega wave raises the water column: the swell riding on it is in
    // deep water and does not shoal or break on the shelf underneath.
    const stillDepth = this.bathy ? Math.max(0.3, this.bathy.sampleDepth(x, z)) : 18;
    const megaH = TUNING.water.megaWave ? this.megaAt(x, z, this._megaD).h : 0;
    const depth = stillDepth + megaH;
    out.megaH = megaH;
    if (!cfg.depthResponse) {
      out.depth = depth;
      out.ratio = 1;
      out.shoal = 1;
      out.shoalRaw = 1;
      out.breakMask = 0;
      out.x0 = this.peakK * depth;
      out.delay = 0;
      out.gradX = 0;
      out.gradZ = 0;
      out.chopScale = 1;
      out.skew = 0;
      return out;
    }
    const x0 = Math.max(1e-4, this.peakK * depth);
    // Approximate solution of k tanh(k h) = k0: k/k0 = 1/sqrt(tanh(k0 h)).
    // Exact in deep water and within a few percent of the finite-depth root
    // in the shoaling band used here.
    const ratio = clamp(1 / Math.sqrt(Math.tanh(x0)), 0.65, 4.5);
    const focus = this.focusAt(x, z);
    const shoalRaw =
      clamp(Math.pow(cfg.shoalReference / depth, cfg.shoalStrength), 0.5, 3.2) * focus;
    const hsLocal = this.stats.height * shoalRaw;
    const breakMask = smoothstep(
      cfg.breakRatio - cfg.breakSoftness,
      cfg.breakRatio + cfg.breakSoftness,
      hsLocal / depth
    );
    // Once breaking, the height cannot keep growing; saturate near H/h.
    // Broken water keeps at least `breakFloor` m of significant height (at
    // most 0.55 of the offshore sea): a storm sea must not be held at half
    // its offshore height over a 5 m shoal, where its troughs would cut
    // into the sand.
    const hs = Math.max(0.3, this.stats.height);
    const cap = (cfg.breakRatio * depth) / hs;
    const floor = Math.min(0.55, (cfg.breakFloor ?? 2.4) / hs);
    const shoal = Math.min(shoalRaw, Math.max(floor, cap * 1.05));
    out.depth = depth;
    out.ratio = ratio;
    out.shoal = shoal;
    out.shoalRaw = shoalRaw;
    out.breakMask = breakMask;
    // Front-face steepening. A shoaling wave pitches forward long before it
    // breaks: the face shortens and steepens while the back stretches out.
    // Grows from about a third of breaking depth to the break line.
    out.skew =
      (cfg.faceSkew || 0) *
      smoothstep(cfg.breakRatio * 0.3, cfg.breakRatio * 0.95, hsLocal / depth);
    out.x0 = x0;
    // Shoaling phase delay and its gradient (along the travel direction).
    out.delay = this.bathy ? this.bathy.sampleDelay(x, z) : 0;
    out.gradX = (ratio - 1) * this.peakDirX;
    out.gradZ = (ratio - 1) * this.peakDirZ;
    // Gerstner crests may not loop. The global Q is sized for deep water;
    // over the bank each component is `shoal` taller and `ratio` shorter, so
    // the local steepness grows by shoal*ratio. Ease Q back by its square
    // root: crests still sharpen as they shoal, but the surface stays single
    // valued under big groundswell. Mirrored in the vertex shader.
    out.chopScale = Math.pow(Math.max(1, shoal * ratio), -0.75);
    return out;
  }

  setPreset(name) {
    const ok = applyPreset(TUNING.water, name);
    if (ok) this.rebuild(TUNING.water);
    return ok;
  }

  /** Advance the shared, deterministic phase clock. */
  setTime(t) {
    this.time = t;
    const n = this.count;
    for (let i = 0; i < n; i++) {
      this.phase[i] = this.phase0[i] - this.omega[i] * t;
    }
    this.peakPhaseNow = this.peakIndex >= 0 ? this.phase[this.peakIndex] : 0;
    // Mega wave train: crest 0 sits at megaSpeed * t along the travel
    // direction from the surf-zone origin. Kept as (position mod L, crest
    // index) so the GPU sees small, precise numbers at any sim time.
    const cfg = TUNING.water;
    const L = Math.max(100, cfg.megaWavelength || 3000);
    this.megaSpeed = Math.sqrt(9.81 * ((cfg.megaDepthRef || 40) + (cfg.megaHeight || 0)));
    const crest = this.megaSpeed * t;
    this.megaIndex = Math.floor(crest / L);
    this.megaCrestMod = crest - this.megaIndex * L;
  }

  /**
   * Mega wave train: every wave 500 m+. Each crest is a sech^2 hump of
   * height H_n (megaHeight, each crest up to megaVariation taller, with a
   * gentle along-crest modulation), `megaFront` metres wide ahead of the
   * crest and `megaBack` behind it, so the face is short and steep and the
   * back long. Crests are megaWavelength apart and the troughs sit near
   * still-water level, so the shelf never drains. Height-only (no horizontal
   * displacement); evaluated at the parameter-space point like the rest of
   * the field so the GPU mirrors it exactly (vertex shader `mega`).
   * Returns the height, its slope along the travel direction, and the
   * signed distance ahead of the nearest crest and that crest's height.
   */
  megaAt(x, z, out = this._megaS) {
    out.h = 0;
    out.ds = 0;
    out.xi = 0;
    out.H = 0;
    const cfg = TUNING.water;
    if (!cfg.megaWave || !(cfg.megaHeight > 0)) return out;
    const ox = x - cfg.surfZoneX;
    const oz = z - cfg.surfZoneZ;
    const s = ox * this.peakDirX + oz * this.peakDirZ;
    const c = -ox * this.peakDirZ + oz * this.peakDirX;
    const L = Math.max(100, cfg.megaWavelength);
    const d = s - this.megaCrestMod;
    const n0 = Math.floor(d / L);
    let best = Infinity;
    for (let n = n0 - 1; n <= n0 + 2; n++) {
      const xi = d - n * L;
      const lam = xi > 0 ? cfg.megaFront : cfg.megaBack;
      // Crest identity: crest positions are crest - (megaIndex - n) L, so
      // n - megaIndex stays fixed for a physical crest when megaCrestMod wraps.
      const g = n - this.megaIndex;
      const Hn =
        cfg.megaHeight *
        (1 + cfg.megaVariation * (0.5 + 0.5 * Math.sin(g * 2.39996 + 0.7))) *
        (1 + cfg.megaLateral * Math.sin(c / 700 + g * 1.3));
      const a = Math.min(20, Math.abs(xi) / lam);
      const ch = Math.cosh(a);
      const sech2 = 1 / (ch * ch);
      out.h += Hn * sech2;
      out.ds -= (2 * Hn * sech2 * Math.tanh(a) * Math.sign(xi)) / lam;
      if (Math.abs(xi) < Math.abs(best)) {
        best = xi;
        out.H = Hn;
      }
    }
    out.xi = best;
    return out;
  }

  /**
   * A spawn point in the trough `lead` seconds ahead of the next mega crest,
   * on the line through the world centre along the travel direction, as far
   * up-wave as the world allows so the ride that follows is long. Returns
   * { x, z, heading, wait } (wait: seconds until the face arrives).
   */
  megaSpawn(lead = 12, limit = 1350) {
    const cfg = TUNING.water;
    const dx = this.peakDirX;
    const dz = this.peakDirZ;
    const L = Math.max(100, cfg.megaWavelength);
    // Mega coordinate of the world centre.
    const s0 = -(cfg.surfZoneX * dx + cfg.surfZoneZ * dz);
    const ahead = this.megaSpeed * lead;
    // Crest positions are megaCrestMod + n L. Take the last crest whose
    // spawn point is still on the up-wave half of the line.
    const target = s0 - 0.1 * limit;
    const n = Math.floor((target - ahead - this.megaCrestMod) / L);
    const crest = this.megaCrestMod + n * L;
    const sigma = Math.max(-limit, crest + ahead - s0);
    return {
      x: dx * sigma,
      z: dz * sigma,
      heading: Math.atan2(dx, dz),
      wait: (sigma + s0 - crest) / Math.max(1, this.megaSpeed),
    };
  }

  /** Raw parameter-space height (no horizontal inversion). */
  heightAtParameter(px, pz, delay = 0, shoal = 1) {
    let h = 0;
    const kx = this.kx;
    const kz = this.kz;
    const k = this.k;
    const amp = this.amp;
    const phase = this.phase;
    const windShoal = Math.min(1, shoal);
    for (let i = 0; i < this.count; i++) {
      const swell = i < this.swellCount;
      h +=
        amp[i] *
        (swell ? shoal : windShoal) *
        Math.sin(kx[i] * px + kz[i] * pz + (swell ? k[i] * delay : 0) + phase[i]);
    }
    return h;
  }

  /**
   * Invert the Gerstner horizontal displacement. Three iterations converge
   * sub-centimetre for the steepness range used here; the shader never needs
   * this because it starts from parameter space.
   */
  invert(x, z, out, delay = 0, shoal = 1, chopScale = 1) {
    // Two fixed-point iterations of p = world - D(p). With the shader using
    // the same horizontal displacement this converges to millimetre parity
    // for the wave steepness range here, and is ~4x cheaper than Newton.
    let px = x;
    let pz = z;
    const kx = this.kx;
    const kz = this.kz;
    const k = this.k;
    const amp = this.amp;
    const phase = this.phase;
    const q = this.chop * chopScale;
    const windShoal = Math.min(1, shoal);
    const swellCount = this.swellCount;
    for (let iter = 0; iter < 2; iter++) {
      let dx = 0;
      let dz = 0;
      for (let i = 0; i < this.count; i++) {
        const swell = i < swellCount;
        const c =
          Math.cos(kx[i] * px + kz[i] * pz + (swell ? k[i] * delay : 0) + phase[i]) *
          amp[i] *
          (swell ? shoal : windShoal) *
          q;
        dx += c * this.dirX[i];
        dz += c * this.dirZ[i];
      }
      px = x - dx;
      pz = z - dz;
    }
    out.px = px;
    out.pz = pz;
    return out;
  }

  /** Surface height at world x/z, including shoaling and the breaker lip. */
  sampleHeight(x, z) {
    return this.sampleSurface(x, z, _height).height;
  }

  /**
   * Surface height, analytic normal, Jacobian and slopes at world x/z.
   * `out` is reused to keep per-frame queries allocation-free.
   */
  sampleSurface(x, z, out = {}) {
    const state = this.depthState(x, z, _depth);
    const inv = _inv;
    this.invert(x, z, inv, state.delay, state.shoal, state.chopScale);
    // The renderer samples bathymetry at the undisplaced parameter position,
    // so resolve the inversion once more with the depth at that position.
    const state1 = this.depthState(inv.px, inv.pz, _depthP);
    this.invert(x, z, inv, state1.delay, state1.shoal, state1.chopScale);
    const px = inv.px;
    const pz = inv.pz;
    const stateP = this.depthState(px, pz, _depthP);
    const ratio = stateP.ratio;
    const shoal = stateP.shoal;
    const breakMask = stateP.breakMask;
    const delay = stateP.delay;
    const gX = stateP.gradX;
    const gZ = stateP.gradZ;
    const kx = this.kx;
    const kz = this.kz;
    const kk = this.k;
    const amp = this.amp;
    const phase = this.phase;
    const q = this.chop * stateP.chopScale;
    let h = 0;
    let dhdx = 0;
    let dhdz = 0;
    let dDxdx = 0;
    let dDzdz = 0;
    let dDxdz = 0;
    let swellH = 0;
    let swellSx = 0;
    let swellSz = 0;
    const swellCount = this.swellCount;
    // Only the swell feels the reef. The wind sea is short (kh >> 1 over the
    // reef top), so it neither shoals nor slows: it rides the giant swell at
    // its own height instead of being focused into steep whitecapped chop.
    const windShoal = Math.min(1, shoal);
    for (let i = 0; i < this.count; i++) {
      const swell = i < swellCount;
      // Local wavevector: the component's own, stretched along the travel
      // direction by the shoaling delay gradient.
      const kxL = swell ? kx[i] + kk[i] * gX : kx[i];
      const kzL = swell ? kz[i] + kk[i] * gZ : kz[i];
      const arg = kx[i] * px + kz[i] * pz + (swell ? kk[i] * delay : 0) + phase[i];
      const s = Math.sin(arg);
      const c = Math.cos(arg);
      const a = amp[i] * (swell ? shoal : windShoal);
      h += a * s;
      dhdx += a * kxL * c;
      dhdz += a * kzL * c;
      if (i === swellCount - 1) {
        swellH = h;
        swellSx = dhdx;
        swellSz = dhdz;
      }
      const ha = a * q;
      dDxdx -= ha * kxL * kxL * s;
      dDzdz -= ha * kzL * kzL * s;
      dDxdz -= ha * kxL * kzL * s;
    }

    // Forward-pitched face. A shoaling wave pitches forward long before it
    // breaks: the face shortens and stands up while the back stretches out.
    // From the same single-wave reading (A, t) as the breaking logic below
    // (A sin t is the swell height, A cos t its slope over k), the swell's
    // sine is replaced by the skewed series
    //   sin t - s sin 2t / 2 + s^2 sin 3t / 3 - ... = atan2(s sin t, 1 + s cos t) / s,
    // which is a sine at s = 0 and tends to a sawtooth with a vertical front
    // as s -> 1. The front face is 1 / (1 - s) times steeper than the sine,
    // the crest leans forward to t = pi/2 + asin(s), and the surface stays
    // single valued for s < 1. Height-only, so the CPU inversion is
    // unchanged. `skewPhase` remaps the face phase so 0 is still the visible
    // crest and pi/2 the middle of the (now shorter) front face. Mirrored in
    // the vertex shader.
    let skewS = 0;
    const kLocalPeak = this.peakK * ratio;
    if (stateP.skew > 0 && this.peak) {
      const dirPX = this.peak.dx;
      const dirPZ = this.peak.dz;
      const C = (swellSx * dirPX + swellSz * dirPZ) / kLocalPeak;
      const A = Math.sqrt(Math.max(0.0004, swellH * swellH + C * C));
      const hsLocal = Math.max(0.05, this.stats.height * shoal);
      skewS = Math.min(0.95, stateP.skew * smoothstep(0.25, 0.7, (2 * A) / hsLocal));
      if (skewS > 1e-3) {
        const sn = swellH / A;
        const cs = C / A;
        const denom = 1 + 2 * skewS * cs + skewS * skewS;
        h += (A / skewS) * Math.atan2(skewS * sn, 1 + skewS * cs) - swellH;
        const dSkew = (A * (skewS + cs)) / denom - C;
        dhdx += dSkew * kLocalPeak * dirPX;
        dhdz += dSkew * kLocalPeak * dirPZ;
      } else skewS = 0;
    }

    // Peak-crest phase drives a small forward breaker lip and the whitewater
    // history. A heightfield cannot overhang; this is the local proxy.
    const peakArg = this.peakKx * px + this.peakKz * pz + this.peakK * delay + this.peakPhaseNow;
    const peakKxL = this.peakKx + this.peakK * gX;
    const peakKzL = this.peakKz + this.peakK * gZ;
    const lipPhase = peakArg - 0.55;
    const lipSin = Math.sin(lipPhase);
    const lipAmp = breakMask * TUNING.water.breakerLip * this.stats.height * shoal * (1 - skewS);
    const lip = lipAmp * Math.max(0, lipSin) ** 2;
    h += lip;
    if (lipSin > 0) {
      const dLip = lipAmp * 2 * lipSin * Math.cos(lipPhase);
      dhdx += dLip * peakKxL;
      dhdz += dLip * peakKzL;
    }

    const crest = 0.5 + 0.5 * Math.sin(peakArg);

    // Per-wave breaking. `breakMask` above is the static surf-zone potential
    // (it also shapes the rendered lip, so it must stay identical on the GPU).
    // Whether *this* wave is breaking *here, now* comes from the local swell
    // envelope: eta = A sin(phi), d(eta)/ds = A k cos(phi) along the travel
    // direction, so A and phi are recovered from the swell height and slope.
    // Bigger waves in a set break first, smaller ones roll through, and the
    // whitewater bore rides on each crest's front face instead of covering the
    // whole bank as a steady current.
    // The envelope and face phase are defined everywhere (the camera and the
    // scenarios read them on open-water swell too); breaking needs the mask.
    let breaking = 0;
    let facePhase = 0;
    let envelope = 0;
    if (this.peak) {
      const kLocal = this.peakK * ratio;
      const slopeAlong = (swellSx * this.peak.dx + swellSz * this.peak.dz) / kLocal;
      envelope = Math.hypot(swellH, slopeAlong);
      // 0 at the crest, +pi/2 halfway down the front face, -pi/2 on the back.
      facePhase = skewPhase(Math.atan2(-slopeAlong, swellH), skewS);
    }
    if (breakMask > 0.001 && this.peak) {
      const hsLocal = Math.max(0.05, this.stats.height * shoal);
      const waveSize = smoothstep(0.32, 0.62, (2 * envelope) / hsLocal);
      // The roller sits on the upper face; the lower face ahead of it stays
      // green water, which is where a wave is actually surfed.
      const onFront = smoothstep(-0.45, 0.05, facePhase) * (1 - smoothstep(0.8, 1.5, facePhase));
      breaking = breakMask * waveSize * onFront;
    }
    // Mega wave train on top of everything else. It sets the face phase,
    // size and speed the camera, ride logic and scenarios read, since it is
    // the wave being surfed whenever it is up.
    let megaH = 0;
    let megaDs = 0;
    let megaCrestH = 0;
    let phaseSpeed = this.stats.peakPhaseSpeed / ratio;
    if (TUNING.water.megaWave) {
      const m = this.megaAt(px, pz, this._megaS);
      megaH = m.h;
      megaDs = m.ds;
      h += megaH;
      dhdx += megaDs * this.peakDirX;
      dhdz += megaDs * this.peakDirZ;
      megaCrestH = m.H;
      if (m.H > 0) {
        const cfg = TUNING.water;
        const L = Math.max(100, cfg.megaWavelength);
        const frontSpan = 2.5 * cfg.megaFront;
        facePhase =
          m.xi >= 0
            ? Math.PI * Math.min(1, m.xi / frontSpan)
            : -Math.PI * Math.min(1, -m.xi / Math.max(1, L - frontSpan));
        envelope = Math.max(envelope, 0.5 * megaH);
        phaseSpeed = this.megaSpeed;
      }
    }
    const noise =
      0.5 +
      0.5 *
        Math.sin(px * 0.63 + pz * 0.87 + this.time * 0.41) *
        Math.sin(px * 0.29 - pz * 0.43 - this.time * 0.27);
    const foamLag =
      0.5 + 0.5 * Math.sin(peakArg - TUNING.water.foamPersistence * 1.6);
    const foamCrest = Math.max(crest, foamLag * TUNING.water.foamPersistence);
    // Aeration lives in the bore. The trailing foam is the advected foam field
    // (ocean.sampleWater*), so between bores the water is solid again and a
    // resting animal floats instead of slowly sinking through froth.
    const aerationSource = breaking;
    const aeration =
      aerationSource *
      (0.35 + 0.5 * noise) *
      (0.4 + 0.6 * foamCrest) *
      TUNING.water.aerationAmount;

    // Tangent vectors of the displaced surface, then normal = tz x tx.
    const txX = 1 + dDxdx;
    const txY = dhdx;
    const txZ = dDxdz;
    const tzX = dDxdz;
    const tzY = dhdz;
    const tzZ = 1 + dDzdz;
    let nx = tzY * txZ - tzZ * txY;
    let ny = tzZ * txX - tzX * txZ;
    let nz = tzX * txY - tzY * txX;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    out.height = h;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    out.slopeX = dhdx;
    out.slopeZ = dhdz;
    out.slope = Math.hypot(dhdx, dhdz);
    out.jacobian = txX * tzZ - tzX * txZ;
    out.parameterX = px;
    out.parameterZ = pz;
    out.depth = state.depth;
    out.depthRatio = ratio;
    out.delay = delay;
    out.gradX = gX;
    out.gradZ = gZ;
    out.shoal = shoal;
    out.shoalRaw = state.shoalRaw;
    out.breakMask = breakMask;
    out.breaking = breaking;
    out.facePhase = facePhase;
    out.envelope = envelope;
    out.aeration = clamp(aeration, 0, 0.85);
    out.turbulence = Math.max(breaking, breakMask * 0.15) * (0.5 + 0.5 * noise);
    out.phaseSpeed = phaseSpeed;
    out.megaH = megaH;
    out.megaDs = megaDs;
    out.megaCrestH = megaCrestH;
    out.stillDepth = state.depth - state.megaH;
    out.wavelength = this.stats.peakWavelength / ratio;
    out.crest = crest;
    out.peakArg = peakArg;
    out.x0 = stateP.x0;
    // Iribarren classification: spilling / plunging / surging.
    if (breakMask > 0.02 && this.bathy) {
      const tanBeta = this.bathy.sampleSlope(px, pz);
      const xi = tanBeta / Math.sqrt(Math.max(0.01, this.stats.height / this.stats.peakWavelength));
      out.xi = xi;
      out.breakerType = xi < 0.5 ? 0 : xi < 3.3 ? 1 : 2;
    } else {
      out.xi = 0;
      out.breakerType = -1;
    }
    return out;
  }

  /**
   * Full physical sample at a 3D point. Orbital velocity and dynamic pressure
   * use the finite-depth cosh/sinh form with the local wavenumber from the
   * bathymetry; a breaker jet is added near an aerated crest.
   */
  sample(x, y, z, out = {}) {
    return this._sample(x, y, z, out, true);
  }

  /** Same as sample(), without the fBm seabed lookup. Hull panels call this
   *  hundreds of times per substep and only need surface/flow/force data. */
  sampleForForces(x, y, z, out = {}) {
    return this._sample(x, y, z, out, false);
  }

  _sample(x, y, z, out, includeSeabed) {
    const surf = this.sampleSurface(x, z, _surf);
    const h = surf.height;
    const depthBelowSurface = Math.min(0, y - h);
    const ratio = surf.depthRatio;
    const depth = surf.depth;
    const shoal = surf.shoal;
    const kx = this.kx;
    const kz = this.kz;
    const k = this.k;
    const amp = this.amp;
    const omega = this.omega;
    const phase = this.phase;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let ax = 0;
    let ay = 0;
    let az = 0;
    let pressure = 0;
    const windShoal = Math.min(1, shoal);
    const swellCount = this.swellCount;
    for (let i = 0; i < this.count; i++) {
      const swell = i < swellCount;
      const kL = swell ? k[i] * ratio : k[i];
      const arg =
        kx[i] * surf.parameterX + kz[i] * surf.parameterZ + (swell ? k[i] * surf.delay : 0) + phase[i];
      const s = Math.sin(arg);
      const c = Math.cos(arg);
      const w = omega[i];
      const a = amp[i] * (swell ? shoal : windShoal);
      const kh = Math.max(1e-4, kL * depth);
      // cosh(k(z+h))/sinh(kh) etc., written in decaying exponentials so deep
      // water (kh >> 1) stays finite: both terms are <= 1 and the ratios tend
      // to exp(k z) instead of overflowing when kh is large.
      const e2kh = Math.exp(-2 * kh);
      const eUp = Math.exp(kL * depthBelowSurface);
      const eDown = Math.exp(-kL * (depthBelowSurface + 2 * depth));
      const uF = (eUp + eDown) / (1 - e2kh);
      const wF = (eUp - eDown) / (1 - e2kh);
      const pF = (eUp + eDown) / (1 + e2kh);
      // eta = a sin(theta): u = omega a sin(theta), w = -omega a cos(theta).
      const horizontal = w * a * uF * s;
      vx += horizontal * this.dirX[i];
      vz += horizontal * this.dirZ[i];
      vy -= w * a * wF * c;
      const accel = -w * w * a * uF * c;
      ax += accel * this.dirX[i];
      az += accel * this.dirZ[i];
      ay -= w * w * a * wF * s;
      pressure += RHO * G * a * pF * s;
    }

    // Mega wave: a long wave over the depth hb, so its flow is depth
    // uniform. Mass conservation for a permanent-form wave moving at c gives
    // u = c eta / (hb + eta) along the travel direction (near c under the
    // crest, still water in the trough) and, from continuity, a vertical
    // velocity growing linearly from the seabed that meets the kinematic
    // surface condition exactly. The pressure is hydrostatic, so the hull
    // sees the face as a slope to slide down; pressure += rho g eta makes
    // the hull's Wheeler-stretched dynamic term vanish for this part.
    let megaFk = 0;
    let megaFkY = 0;
    if (surf.megaH > 0) {
      const eta = surf.megaH;
      // The train's own reference depth (the one its speed is set by), not
      // the local shelf: one consistent long wave, no bathymetry speckle.
      const hb = Math.max(1, TUNING.water.megaDepthRef);
      const col = hb + eta;
      const c = this.megaSpeed;
      const u = (c * eta) / col;
      // Slope along the travel direction and du/ds.
      const etaS = surf.megaDs;
      const duds = ((c * hb) / (col * col)) * etaS;
      const zb = clamp(y + hb, 0, col);
      const wM = -zb * duds;
      const aS = (u - c) * duds;
      vx += u * this.peakDirX;
      vz += u * this.peakDirZ;
      vy += wM;
      ax += aS * this.peakDirX;
      az += aS * this.peakDirZ;
      pressure += RHO * G * eta;
      // Steep faces are not hydrostatic either. Hydrostatic pressure grows
      // by g per metre of *vertical* depth, so its gradient under a 60 degree
      // face is 2 g, normal to the face: a submerged body was shoved out
      // through the face at g tan(theta) while the water itself was not.
      // Under a steep free surface the pressure grows by about g cos(theta)
      // per metre of depth normal to it, i.e. g cos^2(theta) per vertical
      // metre. With that, the body's weight and buoyancy leave g sin(theta)
      // straight down the face: the inclined-plane slide a surfer rides.
      const cos2 = 1 / (1 + etaS * etaS);
      pressure -= RHO * G * (1 - cos2) * Math.max(0, h - y);
      // This flow is not hydrostatic. On the toe of the face the water is
      // flung forward and upward far harder than the slope's pressure push
      // explains, so a body pushed only by that lags the water and the
      // rising face buries it tens of metres deep. On the toe the wetted
      // body is given the water parcel's own acceleration instead (the
      // Froude-Krylov principle: a neutrally buoyant body moves with the
      // fluid), so it is picked up with the water. From about a quarter of
      // the way up, the face's gravity slide is left alone: that is what a
      // surfer rides down. The parcel acceleration is a short finite
      // difference along its path through the steady, travelling field.
      const toe = 1 - smoothstep(0.08, 0.25, eta / Math.max(1, surf.megaCrestH || eta));
      if (toe > 0) {
        const dt = 0.02;
        const ds = (u - c) * dt;
        const m2 = this.megaAt(surf.parameterX + ds * this.peakDirX, surf.parameterZ + ds * this.peakDirZ, _megaFd);
        const col2 = hb + m2.h;
        const u2 = (c * m2.h) / col2;
        const y2 = y + wM * dt;
        const w2 = -clamp(y2 + hb, 0, col2) * ((c * hb) / (col2 * col2)) * m2.ds;
        const slideS = -G * etaS * cos2;
        const slideY = -G * (1 - cos2);
        megaFk = toe * ((u2 - u) / dt - slideS);
        megaFkY = toe * ((w2 - wM) / dt - slideY);
      }
    }
    out.megaFkX = megaFk * this.peakDirX;
    out.megaFkZ = megaFk * this.peakDirZ;
    out.megaFkY = megaFkY;

    // Breaker jet: near a breaking crest, water near the surface is thrown
    // forward at roughly the local phase speed. This is the force that can
    // overtake and throw the dolphin.
    if (surf.breaking > 0.01 && this.peak) {
      const jetType = surf.breakerType === 0 ? 0.7 : surf.breakerType === 1 ? 1.0 : 0.55;
      const jet =
        surf.phaseSpeed *
        surf.breaking *
        TUNING.water.breakerJet *
        jetType *
        Math.exp(depthBelowSurface / 1.5);
      vx += this.peak.dx * jet;
      vz += this.peak.dz * jet;
      vy += jet * 0.08 * Math.sin(surf.peakArg);
    }

    out.height = h;
    out.nx = surf.nx;
    out.ny = surf.ny;
    out.nz = surf.nz;
    out.slope = surf.slope;
    out.slopeX = surf.slopeX;
    out.slopeZ = surf.slopeZ;
    out.jacobian = surf.jacobian;
    out.velocityX = vx;
    out.velocityY = vy;
    out.velocityZ = vz;
    out.accelX = ax;
    out.accelY = ay;
    out.accelZ = az;
    out.dynamicPressure = pressure;
    // The bubble plume under a bore is densest at the surface and thins out
    // over roughly a third of the local wave height, so whitewater holds an
    // animal down near the top without letting it sink through the column.
    const plumeDepth = Math.max(0.6, 0.3 * this.stats.height * shoal);
    out.aeration = surf.aeration * Math.exp(depthBelowSurface / plumeDepth);
    out.turbulence = surf.turbulence;
    out.breakMask = surf.breakMask;
    out.breaking = surf.breaking;
    out.facePhase = surf.facePhase;
    out.shoal = shoal;
    out.depth = depth;
    out.phaseSpeed = surf.phaseSpeed;
    out.waveDirectionX = this.peak ? this.peak.dx : 1;
    out.waveDirectionZ = this.peak ? this.peak.dz : 0;
    out.wavelength = surf.wavelength;
    out.wavePeriod = this.stats.peakPeriod;
    out.significantHeight = this.stats.height;
    out.depthBelowSurface = Math.max(0, h - y);
    out.underwater = y < h;
    // The seabed sits at the still-water depth; the mega wave raises the
    // surface above it, not the floor below.
    const floorDepth = surf.stillDepth ?? depth;
    out.seabedY = -floorDepth;
    out.depthToSeabed = y + floorDepth;
    out.distanceToSurface = h - y;
    return out;
  }

  /**
   * Batch query for hull panels. `positions` is xyz-interleaved; results are
   * written into the caller's typed arrays (no per-panel objects).
   */
  sampleBatch(positions, out, stride = 3, count = positions.length / stride, forForces = false) {
    const height = out.height;
    const nx = out.nx;
    const ny = out.ny;
    const nz = out.nz;
    const vx = out.velocityX;
    const vy = out.velocityY;
    const vz = out.velocityZ;
    const pressure = out.dynamicPressure;
    const aeration = out.aeration;
    const slope = out.slope;
    const phaseSpeed = out.phaseSpeed;
    for (let i = 0; i < count; i++) {
      const p = i * stride;
      const s = forForces
        ? this.sampleForForces(positions[p], positions[p + 1], positions[p + 2], _batch)
        : this.sample(positions[p], positions[p + 1], positions[p + 2], _batch);
      height[i] = s.height;
      nx[i] = s.nx;
      ny[i] = s.ny;
      nz[i] = s.nz;
      vx[i] = s.velocityX;
      vy[i] = s.velocityY;
      vz[i] = s.velocityZ;
      pressure[i] = s.dynamicPressure;
      aeration[i] = s.aeration;
      slope[i] = s.slope;
      phaseSpeed[i] = s.phaseSpeed;
    }
    return out;
  }

  /**
   * Sample a long profile along a direction. Used by the debug HUD to count
   * wave sets without allocating during the render loop.
   */
  profile(x, z, dirX, dirZ, length = 800, samples = 512, out = new Float32Array(samples)) {
    const step = length / samples;
    for (let i = 0; i < samples; i++) {
      out[i] = this.sampleHeight(x + dirX * i * step, z + dirZ * i * step);
    }
    return out;
  }
}

const _inv = {};
const _surf = {};
const _batch = {};
const _depth = {};
const _depthP = {};
const _megaFd = {};
const _height = {};

export { G as GRAVITY, RHO as WATER_DENSITY };
