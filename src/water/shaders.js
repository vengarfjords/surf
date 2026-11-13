/**
 * GLSL for the authoritative wave field. The component array is uploaded from
 * the exact CPU arrays in src/water/field.js; the vertex shader evaluates the
 * same Gerstner sum, so mesh and physics share one source of truth.
 *
 * The wave array is vec4(kx, kz, amplitude, phase). `phase` already includes
 * -omega * t, computed once per frame on the CPU, which keeps the shared clock
 * explicit and avoids a second time convention drifting.
 */
export const MAX_WAVES = 128;

export function waterVertexShader(maxWaves = MAX_WAVES) {
  return /* glsl */ `
    precision highp float;
    #define MAX_WAVES ${maxWaves}

    uniform vec2 uCenter;
    uniform int uWaveCount;
    uniform int uSwellCount;
    uniform vec4 uWaves[MAX_WAVES];
    uniform float uChop;
    uniform float uMaxCrest;
    uniform sampler2D uSimState;
    uniform vec2 uSimCenter;
    uniform float uSimExtent;
    uniform float uSimScale;

    uniform sampler2D uBathy;
    uniform sampler2D uPhaseField;
    uniform float uPhaseFieldSize;
    uniform float uBathyExtent;
    uniform float uBathyMaxDepth;
    uniform float uDepthResponse;
    uniform float uPeakK;
    uniform float uShoalRef;
    uniform float uShoalStrength;
    uniform vec2 uFocusCenter;
    uniform float uFocusGain;
    uniform float uFocusCross;
    uniform float uFocusReach;
    uniform float uBreakRatio;
    uniform float uBreakSoftness;
    uniform float uHs;
    uniform float uPeakKx;
    uniform float uPeakKz;
    uniform float uPeakPhase;
    uniform float uBreakerLip;
    uniform float uFaceSkew;
    uniform float uPeakWavelength;
    uniform float uMegaOn;
    uniform vec4 uMegaA;
    uniform vec4 uMegaB;
    uniform sampler2D uSolverTexture;
    uniform vec2 uSolverCenter;
    uniform float uSolverExtent;
    uniform vec2 uSolverTexel;
    uniform float uSolverCell;
    uniform float uSolverEnabled;
    uniform sampler2D uFoamTexture;
    uniform vec2 uFoamCenter;
    uniform float uFoamExtent;
    uniform float uFoamEnabled;

    varying vec3 vWorld;
    varying vec3 vNormalW;
    varying float vWaveHeight;
    varying float vCrest;
    varying float vJacobian;
    varying float vDistance;
    varying vec2 vSlope;
    varying float vBreak;
    varying float vFacePhase;
    varying vec2 vCapSlope;
    varying float vShoal;
    varying float vDepth;
    varying float vPeakCrest;
    varying float vXi;
    varying float vSolverFoam;
    varying float vFoamField;

    vec2 simSample(vec2 world) {
      vec2 uv = (world - uSimCenter) / uSimExtent + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec2(0.0);
      return texture2D(uSimState, uv).rg;
    }

    // Manual bilinear over the float depth/phase-delay field, mirroring the
    // CPU's sampleField() texel for texel (float textures are not filterable
    // everywhere, and this keeps the two sides bit-for-bit comparable).
    vec2 phaseFieldSample(vec2 world) {
      float n = uPhaseFieldSize;
      vec2 g = (world / uBathyExtent + 0.5) * n - 0.5;
      g = clamp(g, vec2(0.0), vec2(n - 1.001));
      vec2 g0 = floor(g);
      vec2 f = g - g0;
      ivec2 i0 = ivec2(g0);
      vec2 a = texelFetch(uPhaseField, i0, 0).rg;
      vec2 b = texelFetch(uPhaseField, i0 + ivec2(1, 0), 0).rg;
      vec2 c = texelFetch(uPhaseField, i0 + ivec2(0, 1), 0).rg;
      vec2 d = texelFetch(uPhaseField, i0 + ivec2(1, 1), 0).rg;
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    // Mega wave train (WaveField.megaAt): sech^2 crests megaA.z apart, the
    // nearest at megaA.x along the travel direction from the reef origin.
    // megaA = (crest position mod L, crest index, L, height),
    // megaB = (front width, back width, variation, lateral modulation).
    // Returns (height, slope along travel, signed distance ahead of the
    // nearest crest, that crest's height).
    vec4 megaAt(vec2 p, vec2 dir) {
      vec2 o = p - uFocusCenter;
      float s = dot(o, dir);
      float c = -o.x * dir.y + o.y * dir.x;
      float L = uMegaA.z;
      float d = s - uMegaA.x;
      float n0 = floor(d / L);
      float h = 0.0;
      float ds = 0.0;
      float best = 1e9;
      float bestH = 0.0;
      for (int k = -1; k <= 2; k++) {
        float n = n0 + float(k);
        float xi = d - n * L;
        float lam = xi > 0.0 ? uMegaB.x : uMegaB.y;
        float g = n - uMegaA.y;
        float Hn = uMegaA.w * (1.0 + uMegaB.z * (0.5 + 0.5 * sin(g * 2.39996 + 0.7)))
          * (1.0 + uMegaB.w * sin(c / 700.0 + g * 1.3));
        float a = min(20.0, abs(xi) / lam);
        float ch = cosh(a);
        float sech2 = 1.0 / (ch * ch);
        h += Hn * sech2;
        ds -= 2.0 * Hn * sech2 * tanh(a) * sign(xi) / lam;
        if (abs(xi) < abs(best)) {
          best = xi;
          bestH = Hn;
        }
      }
      return vec4(h, ds, best, bestH);
    }

    void main() {
      vec3 base = vec3(position.x + uCenter.x, 0.0, position.z + uCenter.y);

      vec2 field = phaseFieldSample(base.xz);
      vec2 megaDir = vec2(uPeakKx, uPeakKz) / max(1e-6, uPeakK);
      vec4 mega = uMegaOn > 0.5 ? megaAt(base.xz, megaDir) : vec4(0.0);
      // The mega wave deepens the water column the swell rides on.
      float depth = max(0.3, field.x) + mega.x;
      float delay = 0.0;
      float ratio = 1.0;
      float shoal = 1.0;
      float breakMask = 0.0;
      float skew = 0.0;
      if (uDepthResponse > 0.5) {
        float x0 = max(1e-4, uPeakK * depth);
        ratio = clamp(1.0 / sqrt(tanh(x0)), 0.65, 4.5);
        // Reef canyon focusing (WaveField.focusAt).
        vec2 fo = base.xz - uFocusCenter;
        vec2 fDir = vec2(uPeakKx, uPeakKz) / max(1e-6, uPeakK);
        float fs = dot(fo, fDir);
        float fc = -fo.x * fDir.y + fo.y * fDir.x;
        float fAlong = smoothstep(-uFocusReach, -30.0, fs) * (1.0 - smoothstep(150.0, 360.0, fs));
        float focus = 1.0 + uFocusGain * fAlong * exp(-(fc * fc) / (2.0 * uFocusCross * uFocusCross));
        float shoalRaw = clamp(pow(uShoalRef / depth, uShoalStrength), 0.5, 3.2) * focus;
        float hsLocal = uHs * shoalRaw;
        breakMask = smoothstep(uBreakRatio - uBreakSoftness, uBreakRatio + uBreakSoftness, hsLocal / depth);
        skew = uFaceSkew * smoothstep(uBreakRatio * 0.3, uBreakRatio * 0.95, hsLocal / depth);
        float cap = (uBreakRatio * depth) / max(0.3, uHs);
        shoal = min(shoalRaw, max(0.55, cap * 1.05));
        delay = field.y;
      }
      vec2 peakDir = vec2(uPeakKx, uPeakKz) / max(1e-6, uPeakK);
      vec2 delayGrad = (ratio - 1.0) * peakDir;
      // Local Gerstner Q, eased by sqrt(shoal * ratio) so shoaled crests
      // never loop (WaveField.depthState chopScale).
      float chopLocal = uChop * pow(max(1.0, shoal * ratio), -0.75);

      float h = 0.0;
      float dhdx = 0.0;
      float dhdz = 0.0;
      float dxdx = 0.0;
      float dzdz = 0.0;
      float dxdz = 0.0;
      float horizX = 0.0;
      float horizZ = 0.0;
      float swellH = 0.0;
      vec2 swellSlope = vec2(0.0);

      for (int i = 0; i < MAX_WAVES; i++) {
        if (i >= uWaveCount) break;
        vec4 w = uWaves[i];
        float kMag = length(w.xy);
        // Only the swell feels the reef (WaveField.sampleSurface).
        float swellOn = i < uSwellCount ? 1.0 : 0.0;
        float kxL = w.x + kMag * delayGrad.x * swellOn;
        float kzL = w.y + kMag * delayGrad.y * swellOn;
        float arg = w.x * base.x + w.y * base.z + kMag * delay * swellOn + w.w;
        float s = sin(arg);
        float c = cos(arg);
        float amp = w.z * mix(min(shoal, 1.0), shoal, swellOn);
        h += amp * s;
        dhdx += amp * kxL * c;
        dhdz += amp * kzL * c;
        float ha = amp * chopLocal;
        // Horizontal displacement is Q*A*unitDirection*cos(theta). w.x/w.y
        // are kx/kz, so normalise them; using them directly adds a spurious
        // factor of k and makes the rendered surface disagree with the CPU.
        vec2 dir = w.xy / max(kMag, 1e-8);
        horizX += ha * dir.x * c;
        horizZ += ha * dir.y * c;
        dxdx -= ha * kxL * kxL * s;
        dzdz -= ha * kzL * kzL * s;
        dxdz -= ha * kxL * kzL * s;
        if (i < uSwellCount) {
          swellH = h;
          swellSlope = vec2(dhdx, dhdz);
        }
      }

      // Per-wave breaking, mirroring WaveField.sampleSurface: the swell's
      // local envelope and face phase say whether this wave, here, now, is
      // big enough to break, and the bore rides on its front face.
      float kLocalPeak = uPeakK * ratio;
      float slopeAlong = dot(swellSlope, peakDir) / max(1e-6, kLocalPeak);
      float envelope = length(vec2(swellH, slopeAlong));
      float hsLocal = max(0.05, uHs * shoal);

      // Forward-pitched face (WaveField.sampleSurface): the swell's sine is
      // replaced by the skewed series atan2(s sin t, 1 + s cos t) / s, which
      // stands the front face up toward vertical as s -> 1.
      float skewS = 0.0;
      vec2 skewSlope = vec2(0.0);
      if (skew > 0.0) {
        float A = sqrt(max(0.0004, swellH * swellH + slopeAlong * slopeAlong));
        skewS = min(0.95, skew * smoothstep(0.25, 0.7, (2.0 * A) / hsLocal));
        if (skewS > 1e-3) {
          float sn = swellH / A;
          float cs = slopeAlong / A;
          float denom = 1.0 + 2.0 * skewS * cs + skewS * skewS;
          h += (A / skewS) * atan(skewS * sn, 1.0 + skewS * cs) - swellH;
          float dSkew = (A * (skewS + cs)) / denom - slopeAlong;
          skewSlope = dSkew * kLocalPeak * peakDir;
          dhdx += skewSlope.x;
          dhdz += skewSlope.y;
        } else {
          skewS = 0.0;
        }
      }

      // Per-wave breaking, mirroring WaveField.sampleSurface: the swell's
      // local envelope and face phase say whether this wave, here, now, is
      // big enough to break, and the bore rides on its front face. The phase
      // is remapped to the skewed face (skewPhase in field.js).
      float facePhase = atan(-slopeAlong, swellH);
      if (skewS > 0.0) {
        float a = asin(skewS);
        float front = 3.14159265 - 2.0 * a;
        float d = facePhase - a;
        d -= 6.28318531 * floor(d / 6.28318531);
        float mapped = d < front ? d * 3.14159265 / front : 3.14159265 + (d - front) * 3.14159265 / (6.28318531 - front);
        if (mapped > 3.14159265) mapped -= 6.28318531;
        facePhase = mapped;
      }
      float waveSize = smoothstep(0.32, 0.62, (2.0 * envelope) / hsLocal);
      float onFront = smoothstep(-0.45, 0.05, facePhase) * (1.0 - smoothstep(0.8, 1.5, facePhase));
      float waveBreak = breakMask * waveSize * onFront;

      float peakArg = uPeakKx * base.x + uPeakKz * base.z + uPeakK * delay + uPeakPhase;
      float lipPhase = peakArg - 0.55;
      float lipSin = sin(lipPhase);
      float lipAmp = breakMask * uBreakerLip * uHs * shoal * (1.0 - skewS);
      float lip = lipAmp * max(0.0, lipSin) * max(0.0, lipSin);
      if (lipSin > 0.0) {
        float dLip = lipAmp * 2.0 * lipSin * cos(lipPhase);
        dhdx += dLip * (uPeakKx + uPeakK * delayGrad.x);
        dhdz += dLip * (uPeakKz + uPeakK * delayGrad.y);
      }
      h += lip;

      // Mega wave height and slope, and its face phase and whitewater: the
      // upper front face of each crest feathers white.
      float swellOnlyH = h;
      if (mega.w > 0.0) {
        h += mega.x;
        dhdx += mega.y * megaDir.x;
        dhdz += mega.y * megaDir.y;
        float frontSpan = 2.5 * uMegaB.x;
        facePhase = mega.z >= 0.0
          ? 3.14159265 * min(1.0, mega.z / frontSpan)
          : -3.14159265 * min(1.0, -mega.z / max(1.0, uMegaA.z - frontSpan));
        float megaFoam = (mega.z >= 0.0 ? 1.0 : smoothstep(-0.25, 0.0, mega.z / uMegaB.x))
          * (1.0 - smoothstep(0.3, 1.0, mega.z / uMegaB.x))
          * smoothstep(0.6, 0.92, mega.x / mega.w);
        waveBreak = max(waveBreak, megaFoam * 0.85);
      }

      vec3 world = base + vec3(horizX, h, horizZ);

      // Local nonlinear surf-zone solver. Its height/foam replace the
      // spectral field inside the fixed bank window; the mask fades at the
      // window edge where the analytical boundary is imposed.
      vSolverFoam = 0.0;
      vec3 solverNormal = vec3(0.0, 1.0, 0.0);
      vec2 solverUv = (world.xz - uSolverCenter) / uSolverExtent + 0.5;
      float solverEdge = min(min(solverUv.x, 1.0 - solverUv.x), min(solverUv.y, 1.0 - solverUv.y));
      float solverMask = smoothstep(0.0, 0.035, solverEdge) * uSolverEnabled;
      if (solverMask > 0.001) {
        vec4 sc = texture2D(uSolverTexture, solverUv);
        float solverEta = sc.r * 6.0 - 3.0;
        float foam = sc.g;
        float eL = texture2D(uSolverTexture, solverUv - vec2(uSolverTexel.x, 0.0)).r * 6.0 - 3.0;
        float eR = texture2D(uSolverTexture, solverUv + vec2(uSolverTexel.x, 0.0)).r * 6.0 - 3.0;
        float eD = texture2D(uSolverTexture, solverUv - vec2(0.0, uSolverTexel.y)).r * 6.0 - 3.0;
        float eU = texture2D(uSolverTexture, solverUv + vec2(0.0, uSolverTexel.y)).r * 6.0 - 3.0;
        solverNormal = normalize(vec3(
          -(eR - eL) / (2.0 * uSolverCell),
          1.0,
          -(eU - eD) / (2.0 * uSolverCell)
        ));
        h = mix(h, solverEta, solverMask);
        world.y = h;
        vSolverFoam = foam * solverMask;
        breakMask = max(breakMask, foam * solverMask);
      }

      // Persistent advected foam/aeration state over the surf bank.
      vec2 foamUv = (world.xz - uFoamCenter) / uFoamExtent + 0.5;
      float foamEdge = min(min(foamUv.x, 1.0 - foamUv.x), min(foamUv.y, 1.0 - foamUv.y));
      float foamMask = smoothstep(0.0, 0.04, foamEdge) * uFoamEnabled;
      vFoamField = texture2D(uFoamTexture, foamUv).r * foamMask;

      // Local GPU contact heightfield (dolphin parting / wakes). It is
      // deliberately visual: the physics query does not include this field,
      // and the parity probe disables it with uSimScale = 0.
      vec2 sim = simSample(world.xz) * uSimScale;
      world.y += sim.r * ${0.92};
      float e = 0.7;
      float simX = (simSample(world.xz + vec2(e, 0.0)).r - simSample(world.xz - vec2(e, 0.0)).r) * uSimScale;
      float simZ = (simSample(world.xz + vec2(0.0, e)).r - simSample(world.xz - vec2(0.0, e)).r) * uSimScale;
      dhdx += simX / (2.0 * e);
      dhdz += simZ / (2.0 * e);

      vec3 tx = vec3(1.0 + dxdx, dhdx, dxdz);
      vec3 tz = vec3(dxdz, dhdz, 1.0 + dzdz);
      vec3 n = normalize(cross(tz, tx));
      if (n.y < 0.0) n = -n;
      n = normalize(mix(n, solverNormal, solverMask * 0.86));

      vec4 mv = viewMatrix * vec4(world, 1.0);
      gl_Position = projectionMatrix * mv;

      vWorld = world;
      vNormalW = n;
      vWaveHeight = h;
      vCrest = clamp(swellOnlyH / max(0.25, uMaxCrest), -1.0, 1.0);
      vJacobian = (1.0 + dxdx) * (1.0 + dzdz) - dxdz * dxdz;
      vDistance = length(world.xz - uCenter);
      vSlope = vec2(dhdx, dhdz);
      // Whitecaps come from the short wind sea; a long swell's smooth face
      // only contributes a third of its slope, so big groundswell stays glassy.
      // Whitecaps key off the wind sea: the swell's own slope (and the
      // steepened face it is reshaped into) is not a whitecap.
      vCapSlope = vSlope - swellSlope * 0.65 - skewSlope - mega.y * megaDir;
      // Iribarren number for breaker type. Doing this in the vertex shader
      // costs four bathymetry taps per vertex instead of per fragment.
      float be = 8.0;
      float bL = texture2D(uBathy, (base.xz + vec2(be, 0.0)) / uBathyExtent + 0.5).r * uBathyMaxDepth;
      float bR = texture2D(uBathy, (base.xz - vec2(be, 0.0)) / uBathyExtent + 0.5).r * uBathyMaxDepth;
      float bD = texture2D(uBathy, (base.xz + vec2(0.0, be)) / uBathyExtent + 0.5).r * uBathyMaxDepth;
      float bU = texture2D(uBathy, (base.xz - vec2(0.0, be)) / uBathyExtent + 0.5).r * uBathyMaxDepth;
      float tanBeta = length(vec2(bR - bL, bU - bD)) / (2.0 * be);
      vXi = tanBeta / sqrt(max(0.01, uHs / max(1.0, uPeakWavelength)));

      vBreak = waveBreak;
      vFacePhase = facePhase;
      vShoal = shoal;
      vDepth = depth;
      vPeakCrest = 0.5 + 0.5 * sin(peakArg);
    }
  `;
}

/**
 * Renders one pixel from straight above. The fragment writes the interpolated
 * vertex height as a 16-bit fixed-point pair; the CPU reads it back and
 * compares it with WaveField.sampleHeight. This measures the actual rendered
 * mesh (including tessellation error), not just a second analytic evaluation.
 */
export const probeFragmentShader = /* glsl */ `
  precision highp float;
  varying float vWaveHeight;
  void main() {
    float v = clamp((vWaveHeight + 8.0) / 16.0, 0.0, 1.0);
    float q = floor(v * 65535.0 + 0.5);
    float hi = floor(q / 256.0);
    float lo = q - hi * 256.0;
    gl_FragColor = vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);
  }
`;
