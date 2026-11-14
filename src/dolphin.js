import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { TUNING } from "./config.js";
import {
  clamp,
  damp,
  lerp,
  MAX_FRAME_DT,
  seabedHeight,
  smoothstep,
  wrapAngle,
} from "./utils.js";
import { Hull } from "./water/hull.js";

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// Nine joints from the neck/head base to the flukes. The geometry is baked so
// the animal faces +Z, dorsal is +Y, and the body spans roughly ±1.5 m.
const SPINE_Z = [0.9, 0.6, 0.3, 0.0, -0.3, -0.6, -0.9, -1.2, -1.48];
const SPINE_LENGTHS = SPINE_Z.slice(1).map((z, i) => SPINE_Z[i] - z);
const SPINE_FOLLOW = [20, 16, 12.5, 9.5, 7, 5.2, 3.8, 2.8];
const SPINE_NAMES = [
  "head",
  "neck",
  "shoulder",
  "torso-1",
  "torso-2",
  "tail-base",
  "tail-mid",
  "peduncle",
  "flukes",
];
const HEAD_BIND = new THREE.Vector3(0, 0, SPINE_Z[0]);
const SKIN_BONE_COUNT = SPINE_Z.length;

function dampAngle(current, target, lambda, dt) {
  return current + wrapAngle(target - current) * (1 - Math.exp(-lambda * dt));
}

// Fold `dir` back into a cone of `maxAngle` around `reference`. Joint limits
// are applied as hard cones after the damped follow, which keeps the spine
// smooth but prevents the chain from folding through itself on fast flicks.
function clampDirectionToCone(dir, reference, maxAngle, axis) {
  const dot = clamp(dir.dot(reference), -1, 1);
  if (dot >= Math.cos(maxAngle)) return;
  const angle = Math.acos(dot);

  axis.crossVectors(dir, reference);
  if (axis.lengthSq() < 1e-10) {
    // Exactly opposite directions have no unique shortest arc. Pick a stable
    // perpendicular so the joint still resolves instead of producing NaN.
    axis.set(0, 1, 0).cross(dir);
    if (axis.lengthSq() < 1e-10) axis.set(1, 0, 0).cross(dir);
    if (axis.lengthSq() < 1e-10) return;
  }
  axis.normalize();
  dir.applyAxisAngle(axis, angle - maxAngle).normalize();
}

function buildFallbackDolphin() {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: 0x93a8a7,
    roughness: 0.34,
    metalness: 0.04,
  });
  const belly = new THREE.MeshStandardMaterial({
    color: 0xc8d0c3,
    roughness: 0.5,
    metalness: 0.02,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.48, 24, 16), skin);
  body.scale.set(1, 0.82, 3.1);
  body.position.z = 0.05;
  group.add(body);
  const bellyMesh = new THREE.Mesh(new THREE.SphereGeometry(0.47, 20, 12), belly);
  bellyMesh.scale.set(0.82, 0.4, 2.7);
  bellyMesh.position.set(0, -0.24, 0.16);
  group.add(bellyMesh);
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 3), skin);
  dorsal.position.set(0, 0.4, -0.35);
  dorsal.rotation.x = -0.3;
  dorsal.scale.z = 0.5;
  group.add(dorsal);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.7, 4), skin);
  tail.position.set(0, -0.02, -1.5);
  tail.rotation.x = Math.PI / 2;
  tail.scale.set(1.35, 1, 0.18);
  group.add(tail);
  const pectoral = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.52, 4), skin);
  pectoral.position.set(-0.42, -0.16, 0.7);
  pectoral.rotation.z = Math.PI / 2;
  pectoral.rotation.y = 0.25;
  group.add(pectoral);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 8), skin);
  nose.scale.set(1, 0.7, 1.45);
  nose.position.z = 1.47;
  group.add(nose);
  return group;
}

function addDolphinMaterialShader(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCausticTime = uniforms.causticTime;

    shader.vertexShader =
      /* glsl */ `
        varying vec3 vDolphinLocal;
        varying vec3 vDolphinWorld;
      ` +
      shader.vertexShader
        .replace(
          "#include <begin_vertex>",
          /* glsl */ `
            #include <begin_vertex>
            vDolphinLocal = position;
          `
        )
        .replace(
          "#include <skinning_vertex>",
          /* glsl */ `
            #include <skinning_vertex>
            // Capture the final skinned world position for the caustic pass.
            vec4 dolphinWorld = modelMatrix * vec4(transformed, 1.0);
            vDolphinWorld = dolphinWorld.xyz;
          `
        );

    // Surface height at the animal, so caustics only play on it underwater.
    if (!uniforms.waterLevel) uniforms.waterLevel = { value: -1e5 };
    shader.uniforms.uWaterLevel = uniforms.waterLevel;
    shader.fragmentShader =
      /* glsl */ `
        uniform float uCausticTime;
        uniform float uWaterLevel;
        varying vec3 vDolphinLocal;
        varying vec3 vDolphinWorld;
      ` +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        /* glsl */ `
          #include <color_fragment>
          // Bottlenose colouring, anatomical (it follows the body whatever
          // its pose): a dark slate cape over the back that dips behind the
          // dorsal fin, mid grey flanks, a pale belly and throat, and dark
          // fins and flukes. The baked geometry has head +Z, dorsal +Y.
          vec3 dl = vDolphinLocal;
          float s = (dl.y + 0.17) / 0.33;
          float capeLine = 0.3 - 0.42 * exp(-pow((dl.z + 0.2) / 0.55, 2.0)) - 0.15 * smoothstep(0.6, 1.4, dl.z);
          float cape = smoothstep(capeLine - 0.22, capeLine + 0.22, s);
          float throat = 0.32 * smoothstep(0.6, 1.25, dl.z);
          float belly = 1.0 - smoothstep(-0.78, -0.4, s - throat);
          float pecFin = smoothstep(0.3, 0.42, abs(dl.x)) * smoothstep(0.15, 0.3, dl.z) * (1.0 - smoothstep(0.9, 1.05, dl.z));
          float flukes = 1.0 - smoothstep(-1.32, -1.12, dl.z);
          float appendage = max(pecFin, flukes);
          vec3 backC = vec3(0.028, 0.031, 0.036);
          vec3 flankC = vec3(0.085, 0.09, 0.096);
          vec3 bellyC = vec3(0.36, 0.345, 0.335);
          vec3 albedo = mix(flankC, backC, max(cape, appendage * 0.8));
          albedo = mix(albedo, bellyC, belly * (1.0 - appendage * 0.75));
          // A soft blaze of lighter grey on the flank below the fin.
          float blaze = exp(-pow((s + 0.15) / 0.25, 2.0)) * exp(-pow((dl.z + 0.55) / 0.45, 2.0));
          albedo = mix(albedo, flankC * 1.5, blaze * 0.35 * (1.0 - appendage));
          // The texture only carries detail (eyes, mouth line, scars).
          #ifdef USE_MAP
            float texL = dot(sampledDiffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            float detail = clamp(pow(texL / 0.26, 0.75), 0.25, 1.6);
          #else
            float detail = 1.0;
          #endif
          float mottle = sin(dl.z * 7.0 + dl.x * 3.3 + sin(dl.y * 9.0)) * 0.5 + 0.5;
          diffuseColor.rgb = albedo * detail * (0.94 + 0.08 * mottle);
        `
      );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `
        #include <emissivemap_fragment>
        // Caustics only under the water, fading with depth.
        float dolphinDepth = uWaterLevel - vDolphinWorld.y;
        float underMask = smoothstep(0.0, 0.25, dolphinDepth) * exp(-max(dolphinDepth, 0.0) * 0.07);
        // Even light from above; post lays the moving net over the back.
        float dolphinCaustic = 2.3;
        vec3 upInView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        float topLit = clamp(dot(normal, upInView) * 0.5 + 0.5, 0.0, 1.0);
        totalEmissiveRadiance += vec3(0.5, 0.75, 0.68) * dolphinCaustic * 0.07 * underMask * topLit;
      `
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
      /* glsl */ `
        // Skin against water barely reflects: their refractive indices are
        // close, so a submerged dolphin loses nearly all of its sheen.
        float submerged = smoothstep(0.0, 0.4, dolphinDepth);
        vec3 outgoingLight = totalDiffuse + totalSpecular * (1.0 - 0.8 * submerged) + totalEmissiveRadiance;
        // Under the water the light reaching the skin has lost much of its
        // strength and most of its red on the way down.
        vec3 waterLight = vec3(0.4, 0.55, 0.6) * exp(-max(dolphinDepth, 0.0) * 0.03);
        outgoingLight *= mix(vec3(1.0), waterLight, submerged);
      `
    );
  };
  material.customProgramCacheKey = () => "dolphin-skeletal";
}

export class Dolphin {
  static async create(scene, start = TUNING.world.start) {
    const d = new Dolphin(scene, start);
    await d.loadModel();
    return d;
  }

  constructor(scene, start) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = "dolphin";
    this.root.position.set(start.x, start.y, start.z);
    scene.add(this.root);

    this.position = this.root.position;
    this.velocity = new THREE.Vector3(0, 0, 0.2);
    this.forward = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.right = new THREE.Vector3(1, 0, 0);
    this.orientation = new THREE.Quaternion();

    this.yaw = TUNING.world.startYaw;
    this.targetYaw = this.yaw;
    this.pitch = TUNING.world.startPitch;
    this.targetPitch = this.pitch;
    this.roll = 0;
    this.targetRoll = 0;
    this.yawRate = 0;

    this.qYaw = new THREE.Quaternion();
    this.qPitch = new THREE.Quaternion();
    this.qRoll = new THREE.Quaternion();
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.tmpCurrent = new THREE.Vector3();
    this.tmpFlatRight = new THREE.Vector3();
    this.surfaceSample = {};
    this.bodyParts = [
      { name: "nose", offset: new THREE.Vector3(0, 0.04, 1.34), radius: 0.25, load: 0.35 },
      { name: "center", offset: new THREE.Vector3(0, 0, 0), radius: TUNING.movement.bodyRadius, load: 1 },
      { name: "tail", offset: new THREE.Vector3(0, -0.04, -1.38), radius: 0.24, load: 0.55 },
      { name: "leftFin", offset: new THREE.Vector3(0.62, -0.12, 0.3), radius: 0.16, load: 0.28 },
      { name: "rightFin", offset: new THREE.Vector3(-0.62, -0.12, 0.3), radius: 0.16, load: 0.28 },
    ];
    this.floorPoints = this.bodyParts.map((p) => ({ name: p.name, pos: new THREE.Vector3(), alt: 0, radius: p.radius, load: p.load }));

    // M2 physics hull. Mass is derived from displaced volume; the controller
    // still steers the nose directly, but translation is now force-driven.
    this.hull = new Hull();
    this.mass = this.hull.mass;
    this.hydroControl = { thrustAccel: 0, reverseAccel: 0, verticalAccel: 0, streamline: 0 };
    // Shift dive (see update): engaged, and how tucked the body is (0..1).
    this.diveState = false;
    this.streamline = 0;
    this._boostThroughExit = false;
    this.boostBreachCount = 0;
    this.hydro = this.hull.result;

    this.tailUniforms = {
      causticTime: { value: 0 },
    };
    this.tailPhase = 0;
    this.tailHeave = 0;
    this.prevSwimSpeed = this.velocity.length();
    this.swimAccel = 0;
    this.spine = {
      bones: [],
      joints: SPINE_Z.map((z) => new THREE.Vector3(0, 0, z)),
      quats: SPINE_Z.map(() => new THREE.Quaternion()),
      // segDirs[i] is the unit direction from joint i to joint i+1, i.e. the
      // trailing axis of each segment in world space.
      segDirs: SPINE_LENGTHS.map(() => new THREE.Vector3(0, 0, -1)),
      desiredDir: new THREE.Vector3(),
      clampAxis: new THREE.Vector3(),
      lengths: SPINE_LENGTHS,
      bindZ: SPINE_Z.slice(),
      initialized: false,
      targetQ: new THREE.Quaternion(),
      qYaw: new THREE.Quaternion(),
      qPitch: new THREE.Quaternion(),
      qRoll: new THREE.Quaternion(),
      qParentInverse: new THREE.Quaternion(),
      qPitchLocal: new THREE.Quaternion(),
      forwardTarget: new THREE.Vector3(),
      backTarget: new THREE.Vector3(),
      upTarget: new THREE.Vector3(),
      rightTarget: new THREE.Vector3(),
      headTarget: new THREE.Vector3(),
      tmp: new THREE.Vector3(),
      tmp2: new THREE.Vector3(),
      tmpUp: new THREE.Vector3(),
      tmpRight: new THREE.Vector3(),
      tmpMatrix: new THREE.Matrix4(),
      up: new THREE.Vector3(0, 1, 0),
      flukePitchPhase: 0,
      lastTailVel: new THREE.Vector3(),
    };
    this.skinnedMesh = null;
    this.skeleton = null;
    this.wetness = 0;
    this.impact = 0;
    this.turnLean = 0;
    this.tumbleRoll = 0;
    this.tumblePitch = 0;
    this.tumbleRollVel = 0;
    this.tumblePitchVel = 0;
    this.tumbleClock = 0;
    // Water-driven attitude: a small body-frame rotation vector (x pitch,
    // y yaw, z roll, radians) on top of the steered attitude, its angular
    // velocity, and that velocity in world space for the hull's panel drag.
    this.waterTilt = new THREE.Vector3();
    this.waterTiltRate = new THREE.Vector3();
    this.waterSpin = new THREE.Vector3();
    this.qWater = new THREE.Quaternion();
    this.qWaterInv = new THREE.Quaternion();
    this.tmpTorque = new THREE.Vector3();
    this.verticalInput = 0;
    this.pitchInputTimer = 0;
    // Ride trim state: the player's pitch relative to the surface-following
    // attitude, and how strongly the trim is holding.
    this.rideOffset = 0;
    this.rideHold = 0;
    this.rideIdle = 0;
    this.lastRideTarget = null;
    // Surface lock (hold Space): 0..1 blend, whether it has caught the
    // surface, the look offset the mouse gives while locked, and the surface
    // under the body this frame (height, slope and how fast it rises).
    this.surfLock = 0;
    this.surfLockEngaged = false;
    this.surfLockPitch = 0;
    this.surfLook = 0;
    this.surfLockOff = 0;
    this.surfaceLead = 0;
    this.viewPitch = 0;
    this._sl = { x0: 0, z0: 0, h0: 0, sx: 0, sz: 0, dEta: 0, tIn: 0 };
    this._slPrev = { x: 0, z: 0, fx: 0, fz: 1, a: 1.5, b: 0.9, h: 0, valid: false };
    this.speed = 0;
    this.prevCenterAbove = false;
    this.airborne = false;
    this.wasAbove = false;
    this.leaping = false;
    this.surfaceCooldown = 0;
    this.surfaceFxCooldown = 0;
    this.bubbleClock = 0;
    this.plowClock = 0;
    this.glideClock = 0;
    this.wakeClock = 0;
    this.bowClock = 0;
    this.tailBoilClock = 0;
    this.tailSlapClock = 0;
    this.lastFlukeAbove = null;
    this.wakeA = new THREE.Vector3();
    this.wakeB = new THREE.Vector3();
    this.wakeC = new THREE.Vector3();
    this.breachCount = 0;
    this.loaded = false;
    this.model = null;
    this.contact = {
      floor: false,
      surface: false,
      impact: 0,
      sand: 0,
    };
    this.telemetry = {
      depth: 0,
      altitude: 0,
      speed: 0,
      heading: 0,
      waveHeight: 0,
      hydro: null,
    };
  }

  async loadModel() {
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync("/dolphin.glb");
      const raw = gltf.scene;
      raw.updateMatrixWorld(true);

      let sourceMesh = null;
      raw.traverse((o) => {
        if (o.isMesh && !sourceMesh) sourceMesh = o;
      });
      if (!sourceMesh) throw new Error("No mesh found in dolphin.glb");

      const box = new THREE.Box3().setFromObject(sourceMesh);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = TUNING.dolphin.length / size.z;

      // Bake the source's correction into vertex data so the skeleton lives in
      // straightforward local space: head +Z, dorsal +Y, flukes horizontal.
      const geometry = sourceMesh.geometry.clone();
      const bake = new THREE.Matrix4()
        .makeScale(scale, scale, scale)
        .multiply(new THREE.Matrix4().makeRotationZ(-Math.PI * 0.5))
        .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z))
        .multiply(sourceMesh.matrixWorld);
      geometry.applyMatrix4(bake);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      const srcMat = Array.isArray(sourceMesh.material)
        ? sourceMesh.material[0]
        : sourceMesh.material;
      const material = srcMat.clone();
      // Wet skin: smooth and glossy, no metal. Colour comes from the
      // anatomical pattern in the shader; the sky reflection comes from the
      // environment map main.js assigns.
      material.roughness = 0.3;
      material.metalness = 0;
      material.color = new THREE.Color(0xffffff);
      material.emissive = new THREE.Color(0x000000);
      material.emissiveIntensity = 0;
      material.envMapIntensity = 1;
      addDolphinMaterialShader(material, this.tailUniforms);

      // Two influence skinning based on the vertex's position along the spine.
      const position = geometry.attributes.position;
      const skinIndex = new Uint16Array(position.count * 4);
      const skinWeight = new Float32Array(position.count * 4);
      for (let v = 0; v < position.count; v++) {
        const z = position.getZ(v);
        let a = 0;
        let b = 0;
        let t = 0;
        if (z >= SPINE_Z[0]) {
          a = 0;
          b = 0;
        } else if (z <= SPINE_Z[SPINE_Z.length - 1]) {
          a = SPINE_Z.length - 1;
          b = a;
        } else {
          for (let i = 0; i < SPINE_Z.length - 1; i++) {
            if (z <= SPINE_Z[i] && z >= SPINE_Z[i + 1]) {
              a = i;
              b = i + 1;
              t = (SPINE_Z[i] - z) / (SPINE_Z[i] - SPINE_Z[i + 1]);
              break;
            }
          }
        }
        skinIndex[v * 4] = a;
        skinIndex[v * 4 + 1] = b;
        skinWeight[v * 4] = 1 - t;
        skinWeight[v * 4 + 1] = t;
      }
      geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
      geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));

      const bones = [];
      let parentBone = null;
      for (let i = 0; i < SPINE_Z.length; i++) {
        const bone = new THREE.Bone();
        bone.name = SPINE_NAMES[i];
        bone.position.set(0, 0, i === 0 ? SPINE_Z[0] : SPINE_Z[i] - SPINE_Z[i - 1]);
        if (parentBone) parentBone.add(bone);
        else this.skinnedMesh?.add(bone);
        parentBone = bone;
        bones.push(bone);
      }

      const mesh = new THREE.SkinnedMesh(geometry, material);
      mesh.name = "dolphin-skinned";
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.add(bones[0]);
      this.scene.add(mesh);
      mesh.updateMatrixWorld(true);
      const skeleton = new THREE.Skeleton(bones);
      mesh.bind(skeleton, new THREE.Matrix4());

      this.skinnedMesh = mesh;
      this.skeleton = skeleton;
      this.spine.bones = bones;
      this.model = mesh;
      this.loaded = true;
      this.resetVisualChain();
    } catch (err) {
      console.warn("Dolphin model failed to load, using procedural stand-in.", err);
      const fallback = buildFallbackDolphin();
      this.model = fallback;
      this.root.add(fallback);
      this.loaded = true;
    }
  }

  resetVisualChain() {
    this.spine.initialized = false;
  }

  _buildTargetSpine() {
    const sp = this.spine;
    sp.qYaw.setFromAxisAngle(Y_AXIS, this.targetYaw);
    sp.qPitch.setFromAxisAngle(X_AXIS, -(this.targetPitch + this.tumblePitch));
    sp.qRoll.setFromAxisAngle(Z_AXIS, this.roll + this.tumbleRoll);
    sp.targetQ.copy(sp.qYaw).multiply(sp.qPitch).multiply(sp.qRoll).multiply(this.qWater);
    sp.forwardTarget.set(0, 0, 1).applyQuaternion(sp.targetQ);
    sp.backTarget.copy(sp.forwardTarget).multiplyScalar(-1);
    sp.upTarget.set(0, 1, 0).applyQuaternion(sp.targetQ);
    sp.rightTarget.set(1, 0, 0).applyQuaternion(sp.targetQ);
    sp.headTarget.copy(HEAD_BIND).applyQuaternion(sp.targetQ).add(this.position);
  }

  _applySpinePose() {
    const sp = this.spine;
    const bones = sp.bones;
    if (!bones.length || !this.skinnedMesh) return;

    sp.quats[0].copy(sp.targetQ);
    for (let i = 1; i < SPINE_Z.length; i++) {
      // Point the bone's +Z toward the head along the trailing chain.
      sp.tmp.subVectors(sp.joints[i - 1], sp.joints[i]);
      if (sp.tmp.lengthSq() < 1e-8) sp.tmp.copy(sp.forwardTarget);
      else sp.tmp.normalize();

      sp.tmpUp.copy(sp.upTarget);
      sp.tmpUp.addScaledVector(sp.tmp, -sp.tmpUp.dot(sp.tmp));
      if (sp.tmpUp.lengthSq() < 1e-5) {
        sp.tmpUp.set(0, 0, 1).addScaledVector(sp.tmp, -sp.tmp.z);
        if (sp.tmpUp.lengthSq() < 1e-5) {
          sp.tmpUp.set(1, 0, 0).addScaledVector(sp.tmp, -sp.tmp.x);
        }
      }
      sp.tmpUp.normalize();
      sp.tmpRight.crossVectors(sp.tmpUp, sp.tmp).normalize();
      sp.tmpMatrix.makeBasis(sp.tmpRight, sp.tmpUp, sp.tmp);
      sp.quats[i].setFromRotationMatrix(sp.tmpMatrix);
    }

    // The last bone is the fluke pair. Pitch it around its spanwise axis so
    // the blade keeps working through the stroke instead of staying a plank.
    // Pitch authority tracks both steady speed and acceleration.
    const cfg = TUNING.dolphin;
    const flukePhase = this.tailPhase - (SPINE_Z.length - 1) * cfg.tailWaveTravel + Math.PI * 0.5;
    const activity = clamp(0.45 + this.tailHeave * 6.0, 0.45, 2.2);
    sp.qPitchLocal.setFromAxisAngle(X_AXIS, Math.sin(flukePhase) * cfg.flukePitch * activity);
    sp.quats[SPINE_Z.length - 1].multiply(sp.qPitchLocal);

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      if (i === 0) {
        bone.position.copy(sp.joints[0]);
        bone.quaternion.copy(sp.quats[0]);
      } else {
        sp.qParentInverse.copy(sp.quats[i - 1]).invert();
        sp.tmp.subVectors(sp.joints[i], sp.joints[i - 1]).applyQuaternion(sp.qParentInverse);
        bone.position.copy(sp.tmp);
        bone.quaternion.copy(sp.qParentInverse).multiply(sp.quats[i]);
      }
    }
  }

  _updateSpineAnimation(dt) {
    const sp = this.spine;
    const cfg = TUNING.dolphin;
    const segmentCount = SPINE_Z.length - 1;
    this._buildTargetSpine();

    if (!sp.initialized) {
      sp.joints[0].copy(sp.headTarget);
      for (let i = 0; i < segmentCount; i++) {
        sp.segDirs[i].copy(sp.backTarget);
        sp.joints[i + 1].copy(sp.joints[i]).addScaledVector(sp.backTarget, sp.lengths[i]);
      }
      sp.initialized = true;
      this._applySpinePose();
      return;
    }

    // The snout is the handle: the head pivot tracks the mouse target exactly.
    // Every segment behind it keeps its own direction and is dragged toward
    // the segment ahead, so the body trails rather than rotating as one piece.
    sp.joints[0].copy(sp.headTarget);

    for (let i = 0; i < segmentCount; i++) {
      const aheadDir = i === 0 ? sp.backTarget : sp.segDirs[i - 1];

      sp.desiredDir.copy(aheadDir);
      if (sp.desiredDir.lengthSq() < 1e-8) sp.desiredDir.copy(aheadDir);
      else sp.desiredDir.normalize();

      const follow = 1 - Math.exp(-SPINE_FOLLOW[i] * cfg.bodyFollow * dt);
      sp.segDirs[i].lerp(sp.desiredDir, follow);
      if (sp.segDirs[i].lengthSq() < 1e-8) sp.segDirs[i].copy(sp.desiredDir);
      else sp.segDirs[i].normalize();

      // The neck is limited against the head's back axis; every other joint is
      // limited against the segment ahead. The torso is stiffer than the
      // peduncle, so turns read as a banked body with a flexible tail rather
      // than a laterally curling eel.
      const taper = 0.55 + 0.85 * (i / (segmentCount - 1));
      const limit = i === 0 ? cfg.headBendLimit : cfg.bodyBendLimit * taper;
      clampDirectionToCone(sp.segDirs[i], aheadDir, limit, sp.clampAxis);
    }

    // Rebuild the steering chain from the anchored head with exact segment
    // lengths. This is what makes the motion read as a spine instead of a
    // chain of free-floating points.
    for (let i = 0; i < segmentCount; i++) {
      sp.joints[i + 1].copy(sp.joints[i]).addScaledVector(sp.segDirs[i], sp.lengths[i]);
    }

    // Layer the swim wave on top as a real dorsoventral displacement wave.
    // Keeping it out of the steering dampers preserves the full stroke
    // amplitude and the torso→fluke phase all the way to the tip.
    for (let i = 1; i < SPINE_Z.length; i++) {
      const along = i / segmentCount;
      const envelope = smoothstep(cfg.tailWaveStart, 1.0, along);
      const phase = this.tailPhase - i * cfg.tailWaveTravel;
      const heave = Math.sin(phase) * this.tailHeave * envelope;
      sp.joints[i].addScaledVector(sp.upTarget, heave);
    }

    // Reconnect the displaced joints with fixed-length links. The fluke can
    // sweep through a large arc while the skeleton itself never stretches.
    for (let i = 0; i < segmentCount; i++) {
      sp.tmp2.subVectors(sp.joints[i + 1], sp.joints[i]);
      if (sp.tmp2.lengthSq() < 1e-8) sp.tmp2.copy(sp.segDirs[i]);
      else sp.tmp2.normalize();
      sp.joints[i + 1].copy(sp.joints[i]).addScaledVector(sp.tmp2, sp.lengths[i]);
    }

    this._applySpinePose();
  }

  get currentInputDir() {
    return this.forward;
  }

  update(dt, input, ocean, seabed, effects) {
    // The same cap as the main loop's frame time. A lower cap here (it was
    // 1/30 s) let the water run ahead of the body on every long frame: on a
    // 500 m face moving at 72 m/s the body slipped half a metre back on the
    // wave and the surface lock then yanked it up to where the face was.
    dt = Math.min(dt, MAX_FRAME_DT);
    const movement = TUNING.movement;
    const time = performance.now() * 0.001;

    // --- Steering target -------------------------------------------------
    const mouse = input.consumeMouse();
    // Do not clamp per-frame mouse deltas. A fast flick can legitimately
    // produce several hundred pixels in one frame, and truncating that motion
    // is immediately felt as drag on the snout.
    const mx = mouse.dx;
    const my = mouse.dy;
    // Screen-right is world -X when the camera follows the dolphin's +Z
    // heading, so a rightward mouse movement must reduce yaw. The keyboard
    // bank controls share the same convention.
    this.targetYaw = wrapAngle(this.targetYaw - mx * movement.mouseSensitivity);
    this.targetPitch = clamp(
      this.targetPitch - my * movement.mouseSensitivity * 0.78,
      -movement.maxPitch,
      movement.maxPitch
    );
    const keyTurn = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    // On the surface (Space) the dolphin turns like a skier on an edge.
    const skiing = this.surfLock || 0;
    let keyTurnRate = lerp(movement.maxTurnRate * 1.15, TUNING.hydro.surfaceTurnRate, skiing);
    // In the air the body cannot turn its path the way it does in the water,
    // so a turn key held through a leap (porpoising round a bend) used to
    // spin the body a quarter turn off its flight path, and it came down
    // broadside or tail first and stopped dead. A/D now swing the nose up
    // to `airYawMax` off the path, easing to nothing as they get there:
    // lift bends the path toward the nose meanwhile, and the body lands
    // close enough to its line to carve out of the landing. The mouse is
    // not limited.
    if (keyTurn !== 0 && this._flying) {
      const hs = Math.hypot(this.velocity.x, this.velocity.z);
      if (hs >= movement.airPathSpeed) {
        const slip = wrapAngle(this.targetYaw - Math.atan2(this.velocity.x, this.velocity.z));
        // How far the nose is already off the path on the side the key
        // turns it toward.
        const toward = -keyTurn * slip;
        keyTurnRate *= 1 - smoothstep(movement.airYawMax * 0.5, movement.airYawMax, toward);
      }
    }
    this.targetYaw = wrapAngle(this.targetYaw - keyTurn * keyTurnRate * dt);
    const pitchInput =
      Math.abs(mx) > 0 ||
      Math.abs(my) > 0 ||
      input.pitchUpKeys ||
      input.pitchDownKeys;
    if (input.pitchUpKeys) this.targetPitch += 0.9 * dt;
    if (input.pitchDownKeys) this.targetPitch -= 0.9 * dt;
    // How far the player moved the nose up or down this frame (used in the
    // air, where the aim is kept relative to the flight path).
    const aimDelta =
      -my * movement.mouseSensitivity * 0.78 +
      (input.pitchUpKeys ? 0.9 * dt : 0) -
      (input.pitchDownKeys ? 0.9 * dt : 0);
    if (pitchInput) this.pitchInputTimer = movement.pitchTrimDelay;
    else {
      this.pitchInputTimer -= dt;
      if (this.pitchInputTimer <= 0) {
        // Optional neutral trim. It is disabled by default (`pitchReturn: 0`)
        // so free look can hold any attitude; raise the tuning value to make
        // the snout slowly return to level when the mouse rests.
        this.targetPitch = damp(this.targetPitch, 0, movement.pitchReturn, dt);
      }
    }
    // Where the player's own input has put the nose this frame. Everything
    // below that moves it on its own (leap, flight path, ride trim, surface
    // lock) is held to `movement.autoPitchRate` at the end: the visible head
    // pivots on this target, so an automatic jump in it reads as a glitch.
    let pitchRef = this.targetPitch;

    this.verticalInput = (input.rise ? 1 : 0) - (input.dive ? 1 : 0);

    // --- Shift dive --------------------------------------------------------
    // Holding Shift in the air tucks the body into a streamlined dive: an
    // extra pull down and less air drag (dry-hull flight below), the nose
    // kept on the flight path, and in the water far less entry loss, slam,
    // drag and fin lift, no tail stroke, no ride trim and no surface lock
    // (hull.js, re-entry below). The body carries its whole 3D velocity
    // through the surface and stays tucked until Shift is let go.
    // Pressing Shift in the air dives at once. Shift still held from a
    // breach (a boosted breach) arms the dive only past the top of the arc,
    // so it does not pull the body down on its way up. It never arms from a
    // Space leap or while Space is held: those belong to the ride (a leap
    // you land back into, porpoising), and surging riders hold Shift
    // through them.
    {
      const wetNow = this.hydro ? this.hydro.wetFraction : 1;
      const inAir = wetNow < 0.05 && (this.leaping || this.leapFlight);
      if (!input.boost) {
        this.diveState = false;
        this._boostThroughExit = false;
      } else if (
        !this.diveState &&
        inAir &&
        (!this._boostThroughExit || (!this.leapFlight && this.velocity.y <= 0 && !input.rise))
      ) {
        this.diveState = true;
      }
      // The seabed: a diving dolphin knows where the bottom is and pulls out
      // above it. Where the path would reach the sand within about 1.6 s,
      // the body opens out of the tuck (fin lift and drag come back) and
      // the nose comes up, and the water bends the path. Shift stays held:
      // past the bottom the body tucks again.
      // In the air it looks along the falling arc, and the extra pull eases
      // off ahead of shallow water.
      let floorNear = 0;
      if (this.diveState && this.velocity.y < -1 && seabed) {
        const v = this.velocity;
        const p = this.position;
        const fall = wetNow < 0.3 ? 0.5 * movement.airGravity : 0;
        for (let tau = 0.2; tau <= 1.61; tau += 0.2) {
          const fx = p.x + v.x * tau;
          const fz = p.z + v.z * tau;
          if (p.y + v.y * tau - fall * tau * tau - seabed.getSurfaceHeight(fx, fz) < movement.diveFloorClear) {
            floorNear = 1 - smoothstep(0.6, 1.6, tau);
            break;
          }
        }
      }
      this.floorPull = damp(this.floorPull || 0, floorNear, floorNear > (this.floorPull || 0) ? 12 : 3, dt);
      if (this.floorPull < 1e-3) this.floorPull = 0;
      if (this.floorPull > 0) {
        const up = movement.diveFloorPitch;
        if (this.targetPitch < up) {
          this.targetPitch = Math.min(up, this.targetPitch + movement.diveFloorRate * this.floorPull * dt);
          this.lastRideTarget = this.targetPitch;
        }
      }
      // Tucking takes a few hundredths of a second, opening up a little longer.
      // In the air the body stays tucked (it would only slam into the water
      // on its belly); only the extra pull eases off (dry-hull flight).
      const tuck = this.diveState ? 1 - (wetNow < 0.3 ? 0 : this.floorPull) : 0;
      this.streamline = damp(this.streamline, tuck, tuck > this.streamline ? 14 : 8, dt);
      if (this.streamline < 1e-3) this.streamline = 0;
    }
    const lock = this._surfaceLockUpdate(dt, input, ocean, my);
    // On the surface the mouse looks instead of pitching (below).
    pitchRef -= aimDelta * lock;
    // In the air the nose is the player's, kept relative to the flight path:
    // the mouse (or arrow keys) sets how far it points above or below the
    // path, and that aim rides along with the arc. Left alone the nose
    // follows the arc (up out of the water, level at the top, down into
    // it); aimed off it, lift bends the path toward the nose (dry-hull
    // flight below). The aim persists between mouse events, so a mouse that
    // reports on some frames and not others does not make it flicker.
    // Only while clear of the water: in it, the water has the body.
    const wetA = this.hydro ? this.hydro.wetFraction : 1;
    const flying = (this.leapFlight && wetA < 0.3) || (this.leaping && wetA < 0.1);
    // From the leap's stroke until the body is clear of the water, the nose
    // swings up onto the path it is about to fly (`_leapNose`), as the
    // stroke itself pitches a real dolphin up out of the water.
    if (flying || this._leapNose) {
      // The path the body is on, including what is left of a leap's stroke.
      let pvx = this.velocity.x;
      let pvy = this.velocity.y;
      let pvz = this.velocity.z;
      if (this._leapPushT > 0 && this._leapPush) {
        const rem = this._leapPushT / (TUNING.hydro.surfaceLeapStroke || this._leapPushT);
        pvx += this._leapPush.x * rem;
        pvy += this._leapPush.y * rem;
        pvz += this._leapPush.z * rem;
      }
      const pvl = Math.hypot(pvx, pvy, pvz);
      const path = pvl > 0.01 ? Math.asin(clamp(pvy / pvl, -1, 1)) : 0;
      // How fast the path itself turns (gravity bends it down at g cos/v),
      // so the body can turn with it (below).
      const pr = flying && this._flying && this._pathLast !== undefined ? (path - this._pathLast) / Math.max(dt, 1e-4) : 0;
      this._pathRate = flying && this._flying ? damp(this._pathRate || 0, clamp(pr, -3, 3), 20, dt) : 0;
      this._pathLast = path;
      // Leaving the water, the nose keeps whatever aim it has. Below a few
      // m/s (a body bobbing clear of a swell) the path means nothing and the
      // nose is simply the player's.
      if (this._leapNose) {
        this.airAim = clamp((this.airAim || 0) + aimDelta, -movement.airAimMax, movement.airAimMax);
        this.targetPitch = clamp(path + this.airAim, -movement.maxPitch, movement.maxPitch);
        this.lastRideTarget = this.targetPitch;
      } else if (!this._flying || pvl < movement.airPathSpeed) {
        this.airAim = this.targetPitch - path;
      } else {
        // The air flowing over the body turns it back into the path
        // (weathervane): once the player has not aimed for a quarter of a
        // second, the aim relaxes over about 0.7 s. While aiming it holds,
        // and gaps between mouse reports do not count as letting go.
        this._aimIdle = Math.abs(my) > 0 || input.pitchUpKeys || input.pitchDownKeys ? 0 : (this._aimIdle || 0) + dt;
        // Tucked for a dive (Shift), the body lines up with its path at
        // once and much faster, so it goes into the water nose first.
        const aimHold = this.diveState ? 0 : 0.25;
        const aimReturn = movement.airAimReturn * (this.diveState ? 4 : 1);
        if (this._aimIdle > aimHold) this.airAim = damp(this.airAim || 0, 0, aimReturn, dt);
        // The player can aim up to `airAimMax` off the path. A nose already
        // further off it (a breach with the nose well above a shallow path)
        // is not snapped to that limit: the air turns it in.
        const cap = Math.max(movement.airAimMax, Math.abs(this.airAim || 0));
        this.airAim = clamp((this.airAim || 0) + aimDelta, -cap, cap);
        this.targetPitch = clamp(path + this.airAim, -movement.maxPitch, movement.maxPitch);
        this.lastRideTarget = this.targetPitch;
      }
    } else {
      this.airAim = 0;
      this._pathRate = 0;
      this._pathLast = undefined;
    }
    if (flying || !this.leapFlight) this._leapNose = false;
    // Back in the water after a flight, the automatic pitch (ride trim,
    // surface lock) turns the nose at most `landingPitchRate` rad/s for a
    // moment: a nose-down entry pulls out over a few tenths of a second
    // instead of being yanked level in four frames.
    if (this._flying && !flying) {
      this._landClock = 0.6;
      this._landTrim = movement.landingTrimTime;
    }
    this._landClock = Math.max(0, (this._landClock || 0) - dt);
    this._landTrim = Math.max(0, (this._landTrim || 0) - dt);
    this._flying = flying;
    const autoPitch0 = this.targetPitch;
    this._rideTrim(dt, ocean, pitchInput);
    if (lock > 0) {
      // On the surface the body lies along it; the mouse looks instead.
      // Landing into the lock (from a leap, nose down), the nose comes
      // round to the surface over about 0.2 s, tightening as the lock
      // takes hold, instead of being snapped to it.
      this.targetPitch -= aimDelta * lock;
      this.targetPitch = damp(this.targetPitch, this.surfLockPitch, 4 + 40 * lock * lock, dt);
      this.lastRideTarget = this.targetPitch;
      if (lock > 0.5) this.rideOffset = 0;
    }
    // The same while the lock is taking hold (arriving at the surface).
    if (this._landClock > 0 || (lock > 0 && lock < 1 && this.surfLockEngaged)) {
      const most = movement.landingPitchRate * dt;
      const d = this.targetPitch - autoPitch0;
      if (Math.abs(d) > most) {
        this.targetPitch = autoPitch0 + Math.sign(d) * most;
        this.lastRideTarget = this.targetPitch;
      }
    }
    {
      const most = movement.autoPitchRate * dt;
      const d = this.targetPitch - pitchRef;
      if (Math.abs(d) > most) {
        this.targetPitch = pitchRef + Math.sign(d) * most;
        this.lastRideTarget = this.targetPitch;
      }
    }
    const posture = this.verticalInput > 0 ? movement.ascendPitch : this.verticalInput < 0 ? movement.descendPitch : 0;
    const pitchTarget = clamp(this.targetPitch + posture, -movement.maxPitch, movement.maxPitch);

    const prevYaw = this.yaw;
    this.yaw = wrapAngle(
      dampAngle(this.yaw, this.targetYaw, lerp(movement.turnResponsiveness, TUNING.hydro.surfaceTurnResponse, skiing), dt)
    );
    this.yawRate = clamp(wrapAngle(this.yaw - prevYaw) / Math.max(dt, 0.0001), -movement.maxTurnRate, movement.maxTurnRate);
    this.targetPitch = clamp(this.targetPitch, -movement.maxPitch, movement.maxPitch);
    // In the air the body weathervanes with the flow: it turns with its
    // curving path instead of trailing behind it. Trailing left the nose a
    // degree or so above the path all the way down an arc, and that angle
    // alone made lift: 12% of g on a calm leap, and at 90 m/s the full
    // 0.6 g, which turned a leap down a 500 m face into a 10 s glide a
    // metre above the water. Lift now comes only from where the player
    // points the nose.
    if (this._flying && this._pathRate) this.pitch += this._pathRate * dt;
    this.pitch = damp(this.pitch, pitchTarget, movement.pitchResponsiveness, dt);
    if (lock > 0) this.pitch = damp(this.pitch, pitchTarget, TUNING.hydro.surfaceLockPitchRate * lock, dt);
    this.pitch = clamp(this.pitch, -movement.maxPitch, movement.maxPitch);
    // The look offset fades instead of vanishing when the lock lets go (a
    // leap), so the view does not jump.
    this.viewPitch = clamp(this.targetPitch + this.surfLook, -movement.maxPitch, movement.maxPitch);

    // Previous frame's horizontal slip, used to lay the body over into the
    // drift. Use the level right axis so a steep climb doesn't feed vertical
    // velocity into the bank and spiral the body.
    this.tmpFlatRight.set(this.right.x, 0, this.right.z);
    if (this.tmpFlatRight.lengthSq() > 1e-5) this.tmpFlatRight.normalize();
    const slip = this.velocity.dot(this.tmpFlatRight);
    const driftLean = clamp(slip * movement.bankIntoDrift * 0.22, -0.2, 0.2);
    const bankTarget = clamp(
      -this.yawRate * movement.banking + driftLean + this.turnLean * 0.08,
      -movement.maxBank,
      movement.maxBank
    );
    this.roll = damp(this.roll, bankTarget, movement.bankResponsiveness, dt);
    this.roll = clamp(this.roll, -movement.maxRollVisual, movement.maxRollVisual);

    this.qYaw.setFromAxisAngle(Y_AXIS, this.yaw);
    this.qPitch.setFromAxisAngle(X_AXIS, -this.pitch);
    this.qRoll.setFromAxisAngle(Z_AXIS, this.roll);
    this.orientation.copy(this.qYaw).multiply(this.qPitch).multiply(this.qRoll);
    this.forward.copy(FORWARD).applyQuaternion(this.orientation);
    this.up.copy(UP).applyQuaternion(this.orientation);
    this.right.copy(RIGHT).applyQuaternion(this.orientation);

    const water = ocean.getWaterSample(this.position.x, this.position.z);
    const surfaceHeight = water.height;
    const underwater = this.position.y < surfaceHeight;

    // Passive surface trim: when the player is not actively pitching, the
    // body settles parallel to the local face. This is buoyancy stability, not
    // a surf mode; it is disabled as soon as the player pitches or changes
    // depth, and above a few metres it does nothing.
    const depthNow = surfaceHeight - this.position.y;
    if (
      !pitchInput &&
      this.verticalInput === 0 &&
      depthNow > -0.1 &&
      depthNow < TUNING.hydro.surfaceTrimDepth &&
      this.speed < TUNING.hydro.surfaceTrimSpeed
    ) {
      const slopeAlong = water.slopeX * this.forward.x + water.slopeZ * this.forward.z;
      this.pitch = damp(this.pitch, Math.atan(slopeAlong), TUNING.hydro.surfaceTrimRate, dt);
      this.qYaw.setFromAxisAngle(Y_AXIS, this.yaw);
      this.qPitch.setFromAxisAngle(X_AXIS, -this.pitch);
      this.qRoll.setFromAxisAngle(Z_AXIS, this.roll);
      this.orientation.copy(this.qYaw).multiply(this.qPitch).multiply(this.qRoll);
      this.forward.copy(FORWARD).applyQuaternion(this.orientation);
      this.up.copy(UP).applyQuaternion(this.orientation);
      this.right.copy(RIGHT).applyQuaternion(this.orientation);
    }

    this._applyWaterAttitude(dt, pitchInput, keyTurn !== 0 || Math.abs(mx) > 0);

    // Swim pace is speed through the water, not over the ground: a dolphin
    // carried along by a mega wave's 60 m/s flow still strokes against the
    // water around it. (Last frame's water velocity at the body.)
    const wvel = this._bodyWaterVel();
    const forwardSpeed = wvel
      ? (this.velocity.x - wvel.x) * this.forward.x +
        (this.velocity.y - wvel.y) * this.forward.y +
        (this.velocity.z - wvel.z) * this.forward.z
      : this.velocity.dot(this.forward);
    const surge = input.boost && !input.brake;
    const thrusting = (input.forward || surge) && !input.brake;

    // --- Propulsion ------------------------------------------------------
    // Thrust stays an acceleration (the same hand feel as before), while all
    // water forces below are true forces divided by effective mass.
    let thrustAccel = 0;
    if (thrusting) {
      const targetSpeed = surge ? movement.boostSpeed : movement.cruiseSpeed;
      const accel = surge ? movement.boostAcceleration : movement.acceleration;
      const headroom = 1 - clamp(forwardSpeed / targetSpeed, 0, 1);
      // Above the chosen pace the tail eases off rather than pushing on
      // forever, so top speed comes from the stroke, not from drag alone.
      // Speed a wave gives you beyond that is yours to keep.
      const overrun = 1 - smoothstep(1, 1 + movement.thrustTaper, forwardSpeed / targetSpeed);
      thrustAccel = accel * (0.38 + headroom * 0.62) * overrun;
    } else if (!input.brake && forwardSpeed < movement.idleGlide) {
      // A slow, always-present tail scull keeps the creature alive at rest.
      // Capped: swept backwards through fast water (or just after a
      // teleport), the scull must not turn into a sprint.
      thrustAccel = Math.min(movement.idleGlide, movement.idleGlide - forwardSpeed) * 2.6;
    }

    // The wave does the work. On the surface and heading down a face, gravity
    // along the face and the wave's flow carry the dolphin: the tail goes
    // still and W or Shift add no stroke, so it surfs, carves and coasts.
    // Coasting on a wave (no W/Shift) the tail is still whichever way the
    // nose points. Climbing the face or running along it, W and Shift still
    // stroke, to climb or to chase a section. Eased over a few tenths of a
    // second, so the stroke fades rather than switching.
    if (!this.leapFlight) {
      this.tailStill = damp(this.tailStill || 0, this._waveGlideTarget(thrusting), TUNING.hydro.glideRate, dt);
    }
    if (this.tailStill > 0 && thrustAccel > 0) thrustAccel *= 1 - this.tailStill;
    // Tucked in a Shift dive the tail is still: the body glides on what it
    // carried in.
    if (this.streamline > 0 && thrustAccel > 0) thrustAccel *= 1 - this.streamline;

    let reverseAccel = 0;
    if (input.brake) {
      if (forwardSpeed > 0.1) reverseAccel = -movement.braking;
      else if (forwardSpeed > -movement.reverseSpeed) reverseAccel = -movement.reverseAcceleration;
    }

    const verticalAccel = this.verticalInput * movement.verticalThrust;

    // Ambient current: a gentle shelf eddy, always moving, never a treadmill.
    // It is now a water velocity for panel drag rather than an acceleration.
    const t = ocean.time;
    this.tmpCurrent.set(
      movement.currentX + Math.sin(t * 0.071 + this.position.z * 0.002) * movement.currentVariance,
      movement.currentY + Math.sin(t * 0.043) * 0.015,
      movement.currentZ + Math.cos(t * 0.059 + this.position.x * 0.0017) * movement.currentVariance
    );

    // --- Force integration ----------------------------------------------
    // Steering is solved once per frame; water forces and translation run at
    // a fixed 120 Hz (1-4 substeps) so slams and surface crossings are stable.
    // Fixed 120 Hz when the frame allows it, up to four substeps on a slow
    // frame. The water kinematics are sampled once per frame (the expensive
    // part) and later substeps correct the sampled surface for how far each
    // panel has moved, so extra substeps are cheap. With only two, a 40 ms
    // frame took 20 ms steps, and at 70 m/s the crossflow drag overshot from
    // one step to the next.
    const substeps = clamp(Math.ceil(dt / (1 / 120) - 1e-6), 1, 4);
    const step = dt / substeps;
    // The push comes from the stroke, and a stroke winds up and dies away:
    // it follows the key over about a tenth of a second instead of switching
    // on and off in a single frame.
    this._thrustEased = damp(this._thrustEased ?? thrustAccel, thrustAccel, movement.thrustEase, dt);
    this.hydroControl.thrustAccel = this._thrustEased;
    this.hydroControl.reverseAccel = reverseAccel;
    this.hydroControl.verticalAccel = verticalAccel;
    this.hydroControl.streamline = this.streamline;

    let hydro = this.hydro;
    let hullMs = 0;
    // Most of the hull wet in any substep this frame. A body skimming a face
    // at 90 m/s touches the water for a few milliseconds at a time, often in
    // one substep and not the next, so the last substep alone can miss it.
    let wetMax = 0;
    for (let s = 0; s < substeps; s++) {
      hydro = this.hull.apply(this, ocean, this.hydroControl, this.tmpCurrent, s === 0, s * step);
      hullMs += this.hull.lastMs;
      wetMax = Math.max(wetMax, hydro.wetFraction);
      if (this._subA) this._subA[s] = [hydro.accel.x, hydro.accel.y, hydro.accel.z, step];
      this.velocity.addScaledVector(hydro.accel, step);
      if (this._leapPushT > 0) {
        const stroke = TUNING.hydro.surfaceLeapStroke || step;
        const k = Math.min(step, this._leapPushT) / stroke;
        this.velocity.addScaledVector(this._leapPush, k);
        this._leapPushT -= step;
      }
      // Only while engaged: after a release (C, or letting go of Space
      // without a leap) the fading lock used to keep pulling the body back
      // to the surface for a tenth of a second, a 5 m/s tug against a dive.
      // Dropping the constraint changes no velocity, so the release is
      // seamless; the fading `surfLock` still eases posture and camera.
      if (this.surfLock > 0 && this.surfLockEngaged) this._surfaceConstrain(step);
      this.position.addScaledVector(this.velocity, step);
    }
    this.hydro = hydro;
    this.hullMs = hullMs;
    this.wetMax = wetMax;

    // Dry-hull flight: keep the snout-led ballistic glide and the small
    // speed-dependent body lift, but gravity has already been integrated by
    // the hull. Only add the aerodynamic terms while the hull is essentially
    // out of the water.
    if (hydro.wetFraction < 0.02) {
      // Lift: perpendicular to the flight path, toward where the nose
      // points, growing with speed^2 and the angle between nose and path
      // (stalling past movement.airStall), capped at movement.airLiftMax.
      // With the nose on the path there is none: a pure ballistic arc.
      // Turning the path costs speed (induced drag).
      const airSpeed = this.velocity.length();
      if (airSpeed > 1 && movement.airLiftCoef > 0) {
        const vh = this.tmp.copy(this.velocity).multiplyScalar(1 / airSpeed);
        const cosA = this.forward.dot(vh);
        const lift = this.tmp2 || (this.tmp2 = new THREE.Vector3());
        lift.copy(this.forward).addScaledVector(vh, -cosA);
        const sinA = lift.length();
        if (sinA > 1e-4 && cosA > 0) {
          const stall = movement.airStall;
          const alpha = Math.atan2(sinA, cosA);
          const eff = alpha < stall ? Math.sin(alpha) : Math.sin(stall) * Math.max(0, 1 - (alpha - stall) / stall);
          const a = Math.min(movement.airLiftCoef * airSpeed * airSpeed * eff, movement.airLiftMax);
          this.velocity.addScaledVector(lift, (a / sinA) * dt);
          this.velocity.addScaledVector(vh, -a * movement.airInducedDrag * dt);
          this.airLiftNow = a;
        } else this.airLiftNow = 0;
      }

      // Shift dive: an extra pull down on top of gravity, and the tucked
      // body cuts through the air with less drag.
      if (this.diveState) this.velocity.y -= movement.airDiveAccel * this.streamline * (1 - (this.floorPull || 0)) * dt;
      const airDrag = 1 - (1 - movement.airDiveDrag) * this.streamline;
      let vf = this.velocity.dot(this.forward);
      let vr = this.velocity.dot(this.right);
      let vu = this.velocity.dot(this.up);
      vf -= vf * (movement.airForwardDrag + Math.abs(vf) * movement.airForwardQuadraticDrag) * airDrag * dt;
      vr -= vr * movement.airLateralDrag * airDrag * dt;
      vu -= vu * movement.airVerticalDrag * airDrag * dt;
      this.velocity
        .copy(this.forward).multiplyScalar(vf)
        .addScaledVector(this.right, vr)
        .addScaledVector(this.up, vu);

    } else this.airLiftNow = 0;

    this.speed = this.velocity.length();

    // Visual tumble in whitewater. The controller/camera still owns the swim
    // attitude; this is a short, decaying body-space roll/pitch while the
    // body is in breaking, aerated water, so the animal reads as thrown
    // rather than scripted into a "surf mode". Only there: it used to fire
    // on every breach, leap and fast landing too (any slam over 450 N, a
    // quarter of the body's weight), throwing the visible body about in the
    // air with no force behind it. Real entry and exit torques already turn
    // the body through the water attitude (qWater).
    this.tumbleClock -= dt;
    const aer = this.hydro ? this.hydro.aeration : 0;
    // Only in the roller itself (aeration over 0.4): in a storm the foam
    // left behind every bore is above 0.18 almost everywhere near the
    // surface, and the body was thrown about every 0.65 s just swimming
    // through it. Riding the surface (Space held and the lock engaged) the
    // animal holds its line, so the body is not thrown at all.
    const rough = aer > 0.4 && this.hydro.wetFraction > 0.3 && !this.surfLockEngaged;
    if (rough && this.tumbleClock <= 0) {
      this.tumbleClock = 0.65;
      const seed = Math.sin(this.position.x * 0.73 + this.position.z * 0.91 + ocean.time * 1.37);
      const k = smoothstep(0.4, 0.75, aer);
      this.tumbleRollVel += seed * 3.4 * k;
      this.tumblePitchVel += Math.cos(seed * 2.1 + this.position.y) * 2.6 * k;
    }
    this.tumbleRollVel *= Math.exp(-(rough ? 1.4 : 3.2) * dt);
    this.tumblePitchVel *= Math.exp(-(rough ? 1.4 : 3.2) * dt);
    this.tumbleRoll = damp(this.tumbleRoll, 0, rough ? 0.6 : 2.6, dt);
    this.tumblePitch = damp(this.tumblePitch, 0, rough ? 0.6 : 2.6, dt);
    this.tumbleRoll = clamp(this.tumbleRoll + this.tumbleRollVel * dt, -1.1, 1.1);
    this.tumblePitch = clamp(this.tumblePitch + this.tumblePitchVel * dt, -0.9, 0.9);

    if (this.position.y > surfaceHeight + 0.25) {
      this.airborne = true;
    } else if (this.position.y < surfaceHeight - 0.25) {
      this.airborne = false;
    }

    // Stay inside the surveyed 3 x 3 km shelf.
    const limit = TUNING.world.boundary;
    const edge = Math.max(Math.abs(this.position.x), Math.abs(this.position.z));
    // A ride on a mega wave is not stopped at the line: shoving the body
    // back up-wave into a 500 m face buries it. Out past the edge the push
    // is a gentle drift home (at most 6 m/s), not a teleport.
    const onMega = TUNING.water.megaWave && ocean.water.megaAt
      ? ocean.water.megaAt(this.position.x, this.position.z, this._megaProbe || (this._megaProbe = {})).h > 30
      : false;
    if (edge > limit) {
      const push = onMega ? 0 : Math.min((edge - limit) * 0.8, 1.2);
      if (Math.abs(this.position.x) > limit) this.position.x += -Math.sign(this.position.x) * push * dt * 5;
      if (Math.abs(this.position.z) > limit) this.position.z += -Math.sign(this.position.z) * push * dt * 5;
      if (!onMega) {
        this.velocity.x *= 0.998;
        this.velocity.z *= 0.998;
      }
      this.edgeWarning = true;
    } else {
      this.edgeWarning = false;
    }

    // --- Body contact with the granular floor ---------------------------
    this.contact.floor = false;
    this.contact.sand = 0;
    let deepest = 0;
    let deepestPart = null;
    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const dirX = horizontalSpeed > 0.2 ? this.velocity.x / horizontalSpeed : this.forward.x;
    const dirZ = horizontalSpeed > 0.2 ? this.velocity.z / horizontalSpeed : this.forward.z;
    this.plowClock -= dt;
    for (let i = 0; i < this.bodyParts.length; i++) {
      const def = this.bodyParts[i];
      const fp = this.floorPoints[i];
      fp.pos.copy(def.offset).applyQuaternion(this.orientation).add(this.position);
      fp.alt = fp.pos.y - seabed.getSurfaceHeight(fp.pos.x, fp.pos.z);
      fp.radius = def.radius;
      fp.load = def.load;
      if (fp.alt < fp.radius) {
        const pen = fp.radius - fp.alt;
        if (pen > deepest) {
          deepest = pen;
          deepestPart = fp;
        }
        this.contact.floor = true;
        const isNose = def.name === "nose";
        const isTail = def.name === "tail";
        const impactSpeed = Math.max(0, -this.velocity.y) + horizontalSpeed * Math.max(0, -this.forward.y) * 0.5;
        if (this.plowClock <= 0) {
          const shovel =
            (isNose ? Math.max(0, -this.forward.y) * horizontalSpeed * 0.055 : 0) +
            (isTail ? Math.max(0, -this.velocity.y) * 0.035 : 0);
          const depth = clamp(
            pen * 1.05 +
              impactSpeed * 0.045 +
              (this.verticalInput < 0 ? 0.16 : 0) +
              shovel,
            0.04,
            TUNING.sand.maxContactDepth
          );
          const radius = (isNose ? 1.02 : isTail ? 1.38 : 1.55) * (0.9 + horizontalSpeed * 0.018);
          let amount;
          if (isTail && impactSpeed > 1.0) {
            amount = seabed.tailSlap(fp.pos.x, fp.pos.z, radius, depth * 1.12, dirX, dirZ, horizontalSpeed);
          } else if (impactSpeed > 3.2) {
            amount = seabed.impact(fp.pos.x, fp.pos.z, radius, depth, dirX, dirZ, horizontalSpeed);
          } else {
            amount = seabed.plow(fp.pos.x, fp.pos.z, radius, depth, dirX, dirZ, horizontalSpeed);
          }
          if (amount > 0.001) {
            this.contact.sand += amount;
            const surf = seabed.getSurfaceHeight(fp.pos.x, fp.pos.z);
            if (impactSpeed > 2.5) {
              this.impact = Math.max(this.impact, clamp(impactSpeed * 0.16, 0.1, 1));
              effects.splashBurst(fp.pos.x, surf + 0.05, fp.pos.z, impactSpeed * 0.14, dirX, dirZ);
              this.wetness = Math.max(this.wetness, 0.3);
            }
          }
        }
      }
    }

    if (deepest > 0) {
      // The sand yields, then supports the body. This is a yielding correction,
      // not a hard wall, which keeps contact feeling granular.
      const n = seabed.getSurfaceNormal(deepestPart.pos.x, deepestPart.pos.z);
      const push = deepest * (1 - Math.exp(-dt * 68));
      this.position.y += push;
      this.position.x += n.x * push * 0.32;
      this.position.z += n.z * push * 0.32;
      const vn = this.velocity.x * n.x + this.velocity.y * n.y + this.velocity.z * n.z;
      if (vn < 0) {
        // The speed into the sand goes over a few frames, not in one, and
        // the body then slides along the bed instead of bouncing off it.
        const take = 1 - Math.exp(-dt * (TUNING.movement.floorYield + deepest * 220));
        this.velocity.x -= n.x * vn * take;
        this.velocity.y -= n.y * vn * take;
        this.velocity.z -= n.z * vn * take;
      }
      this.velocity.multiplyScalar(Math.exp(-1.15 * dt * Math.min(deepest * 4, 1)));
      if (deepest > 0.3) this.impact = Math.max(this.impact, deepest * 0.3);
    }
    if (this.plowClock <= 0) this.plowClock = 0.032;

    // --- Surface contact, breach and splash -----------------------------
    const centerWater = ocean.getWaterSample(this.position.x, this.position.z);
    // The water clock advances after this update, and the position just
    // integrated is for that next instant. On a 500 m face rising at
    // 100+ m/s that is metres, so compare against the surface where it
    // will be (`surfaceLead`), not where it was.
    const centerHeight = centerWater.height + this.surfaceLead;
    const centerAbove = this.position.y > centerHeight + 0.02;
    const noseWorld = this.tmp.copy(this.forward).multiplyScalar(1.35).add(this.position);
    const noseWater = ocean.getWaterSample(noseWorld.x, noseWorld.z);
    const noseAbove = noseWorld.y > noseWater.height - 0.05;
    this.contact.surface = !centerAbove || !noseAbove;
    this.surfaceCooldown -= dt;
    this.surfaceFxCooldown -= dt;
    const surfaceSpeed = Math.abs(this.velocity.y) + this.speed * 0.25;

    // How fast the surface under the animal is rising along its path. On a
    // wave face the water itself climbs at several m/s; that motion is not
    // the dolphin leaping.
    const surfaceRateRaw =
      this.lastSurfaceHeight === undefined || dt <= 0 ? 0 : (centerHeight - this.lastSurfaceHeight) / dt;
    this.lastSurfaceHeight = centerHeight;
    this.surfaceRate =
      (this.surfaceRate || 0) + (clamp(surfaceRateRaw, -60, 60) - (this.surfaceRate || 0)) * Math.min(1, dt * 10);

    if (!this.wasAbove && centerAbove) {
      // A clean breach, driven by real upward momentum through the surface
      // and a nose aimed out of the water. A high-speed exit gets one last
      // tail kick so the animal can properly clear the surface. Skimming a
      // rising face does neither, so it is not kicked into the air.
      const exitSpeed = this.velocity.length();
      const climbThrough = this.velocity.y - this.surfaceRate;
      const faceSlope = Math.atan(
        (this.forward.x * centerWater.slopeX + this.forward.z * centerWater.slopeZ) /
          Math.max(0.2, Math.hypot(this.forward.x, this.forward.z))
      );
      const noseOut = Math.asin(clamp(this.forward.y, -1, 1)) - faceSlope;
      // And the body must actually be rising through the water: skimming
      // off a 500 m face on the way down (the surface falling away faster
      // than the body) is not a leap, and kicking it would bounce the body
      // off the face.
      const wvy = Number.isFinite(this.hull.waterVel.y) ? this.hull.waterVel.y : 0;
      const rising = this.velocity.y - wvy > 1.2;
      if (
        climbThrough > 1.2 &&
        rising &&
        noseOut > 0.25 &&
        exitSpeed > movement.cruiseSpeed * 0.45 &&
        this.surfLock < 0.5 &&
        !(this.leapClock > 0)
      ) {
        if (input.boost && movement.breachBoost > 0) {
          // Boosted breach (Shift): one last hard fluke stroke while the
          // flukes are still in the water, along the path the body is on
          // (and its axis), spread over a stroke like a leap's. It throws
          // the body higher and further on the line it chose.
          const P = this._leapPush || (this._leapPush = new THREE.Vector3());
          P.copy(this.velocity).multiplyScalar(1 / Math.max(exitSpeed, 1e-3)).add(this.forward).normalize();
          P.multiplyScalar(movement.breachBoost * clamp(exitSpeed / movement.boostSpeed, 0.5, 1.2));
          const stroke = TUNING.hydro.surfaceLeapStroke || 0;
          if (stroke > 0) this._leapPushT = stroke;
          else this.velocity.add(P);
          this.boostBreachCount++;
        } else {
          // The flukes are still in the water as the body comes out, so the
          // last kick is a stroke too, not an instant jump in speed (that
          // was a one-frame jolt of 0.7-1.8 m/s at every breach).
          const kick = movement.breachImpulse * clamp(exitSpeed / movement.boostSpeed, 0, 1.15);
          const stroke = TUNING.hydro.surfaceLeapStroke || 0;
          if (stroke > 0) {
            (this._leapPush || (this._leapPush = new THREE.Vector3())).set(0, kick, 0);
            this._leapPushT = stroke;
          } else this.velocity.y += kick;
        }
      }
    }
    // Breach and re-entry events use a hysteresis band: the body has to get
    // clear of the water (centre 0.3 m up) to count as a breach. Skimming
    // along the surface on a wave face crosses the waterline many times a
    // second; those crossings are not leaps, so they must not each fire a
    // splash fountain, a toast and a re-entry speed loss.
    const clearOfWater = this.position.y > centerHeight + 0.3;
    if (!this.leaping && clearOfWater) {
      this.leaping = true;
      // Shift held through the breach: the dive arms only past the apex.
      this._boostThroughExit = !!input.boost;
      const exitSpeed = this.velocity.length();
      const breachPower = clamp(Math.abs(this.velocity.y) * 0.38 + exitSpeed * 0.08, 0.2, 2.1);
      this.surfaceImpulseAll(ocean, centerWater, breachPower);
      effects.splashBurst(this.position.x, centerHeight + 0.12, this.position.z, breachPower, this.velocity.x, this.velocity.z);
      // Body-shaped sheeting: the whole animal leaves the water, not a point.
      this.wakeA.copy(this.bodyParts[0].offset).applyQuaternion(this.orientation).add(this.position);
      this.wakeB.copy(this.bodyParts[1].offset).applyQuaternion(this.orientation).add(this.position);
      this.wakeC.copy(this.bodyParts[2].offset).applyQuaternion(this.orientation).add(this.position);
      if (breachPower > 0.55 && this.surfaceFxCooldown <= 0) {
        effects.spraySheet(
          [this.wakeA, this.wakeB, this.wakeC],
          clamp(breachPower * 0.7, 0.2, 1.2),
          this.velocity.x,
          this.velocity.y,
          this.velocity.z
        );
        effects.wakeTrail(this.position.x, this.position.z, centerHeight, 0.5, this.forward.x, this.forward.z, 1.6);
        this.surfaceFxCooldown = 0.35;
      }
      effects.bubbleBurst(this.position.x, this.position.y, this.position.z, 12, 0.9, 0.45);
      this.impact = Math.max(this.impact, 0.32 + breachPower * 0.2);
      this.wetness = 1;
      this.breachCount++;
      this.lastBreachTime = time;
    } else if (this.leaping && !centerAbove) {
      // Re-entry.
      this.leaping = false;
      const entry = clamp(Math.abs(this.velocity.y) * 0.33 + this.speed * 0.03, 0.2, 1.5);
      this.surfaceImpulseAll(ocean, centerWater, entry);
      effects.splashBurst(this.position.x, centerHeight + 0.08, this.position.z, entry, this.velocity.x, this.velocity.z);
      if (entry > 0.5 && this.surfaceFxCooldown <= 0) {
        effects.splashCrown(this.position.x, centerHeight + 0.04, this.position.z, entry, this.velocity.x, this.velocity.z);
        for (let i = 0; i < 2; i++) {
          effects.wakeTrail(
            this.position.x + (Math.random() - 0.5) * 2.2,
            this.position.z + (Math.random() - 0.5) * 2.2,
            centerHeight,
            entry * 0.7,
            this.forward.x,
            this.forward.z,
            1.8
          );
        }
        this.surfaceFxCooldown = 0.45;
      }
      effects.bubbleBurst(this.position.x, this.position.y - 0.2, this.position.z, 22, 1.4, 0.7);
      // Water entry takes energy, but keep most of the horizontal momentum so
      // a long leap can skip or carry through instead of stopping dead. The
      // loss is on velocity relative to the water and scales with how hard
      // the body drops into the surface: a dive from a leap pays it in full,
      // while skimming back onto a wave face at 70 m/s (the conveyor already
      // moves the water with the body) loses nothing.
      // Impact speed is the body's speed into the surface along its normal,
      // relative to the water (the surface moves with the water's normal
      // velocity). Sliding back onto a steep face along it is no impact.
      const wv = this.hull.waterVel;
      const wx = Number.isFinite(wv.x) ? wv.x : 0;
      const wy = Number.isFinite(wv.y) ? wv.y : 0;
      const wz = Number.isFinite(wv.z) ? wv.z : 0;
      const nx = centerWater.nx ?? 0;
      const ny = centerWater.ny ?? 1;
      const nz = centerWater.nz ?? 0;
      const rx = this.velocity.x - wx;
      const ry = this.velocity.y - wy;
      const rz = this.velocity.z - wz;
      const vn = rx * nx + ry * ny + rz * nz;
      const hit = smoothstep(1, 5, Math.max(0, -vn));
      if (hit > 0) {
        // A clean nose-first entry slices in and keeps its speed; a belly
        // flop pays the full loss.
        const rl = Math.hypot(rx, ry, rz) || 1;
        const align = Math.max(0, (rx * this.forward.x + ry * this.forward.y + rz * this.forward.z) / rl);
        const clean = align * align;
        // Tucked in a Shift dive the body knifes in and keeps nearly all of
        // its speed.
        const keep = 1 - (TUNING.hydro.diveEntryKeep ?? 0) * this.streamline;
        // Tangential part keeps 1 - cutT, normal part keeps 1 - cutN. The
        // water takes it while the body goes in (`movement.entryLossTime`),
        // not all in the frame its centre meets the surface, which showed
        // as a hitch of half a metre per second on every porpoise landing.
        this._entryCutN = 0.32 * hit * (1 - 0.7 * clean) * keep;
        this._entryCutT = 0.08 * hit * (1 - 0.9 * clean) * keep;
        this._entryLeft = TUNING.movement.entryLossTime;
      }
      this.impact = Math.max(this.impact, 0.55);
      this.wetness = 1;
    }
    this.wasAbove = centerAbove;
    if (this._entryLeft > 0) {
      if (this.leaping) this._entryLeft = 0;
      else {
        const share = Math.min(dt, this._entryLeft) / TUNING.movement.entryLossTime;
        this._entryLeft -= dt;
        const fN = Math.pow(1 - this._entryCutN, share);
        const fT = Math.pow(1 - this._entryCutT, share);
        const wv = this.hull.waterVel;
        const wx = Number.isFinite(wv.x) ? wv.x : 0;
        const wy = Number.isFinite(wv.y) ? wv.y : 0;
        const wz = Number.isFinite(wv.z) ? wv.z : 0;
        const nx = centerWater.nx ?? 0;
        const ny = centerWater.ny ?? 1;
        const nz = centerWater.nz ?? 0;
        const rx = this.velocity.x - wx;
        const ry = this.velocity.y - wy;
        const rz = this.velocity.z - wz;
        const vn = rx * nx + ry * ny + rz * nz;
        // Only speed into the water is taken from the normal part.
        const kn = vn < 0 ? vn * fN : vn;
        this.velocity.x = wx + (rx - vn * nx) * fT + kn * nx;
        this.velocity.y = wy + (ry - vn * ny) * fT + kn * ny;
        this.velocity.z = wz + (rz - vn * nz) * fT + kn * nz;
      }
    }

    if (!centerAbove) {
      // Water parts continuously around the submerged body near the surface.
      for (let i = 0; i < 3; i++) {
        const def = this.bodyParts[i];
        const p = this.tmp2.copy(def.offset).applyQuaternion(this.orientation).add(this.position);
        const w = ocean.getWaterSample(p.x, p.z);
        const proximity = 1 - smoothstep(0.25, 1.5, w.height - p.y);
        if (proximity > 0.01 && p.y < w.height + 0.15) {
          const strength = -0.035 * (def.name === "center" ? 1.4 : 0.7) * (1 + this.speed * 0.07) * proximity;
          ocean.addSurfaceContact(p.x, p.z, strength, def.name === "center" ? 1.6 : 0.9);
        }
      }
      if (surfaceSpeed > TUNING.waves.splashThreshold && this.position.y > centerHeight - 0.65 && this.surfaceCooldown <= 0) {
        // Capped: at 70 m/s on a mega face the old speed term threw a
        // 100-droplet fountain every 0.13 s and buried the view in spray.
        const power = clamp(surfaceSpeed * 0.08, 0.08, 0.5) * Math.min(2, 0.6 + this.speed * 0.12);
        ocean.surfaceImpulse(this.position.x, this.position.z, power, 1.2);
        // Spray comes off the part of the back that is cutting the surface:
        // a body running half a metre down only boils it, and a dolphin
        // riding a face throws a thin sheet rather than a fountain.
        const cutting = 1 - smoothstep(0.08, 0.6, centerHeight - this.position.y);
        if (cutting > 0.05) {
          effects.splashBurst(this.position.x, centerHeight + 0.03, this.position.z, power * cutting, this.velocity.x, this.velocity.z);
        }
        this.surfaceCooldown = 0.13;
        this.wetness = Math.max(this.wetness, 0.22);
      }
    }

    // --- Near-surface wake, bow wave and tail boil ----------------------
    // Strong at 0.3 m, nearly gone by 2 m.
    const depthToSurface = Math.max(0, centerHeight - this.position.y);
    const surfaceFade = 1 - smoothstep(0.25, 2.0, depthToSurface);
    if (!centerAbove && surfaceFade > 0.01 && this.speed > 0.8) {
      const strength = surfaceFade * clamp(this.speed / 9.5, 0, 1.4);
      const bow = this.wakeA.copy(this.bodyParts[0].offset).applyQuaternion(this.orientation).add(this.position);
      const tail = this.wakeB.copy(this.bodyParts[2].offset).applyQuaternion(this.orientation).add(this.position);
      this.bowClock -= dt;
      if (this.bowClock <= 0) {
        ocean.addSurfaceContact(bow.x, bow.z, 0.055 * strength, 0.7);
        effects.bowWave(bow.x, bow.z, centerHeight, strength, this.right.x, this.right.z, this.forward.x, this.forward.z);
        this.bowClock = 0.075;
      }
      this.wakeClock -= dt;
      if (this.wakeClock <= 0) {
        ocean.addSurfaceContact(tail.x, tail.z, -0.05 * strength, 1.15);
        effects.wakeTrail(tail.x, tail.z, centerHeight, strength, this.forward.x, this.forward.z, 1.1);
        this.wakeClock = 0.075;
      }
      this.tailBoilClock -= dt;
      if (this.tailBoilClock <= 0) {
        effects.tailBoil(
          tail.x,
          tail.z,
          centerHeight,
          strength * 1.1,
          this.forward.x,
          this.forward.z,
          this.tailPhase
        );
        this.tailBoilClock = 0.16;
      }
    }

    // Tail slap: trigger on the fluke actually crossing the surface downward.
    // This is more reliable than sampling a particular tail phase.
    this.tailSlapClock -= dt;
    const fluke = this.wakeC.copy(this.spine.joints[SPINE_Z.length - 1]);
    const flukeAbove = fluke.y > centerHeight;
    if (
      this.lastFlukeAbove === true &&
      !flukeAbove &&
      this.tailSlapClock <= 0 &&
      this.speed > 1.0
    ) {
      const power = clamp(0.3 + this.speed / 12 + this.tailHeave * 1.4, 0.2, 1.2);
      if (power > 0.45) {
        effects.tailSlap(fluke.x, centerHeight + 0.02, fluke.z, power, this.forward.x, this.forward.z);
        ocean.surfaceImpulse(fluke.x, fluke.z, 0.18 * power, 1.1);
        this.impact = Math.max(this.impact, 0.22);
      }
      this.tailSlapClock = 0.7;
    }
    this.lastFlukeAbove = flukeAbove;

    // Remove the residual forward acceleration that can push the body back
    // through the surface while hovering. Not in a leap or a breach: that is
    // a ballistic flight, and this brake (0.3/s, 30 m/s^2 at 100 m/s) bled a
    // leap off a mega wave down below the wave's own speed in the air.
    if (this.position.y > centerHeight + 1.8 && !this.leapFlight && !this.leaping) {
      this.velocity.x *= 1 - 0.3 * dt;
      this.velocity.z *= 1 - 0.3 * dt;
    }

    // --- Sand wake from the flukes, indirect hydrodynamic pressure ------
    this.glideClock -= dt;
    if (this.glideClock <= 0) {
      const strokePulse = clamp(0.72 + 0.42 * Math.sin(this.tailPhase), 0.4, 1.35);
      for (let i = 1; i < 3; i++) {
        const part = this.bodyParts[i];
        const p = this.tmp2.copy(part.offset).applyQuaternion(this.orientation).add(this.position);
        const floorY = seabed.getSurfaceHeight(p.x, p.z);
        const altitude = p.y - floorY;
        if (altitude < 6.2 && this.speed > 1.0) {
          const isFluke = i === 2;
          seabed.glide(
            p.x,
            p.z,
            (isFluke ? 2.05 : 1.45) + this.speed * (isFluke ? 0.17 : 0.1),
            altitude,
            this.speed,
            this.forward.x,
            this.forward.z,
            strokePulse * (isFluke ? 1.0 : 0.72)
          );
        }
      }
      this.glideClock = TUNING.sand.glideInterval * (0.75 + Math.random() * 0.5);
    }

    // Bubbles spin off the pectorals and fluke while carving or surging.
    this.bubbleClock -= dt;
    if (this.bubbleClock <= 0 && !centerAbove && (this.speed > 3.2 || surge)) {
      const source = this.tmp2
        .copy(this.bodyParts[1 + Math.floor(Math.random() * 3)].offset)
        .applyQuaternion(this.orientation)
        .add(this.position);
      effects.bubbleBurst(source.x, source.y, source.z, 1 + Math.floor(this.speed * 0.12), 0.32, 0.45);
      this.bubbleClock = 0.22 + Math.random() * 0.5;
    }

    // --- Animation / presentation ---------------------------------------
    this.speed = this.velocity.length();
    const tailCfg = TUNING.dolphin;

    // Drive the tail from real speed changes, not just the held throttle.
    // Scalar speed (rather than body-frame forward speed) keeps hard turns and
    // collision spikes from being mistaken for acceleration. It is speed
    // through the water: a wave's flow carrying the body is not a stroke.
    const wvTail = this._bodyWaterVel();
    this.swimSpeed = wvTail
      ? Math.hypot(this.velocity.x - wvTail.x, this.velocity.y - wvTail.y, this.velocity.z - wvTail.z)
      : this.speed;
    const rawAccel = (this.swimSpeed - this.prevSwimSpeed) / Math.max(dt, 0.0001);
    this.swimAccel = damp(
      this.swimAccel,
      clamp(rawAccel, -tailCfg.tailAccelClamp, tailCfg.tailAccelClamp),
      tailCfg.tailAccelSmoothing,
      dt
    );
    this.prevSwimSpeed = this.swimSpeed;

    const speedRatio = clamp(this.swimSpeed / TUNING.movement.cruiseSpeed, 0, 2.2);
    const accelDrive = clamp(
      Math.max(0, this.swimAccel) / tailCfg.tailAccelReference,
      0,
      1.8
    );
    const strokeScale = tailCfg.tailWaveAmplitude / 3.15;
    // The stroke winds up and dies away over a beat or so. Pressing or
    // letting go of W or Shift, and the tail leaving or meeting the water,
    // used to switch its reach and its tempo in a single frame.
    this._strokeOn = damp(this._strokeOn || 0, thrusting ? 1 : 0, tailCfg.tailEase, dt);
    this._surgeOn = damp(this._surgeOn || 0, surge ? 1 : 0, tailCfg.tailEase, dt);
    this._tailWater = damp(this._tailWater ?? 1, underwater ? 1 : movement.airTailScale, tailCfg.tailEase * 1.5, dt);
    this.tailHeave =
      Math.min(
        (tailCfg.tailHeaveIdle +
          speedRatio * tailCfg.tailHeaveSpeed +
          accelDrive * tailCfg.tailHeaveAccel +
          this._strokeOn * tailCfg.tailThrustHeave +
          this._surgeOn * tailCfg.tailSurgeHeave) *
          strokeScale,
        tailCfg.tailHeaveMax * strokeScale
      ) *
      this._tailWater *
      (1 - 0.92 * (this.tailStill || 0));

    const beatRate =
      tailCfg.tailBeatBase +
      Math.max(0, this.swimSpeed) * tailCfg.tailBeatSpeed +
      Math.max(0, this.swimAccel) * tailCfg.tailBeatAccel +
      this._strokeOn * tailCfg.tailThrustBeat +
      this._surgeOn * tailCfg.tailSurgeBeat;
    // The tempo changes over a beat, too: speed jumps at a landing or a
    // waterline crossing must not make the tail skip.
    this._beatEased = damp(this._beatEased ?? beatRate, beatRate, tailCfg.tailEase, dt);
    this.tailPhase += dt * Math.min(this._beatEased, tailCfg.tailBeatMax) * (1 - 0.75 * (this.tailStill || 0));
    this.tailUniforms.causticTime.value = ocean.time;
    this.wetness = Math.max(0, this.wetness - dt * 0.13);
    this.impact *= Math.exp(-TUNING.movement.cameraShakeDecay * dt);

    // The physical root stays authoritative for collision and camera; the
    // visible animal is a separate skinned spine. Its head pivots instantly on
    // the target while every following vertebra trails the one ahead.
    this.root.position.copy(this.position);
    if (this.skinnedMesh) {
      this.root.quaternion.identity();
      this._updateSpineAnimation(dt);
    } else {
      this.root.quaternion.copy(this.orientation);
    }

    // Telemetry for HUD / camera.
    const surfaceNow = ocean.getWaterHeight(this.position.x, this.position.z) + this.surfaceLead;
    const floorNow = seabed.getSurfaceHeight(this.position.x, this.position.z);
    this.telemetry.depth = Math.max(0, surfaceNow - this.position.y);
    this.telemetry.altitude = Math.max(0, this.position.y - floorNow);
    this.telemetry.speed = this.speed;
    this.telemetry.waveHeight = surfaceNow;
    // The compass follows the snout target so the readout leads with the view
    // instead of lagging behind the physical body.
    this.telemetry.heading = ((-this.targetYaw * 180) / Math.PI + 720) % 360;
    this.telemetry.underwater = !centerAbove;
    this.telemetry.surfLock = this.surfLock;
    this.telemetry.surfGlide = (this.surfGlide || 0) * this.surfLock;
    this.telemetry.porpoising = !!this.porpoising;
    this.telemetry.diving = this.diveState;
    this.telemetry.breaches = this.breachCount;
    this.telemetry.hydro = this.hydro;

    return this.telemetry;
  }

  /**
   * Couple the body attitude to the water. The hull's panel torque (buoyancy
   * at the waterline, wave pressure, bore drag) rotates the body against a
   * muscular spring that holds the steered attitude. When the player is not
   * actively steering an axis, the animal yields to the water and the tilt is
   * absorbed into the steered heading/pitch: the nose drops down a face, a
   * crest lifts it, and whitewater twists the whole body.
   */
  /**
   * Ride trim: the reflex a surfing dolphin uses to stay in the face. Near
   * the surface at speed it pitches the body for the climb rate that keeps
   * it just under the moving surface (the water's own rise along the path,
   * plus a pull back to the riding depth). The player's mouse pitch is kept
   * as an offset on top of that attitude, so a small nudge carves the line
   * higher or deeper in the face, and a clear aim up or down (more than
   * `hydro.rideRelease` rad) lets go: the animal leaps out or dives
   * through. Rise/dive keys, depth below `rideTrimDepth` or low speed also
   * release it. Only the steering target changes; every force on the body
   * is still the hull, fins and thrust.
   */
  /**
   * Water velocity at the body from the hull's last sample, or null when
   * that sample was taken somewhere else (a teleport or scripted pose).
   */
  _bodyWaterVel() {
    const h = this.hull;
    if (!h) return null;
    const reach = 2 + this.velocity.length() * 0.1;
    return h.waterVelAt.distanceToSquared(this.position) < reach * reach ? h.waterVel : null;
  }

  /** Forget ride-trim and surface history after a teleport or scripted pose. */
  resetRide() {
    if (this._slPrev) this._slPrev.valid = this._slPrev.validOff = false;
    this._spaceWas = false;
    this.leapClock = 0;
    this.leapFlight = false;
    this._leapPushT = 0;
    this._leapNose = false;
    this.diveState = false;
    this.streamline = 0;
    this.floorPull = 0;
    this._boostThroughExit = false;
    this._lockSettle = 0;
    this.rideCmd = undefined;
    this.tailStill = 0;
    this._thrustEased = 0;
    this._beatEased = undefined;
    this._entryLeft = 0;
    this.porpoiseClock = 0;
    this.surfGlide = 0;
    this.surfLockEngaged = false;
    this.surfLock = 0;
    this.surfLook = 0;
    this.viewLock = 0;
    this.airAim = 0;
    this._flying = false;
    this._landClock = 0;
    this.leaping = false;
    this.surfaceLead = 0;
    this.rideOffset = 0;
    this.rideHold = 0;
    this.rideIdle = 0;
    this.lastRideTarget = null;
    this.lastSurfaceHeight = undefined;
    this.surfaceRate = 0;
    if (this.hull) this.hull.waterVelAt.set(Infinity, 0, 0);
  }

  /**
   * Surface lock: hold Space to swim up to the surface and stay on it, the
   * way a dolphin travels or surfs along the top of the water. Once the body
   * is within `surfaceLockEnter` m of the surface it is held there at
   * `surfaceLockDepth` (a velocity constraint along the surface normal, see
   * `_surfaceConstrain`), it lies along the surface under its heading, and
   * the mouse looks around instead of pitching. Everything along the surface
   * is still physics: thrust, drag, the water's flow, and gravity, which
   * speeds you up carving down a face and slows you carving up it. Let go
   * of Space (or press C) and you are back to free 3D swimming. Returns the
   * lock blend (0..1).
   */
  _surfaceLockUpdate(dt, input, ocean, my) {
    const cfg = TUNING.hydro;
    // A Shift dive goes through the surface; the lock waits until it ends.
    const want = !!input.rise && !input.dive && cfg.surfaceLock > 0 && !this.diveState;
    // The surface the body follows is the water averaged over its own
    // length (longer at speed): a planing body rides over wavelets shorter
    // than itself instead of chasing every one at 70 m/s.
    const P = this._slPrev;
    const speed = this.velocity.length();
    const a = clamp(1.5 + speed * 0.06, 1.5, 6);
    const b = a * 0.6;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const st = this._stencil(ocean, this.position.x, this.position.z, fx, fz, a, b);
    const h = st.h;
    const sx = st.sx;
    const sz = st.sz;
    // How fast that averaged surface rises at a fixed point: last frame's
    // stencil, sampled again now, over the water time that has passed since
    // (the previous frame's step, not this one's: with uneven frame times,
    // dividing by this frame's dt made the rate, and with it the lock's
    // target speed, swing by tens of m/s from frame to frame on a 500 m face).
    let dEta = P.valid ? this._slDEta || 0 : 0;
    const waterDt = ocean.time - (P.t ?? ocean.time);
    if (P.valid && waterDt > 1e-4) {
      const again = this._stencil(ocean, P.x, P.z, P.fx, P.fz, P.a, P.b).h;
      dEta = clamp((again - P.h) / waterDt, -250, 250);
    }
    this._slDEta = dEta;
    this.surfaceLead = clamp(dEta * dt, -5, 5);
    P.x = this.position.x;
    P.z = this.position.z;
    P.fx = fx;
    P.fz = fz;
    P.a = a;
    P.b = b;
    P.h = h;
    P.t = ocean.time;
    P.valid = true;

    const depth = h - this.position.y;
    // Speed at which the body closes on the surface along its normal
    // (negative: moving away from it, as just after a leap).
    const closing = dEta + sx * this.velocity.x + sz * this.velocity.z - this.velocity.y;
    // Letting go of Space while riding the surface is a leap: a tail push off
    // the water along the surface normal and forward along the heading, on
    // top of the momentum the wave has already given the body. (C instead of
    // letting go dives, with no leap.)
    this.leapClock = Math.max(0, (this.leapClock || 0) - dt);
    if (this.leapFlight && (this.wetMax ?? 1) < 0.02) this._leapWasDry = true;
    // Speed through the water along the heading.
    const wv0 = this.hull.waterVel;
    const wvOk = Number.isFinite(wv0.x);
    const relFwd = wvOk
      ? (this.velocity.x - wv0.x) * fx + (this.velocity.z - wv0.z) * fz
      : this.velocity.x * fx + this.velocity.z * fz;

    // On a wave or on open water? A sloping face or water already moving
    // fast under the body (a wave carrying it) means surfing: the tail goes
    // still and the wave does the work. Otherwise holding Space on the
    // surface is high-speed porpoising.
    const slopeMag = Math.hypot(sx, sz);
    const flow = wvOk ? Math.hypot(wv0.x, wv0.z) : 0;
    const onWave = Math.max(
      smoothstep(cfg.surfGlideSlope * 0.5, cfg.surfGlideSlope, slopeMag),
      smoothstep(cfg.surfGlideFlow * 0.5, cfg.surfGlideFlow, flow)
    );
    this.surfGlide = damp(this.surfGlide || 0, this.surfLockEngaged ? onWave : 0, 3, dt);
    this.onWave = onWave;

    // Letting go of Space while riding the surface is a leap: a tail push off
    // the water along the surface normal and forward along the heading, on
    // top of the momentum the wave has already given the body. (C instead of
    // letting go dives, with no leap.)
    if (
      this._spaceWas &&
      !input.rise &&
      !input.dive &&
      this.surfLockEngaged &&
      this.surfLock > 0.8 &&
      cfg.surfaceLeap > 0
    ) {
      // A dolphin leap is a hard tail drive along the body: it launches
      // forward along the line, much faster than the wave carrying it, at a
      // low angle off the surface, and flies a ballistic arc (nose up out of
      // the water, nose down into it). Faster rides throw longer, higher leaps.
      const up = cfg.surfaceLeap + clamp(relFwd * cfg.surfaceLeapSpeedShare, 0, 3);
      const onWaveDrive = cfg.surfaceLeapForward + clamp(relFwd * cfg.surfaceLeapDriveShare, 0, 8);
      const calmDrive = cfg.surfaceLeapForwardCalm + clamp(relFwd * cfg.surfaceLeapDriveShare * 0.5, 0, 4);
      const drive = lerp(calmDrive, onWaveDrive, Math.max(onWave, this.surfGlide || 0));
      this._leapOff(up, drive, sx, sz, fx, fz);
    }

    // Porpoising: holding Space and swimming (W) on open water at speed, the
    // dolphin runs a short stretch just under the surface and then clears it
    // in a low, long leap, over and over. Leap height grows with speed.
    const swimming = (input.forward || input.boost) && !input.brake;
    if (
      want &&
      swimming &&
      this.surfLockEngaged &&
      this.surfLock > 0.9 &&
      this.surfGlide < 0.3 &&
      relFwd > cfg.porpoiseSpeed &&
      cfg.porpoise > 0
    ) {
      this.porpoiseClock = (this.porpoiseClock || 0) + dt;
      const interval = clamp(1.5 - 0.05 * relFwd, 0.45, 1.2);
      if (this.porpoiseClock > interval) {
        this.porpoiseClock = 0;
        this._leapOff(clamp(relFwd * cfg.porpoiseLift, 2.2, cfg.porpoiseLiftMax), 0, sx, sz, fx, fz);
        this.porpoiseCount = (this.porpoiseCount || 0) + 1;
      }
    } else if (!this.leapFlight) this.porpoiseClock = 0;
    this.porpoising = this.porpoiseClock > 0 || (this.leapFlight && want);

    this._spaceWas = !!input.rise;
    // A leap lasts until the body is back in the ride or back in the water.
    if (this.leapFlight && (this.surfLockEngaged || (this.leapClock <= 0 && this.hydro && this.hydro.wetFraction > 0.6)))
      this.leapFlight = false;
    if (!want) this.surfLockEngaged = false;
    else if (!this.surfLockEngaged) {
      // Caught once the body reaches the surface band from below, or, coming
      // down from a leap, once it is back in the water (a splash-down, not a
      // landing on an invisible cushion).
      // A landing at speed on a steep face skips: the body touches, is
      // thrown off again and never gets 0.15 m deep. So the body touching
      // the water (a quarter of the hull wet) also counts as back.
      const band = depth < cfg.surfaceLockEnter && depth > -cfg.surfaceLockEnter;
      const wetNow = this.wetMax ?? (this.hydro ? this.hydro.wetFraction : 0);
      // Any body in the air (a leap, or a breach in free swimming) is only
      // caught once it is back in the water: Space held while it is still
      // falling clear of the surface used to engage the lock in mid-air and
      // drag the body down onto the water, a visible stall in the arc.
      // Down a 500 m face at 90 m/s the face can fall away almost as fast
      // as the arc: the body then grazes it with its flukes, skipping off
      // again on every touch, for many seconds. Holding Space, any touch
      // in the surface band lands it into the ride.
      // A touch only counts while the body is coming down onto the water
      // (or running along it), never while it is still rising out of it:
      // a fluke still trailing in the water just after take-off used to
      // land the leap at once and pull the body back down out of its arc.
      // Over the back of a crest the face can fall away under the arc for
      // seconds with only the flukes in the water and the body a metre or
      // two above it, outside the surface band: that touch counts too.
      const graze =
        this.leapFlight &&
        this.leapClock < 0.45 &&
        this._leapWasDry &&
        wetNow > 0.001 &&
        closing > -1 &&
        depth > -cfg.surfaceLockReach;
      const back = this.leapFlight
        ? this.leapClock < 0.45 && (depth > 0.15 || wetNow > 0.25) && closing > 0
        : depth > 0 || (closing > 0 && wetNow > 0.25);
      if ((band && back) || graze) {
        this.surfLockEngaged = true;
        // Caught from the air: the body settles into the water (see
        // _surfaceConstrain) instead of being snapped down to the lock depth.
        this._lockSettle = this.leapFlight || depth < 0 ? cfg.surfaceLockSettleTime : 0;
      }
    } else if (depth > cfg.surfaceLockExit) {
      // Dragged deep (a breaking wave): swim back up.
      this.surfLockEngaged = false;
    }
    if (!this.surfLockEngaged) this._lockSettle = 0;
    else if (this._lockSettle > 0) this._lockSettle = Math.max(0, this._lockSettle - dt);
    const target = this.surfLockEngaged ? 1 : 0;
    const ramp = cfg.surfaceLockRamp;
    this.surfLock = target
      ? Math.min(1, this.surfLock + dt * ramp)
      : Math.max(0, this.surfLock - dt * ramp * 2);
    // Rising (Space) gets you to the surface; on it there is nothing to rise
    // to, and in the air Space only means "land back into the ride".
    if (this.surfLockEngaged || (want && depth < 0)) this.verticalInput = 0;

    // The averaged surface sits off the true one where the face curves (the
    // toe of a 500 m wave is concave). That offset changes slowly, chop
    // makes it flicker, so it is followed with a 0.3 s lag.
    const centre = ocean.getWaterSample(this.position.x, this.position.z).height;
    this.surfDepth = centre - this.position.y;
    this.surfLockOff = P.validOff ? damp(this.surfLockOff, centre - h, 3, dt) : centre - h;
    P.validOff = true;
    const L = this._sl;
    L.x0 = this.position.x;
    L.z0 = this.position.z;
    L.h0 = h + this.surfLockOff;
    L.sx = sx;
    L.sz = sz;
    L.dEta = dEta;
    L.tIn = 0;
    // Pitch that lies along the surface under the current heading.
    this.surfLockPitch = Math.atan(sx * Math.sin(this.yaw) + sz * Math.cos(this.yaw));
    if (this.surfLock > 0) {
      this.surfLook = clamp(this.surfLook - my * TUNING.movement.mouseSensitivity * 0.78, -1.2, 1.2);
    } else this.surfLook = damp(this.surfLook, 0, 2.5, dt);
    // The camera's surface framing stays on through a leap off the lock and
    // eases in and out, so it does not cut at take-off or landing.
    this.viewLock = damp(this.viewLock || 0, this.surfLockEngaged || this.leapFlight ? 1 : 0, 5, dt);
    return this.surfLock;
  }

  /**
   * How still the tail should be, 0 (swimming) to 1 (the wave carries the
   * body): on the surface and on a wave, or heading down a face. With
   * `thrusting` (W or Shift held) only a descent counts, so the tail still
   * strokes to climb the face or run along it.
   */
  _waveGlideTarget(thrusting) {
    const cfg = TUNING.hydro;
    const L = this._sl;
    // Slope of the (body-averaged) surface down along the heading.
    const down = -(L.sx * Math.sin(this.yaw) + L.sz * Math.cos(this.yaw));
    const downhill = smoothstep(cfg.glideDownSlope * 0.35, cfg.glideDownSlope, down);
    // With Space held the body is on the surface by definition; without it,
    // tucked into the face just under it or skimming half out of it (riding
    // the face, not swimming deep inside it or flying clear of it).
    const d = this.surfDepth ?? Infinity;
    const near = smoothstep(-1.2, -0.4, d) * (1 - smoothstep(cfg.glideSurfaceDepth * 0.6, cfg.glideSurfaceDepth, d));
    const onSurface = Math.max(this.surfLockEngaged ? this.surfLock : 0, near);
    return onSurface * (thrusting ? downhill : Math.max(downhill, this.onWave || 0));
  }

  /**
   * Leave the surface: `push` m/s along the surface normal and `fwd` m/s
   * along the heading on top of the current velocity (which already carries
   * the wave's momentum), nose along the new flight path.
   */
  _leapOff(push, fwd, sx, sz, fx, fz) {
    const nl = Math.hypot(sx, 1, sz);
    const fy = sx * fx + sz * fz;
    const tl = Math.hypot(fx, fy, fz);
    // One fluke stroke: the change of velocity is spread over
    // `surfaceLeapStroke` s (applied in the substep loop), a hard push of
    // about 15 g rather than a one-frame kick.
    const P = this._leapPush || (this._leapPush = new THREE.Vector3());
    P.set(
      (-sx / nl) * push + (fx / tl) * fwd,
      (1 / nl) * push + (fy / tl) * fwd,
      (-sz / nl) * push + (fz / tl) * fwd
    );
    const stroke = TUNING.hydro.surfaceLeapStroke || 0;
    if (stroke > 0) this._leapPushT = stroke;
    else this.velocity.add(P);
    // Nose along the flight path it is about to fly.
    const vx = this.velocity.x + (stroke > 0 ? P.x : 0);
    const vy = this.velocity.y + (stroke > 0 ? P.y : 0);
    const vz = this.velocity.z + (stroke > 0 ? P.z : 0);
    const vl = Math.hypot(vx, vy, vz);
    // The body swings up into it at its normal pitch rate (no snap).
    if (vl > 0.1) {
      const pitchPath = clamp(Math.asin(clamp(vy / vl, -1, 1)), -TUNING.movement.maxPitch, TUNING.movement.maxPitch);
      this.targetPitch = pitchPath;
      this.lastRideTarget = this.targetPitch;
    }
    this.airAim = 0;
    this._leapNose = true;
    this._leapWasDry = false;
    this.surfLock = 0;
    this.surfLockEngaged = false;
    this.leapClock = 0.6;
    this.leapFlight = true;
    this.leapCount = (this.leapCount || 0) + 1;
  }

  /** Mean surface height and slope over a body-sized cross of five points. */
  _stencil(ocean, x, z, fx, fz, a, b) {
    const out = this._stOut || (this._stOut = { h: 0, sx: 0, sz: 0 });
    const rx = fz;
    const rz = -fx;
    const hc = ocean.getWaterSample(x, z).height;
    const hf = ocean.getWaterSample(x + fx * a, z + fz * a).height;
    const hb = ocean.getWaterSample(x - fx * a, z - fz * a).height;
    const hr = ocean.getWaterSample(x + rx * b, z + rz * b).height;
    const hl = ocean.getWaterSample(x - rx * b, z - rz * b).height;
    out.h = (hc * 2 + hf + hb + hr + hl) / 6;
    const sf = (hf - hb) / (2 * a);
    const sr = (hr - hl) / (2 * b);
    out.sx = sf * fx + sr * rx;
    out.sz = sf * fz + sr * rz;
    return out;
  }

  /**
   * One substep of the surface lock: remove the velocity component along
   * the surface normal that would take the body off the surface (and pull it
   * back to the lock depth), C = y - eta(x, z, t) + d with J = (-sx, 1, -sz).
   * The correction is along J, the normal, so gravity on a slope turns into
   * speed down it, exactly as on a frictionless face.
   */
  _surfaceConstrain(step) {
    const L = this._sl;
    const cfg = TUNING.hydro;
    const p = this.position;
    const v = this.velocity;
    const eta = L.h0 + L.sx * (p.x - L.x0) + L.sz * (p.z - L.z0) + L.dEta * L.tIn;
    L.tIn += step;
    const err = eta - cfg.surfaceLockDepth - p.y;
    const bias = clamp(err * cfg.surfaceLockGain, -8, 8);
    const jj = 1 + L.sx * L.sx + L.sz * L.sz;
    const cdot = v.y - L.sx * v.x - L.sz * v.z;
    let lam = ((L.dEta + bias - cdot) / jj) * this.surfLock;
    if (this._lockSettle > 0) {
      // Settling in after a landing from the air. Above the lock depth the
      // body is still (mostly) in the air: nothing holds it up, and it is
      // drawn down at most `surfaceLockSettlePull` on top of gravity (the
      // flukes biting the water), not dragged down at up to 8 m/s in a
      // frame. Below it the water takes the entry speed out over a few
      // tenths of a second (`surfaceLockSettleBrake`) instead of in one
      // substep.
      const sl = Math.sqrt(jj);
      const full = lam;
      if (err < 0) lam = clamp(lam, (-cfg.surfaceLockSettlePull * step) / sl, 0);
      else {
        // The harder the body comes down, the harder the water stops it:
        // enough to stop it within `surfaceLockSettleDip` m. A porpoise hop
        // dips in and rides back up; only a fast landing on a big face gets
        // the full brake.
        const closing = Math.abs(cdot - L.dEta);
        const brake = clamp(
          (closing * closing) / (2 * cfg.surfaceLockSettleDip),
          cfg.surfaceLockSettleBrakeMin,
          cfg.surfaceLockSettleBrake
        );
        const cap = (brake * step) / sl;
        lam = clamp(lam, -cap, cap);
      }
      // Settled: at the lock depth, and the full lock asks for no more than
      // the settle allows, so it takes over without a jolt. (Handing over
      // while the body was still closing at 1.5 m/s reversed that speed in
      // one frame: 125 m/s^2 on every porpoise landing.)
      if (Math.abs(err) < 0.15 && Math.abs(full - lam) < 1e-6) this._lockSettle = 0;
    }
    v.x -= L.sx * lam;
    v.y += lam;
    v.z -= L.sz * lam;

    // Edge grip: like a ski on its edge, the body's speed through the water
    // swings round into its heading instead of skidding sideways, keeping
    // almost all of it (a carve costs `surfaceCarveLoss` of what it turns).
    // The edge only bites in the water: while a landing from the air is
    // still settling in, it grips as much of the hull as is wet.
    const bite = this._lockSettle > 0 ? clamp((this.wetMax ?? 1) * 2, 0, 1) : 1;
    const grip = cfg.surfaceCarveGrip * this.surfLock * bite;
    if (grip > 0) {
      const wv = this.hull.waterVel;
      const wx = Number.isFinite(wv.x) ? wv.x : 0;
      const wy = Number.isFinite(wv.y) ? wv.y : 0;
      const wz = Number.isFinite(wv.z) ? wv.z : 0;
      // Heading along the surface, and the surface's sideways direction.
      const fx = Math.sin(this.yaw);
      const fz = Math.cos(this.yaw);
      let tx = fx;
      let ty = L.sx * fx + L.sz * fz;
      let tz = fz;
      const tl = Math.hypot(tx, ty, tz);
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const nl = Math.sqrt(jj);
      const nx = -L.sx / nl;
      const ny = 1 / nl;
      const nz = -L.sz / nl;
      const lx = ny * tz - nz * ty;
      const ly = nz * tx - nx * tz;
      const lz = nx * ty - ny * tx;
      const rx = v.x - wx;
      const ry = v.y - wy;
      const rz = v.z - wz;
      const along = rx * tx + ry * ty + rz * tz;
      const side = rx * lx + ry * ly + rz * lz;
      if (along > 0.5) {
        const keep = Math.exp(-grip * step);
        const side2 = side * keep;
        const turned = Math.abs(side - side2);
        const along2 = Math.sqrt(Math.max(0, along * along + side * side - side2 * side2)) - turned * cfg.surfaceCarveLoss;
        const dA = Math.max(0, along2) - along;
        const dS = side2 - side;
        v.x += tx * dA + lx * dS;
        v.y += ty * dA + ly * dS;
        v.z += tz * dA + lz * dS;
      }
    }
  }

  _rideTrim(dt, ocean, pitchInput) {
    const cfg = TUNING.hydro;
    const movement = TUNING.movement;
    // No reflex pulls a Shift dive back up to the surface.
    if (!(cfg.rideTrim > 0) || this.diveState) {
      this.rideHold = 0;
      this.rideOffset = 0;
      this.lastRideTarget = null;
      return;
    }
    // Anything that moved the target since the trim last wrote it is the
    // player's own pitch input.
    if (this.lastRideTarget !== null) this.rideOffset += this.targetPitch - this.lastRideTarget;
    this.rideIdle = pitchInput ? 0 : this.rideIdle + dt;

    const w = ocean.getWaterSample(this.position.x, this.position.z);
    const depth = w.height - this.position.y;
    // Pitch only turns into climb through the water, so the reflex works in
    // the water's frame: speed through it, and climb relative to its own
    // rise. On ordinary swell that is close to the ground frame; on a mega
    // wave face the water itself moves at tens of m/s.
    const wv = this._bodyWaterVel();
    const wvx = wv ? wv.x : 0;
    const wvy = wv ? wv.y : 0;
    const wvz = wv ? wv.z : 0;
    // Only the dolphin's own pace along its body counts: water rushing past
    // a passive body (a mega face lifting it) is not riding speed, and
    // pitching a drifting body up only slices it down through the water.
    const speed = Math.max(
      0,
      (this.velocity.x - wvx) * this.forward.x +
        (this.velocity.y - wvy) * this.forward.y +
        (this.velocity.z - wvz) * this.forward.z
    );
    const near =
      smoothstep(-0.7, -0.15, depth) * (1 - smoothstep(cfg.rideTrimDepth * 0.6, cfg.rideTrimDepth, depth));
    const fast = smoothstep(cfg.rideTrimSpeed * 0.6, cfg.rideTrimSpeed, speed);
    const keys = this.verticalInput === 0 ? 1 : 0;

    // Climb rate that follows the surface at the riding depth.
    const surfaceRate = this.surfaceRate || 0;
    const wantVy = surfaceRate + clamp((depth - cfg.rideDepth) * cfg.rideDepthGain, -4, 4) - wvy;
    const lead = wantVy + (wantVy - (this.velocity.y - wvy)) * cfg.rideDamping;
    // Up to about 72 degrees: a 500 m face is steeper than 60 degrees, and a
    // body that cannot point down it planes on its belly and is pushed off.
    // A reflex has a finite bandwidth: the command is smoothed over about a
    // tenth of a second, so a noisy climb-rate reading (a mega face's flow,
    // a landing) does not flick the nose from frame to frame.
    const cmdRaw = Math.asin(clamp(lead / Math.max(3, speed), -0.95, 0.95));
    this.rideCmd = this.rideCmd === undefined ? cmdRaw : damp(this.rideCmd, cmdRaw, 12, dt);
    let cmd = this.rideCmd;
    // Coming back in from the air the body is sinking fast, and the reflex
    // answered with its hardest nose-up: the nose whipped from 35 degrees
    // down to 50 up in half a second, the body ballooned back to the
    // surface and half its speed went into the turn. For a moment after a
    // landing the reflex only levels the body out and lets it rise at a
    // shallow angle (plus whatever the surface itself is rising at), then
    // hands back to the full trim.
    if (this._landTrim > 0) {
      const follow = Math.asin(clamp(Math.max(0, surfaceRate - wvy) / Math.max(3, speed), 0, 0.9));
      const cap = movement.landingClimb + follow;
      cmd = Math.min(cmd, lerp(movement.maxPitch, cap, smoothstep(0, 1.0, this._landTrim)));
    }

    const release = cfg.rideRelease;
    const free = Math.abs(this.rideOffset) > release;
    if (!free) {
      // Let go of the mouse and the offset eases back to riding the face.
      if (this.rideIdle > 0.15) this.rideOffset = damp(this.rideOffset, 0, cfg.rideOffsetReturn, dt);
    } else if (this.rideIdle > 0.8 && (near > 0.5 || near * fast < 0.05)) {
      // Released, but resting near the surface again: settle back in.
      this.rideOffset = damp(this.rideOffset, 0, cfg.rideOffsetReturn * 0.5, dt);
    }
    const capture = 1 - smoothstep(release * 0.8, release, Math.abs(this.rideOffset));
    // Not during a leap: the trim would pull the nose back down into the face.
    // Nor once the surface lock has caught the body: the lock owns the
    // pitch then, and the two pulling different ways jerked the nose.
    const hold = this.leapFlight || this.surfLockEngaged ? 0 : near * fast * keys * capture * (1 - (this.surfLock || 0));
    // Smooth the engagement so it never snaps the attitude.
    this.rideHold = damp(this.rideHold, hold, 6, dt);

    if (this.rideHold > 0.001) {
      const ride = clamp(cmd + this.rideOffset, -movement.maxPitch, movement.maxPitch);
      this.targetPitch += (ride - this.targetPitch) * this.rideHold;
    }
    // The offset only ever comes from the player's own pitch input. A leap,
    // a landing or a dive that leaves the trim band does not turn into an
    // offset, so the trim picks the animal back up smoothly (`rideHold`
    // eases in) as soon as it is back near the surface at speed.
    this.lastRideTarget = this.targetPitch;
  }

  _applyWaterAttitude(dt, steeringPitch, steeringYaw) {
    const cfg = TUNING.hydro;
    const tilt = this.waterTilt;
    const rate = this.waterTiltRate;
    if (!cfg.waterTorque) {
      tilt.set(0, 0, 0);
      rate.set(0, 0, 0);
      this.waterSpin.set(0, 0, 0);
      this.qWater.identity();
      return;
    }
    const m = this.mass;
    const length = 2.96 * cfg.hullScale;
    const radius = 0.43 * cfg.hullScale;
    // Slender body of revolution plus added inertia (large in pitch/yaw).
    const iPitch = ((m * length * length) / 14) * (1 + cfg.addedInertia);
    const iRoll = m * radius * radius * 0.5 * (1 + cfg.addedInertia * 0.25);

    // Torque from the last hull pass, into the steered body frame.
    this.qWaterInv.copy(this.orientation).invert();
    const tq = this.tmpTorque.copy(this.hydro.torque || this.tmpTorque.set(0, 0, 0)).applyQuaternion(this.qWaterInv);
    const limit = cfg.waterTorqueLimit;
    tq.x = clamp(tq.x * cfg.waterTorque, -limit, limit);
    tq.y = clamp(tq.y * cfg.waterTorque, -limit, limit);
    tq.z = clamp(tq.z * cfg.waterTorque, -limit, limit);

    // Muscle: stiffer while the player is steering that axis.
    const wP = steeringPitch ? cfg.muscleSteerFreq : cfg.muscleFreq;
    const wY = steeringYaw ? cfg.muscleSteerFreq : cfg.muscleFreq;
    const wR = cfg.muscleRollFreq;
    const z = cfg.muscleDamping;
    rate.x += (tq.x / iPitch - wP * wP * tilt.x - 2 * z * wP * rate.x) * dt;
    rate.y += (tq.y / iPitch - wY * wY * tilt.y - 2 * z * wY * rate.y) * dt;
    rate.z += (tq.z / iRoll - wR * wR * tilt.z - 2 * z * wR * rate.z) * dt;
    const maxRate = 6;
    rate.x = clamp(rate.x, -maxRate, maxRate);
    rate.y = clamp(rate.y, -maxRate, maxRate);
    rate.z = clamp(rate.z, -maxRate * 1.5, maxRate * 1.5);
    tilt.addScaledVector(rate, dt);
    tilt.x = clamp(tilt.x, -0.9, 0.9);
    tilt.y = clamp(tilt.y, -0.7, 0.7);
    tilt.z = clamp(tilt.z, -1.2, 1.2);

    // Yield: an unsteered axis hands its tilt to the steered attitude, so the
    // animal keeps the attitude the water gave it instead of springing back.
    const accept = 1 - Math.exp(-cfg.waterYield * dt);
    const acceptPitch = 1 - Math.exp(-cfg.waterYieldPitch * dt);
    if (!steeringPitch && this.verticalInput === 0 && acceptPitch > 0 && !this.leapFlight) {
      const t = tilt.x * acceptPitch;
      tilt.x -= t;
      this.pitch = clamp(this.pitch - t, -TUNING.movement.maxPitch, TUNING.movement.maxPitch);
      this.targetPitch = clamp(this.targetPitch - t, -TUNING.movement.maxPitch, TUNING.movement.maxPitch);
    }
    if (!steeringYaw) {
      const t = tilt.y * accept * 0.5;
      tilt.y -= t;
      this.yaw = wrapAngle(this.yaw + t);
      this.targetYaw = wrapAngle(this.targetYaw + t);
    }

    // Locked to the surface, the body lies along it: water pitch torque
    // does not tip the nose into or out of the face.
    // Same through a leap off the surface: the tail dragging out of the water
    // must not flip the nose down into the face.
    const holdPitch = Math.max(this.surfLock, this.leapFlight ? 1 : 0);
    if (holdPitch > 0) {
      const k = Math.exp(-12 * holdPitch * dt);
      tilt.x *= k;
      rate.x *= k;
    }

    // Rebuild the attitude: steered Euler, then the water tilt.
    this.qYaw.setFromAxisAngle(Y_AXIS, this.yaw);
    this.qPitch.setFromAxisAngle(X_AXIS, -this.pitch);
    this.qRoll.setFromAxisAngle(Z_AXIS, this.roll);
    const angle = tilt.length();
    if (angle > 1e-6) this.qWater.setFromAxisAngle(this.tmpTorque.copy(tilt).divideScalar(angle), angle);
    else this.qWater.identity();
    this.orientation.copy(this.qYaw).multiply(this.qPitch).multiply(this.qRoll).multiply(this.qWater);
    this.forward.copy(FORWARD).applyQuaternion(this.orientation);
    this.up.copy(UP).applyQuaternion(this.orientation);
    this.right.copy(RIGHT).applyQuaternion(this.orientation);
    this.waterSpin.copy(rate).applyQuaternion(this.orientation);
  }

  surfaceImpulseAll(ocean, water, power) {
    const points = [0, 1, 2];
    for (const idx of points) {
      this.tmp2.copy(this.bodyParts[idx].offset).applyQuaternion(this.orientation).add(this.position);
      const w = ocean.getWaterSample(this.tmp2.x, this.tmp2.z);
      const proximity = idx === 1 ? 1 : 0.55;
      ocean.addSurfaceContact(this.tmp2.x, this.tmp2.z, -0.2 * power * proximity, idx === 1 ? 2.2 : 1.25);
    }
    ocean.surfaceImpulse(this.position.x, this.position.z, power * 0.82, 2.15);
  }

  addTurnLean(amount) {
    this.turnLean = clamp(this.turnLean + amount, -1, 1);
  }
}
