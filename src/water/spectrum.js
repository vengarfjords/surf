import { clamp, mulberry32 } from "../utils.js";

const G = 9.81;
const TAU = Math.PI * 2;

/**
 * JONSWAP spectral density, normalised to 1 at the peak. Only the shape
 * matters here because the discrete component set is renormalised to a target
 * significant wave height after generation.
 */
function jonswap(omega, omegaPeak, gamma = 6.0) {
  if (omega <= 0) return 0;
  const sigma = omega <= omegaPeak ? 0.07 : 0.09;
  const r = Math.exp(-((omega - omegaPeak) ** 2) / (2 * sigma * sigma * omegaPeak * omegaPeak));
  const x = omegaPeak / omega;
  const peak = Math.exp(-1.25 * x ** 4);
  return (peak * Math.pow(gamma, r)) / Math.pow(omega, 5);
}

/**
 * Build one directional train. Frequencies are sampled on a uniform grid
 * across the energetic part of the peak (0.68-1.34 omegaP); the JONSWAP value
 * at each frequency sets the component amplitude, so the resulting discrete
 * spectrum has the requested peak enhancement. Directions are drawn from a
 * narrow Gaussian approximation to cos^2s spreading (std ≈ sqrt(2/s)).
 */
function buildTrain(cfg, rand, opts) {
  const { count, height, wavelength, wavelengthSpread, direction, directionSpread, gamma } = opts;
  const out = [];
  if (count <= 0 || height <= 0) return out;

  const kPeak = TAU / wavelength;
  const omegaPeak = Math.sqrt(G * kPeak);
  // `wavelengthSpread` widens the sampled band around the peak. The default
  // (0.17) spans roughly 0.68-1.34 omegaP, which yields visible wave sets of
  // a handful of waves rather than a featureless uniform chop.
  const bandwidth = clamp(wavelengthSpread / 0.17, 0.35, 2.2);
  const omegaMin = omegaPeak * (1 - 0.32 * bandwidth);
  const omegaMax = omegaPeak * (1 + 0.34 * bandwidth);
  const dOmega = (omegaMax - omegaMin) / count;
  let weightSum = 0;

  for (let i = 0; i < count; i++) {
    const omega = Math.max(0.05, omegaMin + (i + 0.5) * dOmega);
    const k = (omega * omega) / G;
    const weight = jonswap(omega, omegaPeak, gamma);
    // Three uniforms give a deterministic Gaussian with std 1.
    const gd = (rand() + rand() + rand() - 1.5) * 2;
    const theta = direction + clamp(gd * directionSpread, -1.1, 1.1);
    const dx = Math.cos(theta);
    const dz = Math.sin(theta);
    const amp = Math.sqrt(Math.max(0, weight) * dOmega);
    weightSum += amp * amp;
    out.push({
      kx: k * dx,
      kz: k * dz,
      k,
      omega,
      wavelength: TAU / k,
      dx,
      dz,
      amp,
      phase0: rand() * TAU,
      layer: opts.layer,
    });
  }

  // Renormalise this train to its own significant wave height: Hs = 4 sqrt(m0)
  // where m0 = sum(a_i^2 / 2).
  const scale = weightSum > 1e-12 ? height / (4 * Math.sqrt(weightSum * 0.5)) : 0;
  for (const c of out) c.amp *= scale;
  return out;
}

export function buildSpectrum(cfg) {
  const rand = mulberry32(cfg.seed >>> 0);
  const swell = buildTrain(cfg, rand, {
    count: Math.round(cfg.swellComponents),
    height: cfg.swellHeight,
    wavelength: cfg.swellWavelength,
    wavelengthSpread: cfg.swellWavelengthSpread,
    direction: cfg.swellDirection,
    directionSpread: cfg.swellDirectionSpread,
    gamma: 7.0,
    layer: 0,
  });
  const wind = buildTrain(cfg, rand, {
    count: Math.round(cfg.windSeaComponents),
    height: cfg.windSeaHeight,
    wavelength: cfg.windSeaWavelength,
    wavelengthSpread: cfg.windSeaWavelengthSpread,
    direction: cfg.windSeaDirection,
    directionSpread: cfg.windSeaDirectionSpread,
    gamma: 2.2,
    layer: 1,
  });
  const components = swell.concat(wind);

  // Gerstner horizontal displacement. Q is global so a single uniform can
  // drive both CPU and GPU. The safety factor keeps sum(Q k A) < 1 and the
  // surface from looping; `chop` is the artistic multiplier.
  let steepness = 0;
  let ampSum = 0;
  let variance = 0;
  for (const c of components) {
    steepness += c.amp * c.k;
    ampSum += c.amp;
    variance += c.amp * c.amp * 0.5;
  }
  const safeQ = 0.82 / Math.max(1e-6, steepness);
  const chop = safeQ * clamp(cfg.chop, 0, 1.4);

  const peak = swell.length ? swell.reduce((a, b) => (b.amp > a.amp ? b : a)) : null;
  const stats = {
    components: components.length,
    swellComponents: swell.length,
    windComponents: wind.length,
    height: 4 * Math.sqrt(variance),
    swellHeight: cfg.swellHeight,
    windSeaHeight: cfg.windSeaHeight,
    peakWavelength: peak ? peak.wavelength : 0,
    peakPeriod: peak ? TAU / peak.omega : 0,
    peakPhaseSpeed: peak ? peak.omega / peak.k : 0,
    steepness,
    chop,
    amplitudeSum: ampSum,
  };

  return { components, chop, stats };
}

export function applyPreset(water, name) {
  const presets = {
    calm: {
      swellHeight: 0.8,
      swellWavelength: 46,
      windSeaHeight: 0.28,
      windSeaWavelength: 8.5,
      swellDirection: 0.61,
      swellDirectionSpread: 0.24,
      windSeaDirection: 1.02,
      chop: 0.62,
      timeScale: 1.0,
      foamAmount: 0.35,
    },
    moderate: {
      swellHeight: 2.15,
      swellWavelength: 58,
      windSeaHeight: 0.55,
      windSeaWavelength: 11.5,
      swellDirection: 0.61,
      swellDirectionSpread: 0.24,
      windSeaDirection: 1.02,
      chop: 0.78,
      timeScale: 1.0,
      foamAmount: 0.8,
    },
    surf: {
      swellHeight: 3.0,
      swellWavelength: 66,
      windSeaHeight: 0.85,
      windSeaWavelength: 13.5,
      swellDirection: 0.61,
      swellDirectionSpread: 0.24,
      windSeaDirection: 1.12,
      chop: 1.0,
      timeScale: 1.0,
      foamAmount: 1.05,
    },
    // Long-period groundswell (T ~ 10.7 s) with light wind. Sets stand up to
    // 5-7 m faces over the surf bank and roll through the shelf as 3-6 m
    // swells, big enough to drop down a face and climb back up it.
    groundswell: {
      swellHeight: 4.2,
      swellWavelength: 180,
      windSeaHeight: 0.4,
      windSeaWavelength: 9.5,
      swellDirection: 0.61,
      swellDirectionSpread: 0.16,
      windSeaDirection: 1.02,
      chop: 0.72,
      timeScale: 1.0,
      foamAmount: 0.9,
    },
    // Long-period big-wave swell (T ~ 16 s). 3-6 m on the open shelf; the
    // reef canyon focuses the sets into 15-30 m faces on the big-wave reef.
    bigwave: {
      swellHeight: 4.4,
      swellWavelength: 400,
      windSeaHeight: 0.4,
      windSeaWavelength: 9.5,
      swellDirection: 0.61,
      swellDirectionSpread: 0.12,
      windSeaDirection: 1.02,
      chop: 0.72,
      timeScale: 1.0,
      // Glassy big-wave day: light wind, few whitecaps.
      foamAmount: 0.3,
    },
    // Every wave 500 m+: the mega wave train (field.js megaAt) with a small
    // long swell and light wind sea riding on it.
    mega: {
      swellHeight: 1.6,
      swellWavelength: 400,
      windSeaHeight: 0.4,
      windSeaWavelength: 9.5,
      swellDirection: 0.61,
      swellDirectionSpread: 0.12,
      windSeaDirection: 1.02,
      chop: 0.72,
      timeScale: 1.0,
      foamAmount: 0.3,
      megaWave: true,
    },
  };
  const p = presets[name];
  if (!p) return false;
  Object.assign(water, p);
  // Only the mega preset runs the 500 m wave train.
  water.megaWave = !!p.megaWave;
  water.preset = name;
  return true;
}
