import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TUNING, PALETTE, WATER_OPAQUE_DISTANCE } from "./config.js";
import {
  clamp,
  fbm,
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

// Photogrammetry specimens from the NMNH coral collection: the only corals on
// the seabed, placed on the opening patch reef near the start.
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
      ` +
      shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `
          #include <emissivemap_fragment>
          // Even light from above. The moving net of bright lines is laid
          // over every surface in post, so it lines up across sand and coral.
          float caustic = 2.3;
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
 *
 * `reach` is an exact limit on top of that: a chunk whose bounding sphere is
 * wholly farther than it from the camera (in 3D) draws nothing that can show,
 * so it is skipped. With the camera fully under water that is
 * WATER_OPAQUE_DISTANCE (past it along a ray the water column replaces the
 * scene outright); seagrass has a shorter one of its own, GRASS_SHRINK_END.
 */
function cullInstancedChunks(group, camera, distance, reach = Infinity) {
  const cx = camera.position.x;
  const cy = camera.position.y;
  const cz = camera.position.z;
  group.traverse((object) => {
    if (!object.isInstancedMesh || !object.boundingSphere) return;
    const sphere = object.boundingSphere;
    const dx = sphere.center.x - cx;
    const dz = sphere.center.z - cz;
    const nearest = Math.sqrt(dx * dx + dz * dz) - sphere.radius;
    let visible = nearest < distance;
    if (visible && reach < Infinity) {
      const dy = sphere.center.y - cy;
      visible = Math.sqrt(dx * dx + dy * dy + dz * dz) - sphere.radius < reach;
    }
    object.visible = visible;
  });
}

export class Reefs {
  constructor(scene, seed = 70521) {
    this.scene = scene;
    this.rnd = mulberry32(seed);
    this.group = new THREE.Group();
    this.scene.add(this.group);
  }

  updateCulling(camera, fullyUnderwater = false) {
    // (The metre past the limit is only a safety margin: the sphere holds
    // the whole coral, so all of it is farther than that.)
    const reach = fullyUnderwater ? WATER_OPAQUE_DISTANCE + 1 : Infinity;
    cullInstancedChunks(this.group, camera, TUNING.visuals.reefCullDistance, reach);
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
          if (mat.map) mat.map.anisotropy = 16;
          if (mat.normalMap) mat.normalMap.anisotropy = 16;
          if (mat.aoMap) mat.aoMap.anisotropy = 16;
          injectCaustics(mat, 0.05, 0xffedc7);
          mat.customProgramCacheKey = () => `reference-coral-${def.id}`;

          const maxDim = Math.max(size.x, size.y, size.z);
          // One mesh per placement (each a 100k-triangle scan), so the
          // renderer can skip each coral that is out of view or past the
          // water's visibility on its own, not all of a kind together.
          const meshes = def.placements.map(() => new THREE.InstancedMesh(geo, mat, 1));
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
            meshes[i].setMatrixAt(0, matrix);
            color.setHex(0xffffff).offsetHSL((rnd() - 0.5) * 0.02, 0.02, (rnd() - 0.5) * 0.05);
            meshes[i].setColorAt(0, color);

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
          shadowMesh.instanceMatrix.needsUpdate = true;
          shadowMesh.computeBoundingSphere();
          shadowMesh.frustumCulled = true;
          this.group.add(shadowMesh);
          for (const mesh of meshes) {
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            mesh.computeBoundingSphere();
            mesh.frustumCulled = true;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            this.group.add(mesh);
            this.referenceCorals.push(mesh);
          }
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
  // Seven single ribbons of three segments, splayed out from the root the
  // way a shoot of seagrass lies over in the surge. More, shorter, thinner
  // blades for about the same triangle count as four crossed ones: a meadow
  // in a photograph is a shaggy mat of leaves, not a stand of reeds.
  const blades = 7;
  const segments = 3;

  for (let blade = 0; blade < blades; blade++) {
    const rootAngle = rnd() * Math.PI * 2;
    const ox = Math.cos(rootAngle) * (0.02 + rnd() * 0.16);
    const oz = Math.sin(rootAngle) * (0.02 + rnd() * 0.16);
    const heightScale = 0.58 + rnd() * 0.46;
    const facing = rnd() * Math.PI;
    const dirX = Math.cos(facing);
    const dirZ = Math.sin(facing);
    const halfW = 0.015 + rnd() * 0.013;
    const lean = 0.1 + rnd() * 0.34;
    const twist = (rnd() - 0.5) * 0.65;
    const curl = (rnd() - 0.5) * 0.05;
    const tipSway = (rnd() - 0.5) * 0.1;

    for (let side = 0; side < 1; side++) {
      const baseAngle = facing + Math.PI * 0.5 + (rnd() - 0.5) * 0.9;
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
        const rootShade = 0.6 + t * 0.62;
        colors.push(
          rootShade * 0.66,
          rootShade * 0.92,
          rootShade * 0.42,
          rootShade * 0.7,
          rootShade * 0.94,
          rootShade * 0.44
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
  tex.anisotropy = 16;
  return tex;
}

// Seagrass tufts shrink away between these distances from the camera
// (metres, from the tuft's root): past the far one a tuft is a point.
const GRASS_SHRINK_START = 14;
const GRASS_SHRINK_END = 28;

function makeSeagrassMaterial() {
  const grassTexture = makeSeagrassTexture();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd2dcb8,
    map: grassTexture,
    bumpMap: grassTexture,
    bumpScale: 0.025,
    roughness: 0.7,
    metalness: 0.0,
    vertexColors: true,
    side: THREE.DoubleSide,
    emissive: 0x16330f,
    emissiveIntensity: 0.8,
  });
  injectCaustics(mat, 0.05, 0xf0ffd0);
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
          // Blades thinner than a pixel only alias into specks: past a
          // few tens of metres they shrink away and the meadow colour on
          // the sand carries the field. Past the far distance a tuft is a
          // point and draws nothing, so whole chunks beyond it are not
          // drawn at all (Seagrass.updateCulling).
          float grassDist = distance(rootWorld, cameraPosition);
          transformed *= 1.0 - smoothstep(${GRASS_SHRINK_START.toFixed(1)}, ${GRASS_SHRINK_END.toFixed(1)}, grassDist);
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
          // Past ten metres or so a blade is only a pixel or two wide; its
          // colour settles toward the meadow's mean so the field reads as a
          // soft mat instead of a scatter of bright specks.
          float bladeFar = smoothstep(7.0, 22.0, distance(vCausticWorld, cameraPosition));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.32, 0.1), bladeFar * 0.6);
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
    // Sunlit eelgrass in clear shallow water is a bright yellow-green at
    // the tips over darker olive roots.
    const dark = new THREE.Color(0x2c5532);
    const light = new THREE.Color(0x9fb75a);
    const dead = new THREE.Color(0x7a6a42);

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
    // Denser blades in the meadows the player starts among.
    for (let i = 0; i < nearMeadows.length; i++) meadows[i] = { ...meadows[i], n: Math.round(meadows[i].n * 3.0) };

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
        const height = 0.2 + Math.pow(rnd(), 1.5) * 0.62;
        const width = 0.7 + rnd() * 0.6;
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

  updateCulling(camera, fullyUnderwater = false) {
    // Every tuft past GRASS_SHRINK_END has shrunk to a point (see the
    // material), above water or below, so a chunk wholly beyond it draws
    // nothing. The metre past it covers a tuft's root lying up to ~0.3 m
    // outside the chunk's bounding sphere. (Under water the opaque distance
    // is farther, so this limit is the one that counts.)
    const reach = Math.min(GRASS_SHRINK_END + 1, fullyUnderwater ? WATER_OPAQUE_DISTANCE + 1 : Infinity);
    cullInstancedChunks(this.group, camera, TUNING.visuals.grassCullDistance, reach);
  }
}

function paintGeometry(geo, color) {
  const count = geo.attributes.position.count;
  const data = new Float32Array(count * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < count; i++) {
    data[i * 3] = c.r;
    data[i * 3 + 1] = c.g;
    data[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(data, 3));
  return geo;
}

function finGeometry(vertices, color) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(vertices.length / 3 * 2), 2));
  geo.computeVertexNormals();
  paintGeometry(geo, color);
  return geo;
}

function fishGeometry() {
  const parts = [];
  const belly = new THREE.Color(0xd7ddca);
  const flank = new THREE.Color(0x91aba1);
  const back = new THREE.Color(0x617c76);
  const fin = new THREE.Color(0x7c968c);

  const body = new THREE.SphereGeometry(1, 12, 8);
  body.scale(0.105, 0.19, 0.52);
  const bp = body.attributes.position;
  const colors = new Float32Array(bp.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < bp.count; i++) {
    const y = bp.getY(i);
    const z = bp.getZ(i);
    const t = clamp((y + 0.16) / 0.34, 0, 1);
    c.copy(belly).lerp(flank, t).lerp(back, smoothstep(0.42, 0.95, t) * 0.45);
    // A faint lateral line and a slightly darker gill band.
    c.multiplyScalar(1 - (1 - smoothstep(0.006, 0.04, Math.abs(y + 0.01))) * 0.09);
    c.multiplyScalar(1 - smoothstep(0.12, 0.02, Math.abs(z - 0.18)) * 0.05);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  body.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  parts.push(body.index ? body.toNonIndexed() : body);

  // Forked caudal fin, dorsal, anal and pectoral fins.
  parts.push(finGeometry([
    0, 0, -0.43, 0, 0.2, -0.8, 0, 0, -0.65,
    0, 0, -0.43, 0, 0, -0.65, 0, -0.2, -0.8,
  ], fin));
  parts.push(finGeometry([
    0, 0.15, 0.18, 0, 0.29, -0.08, 0, 0.1, -0.3,
  ], fin));
  parts.push(finGeometry([
    0, -0.12, -0.03, 0, -0.24, -0.25, 0, -0.08, -0.36,
  ], fin));
  parts.push(finGeometry([
    -0.095, -0.01, 0.12, -0.26, -0.08, -0.01, -0.11, -0.09, -0.1,
  ], fin));
  parts.push(finGeometry([
    0.095, -0.01, 0.12, 0.26, -0.08, -0.01, 0.11, -0.09, -0.1,
  ], fin));

  // Eyes are tiny dark spheres merged into the same vertex-coloured mesh.
  for (const side of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.021, 7, 5);
    eye.translate(side * 0.088, 0.035, 0.29);
    paintGeometry(eye, 0x090c0a);
    parts.push(eye.index ? eye.toNonIndexed() : eye);
  }

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

export class FishSchools {
  constructor(scene, seed = 88012) {
    this.scene = scene;
    this.rnd = mulberry32(seed);
    const rnd = this.rnd;
    this.time = 0;
    this.schools = [];
    const curated = [
      { x: 3, z: 22, y: -4.1, r: 4.4 },
      { x: 20, z: 44, y: -4.8, r: 8 },
      { x: 0, z: 48, y: -4.5, r: 5.6 },
      { x: -18, z: 62, y: -5.8, r: 9 },
      { x: 42, z: 89, y: -5.2, r: 11 },
      { x: -32, z: 16, y: -4.3, r: 6.5 },
      { x: 8, z: 118, y: -6.1, r: 10 },
      { x: 72, z: 28, y: -5.5, r: 9 },
    ];
    for (let i = 0; i < TUNING.fish.schools; i++) {
      const base = curated[i] || {
        x: (rnd() - 0.5) * 850,
        z: (rnd() - 0.5) * 850,
        y: -4.5 - rnd() * 5,
        r: 7 + rnd() * 11,
      };
      this.schools.push({
        base,
        phase: rnd() * Math.PI * 2,
        rate: 0.02 + rnd() * 0.025,
        cx: base.x,
        cz: base.z,
        scare: 0,
        fish: Array.from({ length: TUNING.fish.perSchool }, (_, fi) => ({
          a: rnd() * Math.PI * 2,
          r: 1.1 + Math.pow(rnd(), 0.6) * 5.8,
          y: (rnd() - 0.5) * 3.2,
          speed: 0.35 + rnd() * 0.5,
          phase: rnd() * Math.PI * 2,
          size: 0.3 + rnd() * 0.26,
          scatter: 0,
          sx: 0,
          sy: 0,
          sz: 0,
        })),
      });
    }
    const total = this.schools.length * TUNING.fish.perSchool;
    const fishMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.34,
      metalness: 0.08,
      emissive: 0x28433c,
      emissiveIntensity: 0.32,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    fishMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uFishTime = sharedShader.time;
      shader.vertexShader =
        /* glsl */ `
          uniform float uFishTime;
          varying vec3 vFishWorld;
          varying vec3 vFishLocal;
        ` +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          /* glsl */ `
            #include <begin_vertex>
            vFishLocal = position;
            vec3 fishRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            float fishTail = smoothstep(-0.04, -0.62, position.z);
            float fishWiggle = sin(uFishTime * 5.4 + fishRoot.x * 0.7 + fishRoot.z * 0.43 + position.z * 4.2);
            transformed.x += fishWiggle * fishTail * 0.06;
            transformed.y += cos(uFishTime * 4.7 + fishRoot.z * 0.5 + position.z * 3.5) * fishTail * 0.012;
            vFishWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          `
        );
      shader.fragmentShader =
        /* glsl */ `
          varying vec3 vFishWorld;
          varying vec3 vFishLocal;
        ` +
        shader.fragmentShader.replace(
          "#include <color_fragment>",
          /* glsl */ `
            #include <color_fragment>
            float fishScale = sin(vFishLocal.z * 48.0 + sin(vFishLocal.y * 63.0) * 1.4) * 0.5 + 0.5;
            diffuseColor.rgb *= 0.93 + fishScale * 0.07;
            float fishGill = smoothstep(0.03, 0.0, abs(vFishLocal.z - 0.15));
            diffuseColor.rgb *= 1.0 - fishGill * 0.08;
          `
        );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `
          #include <emissivemap_fragment>
          float fishFresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 2.4);
          totalEmissiveRadiance += vec3(0.3, 0.46, 0.42) * fishFresnel * 0.16;
        `
      );
    };
    fishMaterial.customProgramCacheKey = () => "fish-school-detailed";
    this.mesh = new THREE.InstancedMesh(fishGeometry(), fishMaterial, total);
    this.mesh.frustumCulled = false;
    const c = new THREE.Color();
    const palettes = [0xbfd9cb, 0xa9c7ba, 0xe0e2ca, 0x92bdba, 0xe8ddb8, 0xb5c7bf];
    for (let i = 0; i < total; i++) {
      c.setHex(palettes[Math.floor(rnd() * palettes.length)]).offsetHSL(0, 0, (rnd() - 0.5) * 0.12);
      this.mesh.setColorAt(i, c);
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.scene.add(this.mesh);
    this.dummy = new THREE.Object3D();
    this.forward = new THREE.Vector3();
    this.zAxis = new THREE.Vector3(0, 0, 1);
    this.world = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.up = new THREE.Vector3(0, 1, 0);
    this.current = new THREE.Vector3();
  }

  update(dt, dolphinPosition, time) {
    this.time += dt;
    const dummy = this.dummy;
    let idx = 0;
    const world = this.world;
    for (const school of this.schools) {
      const driftX = Math.sin(this.time * school.rate + school.phase) * 20;
      const driftZ = Math.cos(this.time * school.rate * 0.83 + school.phase * 1.3) * 18;
      const cx = school.base.x + driftX;
      const cz = school.base.z + driftZ;
      const dist = Math.hypot(dolphinPosition.x - cx, dolphinPosition.z - cz);
      const targetScare = clamp(1 - dist / TUNING.fish.startleRadius, 0, 1);
      school.scare = lerp(school.scare, targetScare, 1 - Math.exp(-3.2 * dt));
      school.cx = cx;
      school.cz = cz;

      for (const fish of school.fish) {
        const a = fish.a + this.time * fish.speed * 0.16;
        const rr = fish.r * (1 + school.scare * 0.7);
        const baseX = cx + Math.cos(a) * rr;
        const baseZ = cz + Math.sin(a) * rr;
        const baseY = school.base.y + fish.y + Math.sin(this.time * 0.4 + fish.phase) * 0.35;
        // Spook scatter is a smoothed outward displacement from the dolphin.
        const dx = baseX - dolphinPosition.x;
        const dz = baseZ - dolphinPosition.z;
        const dl = Math.hypot(dx, dz) + 0.001;
        const targetSX = dx / dl * school.scare * 6.5;
        const targetSZ = dz / dl * school.scare * 6.5;
        const targetSY = (baseY > dolphinPosition.y ? 1 : -1) * school.scare * 1.2;
        fish.sx = lerp(fish.sx, targetSX, 1 - Math.exp(-3.5 * dt));
        fish.sy = lerp(fish.sy, targetSY, 1 - Math.exp(-2.8 * dt));
        fish.sz = lerp(fish.sz, targetSZ, 1 - Math.exp(-3.5 * dt));

        world.set(baseX + fish.sx, baseY + fish.sy, baseZ + fish.sz);
        const tangentX = -Math.sin(a);
        const tangentZ = Math.cos(a);
        this.forward.set(tangentX, Math.sin(this.time * 1.7 + fish.phase) * 0.1, tangentZ).normalize();
        this.quat.setFromUnitVectors(this.zAxis, this.forward);
        dummy.position.copy(world);
        dummy.quaternion.copy(this.quat);
        dummy.scale.setScalar(fish.size);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(idx++, dummy.matrix);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

function makeJellyArmTexture() {
  const w = 128;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const rnd = mulberry32(6643);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(238,255,244,0.7)");
  grad.addColorStop(0.45, "rgba(196,235,220,0.42)");
  grad.addColorStop(1, "rgba(132,202,190,0.02)");
  ctx.fillStyle = grad;
  for (let strand = 0; strand < 5; strand++) {
    const cx = 36 + strand * 14;
    ctx.beginPath();
    ctx.moveTo(cx - 8, 0);
    for (let y = 0; y <= h; y += 16) {
      const t = y / h;
      const wave = Math.sin(t * 8.5 + strand * 1.7) * (2 + t * 8);
      const width = 13 * (1 - t * 0.72);
      ctx.lineTo(cx + wave + width, y);
    }
    for (let y = h; y >= 0; y -= 16) {
      const t = y / h;
      const wave = Math.sin(t * 8.5 + strand * 1.7) * (2 + t * 8);
      const width = 13 * (1 - t * 0.72);
      ctx.lineTo(cx + wave - width, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = `rgba(235,255,244,${0.1 + rnd() * 0.25})`;
    ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 5);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 16;
  return tex;
}

export class Jellyfish {
  constructor(scene, seed = 33127) {
    this.scene = scene;
    this.rnd = mulberry32(seed);
    this.time = 0;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.bellGeo = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.56);
    this.bellGeo.translate(0, 0.02, 0);
    this.ringGeo = new THREE.TorusGeometry(1.02, 0.014, 8, 64);
    this.ringGeo.rotateX(Math.PI * 0.5);
    this.armTexture = makeJellyArmTexture();
    this.jellies = [];
    const colors = [0xa8e6d3, 0xd7c4c9, 0x93d7c4, 0xc7d9b7, 0xd7b8c1];
    const spots = [
      [-14, -3.4, 29], [18, -4.6, 47], [-4, -5.6, 62], [28, -3.0, 23],
      [-35, -5.2, 74], [42, -6.0, 58], [2, -7.2, 98], [-48, -4.2, 36],
    ];
    for (let i = 0; i < spots.length; i++) {
      const [x, y, z] = spots[i];
      const color = new THREE.Color(colors[i % colors.length]);
      const bellMat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.16,
        metalness: 0.02,
        transparent: true,
        opacity: 0.3,
        emissive: color.clone().multiplyScalar(0.24),
        emissiveIntensity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      bellMat.onBeforeCompile = (shader) => {
        shader.vertexShader =
          "varying vec3 vJellyLocal;\n" +
          shader.vertexShader.replace(
            "#include <begin_vertex>",
            /* glsl */ `
              #include <begin_vertex>
              vJellyLocal = position;
            `
          );
        shader.fragmentShader =
          "varying vec3 vJellyLocal;\n" +
          shader.fragmentShader.replace(
            "#include <color_fragment>",
            /* glsl */ `
              #include <color_fragment>
              float jellyAngle = atan(vJellyLocal.z, vJellyLocal.x);
              float jellyCanals = pow(0.5 + 0.5 * cos(jellyAngle * 8.0), 18.0);
              float jellyRim = smoothstep(0.0, 0.18, vJellyLocal.y) * (1.0 - smoothstep(0.34, 0.58, vJellyLocal.y));
              float jellyGonads = smoothstep(0.22, 0.36, vJellyLocal.y) * (1.0 - smoothstep(0.52, 0.68, vJellyLocal.y));
              diffuseColor.rgb += vec3(0.2, 0.37, 0.31) * jellyCanals * 0.42;
              diffuseColor.rgb += vec3(0.12, 0.24, 0.2) * jellyRim * 0.22;
              diffuseColor.rgb += vec3(0.24, 0.11, 0.16) * jellyGonads * 0.2;
            `
          );
      };
      bellMat.customProgramCacheKey = () => "jelly-bell-detailed";
      const bell = new THREE.Mesh(this.bellGeo, bellMat);
      bell.scale.set(0.55, 0.42, 0.55);
      bell.renderOrder = 2;
      const glow = new THREE.Mesh(
        this.ringGeo,
        new THREE.MeshBasicMaterial({
          color: color.clone().offsetHSL(0, 0.05, 0.15),
          transparent: true,
          opacity: 0.2,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      glow.scale.set(0.52, 0.52, 0.52);
      glow.position.y = -0.12;
      glow.renderOrder = 2;

      const segs = 11;
      const arms = 16;
      const positions = new Float32Array(arms * segs * 2 * 3);
      const basePositions = new Float32Array(arms * segs * 2 * 3);
      const strandLength = 1.6 + this.rnd() * 0.6;
      for (let a = 0; a < arms; a++) {
        const ang = (a / arms) * Math.PI * 2 + this.rnd() * 0.2;
        const rad = 0.42 + this.rnd() * 0.12;
        const points = [];
        for (let s = 0; s <= segs; s++) {
          const t = s / segs;
          const sway = Math.sin(t * 7.0 + a) * 0.06;
          const y = -0.06 - t * strandLength;
          const x = Math.cos(ang) * (rad + t * 0.12) + sway;
          const z = Math.sin(ang) * (rad + t * 0.12) + Math.cos(t * 5 + a) * 0.05;
          points.push([x, y, z]);
        }
        for (let s = 0; s < segs; s++) {
          for (let k = 0; k < 2; k++) {
            const idx = (a * segs + s) * 6 + k * 3;
            const p = points[s + k];
            positions[idx] = p[0];
            positions[idx + 1] = p[1];
            positions[idx + 2] = p[2];
            basePositions[idx] = p[0];
            basePositions[idx + 1] = p[1];
            basePositions[idx + 2] = p[2];
          }
        }
      }
      const tentGeo = new THREE.BufferGeometry();
      tentGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const tentMat = new THREE.LineBasicMaterial({
        color: color.clone().lerp(new THREE.Color(0xe7fff5), 0.5),
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const tentacles = new THREE.LineSegments(tentGeo, tentMat);
      tentacles.renderOrder = 2;

      // Four crossed, alpha-tested oral-arm ribbons beneath the bell.
      const oralArms = new THREE.Group();
      const oralMat = new THREE.MeshStandardMaterial({
        color: color.clone().lerp(new THREE.Color(0xe9fff3), 0.55),
        map: this.armTexture,
        transparent: true,
        opacity: 0.48,
        roughness: 0.32,
        metalness: 0.0,
        emissive: color.clone().multiplyScalar(0.18),
        emissiveIntensity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
        alphaTest: 0.015,
      });
      for (let arm = 0; arm < 4; arm++) {
        const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 1.35, 3, 18), oralMat);
        ribbon.position.y = -0.68;
        ribbon.rotation.y = (arm / 4) * Math.PI;
        ribbon.rotation.x = (arm % 2 ? 1 : -1) * 0.08;
        ribbon.renderOrder = 2;
        oralArms.add(ribbon);
      }
      oralArms.position.y = -0.04;

      const obj = new THREE.Group();
      obj.add(bell, glow, tentacles, oralArms);
      obj.position.set(x, y, z);
      obj.scale.setScalar(0.9 + this.rnd() * 1.3);
      obj.userData = {
        home: new THREE.Vector3(x, y, z),
        phase: this.rnd() * Math.PI * 2,
        driftPhase: this.rnd() * Math.PI * 2,
        bed: seabedHeight(x, z),
        tentacles,
        basePositions,
        oralArms,
        phaseArm: this.rnd() * 10,
      };
      this.group.add(obj);
      this.jellies.push(obj);
    }
  }

  update(dt, time) {
    this.time += dt;
    for (const j of this.jellies) {
      const ph = j.userData.phase;
      const home = j.userData.home;
      j.position.x = home.x + Math.sin(time * 0.045 + j.userData.driftPhase) * 2.4;
      j.position.z = home.z + Math.cos(time * 0.037 + j.userData.driftPhase * 1.7) * 2.1;
      j.position.y = home.y + Math.sin(time * 0.11 + ph) * 0.3;
      const pulse = 1 + Math.sin(time * 1.35 + ph) * 0.11;
      j.scale.y = j.scale.x * (0.8 + (pulse - 1) * 0.3);
      j.rotation.y = Math.sin(time * 0.06 + ph) * 0.15;
      if (j.userData.oralArms) {
        j.userData.oralArms.rotation.y = Math.sin(time * 0.48 + ph) * 0.12;
        j.userData.oralArms.scale.y = 0.92 + pulse * 0.08;
        j.userData.oralArms.rotation.z = Math.cos(time * 0.33 + ph) * 0.05;
      }
      const pos = j.userData.tentacles.geometry.attributes.position;
      const base = j.userData.basePositions;
      for (let i = 0; i < pos.count; i++) {
        const bx = base[i * 3];
        const by = base[i * 3 + 1];
        const bz = base[i * 3 + 2];
        const wave = Math.sin(time * 0.9 + by * 2.7 + j.userData.phaseArm + i * 0.05);
        pos.setXYZ(i, bx + wave * 0.055, by, bz + Math.cos(time * 0.7 + by * 1.9 + i * 0.03) * 0.045);
      }
      pos.needsUpdate = true;
      const floor = seabedHeight(j.position.x, j.position.z);
      if (j.position.y < floor + 0.8) j.position.y = floor + 0.8;
    }
  }
}
