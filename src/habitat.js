import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TUNING, PALETTE, SUN_DIRECTION } from "./config.js";
import {
  clamp,
  fbm,
  glslCaustics,
  glslFog,
  glslNoise,
  lerp,
  mulberry32,
  seabedHeight,
  smoothstep,
} from "./utils.js";

export const sharedShader = {
  time: { value: 0 },
};

const CAUSTIC_UNIFORMS = {
  uOceanTime: sharedShader.time,
  uCausticTint: { value: new THREE.Color(0xffedc2) },
  uCausticStrength: { value: 0.36 },
};

// Photogrammetry specimens from the NMNH coral collection. They are expensive
// per specimen but make a convincing near-field reef when used as hero pieces
// against the cheaper procedural reef.
const REFERENCE_CORALS = [
  {
    id: "corallium",
    url: "/corals/corallium-sp/usnm_56807-100k-2048.gltf",
    tint: 0xd7a184,
    roughness: 0.74,
    placements: [
      { x: -4.0, z: 14.5, size: 2.3, yaw: 0.4 },
      { x: 0.0, z: 19.0, size: 2.3, yaw: 0.1 },
      { x: 10.5, z: 25.0, size: 1.8, yaw: 3.8 },
      { x: 36.0, z: 76.0, size: 2.3, yaw: 0.8 },
    ],
  },
  {
    id: "diploria",
    url: "/corals/diploria-labyrinthiformis/usnm_74947-100k-2048.gltf",
    tint: 0xc9b08b,
    roughness: 0.8,
    placements: [
      { x: 1.5, z: 16.5, size: 1.4, yaw: 0.2 },
      { x: 7.5, z: 22.0, size: 1.3, yaw: 4.1 },
    ],
  },
  {
    id: "distichopora",
    url: "/corals/distichopora-borealis/usnm_1122878-100k-2048.gltf",
    tint: 0xcda17f,
    roughness: 0.72,
    placements: [
      { x: 3.5, z: 13.5, size: 0.9, yaw: 0.1 },
      { x: 8.5, z: 18.5, size: 0.8, yaw: 2.2 },
    ],
  },
  {
    id: "stylaster",
    url: "/corals/stylaster-sanguineus/USNM_76660_macro-100k-2048.gltf",
    tint: 0xc18b86,
    roughness: 0.7,
    placements: [
      { x: -2.0, z: 19.0, size: 0.85, yaw: 3.3 },
      { x: 4.5, z: 21.5, size: 0.8, yaw: 0.7 },
    ],
  },
];

function nearReferenceCoral(x, z, radius) {
  const r2 = radius * radius;
  for (const def of REFERENCE_CORALS) {
    for (const p of def.placements) {
      const dx = x - p.x;
      const dz = z - p.z;
      if (dx * dx + dz * dz < r2) return true;
    }
  }
  return false;
}

// The opening drift is a hand-cleared patch reef: scans and sand, not the
// chunky procedural boulders used to fill the rest of the 3 x 3 km shelf.
function inHeroReef(x, z) {
  return x > -18 && x < 18 && z > 10 && z < 32;
}

export function injectCaustics(material, strength = 0.34, tint = 0xffedc2) {
  material.onBeforeCompile = (shader) => {
    // Use the same animated clock for every surface; created once in World.
    shader.uniforms.uOceanTime = sharedShader.time;
    shader.uniforms.uCausticTint = { value: new THREE.Color(tint) };
    shader.uniforms.uCausticStrength = { value: strength };

    shader.vertexShader =
      "varying vec3 vCausticWorld;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        /* glsl */ `
          #include <begin_vertex>
          vec4 causticWorld = modelMatrix * vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            causticWorld = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
          #endif
          vCausticWorld = causticWorld.xyz;
        `
      );

    shader.fragmentShader =
      /* glsl */ `
        varying vec3 vCausticWorld;
        uniform float uOceanTime;
        uniform vec3 uCausticTint;
        uniform float uCausticStrength;
        ${glslCaustics}
      ` +
      shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `
          #include <emissivemap_fragment>
          float caustic = causticNetwork(vCausticWorld.xz * 1.35, uOceanTime);
          float causticMask = smoothstep(-16.0, -1.0, vCausticWorld.y);
          totalEmissiveRadiance += uCausticTint * caustic * uCausticStrength * causticMask;
          #ifdef USE_INSTANCING_COLOR
            totalEmissiveRadiance += vColor * 0.14;
          #endif
        `
      );
  };
  material.customProgramCacheKey = () => `caustic-${strength}-${tint}`;
  return material;
}


function makeCoralPoreTexture(size = 512) {
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = colorCanvas.height = size;
  const ctx = colorCanvas.getContext("2d");
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = maskCanvas.height = size;
  const maskCtx = maskCanvas.getContext("2d");
  maskCtx.fillStyle = "#000";
  maskCtx.fillRect(0, 0, size, size);
  const rnd = mulberry32(44113);

  // Layered mineral colour: warm base, green algae films, pale exposed ridges.
  const base = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const broad = fbm(u * 3.4 + 2.1, v * 3.4 - 1.7, 4);
      const fine = fbm(u * 13.0 - 4.2, v * 13.0 + 8.3, 3);
      const algae = smoothstep(0.54, 0.78, fbm(u * 5.2 + 9.1, v * 5.2 + 1.4, 3));
      let r = 168 + broad * 46 + fine * 20;
      let g = 139 + broad * 40 + fine * 16;
      let b = 106 + broad * 30 + fine * 12;
      r = lerp(r, 92, algae * 0.48);
      g = lerp(g, 110, algae * 0.42);
      b = lerp(b, 73, algae * 0.38);
      const i = (y * size + x) * 4;
      base.data[i] = r;
      base.data[i + 1] = g;
      base.data[i + 2] = b;
      base.data[i + 3] = 255;
    }
  }
  ctx.putImageData(base, 0, 0);

  // Corallite cups large enough to survive the low-fi render. Each has a
  // pale raised rim, radial septa, a dark centre, and a matching bright mask
  // so the cups remain legible on shaded sides of branches.
  for (let i = 0; i < 240; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 4.5 + rnd() * 12.5;
    const ry = r * (0.68 + rnd() * 0.45);
    const rot = rnd() * Math.PI * 2;
    ctx.strokeStyle = `rgba(244, 220, 178, ${0.55 + rnd() * 0.35})`;
    ctx.lineWidth = 1.5 + rnd() * 3.0;
    ctx.beginPath();
    ctx.ellipse(x, y, r, ry, rot, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(49, 31, 22, ${0.42 + rnd() * 0.35})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.56, ry * 0.56, rot, 0, Math.PI * 2);
    ctx.fill();
    const septa = 6 + Math.floor(rnd() * 4);
    for (let s = 0; s < septa; s++) {
      const a = rot + (s / septa) * Math.PI * 2;
      ctx.strokeStyle = `rgba(218, 188, 146, ${0.22 + rnd() * 0.25})`;
      ctx.lineWidth = 0.7 + rnd() * 1.2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * r * 0.34, y + Math.sin(a) * ry * 0.34);
      ctx.lineTo(x + Math.cos(a) * r * 0.86, y + Math.sin(a) * ry * 0.86);
      ctx.stroke();
    }
    maskCtx.strokeStyle = `rgba(255, 244, 218, ${0.65 + rnd() * 0.35})`;
    maskCtx.lineWidth = 1.5 + rnd() * 2.6;
    maskCtx.beginPath();
    maskCtx.ellipse(x, y, r, ry, rot, 0, Math.PI * 2);
    maskCtx.stroke();
    maskCtx.fillStyle = `rgba(255, 224, 186, ${0.08 + rnd() * 0.16})`;
    maskCtx.beginPath();
    maskCtx.ellipse(x, y, r * 0.45, ry * 0.45, rot, 0, Math.PI * 2);
    maskCtx.fill();
  }

  // Fine mineral and skeletal grain between the cups.
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 0.35 + rnd() * 2.1;
    const v = rnd() > 0.52 ? 196 + rnd() * 44 : 48 + rnd() * 54;
    ctx.fillStyle = `rgba(${v}, ${v * 0.9}, ${v * 0.7}, ${0.08 + rnd() * 0.26})`;
    ctx.fillRect(x, y, r, r);
    if (v > 190 && rnd() > 0.55) {
      maskCtx.fillStyle = `rgba(255, 238, 205, ${0.08 + rnd() * 0.22})`;
      maskCtx.fillRect(x, y, r, r);
    }
  }

  // Growth striations and sediment-filled crevices.
  for (let i = 0; i < 240; i++) {
    const x = rnd() * size;
    ctx.strokeStyle = `rgba(66, 45, 32, ${0.07 + rnd() * 0.18})`;
    ctx.lineWidth = 0.5 + rnd() * 1.7;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + (rnd() - 0.5) * 30, size * 0.35, x + (rnd() - 0.5) * 30, size * 0.7, x + (rnd() - 0.5) * 12, size);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(colorCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  tex.anisotropy = 4;

  const maskTex = new THREE.CanvasTexture(maskCanvas);
  maskTex.colorSpace = THREE.SRGBColorSpace;
  maskTex.wrapS = maskTex.wrapT = THREE.RepeatWrapping;
  maskTex.anisotropy = 4;

  // Normal map derived from the cup/rim luminance.
  const src = ctx.getImageData(0, 0, size, size).data;
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) {
    height[i] =
      (src[i * 4] * 0.35 + src[i * 4 + 1] * 0.45 + src[i * 4 + 2] * 0.2) / 255;
  }
  const normalCanvas = document.createElement("canvas");
  normalCanvas.width = normalCanvas.height = size;
  const normalCtx = normalCanvas.getContext("2d");
  const normalData = normalCtx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 34.0;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 34.0;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      normalData.data[i] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      normalData.data[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
      normalData.data[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      normalData.data[i + 3] = 255;
    }
  }
  normalCtx.putImageData(normalData, 0, 0);
  const normalTex = new THREE.CanvasTexture(normalCanvas);
  normalTex.wrapS = normalTex.wrapT = THREE.RepeatWrapping;
  normalTex.anisotropy = 4;
  return { color: tex, normal: normalTex, emissive: maskTex };
}

function makeTaperedTube(points, radiusStart, radiusEnd, seed, radialSegments = 7, tubularSegments = 4) {
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.38);
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const positions = [];
  const uvs = [];
  const indices = [];
  const curveLength = curve.getLength();
  const textureMeters = 0.42;
  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments;
    const center = curve.getPointAt(t);
    const normal = frames.normals[i];
    const binormal = frames.binormals[i];
    const radius = lerp(radiusStart, radiusEnd, t);
    for (let j = 0; j <= radialSegments; j++) {
      const angle = (j / radialSegments) * Math.PI * 2;
      const knobs =
        1 +
        0.12 * Math.sin(angle * 3.0 + t * 9.0 + seed * 0.17) +
        0.065 * Math.sin(angle * 7.0 - t * 14.0 + seed * 0.31) +
        0.04 * Math.sin(angle * 13.0 + t * 27.0 - seed * 0.09) +
        0.025 * Math.sin(angle * 23.0 - t * 41.0 + seed * 0.43);
      const rr = radius * knobs;
      positions.push(
        center.x + normal.x * Math.cos(angle) * rr + binormal.x * Math.sin(angle) * rr,
        center.y + normal.y * Math.cos(angle) * rr + binormal.y * Math.sin(angle) * rr,
        center.z + normal.z * Math.cos(angle) * rr + binormal.z * Math.sin(angle) * rr
      );
      // Physical-size UVs keep corallite cups at a consistent real-world
      // scale across thick trunks and thin branch tips.
      uvs.push(
        (angle * radius) / textureMeters,
        (t * curveLength) / textureMeters + seed * 0.013
      );
    }
  }
  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * (radialSegments + 1) + j;
      const b = a + radialSegments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function makeBranchCoral(seed) {
  const rnd = mulberry32(seed);
  const geometries = [];
  const up = new THREE.Vector3(0, 1, 0);

  const perpendicular = (dir) => {
    const helper = Math.abs(dir.y) < 0.88 ? up : new THREE.Vector3(1, 0, 0);
    return helper.clone().cross(dir).normalize();
  };

  function grow(origin, dir, length, radius, depth) {
    const bendA = new THREE.Vector3(
      (rnd() - 0.5) * length * 0.34,
      (rnd() - 0.5) * length * 0.12,
      (rnd() - 0.5) * length * 0.34
    );
    const bendB = new THREE.Vector3(
      (rnd() - 0.5) * length * 0.3,
      (rnd() - 0.5) * length * 0.1,
      (rnd() - 0.5) * length * 0.3
    );
    const end = origin.clone().addScaledVector(dir, length);
    const p0 = origin.clone();
    const p1 = origin.clone().addScaledVector(dir, length * 0.34).add(bendA);
    const p2 = origin.clone().addScaledVector(dir, length * 0.7).add(bendB);
    const curve = new THREE.CatmullRomCurve3([p0, p1, p2, end], false, "catmullrom", 0.36);
    geometries.push(makeTaperedTube([p0, p1, p2, end], radius, radius * 0.46, seed + depth * 7 + length * 9));
    if (depth <= 0) {
      const tip = new THREE.SphereGeometry(radius * 0.5, 6, 4);
      tip.translate(end.x, end.y, end.z);
      geometries.push(tip);
      return;
    }

    const childCount =
      2 + (rnd() > 0.38 ? 1 : 0) + (depth > 1 && rnd() > 0.68 ? 1 : 0);
    for (let i = 0; i < childCount; i++) {
      const axis = perpendicular(dir);
      const second = dir.clone().cross(axis).normalize();
      const angle = rnd() * Math.PI * 2;
      const side = axis.multiplyScalar(Math.cos(angle)).addScaledVector(second, Math.sin(angle));
      const nextDir = dir
        .clone()
        .multiplyScalar(0.64)
        .addScaledVector(side, 0.34 + rnd() * 0.3)
        .addScaledVector(up, 0.14 + rnd() * 0.18)
        .normalize();
      grow(
        end,
        nextDir,
        length * (0.58 + rnd() * 0.18),
        radius * (0.56 + rnd() * 0.1),
        depth - 1
      );
    }

    if (rnd() < 0.44) {
      const t = 0.4 + rnd() * 0.3;
      const point = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      const side = perpendicular(tangent);
      const nextDir = tangent
        .clone()
        .multiplyScalar(0.52)
        .addScaledVector(side, 0.48 + rnd() * 0.26)
        .addScaledVector(up, 0.12)
        .normalize();
      grow(point, nextDir, length * (0.22 + rnd() * 0.12), radius * 0.3, 0);
    }
  }

  const holdfast = new THREE.SphereGeometry(0.085, 8, 6);
  holdfast.scale(1.22, 0.5, 1.12);
  holdfast.translate(0, 0.018, 0);
  geometries.push(holdfast);

  const trunks = 4;
  for (let i = 0; i < trunks; i++) {
    const a = (i / trunks) * Math.PI * 2 + rnd() * 0.48;
    const origin = new THREE.Vector3(Math.cos(a) * 0.065, 0.04, Math.sin(a) * 0.065);
    const dir = new THREE.Vector3(Math.cos(a) * 0.26, 0.97, Math.sin(a) * 0.26).normalize();
    grow(origin, dir, 0.5 + rnd() * 0.24, 0.063 + rnd() * 0.018, 2);
  }

  const merged = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

function makeBrainCoral(seed) {
  const geo = new THREE.IcosahedronGeometry(0.62, 3);
  const pos = geo.attributes.position;
  const rnd = mulberry32(seed);
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`;
    if (!seen.has(key)) {
      const n = 1.0 + Math.sin(x * 16.0) * Math.cos(z * 15.0) * 0.045 + (rnd() - 0.5) * 0.035;
      seen.set(key, n);
    }
    const n = seen.get(key);
    pos.setXYZ(i, x * n, y * 0.52 * n, z * n);
  }
  geo.computeVertexNormals();
  return geo;
}

function makeTableCoral(seed) {
  const rnd = mulberry32(seed);
  const top = new THREE.CylinderGeometry(1, 0.72, 0.12, 12, 1);
  const pos = top.attributes.position;
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`;
    if (!seen.has(key)) {
      const r = 0.85 + 0.35 * Math.sin(Math.atan2(z, x) * 5.0 + rnd() * 0.4) + (rnd() - 0.5) * 0.12;
      seen.set(key, r);
    }
    const r = seen.get(key);
    pos.setXYZ(i, x * r, y + (rnd() - 0.5) * 0.025, z * r);
  }
  const stem = new THREE.CylinderGeometry(0.13, 0.2, 0.7, 6, 1);
  stem.translate(0, 0.34, 0);
  top.translate(0, 0.75, 0);
  top.computeVertexNormals();
  const merged = mergeGeometries([top, stem], false);
  top.dispose();
  stem.dispose();
  return merged;
}

function makeTubeSponges(seed) {
  const rnd = mulberry32(seed);
  const geometries = [];
  for (let i = 0; i < 5; i++) {
    const h = 0.55 + rnd() * 1.35;
    const r = 0.055 + rnd() * 0.09;
    const geo = new THREE.CylinderGeometry(r * 0.82, r, h, 6, 1, true);
    const a = rnd() * Math.PI * 2;
    const rad = rnd() * 0.35;
    geo.translate(Math.cos(a) * rad, h * 0.5, Math.sin(a) * rad);
    geometries.push(geo);
  }
  const merged = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  merged.computeVertexNormals();
  return merged;
}

function makeSeaFan(seed) {
  const rnd = mulberry32(seed);
  const geometries = [];
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  function branch(origin, dir, length, depth) {
    const end = origin.clone().addScaledVector(dir, length);
    const geo = new THREE.CylinderGeometry(0.012 + depth * 0.006, 0.021 + depth * 0.006, length, 4, 1);
    q.setFromUnitVectors(up, dir.clone().normalize());
    geo.applyQuaternion(q);
    const mid = origin.clone().add(end).multiplyScalar(0.5);
    geo.translate(mid.x, mid.y, mid.z);
    geometries.push(geo);
    if (depth <= 0) return;
    for (let i = 0; i < 2; i++) {
      const next = dir
        .clone()
        .add(new THREE.Vector3((i === 0 ? -1 : 1) * (0.37 + rnd() * 0.25), 0.14 + rnd() * 0.2, 0))
        .normalize();
      branch(end, next, length * 0.68, depth - 1);
    }
  }
  branch(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 0.8, 3);
  const merged = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  merged.computeVertexNormals();
  return merged;
}

function makeSeaFanTexture(seed = 83) {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  const rnd = mulberry32(seed);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  function drawBranch(x, y, angle, length, width, depth) {
    const x2 = x + Math.cos(angle) * length;
    const y2 = y + Math.sin(angle) * length;
    const shade = 0.55 + rnd() * 0.45;
    ctx.strokeStyle = `rgba(${Math.floor(175 * shade)}, ${Math.floor(188 * shade)}, ${Math.floor(172 * shade)}, 0.95)`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + Math.cos(angle + 0.1) * length * 0.5,
      y + Math.sin(angle + 0.1) * length * 0.5,
      x2,
      y2
    );
    ctx.stroke();
    if (depth <= 0) {
      ctx.fillStyle = "rgba(220, 228, 208, 0.8)";
      ctx.beginPath();
      ctx.arc(x2, y2, width * 0.9, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const branches = depth > 2 ? 2 : 2 + (rnd() > 0.5 ? 1 : 0);
    for (let i = 0; i < branches; i++) {
      const spread = 0.25 + rnd() * 0.35;
      const dir = i === 0 ? -spread : spread;
      drawBranch(x2, y2, angle + dir, length * (0.62 + rnd() * 0.12), width * 0.68, depth - 1);
    }
  }

  for (let i = 0; i < 9; i++) {
    const startAngle = -Math.PI * 0.5 + (i - 4) * 0.11 + (rnd() - 0.5) * 0.1;
    drawBranch(256 + (rnd() - 0.5) * 30, 500, startAngle, 120 + rnd() * 40, 9, 4);
  }
  // Fine polyps — enough grain to survive alpha test at a distance.
  for (let i = 0; i < 420; i++) {
    const x = 50 + rnd() * 412;
    const y = 60 + rnd() * 380;
    const fade = 1 - Math.abs(x - 256) / 300;
    if (rnd() > fade) continue;
    ctx.fillStyle = `rgba(225, 223, 198, ${0.18 + rnd() * 0.42})`;
    ctx.beginPath();
    ctx.arc(x, y, 0.7 + rnd() * 2.1, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 2;
  return tex;
}

function makeFanBillboardGeometry() {
  const geoA = new THREE.PlaneGeometry(2, 2, 1, 3);
  geoA.translate(0, 1, 0);
  const geoB = geoA.clone();
  geoB.rotateY(Math.PI * 0.5);
  const merged = mergeGeometries([geoA, geoB], false);
  geoA.dispose();
  geoB.dispose();
  return merged;
}

function makeSeaFanMaterial(texture) {
  const mat = injectCaustics(
    new THREE.MeshStandardMaterial({
      map: texture,
      color: 0x7e7464,
      alphaTest: 0.28,
      transparent: false,
      side: THREE.DoubleSide,
      roughness: 0.86,
      metalness: 0.0,
      emissive: 0x170b06,
      emissiveIntensity: 0.2,
    }),
    0.02,
    0xffeecc
  );
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    prev(shader);
    shader.uniforms.uOceanTime = sharedShader.time;
    shader.vertexShader =
      "uniform float uOceanTime;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        /* glsl */ `
          #include <begin_vertex>
          float fanT = uv.y;
          vec3 fanRoot = vec3(0.0);
          #ifdef USE_INSTANCING
            fanRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #endif
          float fanPhase = fanRoot.x * 0.09 + fanRoot.z * 0.07;
          transformed.x += (sin(uOceanTime * 0.72 + fanPhase) * 0.055 + sin(uOceanTime * 1.67 + fanPhase * 2.0) * 0.016) * fanT * fanT;
          transformed.z += cos(uOceanTime * 0.58 + fanPhase) * 0.028 * fanT * fanT;
        `
      );
  };
  mat.customProgramCacheKey = () => "seafan-animated";
  return mat;
}

function makeCoralMaterials() {
  const coral = injectCaustics(
    new THREE.MeshStandardMaterial({
      color: 0x8e7c6a,
      roughness: 0.8,
      metalness: 0.0,
      emissive: 0x0f1f19,
      emissiveIntensity: 0.6,
    }),
    0.06,
    0xffeac6
  );
  const coralDeep = injectCaustics(
    new THREE.MeshStandardMaterial({
      color: 0x687965,
      roughness: 0.9,
      metalness: 0.02,
      emissive: 0x081a15,
      emissiveIntensity: 0.45,
    }),
    0.04,
    0xdcefc8
  );
  const coralPore = makeCoralPoreTexture();
  const branch = injectCaustics(
    new THREE.MeshStandardMaterial({
      map: coralPore.color,
      bumpMap: coralPore.color,
      bumpScale: 0.012,
      normalMap: coralPore.normal,
      normalScale: new THREE.Vector2(1.8, 1.8),
      emissiveMap: coralPore.emissive,
      color: 0xffffff,
      roughness: 0.76,
      metalness: 0.015,
      emissive: 0x6a4932,
      emissiveIntensity: 0.3,
      side: THREE.DoubleSide,
    }),
    0.035,
    0xffeac4
  );
  const branchCaustic = branch.onBeforeCompile;
  branch.onBeforeCompile = (shader) => {
    branchCaustic(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `
        #include <emissivemap_fragment>
        // A little multiple-scattering fill: coral branches should not go
        // black on the side turned away from the surface light.
        totalEmissiveRadiance += diffuseColor.rgb * 0.24;
      `
    );
  };
  branch.customProgramCacheKey = () => "branch-coral-pored-lit";
  return { coral, coralDeep, branch };
}

function instanced(geometry, material, transforms, colors, chunkSize = 0) {
  const createMesh = (indices) => {
    const mesh = new THREE.InstancedMesh(geometry, material, indices.length);
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j];
      mesh.setMatrixAt(j, transforms[i]);
      if (colors) mesh.setColorAt(j, colors[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (colors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // A proper bounding sphere lets the renderer reject whole spatial chunks
    // before vertex processing. This is the difference between submitting
    // every coral on the shelf and submitting only the visible reef.
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    return mesh;
  };

  if (!chunkSize) {
    return createMesh(transforms.map((_, i) => i));
  }

  const buckets = new Map();
  const p = new THREE.Vector3();
  for (let i = 0; i < transforms.length; i++) {
    p.setFromMatrixPosition(transforms[i]);
    const key = `${Math.floor(p.x / chunkSize)}:${Math.floor(p.z / chunkSize)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(i);
  }

  const group = new THREE.Group();
  group.userData.chunked = true;
  for (const [key, indices] of buckets) {
    const mesh = createMesh(indices);
    mesh.userData.chunkKey = key;
    group.add(mesh);
  }
  return group;
}

/**
 * Hide whole fogged/out-of-range instanced chunks. Frustum culling does the
 * rest; this rejects the geometry that is technically in front of the camera
 * but beyond the point where water fog can resolve it.
 */
function cullInstancedChunks(group, camera, distance) {
  const cx = camera.position.x;
  const cz = camera.position.z;
  group.traverse((object) => {
    if (!object.isInstancedMesh || !object.boundingSphere) return;
    const sphere = object.boundingSphere;
    const dx = sphere.center.x - cx;
    const dz = sphere.center.z - cz;
    const nearest = Math.sqrt(dx * dx + dz * dz) - sphere.radius;
    object.visible = nearest < distance;
  });
}

function placeAt(x, z, yOffset = 0) {
  return new THREE.Vector3(x, seabedHeight(x, z) + yOffset, z);
}

export class Reefs {
  constructor(scene, seed = 70521) {
    this.scene = scene;
    this.rnd = mulberry32(seed);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.materials = makeCoralMaterials();
    this.geometries = [];
    this.build();
  }

  build() {
    const rnd = this.rnd;
    const patches = [
      { x: 6, z: 17, r: 8.5, detail: 1.15 },
      { x: 11, z: 31, r: 13, detail: 1 },
      { x: -18, z: 41, r: 12, detail: 1 },
      { x: -24, z: 54, r: 16, detail: 1 },
      { x: 3, z: 47, r: 11, detail: 1.05 },
      { x: 22, z: 59, r: 13, detail: 1 },
      { x: 36, z: 76, r: 20, detail: 1 },
      { x: -52, z: 92, r: 15, detail: 1 },
      { x: 39, z: 4, r: 14, detail: 1 },
      { x: -14, z: -36, r: 15, detail: 1 },
      { x: 84, z: 36, r: 19, detail: 0.8 },
      { x: 5, z: 130, r: 24, detail: 0.8 },
      { x: -91, z: 37, r: 22, detail: 0.8 },
    ];

    while (patches.length < 82) {
      const x = (rnd() - 0.5) * 2500;
      const z = (rnd() - 0.5) * 2500;
      const depth = -seabedHeight(x, z);
      if (depth < 4.2 || depth > 20) continue;
      if (Math.hypot(x, z) < 70) continue;
      const noise = fbm(x * 0.005 + 3.2, z * 0.005 - 7.1, 2);
      if (noise < 0.42) continue;
      patches.push({ x, z, r: 9 + rnd() * 17, detail: 0.5 + rnd() * 0.5 });
    }

    const branchXf = [];
    const branchCol = [];
    const brainXf = [];
    const brainCol = [];
    const spongeXf = [];
    const spongeCol = [];
    const fanXf = [];
    const fanCol = [];
    const softFanXf = [];
    const softFanCol = [];
    const tableXf = [];
    const tableCol = [];

    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const mat = new THREE.Matrix4();
    const color = new THREE.Color();
    const coralPalettes = [0xc77949, 0xb58d50, 0x6f8f5a, 0xd39a55, 0xa25b4a, 0xb4706e, 0x4f8a75, 0xc4733e, 0x9b7f9b];
    const branchPalettes = [0xd0946e, 0xc88162, 0xd9a47b, 0xb9785b, 0xc99876, 0xd7b08a, 0xb98770];
    const spongePalettes = [0xb47d38, 0xc49a4f, 0x8e613f, 0x537f63];
    const fanPalettes = [0xb24b5a, 0xc98155, 0x8c6a46, 0xad8f68, 0xb76d83];

    for (const p of patches) {
      const patchY = seabedHeight(p.x, p.z);
      const depth = -patchY;
      if (depth < 2.8) continue;


      const branches = Math.floor(5 + rnd() * 11 * p.detail);
      for (let i = 0; i < branches; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.sqrt(rnd()) * p.r * 0.92;
        const px = p.x + Math.cos(a) * rr;
        const pz = p.z + Math.sin(a) * rr;
        if (inHeroReef(px, pz)) continue;
        if (nearReferenceCoral(px, pz, 2.3)) continue;
        const h = 0.4 + Math.pow(rnd(), 1.25) * 1.35;
        pos.set(px, seabedHeight(px, pz) + 0.03, pz);
        q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.28, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.28));
        scale.set(h * (0.9 + rnd() * 0.2), h, h * (0.9 + rnd() * 0.2));
        mat.compose(pos, q, scale);
        branchXf.push(mat.clone());
        color
          .setHex(branchPalettes[Math.floor(rnd() * branchPalettes.length)])
          .offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.08);
        branchCol.push(color.clone());
      }

      const brains = Math.floor(3 + rnd() * 8 * p.detail);
      for (let i = 0; i < brains; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.sqrt(rnd()) * p.r * 0.75;
        const px = p.x + Math.cos(a) * rr;
        const pz = p.z + Math.sin(a) * rr;
        if (nearReferenceCoral(px, pz, 2.1)) continue;
        const s = 0.22 + rnd() * 0.68;
        pos.set(px, seabedHeight(px, pz) + s * 0.16, pz);
        q.setFromEuler(new THREE.Euler(0, rnd() * Math.PI * 2, 0));
        scale.set(s, s * (0.55 + rnd() * 0.35), s);
        mat.compose(pos, q, scale);
        brainXf.push(mat.clone());
        color
          .setHex(coralPalettes[Math.floor(rnd() * coralPalettes.length)])
          .offsetHSL(0.015, (rnd() - 0.5) * 0.08, -0.02 + rnd() * 0.05);
        brainCol.push(color.clone());
      }

      const sponges = Math.floor(5 + rnd() * 9 * p.detail);
      for (let i = 0; i < sponges; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.sqrt(rnd()) * p.r * 0.8;
        const px = p.x + Math.cos(a) * rr;
        const pz = p.z + Math.sin(a) * rr;
        if (nearReferenceCoral(px, pz, 2.0)) continue;
        const s = 0.4 + rnd() * 0.8;
        pos.set(px, seabedHeight(px, pz), pz);
        q.setFromEuler(new THREE.Euler(0, rnd() * Math.PI * 2, 0));
        scale.set(s, s * (0.75 + rnd() * 0.8), s);
        mat.compose(pos, q, scale);
        spongeXf.push(mat.clone());
        color.setHex(spongePalettes[Math.floor(rnd() * spongePalettes.length)]);
        spongeCol.push(color.clone());
      }

      const fans = Math.floor(1 + rnd() * 4 * p.detail);
      for (let i = 0; i < fans; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = p.r * (0.3 + rnd() * 0.85);
        const px = p.x + Math.cos(a) * rr;
        const pz = p.z + Math.sin(a) * rr;
        if (nearReferenceCoral(px, pz, 2.2)) continue;
        const s = 0.45 + rnd() * 0.7;
        pos.set(px, seabedHeight(px, pz), pz);
        q.setFromEuler(new THREE.Euler(0, a + (rnd() - 0.5) * 1.2, 0));
        scale.set(s, s, s);
        mat.compose(pos, q, scale);
        fanXf.push(mat.clone());
        color.setHex(fanPalettes[Math.floor(rnd() * fanPalettes.length)]);
        fanCol.push(color.clone());
      }

      const softFans = Math.floor((3 + rnd() * 4) * Math.max(0.7, p.detail));
      for (let i = 0; i < softFans; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = p.r * (0.4 + rnd() * 0.8);
        const px = p.x + Math.cos(a) * rr;
        const pz = p.z + Math.sin(a) * rr;
        if (nearReferenceCoral(px, pz, 2.4)) continue;
        const s = 0.45 + rnd() * 0.8;
        pos.set(px, seabedHeight(px, pz) - 0.08, pz);
        q.setFromEuler(
          new THREE.Euler((rnd() - 0.5) * 0.22, a + (rnd() - 0.5) * 1.4, (rnd() - 0.5) * 0.3)
        );
        scale.set(s * (0.7 + rnd() * 0.5), s * (0.85 + rnd() * 0.6), s);
        mat.compose(pos, q, scale);
        softFanXf.push(mat.clone());
        color
          .setHex(fanPalettes[Math.floor(rnd() * fanPalettes.length)])
          .offsetHSL((rnd() - 0.5) * 0.035, (rnd() - 0.5) * 0.15, (rnd() - 0.5) * 0.08);
        softFanCol.push(color.clone());
      }

      const tables = Math.floor(1 + rnd() * 3 * Math.max(0.6, p.detail));
      for (let i = 0; i < tables; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = p.r * (0.25 + rnd() * 0.8);
        const px = p.x + Math.cos(a) * rr;
        const pz = p.z + Math.sin(a) * rr;
        if (nearReferenceCoral(px, pz, 3.0)) continue;
        const s = 0.5 + rnd() * 0.85;
        pos.set(px, seabedHeight(px, pz) + 0.02, pz);
        q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.12, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.12));
        scale.set(s, s * (0.65 + rnd() * 0.5), s);
        mat.compose(pos, q, scale);
        tableXf.push(mat.clone());
        color
          .setHex(coralPalettes[Math.floor(rnd() * coralPalettes.length)])
          .offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.05);
        tableCol.push(color.clone());
      }
    }

    const branchGeos = [makeBranchCoral(13), makeBranchCoral(42), makeBranchCoral(77)];
    const brainGeo = makeBrainCoral(71);
    this.geometries.push(...branchGeos, brainGeo);

    const chunk = TUNING.visuals.reefChunkSize;

    // Empty fan shells scattered through the meadow: a small, quiet sign of
    // the living reef that also gives the sand a readable scale.
    const shellGeo = makeScallopGeometry();
    const shellTex = makeShellTexture();
    const shellMat = injectCaustics(
      new THREE.MeshStandardMaterial({
        map: shellTex,
        bumpMap: shellTex,
        bumpScale: 0.018,
        color: 0xcfc1a4,
        roughness: 0.56,
        metalness: 0.06,
        emissive: 0x1a1710,
        emissiveIntensity: 0.3,
        side: THREE.DoubleSide,
      }),
      0.02,
      0xffedc4
    );
    const shellXf = [];
    const shellCol = [];
    for (let i = 0; i < 88; i++) {
      const x = -18 + rnd() * 36;
      const z = 9 + rnd() * 24;
      const y = seabedHeight(x, z) + 0.03;
      const s = 0.9 + rnd() * 0.85;
      pos.set(x, y, z);
      q.setFromEuler(
        new THREE.Euler((rnd() - 0.5) * 0.2, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.2)
      );
      scale.set(s, s, s);
      mat.compose(pos, q, scale);
      shellXf.push(mat.clone());
      color
        .setHex([0xd8cbaa, 0xc0aa89, 0xb58e80, 0xd4c19b][Math.floor(rnd() * 4)])
        .offsetHSL((rnd() - 0.5) * 0.025, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.08);
      shellCol.push(color.clone());
    }
    this.group.add(instanced(shellGeo, shellMat, shellXf, shellCol));
    this.geometries.push(shellGeo);


    // Interleave coral variants into three instanced draws.
    for (let v = 0; v < branchGeos.length; v++) {
      const xf = branchXf.filter((_, i) => i % 3 === v);
      const cols = branchCol.filter((_, i) => i % 3 === v);
      if (xf.length) this.group.add(instanced(branchGeos[v], this.materials.branch, xf, cols, chunk));
    }

    this.patches = patches;
  }

  updateCulling(camera) {
    cullInstancedChunks(this.group, camera, TUNING.visuals.reefCullDistance);
  }

  async loadReferenceCorals() {
    const loader = new GLTFLoader();
    this.referenceCorals = [];
    const rnd = this.rnd;

    // Soft contact shadows anchor the scans to the sand. The scene has no
    // shadow map, and a pasted-on coral is one of the fastest ways to read 3D.
    const shadowCanvas = document.createElement("canvas");
    shadowCanvas.width = shadowCanvas.height = 128;
    const shadowCtx = shadowCanvas.getContext("2d");
    const shadowGrad = shadowCtx.createRadialGradient(64, 64, 2, 64, 64, 62);
    shadowGrad.addColorStop(0, "rgba(0,0,0,0.58)");
    shadowGrad.addColorStop(0.55, "rgba(0,0,0,0.26)");
    shadowGrad.addColorStop(1, "rgba(0,0,0,0)");
    shadowCtx.fillStyle = shadowGrad;
    shadowCtx.fillRect(0, 0, 128, 128);
    const shadowTex = new THREE.CanvasTexture(shadowCanvas);
    shadowTex.colorSpace = THREE.SRGBColorSpace;
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      color: 0x07110e,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI * 0.5);

    await Promise.all(
      REFERENCE_CORALS.map(async (def) => {
        try {
          const gltf = await loader.loadAsync(def.url);
          gltf.scene.updateMatrixWorld(true);
          let src = null;
          gltf.scene.traverse((o) => {
            if (o.isMesh && !src) src = o;
          });
          if (!src) throw new Error("no mesh in " + def.url);

          // Bake the scan's transform into local space and center it. The
          // collection's specimens are tiny museum pieces; scale each one to
          // a believable reef size after normalising the bounding box.
          const geo = src.geometry.clone();
          geo.applyMatrix4(src.matrixWorld);
          geo.computeBoundingBox();
          const box = geo.boundingBox;
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          geo.applyMatrix4(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
          geo.computeBoundingBox();
          geo.computeBoundingSphere();

          const srcMat = Array.isArray(src.material) ? src.material[0] : src.material;
          const mat = srcMat.clone();
          mat.roughness = def.roughness;
          mat.metalness = 0.0;
          mat.side = THREE.DoubleSide;
          if (!mat.map) mat.color.setHex(def.tint).multiplyScalar(0.9);
          else {
            mat.color
              .setHex(0xd2c8bf)
              .lerp(new THREE.Color(def.tint), 0.22)
              .multiplyScalar(0.98);
          }
          mat.emissive = new THREE.Color(0x061714);
          mat.emissiveIntensity = 0.22;
          if (mat.map) mat.map.anisotropy = 4;
          if (mat.normalMap) mat.normalMap.anisotropy = 4;
          if (mat.aoMap) mat.aoMap.anisotropy = 4;
          injectCaustics(mat, 0.05, 0xffedc7);
          mat.customProgramCacheKey = () => `reference-coral-${def.id}`;

          const maxDim = Math.max(size.x, size.y, size.z);
          const mesh = new THREE.InstancedMesh(geo, mat, def.placements.length);
          const shadowMesh = new THREE.InstancedMesh(
            shadowGeo,
            shadowMat,
            def.placements.length
          );
          const matrix = new THREE.Matrix4();
          const position = new THREE.Vector3();
          const quaternion = new THREE.Quaternion();
          const scale = new THREE.Vector3();
          const color = new THREE.Color();
          for (let i = 0; i < def.placements.length; i++) {
            const p = def.placements[i];
            const ground = seabedHeight(p.x, p.z);
            const s = (p.size * 1.15) / maxDim;
            quaternion.setFromEuler(
              new THREE.Euler(
                (rnd() - 0.5) * 0.07,
                p.yaw,
                (rnd() - 0.5) * 0.07,
                "YXZ"
              )
            );
            position.set(p.x, ground + size.y * s * 0.5 - 0.14, p.z);
            scale.set(s, s, s);
            matrix.compose(position, quaternion, scale);
            mesh.setMatrixAt(i, matrix);
            color.setHex(0xffffff).offsetHSL((rnd() - 0.5) * 0.02, 0.02, (rnd() - 0.5) * 0.05);
            mesh.setColorAt(i, color);

            position.set(p.x, ground + 0.035, p.z);
            quaternion.setFromEuler(new THREE.Euler(0, p.yaw, 0));
            scale.set(
              p.size * 0.95,
              1,
              p.size * (def.id === "corallium" ? 0.38 : 0.7)
            );
            matrix.compose(position, quaternion, scale);
            shadowMesh.setMatrixAt(i, matrix);
          }
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.computeBoundingSphere();
          mesh.frustumCulled = true;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          shadowMesh.instanceMatrix.needsUpdate = true;
          shadowMesh.computeBoundingSphere();
          shadowMesh.frustumCulled = true;
          this.group.add(shadowMesh);
          this.group.add(mesh);
          this.referenceCorals.push(mesh);
        } catch (err) {
          console.warn("Reference coral failed to load", def.id, err);
        }
      })
    );
  }
}

function bladeGeometry() {
  // Each instance is a small tuft of thin eelgrass ribbons, not one thick
  // reed. This is what gives a meadow its soft, layered look at a distance.
  const positions = [];
  const colors = [];
  const uvs = [];
  const indices = [];
  const rnd = mulberry32(99117);
  // Three blades of four segments still read as a dense tuft under the low-fi
  // grade and cut the grass vertex/triangle load by more than half.
  const blades = 3;
  const segments = 4;

  for (let blade = 0; blade < blades; blade++) {
    const rootAngle = rnd() * Math.PI * 2;
    const ox = Math.cos(rootAngle) * (0.015 + rnd() * 0.11);
    const oz = Math.sin(rootAngle) * (0.015 + rnd() * 0.11);
    const heightScale = 0.58 + rnd() * 0.46;
    const facing = rnd() * Math.PI;
    const dirX = Math.cos(facing);
    const dirZ = Math.sin(facing);
    const halfW = 0.012 + rnd() * 0.011;
    const lean = 0.025 + rnd() * 0.1;
    const twist = (rnd() - 0.5) * 0.65;
    const curl = (rnd() - 0.5) * 0.05;
    const tipSway = (rnd() - 0.5) * 0.1;

    for (let side = 0; side < 2; side++) {
      const baseAngle = facing + side * Math.PI * 0.5;
      const base = positions.length / 3;
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const taper = 0.05 + 0.95 * Math.pow(1 - t, 0.68);
        const width = halfW * taper * (0.88 + 0.16 * Math.sin(t * 19.0 + blade));
        const curve =
          Math.sin(t * Math.PI * 0.62) * lean +
          Math.sin(t * Math.PI * 1.7 + rootAngle) * curl +
          t * t * tipSway;
        const angle = baseAngle + twist * t;
        const ax = Math.cos(angle);
        const az = Math.sin(angle);
        const y = t * heightScale;
        const cx = ox + dirX * curve + ax * width;
        const cz = oz + dirZ * curve + az * width;
        const cx2 = ox + dirX * curve - ax * width;
        const cz2 = oz + dirZ * curve - az * width;
        positions.push(cx, y, cz, cx2, y, cz2);
        uvs.push(0, t, 1, t);
        // Dark, cold roots; sunlit jade tips.
        const rootShade = 0.52 + t * 0.64;
        colors.push(
          rootShade * 0.62,
          rootShade * 0.84,
          rootShade * 0.6,
          rootShade * 0.66,
          rootShade * 0.88,
          rootShade * 0.62
        );
      }
      for (let i = 0; i < segments; i++) {
        const a = base + i * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function makeSeagrassTexture() {
  const w = 256;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e1e1cf";
  ctx.fillRect(0, 0, w, h);
  const rnd = mulberry32(9137);

  // Longitudinal veins and the odd split/crease.
  for (let i = 0; i < 34; i++) {
    const x = 8 + rnd() * (w - 16);
    ctx.strokeStyle = `rgba(${70 + Math.floor(rnd() * 45)}, ${82 + Math.floor(rnd() * 40)}, ${52 + Math.floor(rnd() * 35)}, ${0.12 + rnd() * 0.24})`;
    ctx.lineWidth = 0.6 + rnd() * 2.2;
    ctx.beginPath();
    for (let y = 0; y <= h; y += 24) {
      const xx = x + Math.sin(y * 0.021 + i * 1.7) * (2 + rnd() * 3);
      if (y === 0) ctx.moveTo(xx, y);
      else ctx.lineTo(xx, y);
    }
    ctx.stroke();
  }

  // Epiphyte / diatom mottling and pale encrusting specks.
  for (let i = 0; i < 380; i++) {
    const x = 8 + rnd() * (w - 16);
    const y = 10 + rnd() * (h - 20);
    const r = 0.8 + rnd() * 5.5;
    ctx.fillStyle = `rgba(${92 + Math.floor(rnd() * 50)}, ${78 + Math.floor(rnd() * 35)}, ${44 + Math.floor(rnd() * 26)}, ${0.08 + rnd() * 0.22})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.55, r * 1.4, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 900; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    ctx.fillStyle = `rgba(230, 230, 205, ${0.15 + rnd() * 0.28})`;
    ctx.fillRect(x, y, 0.8 + rnd() * 1.8, 0.8 + rnd() * 2.4);
  }
  // Darker root end.
  const grad = ctx.createLinearGradient(0, h * 0.78, 0, h);
  grad.addColorStop(0, "rgba(40, 45, 24, 0)");
  grad.addColorStop(1, "rgba(35, 38, 20, 0.34)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, h * 0.78, w, h * 0.22);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeSeagrassMaterial() {
  const grassTexture = makeSeagrassTexture();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb8cdb1,
    map: grassTexture,
    bumpMap: grassTexture,
    bumpScale: 0.025,
    roughness: 0.7,
    metalness: 0.0,
    vertexColors: true,
    side: THREE.DoubleSide,
    emissive: 0x071f14,
    emissiveIntensity: 0.6,
  });
  injectCaustics(mat, 0.04, 0xddffcf);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    prev(shader);
    shader.uniforms.uOceanTime = sharedShader.time;
    shader.vertexShader =
      /* glsl */ `
        uniform float uOceanTime;
        varying float vGrassT;
      ` +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        /* glsl */ `
          #include <begin_vertex>
          float bladeT = uv.y;
          vGrassT = bladeT;
          vec3 rootWorld = vec3(0.0);
          #ifdef USE_INSTANCING
            rootWorld = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #else
            rootWorld = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #endif
          float phase = rootWorld.x * 0.115 + rootWorld.z * 0.09;
          float sway = sin(uOceanTime * 0.86 + phase) * 0.14;
          sway += sin(uOceanTime * 2.21 + phase * 1.73) * 0.032;
          float bend = bladeT * bladeT;
          transformed.x += sway * bend;
          transformed.z += cos(uOceanTime * 0.71 + phase * 1.2) * bend * 0.09;
        `
      );
    shader.fragmentShader =
      /* glsl */ `
        varying float vGrassT;
        ${glslNoise}
      ` +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        /* glsl */ `
          #include <color_fragment>
          float bladeMottle = fbm2(vCausticWorld.xz * 7.0 + vCausticWorld.y * 2.5 + 11.0);
          float bladeBrown = smoothstep(0.62, 0.92, fbm2(vCausticWorld.xz * 16.0 + 3.0 + vGrassT * 3.0));
          diffuseColor.rgb *= 0.76 + bladeMottle * 0.45;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.16, 0.08), bladeBrown * (0.15 + vGrassT * 0.35));
          float bladeSpecks = smoothstep(0.82, 0.95, vnoise(vCausticWorld.xz * 55.0 + vGrassT * 12.0));
          diffuseColor.rgb += vec3(0.08, 0.08, 0.05) * bladeSpecks;
        `
      );
  };
  mat.customProgramCacheKey = () => "seagrass-animated";
  return mat;
}

export class Seagrass {
  constructor(scene, seed = 31007) {
    this.scene = scene;
    this.rnd = mulberry32(seed);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.material = makeSeagrassMaterial();
    this.geometry = bladeGeometry();
    this.build();
  }

  build() {
    const rnd = this.rnd;
    const transforms = [];
    const colors = [];
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const dark = new THREE.Color(0x1c4a36);
    const light = new THREE.Color(0x728b5c);
    const dead = new THREE.Color(0x66563a);

    const nearMeadows = [
      { x: -6, z: 25, r: 27, n: 6200 },
      { x: 8, z: 55, r: 31, n: 2400 },
      { x: 23, z: 49, r: 20, n: 1200 },
      { x: -35, z: 53, r: 18, n: 720 },
      { x: 52, z: 31, r: 17, n: 480 },
      { x: -4, z: 84, r: 26, n: 1150 },
      { x: 74, z: 104, r: 26, n: 400 },
      { x: -66, z: 8, r: 19, n: 380 },
      { x: 12, z: -20, r: 17, n: 410 },
      { x: 96, z: 73, r: 23, n: 350 },
      { x: -88, z: 124, r: 25, n: 360 },
      { x: -4, z: 16, r: 17, n: 1100 },
    ];
    const meadows = nearMeadows.slice();
    while (meadows.length < 72) {
      const x = (rnd() - 0.5) * 2450;
      const z = (rnd() - 0.5) * 2450;
      const depth = -seabedHeight(x, z);
      if (depth < 2.8 || depth > 13.5) continue;
      meadows.push({ x, z, r: 10 + rnd() * 24, n: 80 + rnd() * 220 });
    }

    for (const meadow of meadows) {
      for (let i = 0; i < meadow.n; i++) {
        const a = rnd() * Math.PI * 2;
        const radius = Math.sqrt(rnd()) * meadow.r;
        const x = meadow.x + Math.cos(a) * radius * (0.7 + rnd() * 0.6);
        const z = meadow.z + Math.sin(a) * radius * (0.7 + rnd() * 0.6);
        if (nearReferenceCoral(x, z, 1.7)) continue;
        const y = seabedHeight(x, z);
        const depth = -y;
        if (depth < 2.1 || depth > 15.5) continue;
        const density = fbm(x * 0.042 + 4.3, z * 0.042 - 8.7, 2);
        if (density < 0.34 && rnd() > 0.18) continue;
        const height = 0.24 + Math.pow(rnd(), 1.35) * 0.95;
        const width = 0.62 + rnd() * 0.62;
        p.set(x, y - 0.02, z);
        q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.12, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.12));
        s.set(width, height, width);
        m.compose(p, q, s);
        transforms.push(m.clone());
        const shade = clamp(0.18 + rnd() * 0.68 + (13.5 - depth) * 0.02, 0, 1);
        c.copy(dark).lerp(light, shade);
        if (rnd() < 0.18) c.lerp(dead, 0.35 + rnd() * 0.35);
        c.offsetHSL((rnd() - 0.5) * 0.025, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.1);
        colors.push(c.clone());
      }
    }

    this.mesh = instanced(
      this.geometry,
      this.material,
      transforms,
      colors,
      TUNING.visuals.grassChunkSize
    );
    this.group.add(this.mesh);
    this.count = transforms.length;
  }

  updateCulling(camera) {
    cullInstancedChunks(this.group, camera, TUNING.visuals.grassCullDistance);
  }
}

export class SunShafts {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    this.scene.add(this.group);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: sharedShader.time,
        uColor: { value: new THREE.Color(0xffe6bd) },
        uOpacity: { value: 0.15 },
        uFogDensity: { value: TUNING.visuals.underwaterDensity },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vDepth;
        void main() {
          vUv = uv;
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vNormal = normalize(mat3(modelMatrix) * normal);
          vec4 mv = viewMatrix * world;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vDepth;
        ${glslNoise}
        void main() {
          float endFade = smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
          float edge = 0.45 + 0.55 * pow(1.0 - abs(vNormal.y), 0.6);
          float bands = vnoise(vec2(vUv.x * 11.0 + vWorld.z * 0.03, vUv.y * 2.2 + uTime * 0.07));
          bands = smoothstep(0.36, 0.8, bands);
          float shimmer = 0.55 + 0.45 * sin(vWorld.x * 0.35 + vWorld.z * 0.27 + uTime * 0.5);
          float nearFade = smoothstep(2.5, 13.0, vDepth);
          float farFade = smoothstep(85.0, 25.0, vDepth);
          float alpha = uOpacity * endFade * edge * (0.25 + bands * 0.9) * shimmer * nearFade * farFade;
          float fog = exp(-uFogDensity * uFogDensity * vDepth * vDepth);
          gl_FragColor = vec4(uColor, alpha * fog);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.beams = [];
    const sunDir = new THREE.Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize();
    this.axis = sunDir.clone().multiplyScalar(-1);
    this.quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.axis);
    for (let i = 0; i < 15; i++) {
      const geo = new THREE.CylinderGeometry(1.4 + Math.random() * 3.5, 6 + Math.random() * 11, 30 + Math.random() * 26, 12, 7, true);
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      mesh.userData.anchor = new THREE.Vector3(
        (Math.random() - 0.5) * 190,
        -12 - Math.random() * 11,
        (Math.random() - 0.5) * 190
      );
      this.group.add(mesh);
      this.beams.push(mesh);
    }
  }

  update(camera, time, underwater) {
    this.group.visible = underwater > 0.4;
    if (!this.group.visible) return;
    for (let i = 0; i < this.beams.length; i++) {
      const beam = this.beams[i];
      const anchor = beam.userData.anchor;
      const x = camera.position.x + anchor.x + Math.sin(time * 0.014 + i) * 10;
      const z = camera.position.z + anchor.z + Math.cos(time * 0.011 + i * 1.9) * 10;
      beam.position.set(x, anchor.y, z);
      beam.quaternion.copy(this.quat);
      beam.rotateY(Math.sin(time * 0.01 + i) * 0.12);
    }
    this.material.uniforms.uOpacity.value = 0.05;
  }
}

/**
 * A scallop shell and a startled crab, buried in the surface sand. Their
 * exposure is driven by the actual height field, not a trigger volume.
 */
function makeShellTexture() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#c8b895";
  ctx.fillRect(0, 0, size, size);
  const rnd = mulberry32(7723);

  // Radiating ribs.
  for (let i = 0; i < 64; i++) {
    const x = (i / 64) * size;
    const shade = 0.72 + 0.28 * Math.sin(i * 1.7 + rnd() * 2.0);
    ctx.strokeStyle = `rgba(${Math.floor(116 * shade)}, ${Math.floor(104 * shade)}, ${Math.floor(78 * shade)}, ${0.18 + rnd() * 0.35})`;
    ctx.lineWidth = 0.7 + rnd() * 3.2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + 6, size * 0.35, x - 5, size * 0.7, x + (rnd() - 0.5) * 12, size);
    ctx.stroke();
  }
  // Concentric growth bands.
  for (let j = 0; j < 30; j++) {
    const y = (j / 30) * size + rnd() * 12;
    ctx.strokeStyle = `rgba(92, 79, 58, ${0.08 + rnd() * 0.18})`;
    ctx.lineWidth = 0.6 + rnd() * 1.6;
    ctx.beginPath();
    for (let x = 0; x <= size; x += 16) {
      const yy = y + Math.sin(x * 0.035 + j) * (2 + j * 0.15);
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  // Mineral mottling and perforations.
  for (let i = 0; i < 900; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 0.5 + rnd() * 4.5;
    ctx.fillStyle = rnd() > 0.5
      ? `rgba(230, 218, 183, ${0.05 + rnd() * 0.2})`
      : `rgba(74, 63, 46, ${0.05 + rnd() * 0.2})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

export function makeScallopGeometry() {
  const positions = [];
  const indices = [];
  const uvs = [];
  const rings = 9;
  const segs = 64;
  const arc = Math.PI * 0.9;
  for (let ring = 0; ring <= rings; ring++) {
    const rad = ring / rings;
    for (let i = 0; i <= segs; i++) {
      const a = -arc * 0.5 + (i / segs) * arc;
      const ribs = Math.sin(a * 39 + Math.sin(rad * 9) * 1.2);
      const ridge = Math.pow(Math.abs(ribs), 1.8);
      const scallop = 1 + Math.sin(a * 17 + rad * 8) * 0.035 * rad;
      const height =
        0.014 * (1 - rad * 0.34) +
        ridge * 0.011 * rad +
        Math.sin(rad * 27) * 0.0022 * (1 - rad);
      positions.push(
        Math.cos(a) * rad * 0.2 * scallop,
        height,
        Math.sin(a) * rad * 0.2 * scallop
      );
      uvs.push(i / segs, rad);
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let i = 0; i < segs; i++) {
      const a = ring * (segs + 1) + i;
      const b = a + 1;
      const c = a + segs + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export class HiddenThings {
  constructor(scene, sand, onDiscover) {
    this.scene = scene;
    this.sand = sand;
    this.onDiscover = onDiscover;
    this.rnd = mulberry32(44219);
    this.shellGeo = makeScallopGeometry();
    const shellTex = makeShellTexture();
    this.shellMat = new THREE.MeshStandardMaterial({
      map: shellTex,
      bumpMap: shellTex,
      bumpScale: 0.014,
      color: 0xd8c59e,
      roughness: 0.54,
      metalness: 0.12,
      emissive: 0x2f2719,
      emissiveIntensity: 0.5,
      side: THREE.DoubleSide,
    });
    this.shells = [];
    const places = [
      [5, 17], [12, 25], [-7, 23], [16, 38], [-14, 41],
      [28, 51], [-25, 62], [4, 47], [36, 23], [-31, 38],
      [21, 78], [-7, 96],
    ];
    for (const [x, z] of places) {
      const y = seabedHeight(x, z);
      const group = new THREE.Group();
      const shell = new THREE.Mesh(this.shellGeo, this.shellMat);
      shell.rotation.x = (this.rnd() - 0.5) * 0.08;
      shell.rotation.z = (this.rnd() - 0.5) * 0.08;
      group.add(shell);
      const hinge = new THREE.Mesh(
        new THREE.SphereGeometry(0.024, 7, 5),
        new THREE.MeshStandardMaterial({ color: 0xa9835c, roughness: 0.65 })
      );
      hinge.position.set(0, 0.006, -0.084);
      group.add(hinge);
      const buried = 0.11 + this.rnd() * 0.22;
      group.position.set(x, y - buried, z);
      group.rotation.y = this.rnd() * Math.PI * 2;
      group.userData = { baseY: y, buried, exposed: false, discovered: false };
      this.scene.add(group);
      this.shells.push(group);
    }

    this.crab = this._makeCrab();
    const crabX = -3;
    const crabZ = 13;
    this.crabBaseY = seabedHeight(crabX, crabZ);
    this.crab.position.set(crabX, this.crabBaseY - 0.22, crabZ);
    this.crab.userData = { awake: false, exposed: false, discovered: false, speed: 0.45, dir: 1 };
    this.scene.add(this.crab);
    this.lastPlayer = new THREE.Vector3();
  }

  _makeCrab() {
    const group = new THREE.Group();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#8e4a3a";
    ctx.fillRect(0, 0, 256, 256);
    const rnd = mulberry32(9241);
    for (let i = 0; i < 900; i++) {
      const x = rnd() * 256;
      const y = rnd() * 256;
      const r = 0.6 + rnd() * 5;
      ctx.fillStyle = rnd() > 0.48
        ? `rgba(${130 + Math.floor(rnd() * 55)}, ${56 + Math.floor(rnd() * 34)}, ${40 + Math.floor(rnd() * 22)}, ${0.08 + rnd() * 0.3})`
        : `rgba(${52 + Math.floor(rnd() * 30)}, ${26 + Math.floor(rnd() * 20)}, ${18 + Math.floor(rnd() * 14)}, ${0.08 + rnd() * 0.28})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.7, r * 1.2, rnd() * 3.0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 40; i++) {
      ctx.strokeStyle = `rgba(225, 166, 113, ${0.12 + rnd() * 0.22})`;
      ctx.lineWidth = 0.6 + rnd();
      ctx.beginPath();
      const x = rnd() * 256;
      const y = rnd() * 256;
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rnd() - 0.5) * 35, y + (rnd() - 0.5) * 35);
      ctx.stroke();
    }
    const crabTex = new THREE.CanvasTexture(canvas);
    crabTex.colorSpace = THREE.SRGBColorSpace;
    crabTex.anisotropy = 4;
    const bodyMat = injectCaustics(
      new THREE.MeshStandardMaterial({
        map: crabTex,
        bumpMap: crabTex,
        bumpScale: 0.012,
        color: 0xe1c4ad,
        roughness: 0.56,
        metalness: 0.04,
        emissive: 0x1c0905,
        emissiveIntensity: 0.22,
      }),
      0.02,
      0xffe4bd
    );
    const legMat = injectCaustics(
      new THREE.MeshStandardMaterial({
        map: crabTex,
        bumpMap: crabTex,
        bumpScale: 0.01,
        color: 0xc9957c,
        roughness: 0.7,
        metalness: 0.03,
        emissive: 0x160806,
        emissiveIntensity: 0.2,
      }),
      0.02,
      0xffe4bd
    );
    const up = new THREE.Vector3(0, 1, 0);
    const limb = (a, b, r1, r2, material) => {
      const dir = b.clone().sub(a);
      const len = dir.length();
      const geo = new THREE.CylinderGeometry(r2, r1, len, 9, 1);
      geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.normalize()));
      geo.translate((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
      const mesh = new THREE.Mesh(geo, material);
      group.add(mesh);
      return mesh;
    };

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.12, 28, 16), bodyMat);
    body.scale.set(1.35, 0.5, 0.95);
    group.add(body);

    // Two-segment walking legs with knuckles.
    for (let i = 0; i < 8; i++) {
      const side = i < 4 ? -1 : 1;
      const row = i % 4;
      const hip = new THREE.Vector3(side * 0.12, -0.008, -0.09 + row * 0.058);
      const knee = new THREE.Vector3(
        side * (0.235 + rnd() * 0.035),
        0.045 + rnd() * 0.018,
        hip.z - 0.015 + rnd() * 0.03
      );
      const foot = new THREE.Vector3(side * (0.32 + rnd() * 0.04), -0.115, hip.z + 0.02);
      limb(hip, knee, 0.012, 0.008, legMat);
      limb(knee, foot, 0.009, 0.005, legMat);
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 7), legMat);
      joint.position.copy(knee);
      group.add(joint);
    }

    // Claw arms and pincers.
    for (let s = 0; s < 2; s++) {
      const side = s ? 1 : -1;
      const shoulder = new THREE.Vector3(side * 0.09, 0.025, 0.1);
      const elbow = new THREE.Vector3(side * 0.18, 0.01, 0.21);
      const wrist = new THREE.Vector3(side * 0.22, 0.02, 0.3);
      limb(shoulder, elbow, 0.017, 0.014, bodyMat);
      limb(elbow, wrist, 0.014, 0.02, bodyMat);
      const palm = new THREE.Mesh(new THREE.SphereGeometry(0.048, 14, 9), bodyMat);
      palm.position.copy(wrist);
      palm.scale.set(0.82, 0.48, 1.25);
      group.add(palm);
      const fingerA = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.018, 0.1, 8), legMat);
      fingerA.position.set(wrist.x, wrist.y + 0.02, wrist.z + 0.075);
      fingerA.rotation.x = Math.PI * 0.5;
      group.add(fingerA);
      const fingerB = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.015, 0.09, 8), legMat);
      fingerB.position.set(wrist.x, wrist.y - 0.018, wrist.z + 0.07);
      fingerB.rotation.x = Math.PI * 0.5;
      group.add(fingerB);
    }

    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x080a08 });
    for (let s = 0; s < 2; s++) {
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.007, 0.05, 7), legMat);
      stalk.position.set((s ? 1 : -1) * 0.04, 0.075, 0.1);
      stalk.rotation.z = (s ? 1 : -1) * 0.25;
      group.add(stalk);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 9, 7), eyeMat);
      eye.position.set((s ? 1 : -1) * 0.046, 0.1, 0.1);
      group.add(eye);
    }

    group.scale.setScalar(0.8);
    return group;
  }

  update(dt, player, effects) {
    this.lastPlayer.copy(player.position);
    let nearby = false;
    for (const shell of this.shells) {
      const x = shell.position.x;
      const z = shell.position.z;
      const sandTop = seabedHeight(x, z) + this.sand.sampleDelta(x, z);
      const exposed = sandTop < shell.userData.baseY - 0.035;
      shell.userData.exposed = exposed;
      if (exposed) {
        // Settle onto the freshly excavated surface and catch a little light.
        shell.position.y = Math.max(sandTop + 0.008, shell.userData.baseY - 0.28);
      } else {
        shell.position.y = shell.userData.baseY - shell.userData.buried;
      }
      const dist = Math.hypot(player.position.x - x, player.position.z - z);
      if (exposed && dist < 8) {
        nearby = true;
        if (!shell.userData.discovered) {
          shell.userData.discovered = true;
          this.onDiscover?.("shell uncovered", "a fan shell, still cold from the sand");
          effects?.bubbleBurst(x, shell.position.y + 0.1, z, 4, 0.25, 0.4);
        }
      }
    }

    const crab = this.crab;
    const cx = crab.position.x;
    const cz = crab.position.z;
    const sandTop = seabedHeight(cx, cz) + this.sand.sampleDelta(cx, cz);
    const crabExposed = sandTop < this.crabBaseY - 0.08;
    if (crabExposed && !crab.userData.awake) {
      crab.userData.awake = true;
      crab.position.y = sandTop + 0.08;
    }
    if (crab.userData.awake) {
      // Scuttle sideways, away from the enormous grey thing.
      const awayX = cx - player.position.x;
      const awayZ = cz - player.position.z;
      const dl = Math.hypot(awayX, awayZ) || 1;
      crab.userData.dir *= Math.sin(this.sand.time * 0.8) > 0 ? 1 : -1;
      const nx = cx + (awayX / dl) * 0.38 * dt * (0.8 + Math.sin(this.sand.time * 3) * 0.25);
      const nz = cz + (awayZ / dl) * 0.38 * dt * (0.8 + Math.cos(this.sand.time * 2) * 0.25);
      const tx = seabedHeight(nx, nz) + this.sand.sampleDelta(nx, nz) + 0.07;
      crab.position.set(nx, lerp(crab.position.y, tx, 0.3), nz);
      crab.rotation.y = Math.atan2(awayX, awayZ) + Math.PI * 0.5 * crab.userData.dir;
      crab.position.y += Math.sin(this.sand.time * 15) * 0.005;
      const dist = Math.hypot(player.position.x - nx, player.position.z - nz);
      if (dist < 7 && !crab.userData.discovered) {
        crab.userData.discovered = true;
        this.onDiscover?.("crab disturbed", "it was under there the whole time");
        effects?.bubbleBurst(nx, crab.position.y + 0.1, nz, 3, 0.3, 0.5);
      }
    } else {
      crab.position.y = this.crabBaseY - 0.22;
    }
    return { nearby };
  }
}
