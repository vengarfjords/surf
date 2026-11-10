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
    uniform vec4 uWaves[MAX_WAVES];
    uniform float uChop;
    uniform float uMaxCrest;
    uniform sampler2D uSimState;
    uniform vec2 uSimCenter;
    uniform float uSimExtent;
    uniform float uSimScale;

    uniform sampler2D uBathy;
    uniform float uBathyExtent;
    uniform float uBathyMaxDepth;
    uniform float uDepthResponse;
    uniform float uPeakK;
    uniform float uShoalRef;
    uniform float uShoalStrength;
    uniform float uBreakRatio;
    uniform float uBreakSoftness;
    uniform float uHs;
    uniform float uPeakKx;
    uniform float uPeakKz;
    uniform float uPeakPhase;
    uniform float uBreakerLip;
    uniform float uPeakWavelength;
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

    void main() {
      vec3 base = vec3(position.x + uCenter.x, 0.0, position.z + uCenter.y);

      float depth = texture2D(uBathy, base.xz / uBathyExtent + 0.5).r * uBathyMaxDepth;
      depth = max(0.3, depth);
      float ratio = 1.0;
      float shoal = 1.0;
      float breakMask = 0.0;
      if (uDepthResponse > 0.5) {
        float x0 = max(1e-4, uPeakK * depth);
        ratio = clamp(1.0 / sqrt(tanh(x0)), 0.65, 4.5);
        float shoalRaw = clamp(pow(uShoalRef / depth, uShoalStrength), 0.5, 3.2);
        float hsLocal = uHs * shoalRaw;
        breakMask = smoothstep(uBreakRatio - uBreakSoftness, uBreakRatio + uBreakSoftness, hsLocal / depth);
        float cap = (uBreakRatio * depth) / max(0.3, uHs);
        shoal = min(shoalRaw, max(0.55, cap * 1.05));
      }

      float h = 0.0;
      float dhdx = 0.0;
      float dhdz = 0.0;
      float dxdx = 0.0;
      float dzdz = 0.0;
      float dxdz = 0.0;
      float horizX = 0.0;
      float horizZ = 0.0;

      for (int i = 0; i < MAX_WAVES; i++) {
        if (i >= uWaveCount) break;
        vec4 w = uWaves[i];
        float kxL = w.x * ratio;
        float kzL = w.y * ratio;
        float arg = kxL * base.x + kzL * base.z + w.w;
        float s = sin(arg);
        float c = cos(arg);
        float amp = w.z * shoal;
        h += amp * s;
        dhdx += amp * kxL * c;
        dhdz += amp * kzL * c;
        float ha = amp * uChop;
        // Horizontal displacement is Q*A*unitDirection*cos(theta). w.x/w.y
        // are kx/kz, so normalise them; using them directly adds a spurious
        // factor of k and makes the rendered surface disagree with the CPU.
        vec2 kvec = vec2(kxL, kzL);
        vec2 dir = kvec * inversesqrt(max(dot(kvec, kvec), 1e-8));
        horizX += ha * dir.x * c;
        horizZ += ha * dir.y * c;
        dxdx -= ha * kxL * kxL * s;
        dzdz -= ha * kzL * kzL * s;
        dxdz -= ha * kxL * kzL * s;
      }

      float peakArg = uPeakKx * ratio * base.x + uPeakKz * ratio * base.z + uPeakPhase;
      float lipPhase = peakArg - 0.55;
      float lipSin = sin(lipPhase);
      float lipAmp = breakMask * uBreakerLip * uHs * shoal;
      float lip = lipAmp * max(0.0, lipSin) * max(0.0, lipSin);
      if (lipSin > 0.0) {
        float dLip = lipAmp * 2.0 * lipSin * cos(lipPhase);
        dhdx += dLip * uPeakKx * ratio;
        dhdz += dLip * uPeakKz * ratio;
      }
      h += lip;

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
      vCrest = clamp(h / max(0.25, uMaxCrest), -1.0, 1.0);
      vJacobian = (1.0 + dxdx) * (1.0 + dzdz) - dxdz * dxdz;
      vDistance = length(world.xz - uCenter);
      vSlope = vec2(dhdx, dhdz);
      // Iribarren number for breaker type. Doing this in the vertex shader
      // costs four bathymetry taps per vertex instead of per fragment.
      float be = 8.0;
      float bL = texture2D(uBathy, (base.xz + vec2(be, 0.0)) / uBathyExtent + 0.5).r * uBathyMaxDepth;
      float bR = texture2D(uBathy, (base.xz - vec2(be, 0.0)) / uBathyExtent + 0.5).r * uBathyMaxDepth;
      float bD = texture2D(uBathy, (base.xz + vec2(0.0, be)) / uBathyExtent + 0.5).r * uBathyMaxDepth;
      float bU = texture2D(uBathy, (base.xz - vec2(0.0, be)) / uBathyExtent + 0.5).r * uBathyMaxDepth;
      float tanBeta = length(vec2(bR - bL, bU - bD)) / (2.0 * be);
      vXi = tanBeta / sqrt(max(0.01, uHs / max(1.0, uPeakWavelength)));

      vBreak = breakMask;
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
