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

    varying vec3 vWorld;
    varying vec3 vNormalW;
    varying float vWaveHeight;
    varying float vCrest;
    varying float vJacobian;
    varying float vDistance;
    varying vec2 vSlope;

    vec2 simSample(vec2 world) {
      vec2 uv = (world - uSimCenter) / uSimExtent + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec2(0.0);
      return texture2D(uSimState, uv).rg;
    }

    void main() {
      vec3 base = vec3(position.x + uCenter.x, 0.0, position.z + uCenter.y);

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
        float arg = w.x * base.x + w.y * base.z + w.w;
        float s = sin(arg);
        float c = cos(arg);
        float amp = w.z;
        h += amp * s;
        dhdx += amp * w.x * c;
        dhdz += amp * w.y * c;
        float ha = amp * uChop;
        // Horizontal displacement is Q*A*unitDirection*cos(theta). w.x/w.y
        // are kx/kz, so normalise them; using them directly adds a spurious
        // factor of k and makes the rendered surface disagree with the CPU.
        vec2 kvec = vec2(w.x, w.y);
        vec2 dir = kvec * inversesqrt(max(dot(kvec, kvec), 1e-8));
        horizX += ha * dir.x * c;
        horizZ += ha * dir.y * c;
        dxdx -= ha * w.x * w.x * s;
        dzdz -= ha * w.y * w.y * s;
        dxdz -= ha * w.x * w.y * s;
      }

      vec3 world = base + vec3(horizX, h, horizZ);

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

      vec4 mv = viewMatrix * vec4(world, 1.0);
      gl_Position = projectionMatrix * mv;

      vWorld = world;
      vNormalW = n;
      vWaveHeight = h;
      vCrest = clamp(h / max(0.25, uMaxCrest), -1.0, 1.0);
      vJacobian = (1.0 + dxdx) * (1.0 + dzdz) - dxdz * dxdz;
      vDistance = length(world.xz - uCenter);
      vSlope = vec2(dhdx, dhdz);
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
