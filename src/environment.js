import * as THREE from "three";
import { PALETTE } from "./config.js";
import { glslNoise } from "./utils.js";
import { glslSky } from "./atmosphere.js";

/**
 * Prefiltered environment maps for glossy, wet surfaces (the dolphin's
 * skin). Above the water: the same overcast sky as the dome, over a dark
 * sea that reflects it at grazing angles. Below: the bright window of the
 * surface overhead fading into the blue-green water and the dark deep.
 */
function envScene(fragment, uniforms) {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: fragment,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), material));
  return scene;
}

export function buildEnvironments(renderer, sunDir) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const lin = (hex) => new THREE.Color(hex);
  const uniforms = {
    uSunDir: { value: sunDir.clone().normalize() },
    uDeep: { value: lin(PALETTE.waterDeep) },
    uTop: { value: lin(PALETTE.waterTop) },
    uFogShallow: { value: lin(PALETTE.fogShallow) },
    uFogDeep: { value: lin(PALETTE.fogDeep) },
  };
  const above = envScene(
    /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uSunDir;
      uniform vec3 uDeep;
      ${glslNoise}
      ${glslSky}
      void main() {
        vec3 d = normalize(vDir);
        vec3 col;
        if (d.y >= 0.0) {
          col = skyColor(d, uSunDir, 0.0, 0.6);
        } else {
          // The sea below the horizon: dark water, the sky reflected in it
          // more strongly toward the horizon.
          vec3 r = normalize(vec3(d.x, -d.y, d.z));
          float c = clamp(-d.y, 0.0, 1.0);
          float fres = min(0.02 + 0.98 * pow(1.0 - c, 5.0), 0.5);
          vec3 sea = uDeep * mix(SKY_HORIZON_AWAY, SKY_MID, 0.5) * 0.9;
          col = mix(sea, skyColor(r, uSunDir, 0.0, 0.3) * 0.8, fres);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    uniforms
  );
  const below = envScene(
    /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uTop;
      uniform vec3 uFogShallow;
      uniform vec3 uFogDeep;
      void main() {
        vec3 d = normalize(vDir);
        // Snell's window overhead, the lit water around it, the deep below.
        vec3 window = vec3(0.62, 0.82, 0.8) * 1.3;
        vec3 col = mix(uFogShallow * 1.15, uTop * 0.9, smoothstep(0.1, 0.6, d.y));
        col = mix(col, window, smoothstep(0.62, 0.8, d.y));
        col = mix(col, uFogDeep * 0.55, smoothstep(0.0, -0.75, d.y));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    uniforms
  );
  const aboveRT = pmrem.fromScene(above, 0, 0.1, 50);
  const belowRT = pmrem.fromScene(below, 0, 0.1, 50);
  pmrem.dispose();
  return { above: aboveRT.texture, below: belowRT.texture };
}
