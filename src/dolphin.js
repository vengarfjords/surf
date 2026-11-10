import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { TUNING } from "./config.js";
import {
  clamp,
  damp,
  glslCaustics,
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

    shader.fragmentShader =
      /* glsl */ `
        uniform float uCausticTime;
        varying vec3 vDolphinLocal;
        varying vec3 vDolphinWorld;
        ${glslCaustics}
      ` +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        /* glsl */ `
          #include <color_fragment>
          // The geometry has been baked upright, so local Y is dorsal.
          float dorsalAmount = smoothstep(-0.2, 0.65, vDolphinLocal.y);
          float bellyMix = 1.0 - smoothstep(-1.2, 0.7, vDolphinLocal.y);
          vec3 darkBack = vec3(0.13, 0.23, 0.27);
          vec3 paleBelly = vec3(1.35, 1.26, 1.05);
          diffuseColor.rgb *= mix(darkBack, paleBelly, bellyMix);
          float mottle = sin(vDolphinLocal.z * 8.0 + vDolphinLocal.x * 3.3) * 0.5 + 0.5;
          float speckle = smoothstep(0.72, 0.94, sin(vDolphinLocal.z * 24.0 + vDolphinLocal.x * 5.1) * 0.5 + 0.5);
          diffuseColor.rgb *= 0.86 + mottle * 0.13 - speckle * 0.05;
          float flankSheen = smoothstep(0.1, 0.9, abs(vDolphinLocal.x) / 0.6);
          diffuseColor.rgb += vec3(0.015, 0.04, 0.042) * flankSheen;
        `
      );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `
        #include <emissivemap_fragment>
        float dolphinCaustic = causticNetwork(vDolphinWorld.xz + 2.0, uCausticTime);
        totalEmissiveRadiance += vec3(0.6, 0.82, 0.7) * dolphinCaustic * 0.12;
      `
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
      /* glsl */ `
        vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
        outgoingLight *= mix(vec3(0.17, 0.25, 0.29), vec3(1.03, 0.99, 0.9), 1.0 - dorsalAmount * 0.88);
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
    this.hydroControl = { thrustAccel: 0, reverseAccel: 0, verticalAccel: 0 };
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
    this.verticalInput = 0;
    this.pitchInputTimer = 0;
    this.speed = 0;
    this.prevCenterAbove = false;
    this.airborne = false;
    this.wasAbove = false;
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
      material.roughness = 0.36;
      material.metalness = 0.055;
      material.color = new THREE.Color(TUNING.dolphin.skin);
      material.emissive = new THREE.Color(0x041719);
      material.emissiveIntensity = 0.35;
      if (material.map) material.color.multiplyScalar(1.12);
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
    sp.targetQ.copy(sp.qYaw).multiply(sp.qPitch).multiply(sp.qRoll);
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
    dt = Math.min(dt, 1 / 30);
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
    this.targetYaw = wrapAngle(this.targetYaw - keyTurn * movement.maxTurnRate * 1.15 * dt);
    const pitchInput =
      Math.abs(mx) > 0 ||
      Math.abs(my) > 0 ||
      input.pitchUpKeys ||
      input.pitchDownKeys;
    if (input.pitchUpKeys) this.targetPitch += 0.9 * dt;
    if (input.pitchDownKeys) this.targetPitch -= 0.9 * dt;
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

    this.verticalInput = (input.rise ? 1 : 0) - (input.dive ? 1 : 0);
    const posture = this.verticalInput > 0 ? movement.ascendPitch : this.verticalInput < 0 ? movement.descendPitch : 0;
    const pitchTarget = clamp(this.targetPitch + posture, -movement.maxPitch, movement.maxPitch);

    const prevYaw = this.yaw;
    this.yaw = wrapAngle(dampAngle(this.yaw, this.targetYaw, movement.turnResponsiveness, dt));
    this.yawRate = clamp(wrapAngle(this.yaw - prevYaw) / Math.max(dt, 0.0001), -movement.maxTurnRate, movement.maxTurnRate);
    this.targetPitch = clamp(this.targetPitch, -movement.maxPitch, movement.maxPitch);
    this.pitch = damp(this.pitch, pitchTarget, movement.pitchResponsiveness, dt);
    this.pitch = clamp(this.pitch, -movement.maxPitch, movement.maxPitch);

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

    const forwardSpeed = this.velocity.dot(this.forward);
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
      thrustAccel = accel * (0.38 + headroom * 0.62);
    } else if (!input.brake && forwardSpeed < movement.idleGlide) {
      // A slow, always-present tail scull keeps the creature alive at rest.
      thrustAccel = (movement.idleGlide - forwardSpeed) * 2.6;
    }

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
    // Fixed 120 Hz when the frame allows it. Cap at two substeps: the water
    // kinematics are refreshed once per frame, and allowing more substeps on a
    // slow frame would turn a CPU spike into a feedback loop.
    const substeps = clamp(Math.ceil(dt / (1 / 120)), 1, 2);
    const step = dt / substeps;
    this.hydroControl.thrustAccel = thrustAccel;
    this.hydroControl.reverseAccel = reverseAccel;
    this.hydroControl.verticalAccel = verticalAccel;

    let hydro = this.hydro;
    let hullMs = 0;
    for (let s = 0; s < substeps; s++) {
      hydro = this.hull.apply(this, ocean, this.hydroControl, this.tmpCurrent, s === 0);
      hullMs += this.hull.lastMs;
      this.velocity.addScaledVector(hydro.accel, step);
      this.position.addScaledVector(this.velocity, step);
    }
    this.hydro = hydro;
    this.hullMs = hullMs;

    // Dry-hull flight: keep the snout-led ballistic glide and the small
    // speed-dependent body lift, but gravity has already been integrated by
    // the hull. Only add the aerodynamic terms while the hull is essentially
    // out of the water.
    if (hydro.wetFraction < 0.02) {
      const airSpeed = this.velocity.length();
      const horizontalAirspeed = Math.hypot(this.velocity.x, this.velocity.z);
      const levelness = airSpeed > 0.01 ? clamp(horizontalAirspeed / airSpeed, 0, 1) : 0;
      this.velocity.y += movement.airLift * airSpeed * airSpeed * levelness * dt;

      let vf = this.velocity.dot(this.forward);
      let vr = this.velocity.dot(this.right);
      let vu = this.velocity.dot(this.up);
      vf -= vf * (movement.airForwardDrag + Math.abs(vf) * movement.airForwardQuadraticDrag) * dt;
      vr -= vr * movement.airLateralDrag * dt;
      vu -= vu * movement.airVerticalDrag * dt;
      this.velocity
        .copy(this.forward).multiplyScalar(vf)
        .addScaledVector(this.right, vr)
        .addScaledVector(this.up, vu);

      const steerSpeed = this.velocity.length();
      const steerAuthority = clamp((steerSpeed - 4.0) / 10.0, 0, 1);
      if (steerAuthority > 0.001) {
        const steer = (1 - Math.exp(-movement.airSteer * dt)) * steerAuthority;
        this.tmp.copy(this.forward).multiplyScalar(steerSpeed);
        // Do not renormalise after steering: redirecting momentum costs a
        // little energy instead of letting the animal carve for free.
        this.velocity.lerp(this.tmp, steer);
      }
    }

    this.speed = this.velocity.length();

    // Visual tumble in whitewater. The controller/camera still owns the swim
    // attitude; this is a short, decaying body-space roll/pitch driven by
    // aeration and slam impact, so the animal reads as thrown rather than
    // scripted into a "surf mode".
    this.tumbleClock -= dt;
    const rough =
      (this.hydro && (this.hydro.aeration > 0.18 || this.hydro.slamForce > 450)) ||
      this.impact > 0.35;
    if (rough && this.tumbleClock <= 0) {
      this.tumbleClock = 0.65;
      const seed = Math.sin(this.position.x * 0.73 + this.position.z * 0.91 + ocean.time * 1.37);
      this.tumbleRollVel += seed * 3.4;
      this.tumblePitchVel += Math.cos(seed * 2.1 + this.position.y) * 2.6;
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
    if (edge > limit) {
      const push = (edge - limit) * 0.8;
      if (Math.abs(this.position.x) > limit) this.position.x += -Math.sign(this.position.x) * push * dt * 5;
      if (Math.abs(this.position.z) > limit) this.position.z += -Math.sign(this.position.z) * push * dt * 5;
      this.velocity.x *= 0.998;
      this.velocity.z *= 0.998;
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
      const push = deepest * 0.68;
      this.position.y += push;
      this.position.x += n.x * push * 0.32;
      this.position.z += n.z * push * 0.32;
      const vn = this.velocity.x * n.x + this.velocity.y * n.y + this.velocity.z * n.z;
      if (vn < 0) {
        this.velocity.x -= n.x * vn * (1 + TUNING.movement.floorBounce);
        this.velocity.y -= n.y * vn * (1 + TUNING.movement.floorBounce);
        this.velocity.z -= n.z * vn * (1 + TUNING.movement.floorBounce);
      }
      this.velocity.multiplyScalar(1 - 0.019 * Math.min(deepest * 4, 1));
      if (deepest > 0.3) this.impact = Math.max(this.impact, deepest * 0.3);
    }
    if (this.plowClock <= 0) this.plowClock = 0.032;

    // --- Surface contact, breach and splash -----------------------------
    const centerWater = ocean.getWaterSample(this.position.x, this.position.z);
    const centerHeight = centerWater.height;
    const centerAbove = this.position.y > centerHeight + 0.02;
    const noseWorld = this.tmp.copy(this.forward).multiplyScalar(1.35).add(this.position);
    const noseWater = ocean.getWaterSample(noseWorld.x, noseWorld.z);
    const noseAbove = noseWorld.y > noseWater.height - 0.05;
    this.contact.surface = !centerAbove || !noseAbove;
    this.surfaceCooldown -= dt;
    this.surfaceFxCooldown -= dt;
    const surfaceSpeed = Math.abs(this.velocity.y) + this.speed * 0.25;

    if (!this.wasAbove && centerAbove) {
      // A clean breach, driven by real upward momentum. A high-speed exit gets
      // one last tail kick so the animal can properly clear the surface.
      const exitSpeed = this.velocity.length();
      if (this.velocity.y > 1.2 && exitSpeed > movement.cruiseSpeed * 0.45) {
        this.velocity.y +=
          movement.breachImpulse * clamp(exitSpeed / movement.boostSpeed, 0, 1.15);
      }
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
    } else if (this.wasAbove && !centerAbove) {
      // Re-entry.
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
      // a long leap can skip or carry through instead of stopping dead.
      this.velocity.x *= 0.92;
      this.velocity.z *= 0.92;
      this.velocity.y *= 0.68;
      this.impact = Math.max(this.impact, 0.55);
      this.wetness = 1;
    }
    this.wasAbove = centerAbove;

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
        const power = clamp(surfaceSpeed * 0.08, 0.08, 0.5) * (0.6 + this.speed * 0.12);
        ocean.surfaceImpulse(this.position.x, this.position.z, power, 1.2);
        effects.splashBurst(this.position.x, centerHeight + 0.03, this.position.z, power * 1.4, this.velocity.x, this.velocity.z);
        this.surfaceCooldown = 0.09;
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
    // through the surface while hovering.
    if (this.position.y > centerHeight + 1.8) {
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
    // collision spikes from being mistaken for acceleration.
    const rawAccel = (this.speed - this.prevSwimSpeed) / Math.max(dt, 0.0001);
    this.swimAccel = damp(
      this.swimAccel,
      clamp(rawAccel, -tailCfg.tailAccelClamp, tailCfg.tailAccelClamp),
      tailCfg.tailAccelSmoothing,
      dt
    );
    this.prevSwimSpeed = this.speed;

    const speedRatio = clamp(this.speed / TUNING.movement.cruiseSpeed, 0, 2.2);
    const accelDrive = clamp(
      Math.max(0, this.swimAccel) / tailCfg.tailAccelReference,
      0,
      1.8
    );
    const strokeScale = tailCfg.tailWaveAmplitude / 3.15;
    this.tailHeave =
      Math.min(
        (tailCfg.tailHeaveIdle +
          speedRatio * tailCfg.tailHeaveSpeed +
          accelDrive * tailCfg.tailHeaveAccel +
          (thrusting ? tailCfg.tailThrustHeave : 0) +
          (surge ? tailCfg.tailSurgeHeave : 0)) *
          strokeScale,
        tailCfg.tailHeaveMax * strokeScale
      ) * (underwater ? 1 : movement.airTailScale);

    const beatRate =
      tailCfg.tailBeatBase +
      Math.max(0, this.speed) * tailCfg.tailBeatSpeed +
      Math.max(0, this.swimAccel) * tailCfg.tailBeatAccel +
      (thrusting ? tailCfg.tailThrustBeat : 0) +
      (surge ? tailCfg.tailSurgeBeat : 0);
    this.tailPhase += dt * Math.min(beatRate, tailCfg.tailBeatMax);
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
    const surfaceNow = ocean.getWaterHeight(this.position.x, this.position.z);
    const floorNow = seabed.getSurfaceHeight(this.position.x, this.position.z);
    this.telemetry.depth = Math.max(0, surfaceNow - this.position.y);
    this.telemetry.altitude = Math.max(0, this.position.y - floorNow);
    this.telemetry.speed = this.speed;
    this.telemetry.waveHeight = surfaceNow;
    // The compass follows the snout target so the readout leads with the view
    // instead of lagging behind the physical body.
    this.telemetry.heading = ((-this.targetYaw * 180) / Math.PI + 720) % 360;
    this.telemetry.underwater = !centerAbove;
    this.telemetry.breaches = this.breachCount;
    this.telemetry.hydro = this.hydro;

    return this.telemetry;
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
