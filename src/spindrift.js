import * as THREE from "three";
import { TUNING } from "./config.js";
import { glslNoise } from "./utils.js";
import { glslSky } from "./atmosphere.js";

/**
 * Spindrift: the veil of spray the wind tears off a big crest and streams
 * back over the wave. One translucent sheet rides each visible mega crest.
 * Purely visual; it reads the mega train's public state (crest position,
 * crest index, heights) and mirrors WaveField.megaAt's crest height so the
 * sheet sits on the lip.
 */
const VERT = /* glsl */ `
  uniform vec4 uFrame;   // origin x, origin z, travel dir x, travel dir z
  uniform vec4 uParams;  // height, variation, lateral, crest index g
  uniform float uCrestS;
  uniform float uCamC;
  uniform float uLength;
  uniform float uBack;
  uniform float uRise;
  uniform float uTime;
  varying vec2 vSheet;   // x: metres along the crest, y: 0..1 back from the lip
  varying vec3 vWorld;
  varying float vEnd;
  ${glslNoise}
  void main() {
    float u = uv.x;
    float v = uv.y;
    vec2 dir = uFrame.zw;
    vec2 perp = vec2(-dir.y, dir.x);
    float c = uCamC + (u - 0.5) * uLength;
    float g = uParams.w;
    float H = uParams.x * (1.0 + uParams.y * (0.5 + 0.5 * sin(g * 2.39996 + 0.7)))
      * (1.0 + uParams.z * sin(c / 700.0 + g * 1.3));
    // Gusts change how far and how high the veil is thrown.
    float gust = 0.55 + 0.9 * vnoise(vec2(c * 0.004 - uTime * 0.03, g * 3.1));
    float back = v * uBack * gust;
    float rise = uRise * gust * (1.0 - (1.0 - v) * (1.0 - v));
    vec2 xz = uFrame.xy + dir * (uCrestS - back) + perp * c;
    // Start just under the lip so the sheet grows out of the crest foam.
    vec3 world = vec3(xz.x, H - 4.0 + rise - back * 0.18, xz.y);
    vSheet = vec2(c, v);
    vWorld = world;
    vEnd = min(u, 1.0 - u);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uStrength;
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  uniform float uHorizonFog;
  varying vec2 vSheet;
  varying vec3 vWorld;
  varying float vEnd;
  ${glslNoise}
  ${glslSky}
  void main() {
    float c = vSheet.x;
    float v = vSheet.y;
    // Spray streams back from the lip: long streaks along the wind that
    // scroll backward, broken into puffs.
    float streak = fbm2(vec2(c * 0.018, v * 3.0 - uTime * 0.22));
    float puff = vnoise(vec2(c * 0.06, v * 9.0 - uTime * 0.9));
    float wisp = vnoise(vec2(c * 0.2, v * 22.0 - uTime * 2.1));
    float density = smoothstep(0.32, 0.78, streak * 0.75 + puff * 0.35 + wisp * 0.12);
    float profile = smoothstep(0.0, 0.07, v) * pow(1.0 - v, 2.2);
    // Sections of the crest throw more spray than others.
    float section = smoothstep(0.25, 0.7, vnoise(vec2(c * 0.0025 - uTime * 0.015, 4.0)));
    float ends = smoothstep(0.0, 0.12, vEnd);
    float alpha = density * profile * (0.35 + 0.65 * section) * ends * 0.62 * uStrength;

    vec3 viewDir = normalize(vWorld - uCameraPos);
    vec3 horizon = skyHorizonColor(viewDir, uSunDir);
    // Fine droplets scatter forward: the veil glows when backlit.
    float forward = pow(max(dot(viewDir, uSunDir), 0.0), 3.0);
    vec3 col = mix(horizon, vec3(0.93, 0.95, 0.95), 0.55);
    col += SKY_HORIZON_SUN * forward * 0.45;
    col *= 0.88 + 0.2 * wisp;

    float dist = length(vWorld.xz - uCameraPos.xz);
    float hz = seaHaze(dist, uHorizonFog);
    col = mix(col, horizon, clamp(hz, 0.0, 0.95));
    alpha *= smoothstep(20.0, 140.0, length(vWorld - uCameraPos));
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

export class Spindrift {
  constructor(scene, ocean) {
    this.ocean = ocean;
    this.sheets = [];
    const geometry = new THREE.PlaneGeometry(1, 1, 180, 12);
    // PlaneGeometry uv.y runs 0 at the bottom row; that is the lip.
    for (let i = 0; i < 2; i++) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uFrame: { value: new THREE.Vector4() },
          uParams: { value: new THREE.Vector4() },
          uCrestS: { value: 0 },
          uCamC: { value: 0 },
          uLength: { value: 7000 },
          uBack: { value: 320 },
          uRise: { value: 95 },
          uTime: { value: 0 },
          uStrength: { value: 1 },
          uSunDir: ocean.uniforms.uSunDir,
          uCameraPos: ocean.uniforms.uCameraPos,
          uHorizonFog: ocean.uniforms.uHorizonFog,
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      mesh.visible = false;
      scene.add(mesh);
      this.sheets.push(mesh);
    }
  }

  update(dt, camera, underwater) {
    const cfg = TUNING.water;
    const water = this.ocean.water;
    const on = cfg.megaWave && cfg.megaHeight > 0 && TUNING.visuals.spindrift > 0 && underwater < 0.5;
    if (!on) {
      for (const s of this.sheets) s.visible = false;
      return;
    }
    const dx = water.peakDirX;
    const dz = water.peakDirZ;
    const ox = camera.position.x - cfg.surfZoneX;
    const oz = camera.position.z - cfg.surfZoneZ;
    const camS = ox * dx + oz * dz;
    const camC = -ox * dz + oz * dx;
    const L = Math.max(100, cfg.megaWavelength);
    // The crest just ahead of or under the camera, and the one behind it.
    const n0 = Math.floor((camS - water.megaCrestMod) / L);
    const time = this.ocean.time;
    for (let i = 0; i < this.sheets.length; i++) {
      const n = n0 + i;
      const sheet = this.sheets[i];
      const u = sheet.material.uniforms;
      u.uFrame.value.set(cfg.surfZoneX, cfg.surfZoneZ, dx, dz);
      u.uParams.value.set(cfg.megaHeight, cfg.megaVariation, cfg.megaLateral, n - water.megaIndex);
      u.uCrestS.value = water.megaCrestMod + n * L;
      u.uCamC.value = camC;
      u.uTime.value = time;
      u.uStrength.value = TUNING.visuals.spindrift;
      // Scale the plume with the wave.
      u.uBack.value = Math.max(30, cfg.megaHeight * 0.36);
      u.uRise.value = Math.max(8, cfg.megaHeight * 0.14);
      sheet.visible = true;
    }
  }
}
