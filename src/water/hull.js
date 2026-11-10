import * as THREE from "three";
import { TUNING } from "../config.js";
import { clamp, smoothstep } from "../utils.js";

const RHO = 1025;
const RHO_AIR = 1.225;

/**
 * Physics hull: a surface of revolution sampled as ~200 panels. The body
 * visual is unchanged; this slightly smaller hull is the volume that
 * displaces water and receives pressure.
 *
 * Per panel and per substep we integrate:
 *   - hydrostatic pressure  rho g (eta - y)
 *   - wave dynamic pressure  (Froude-Krylov)
 *   - quadratic drag relative to the local water velocity
 *   - an extra slam drag while a panel is first being immersed
 *
 * The total force is resolved in the body frame and divided by anisotropic
 * effective mass (mass + added mass) before being returned as an
 * acceleration. Fin lift is applied separately so bank angle produces a real
 * sideways force.
 */

const STATIONS = [
  { z: 1.48, r: 0.02 },
  { z: 1.32, r: 0.1 },
  { z: 1.12, r: 0.2 },
  { z: 0.9, r: 0.3 },
  { z: 0.65, r: 0.37 },
  { z: 0.4, r: 0.415 },
  { z: 0.15, r: 0.43 },
  { z: -0.1, r: 0.42 },
  { z: -0.35, r: 0.38 },
  { z: -0.6, r: 0.31 },
  { z: -0.85, r: 0.22 },
  { z: -1.1, r: 0.14 },
  { z: -1.32, r: 0.08 },
  { z: -1.48, r: 0.03 },
];

function buildPanels(cfg) {
  const radial = Math.max(8, Math.round(cfg.radialPanels));
  const dTheta = (Math.PI * 2) / radial;
  const scale = cfg.hullScale;
  const panels = [];

  for (let i = 0; i < STATIONS.length; i++) {
    const here = STATIONS[i];
    const prev = STATIONS[Math.max(0, i - 1)];
    const next = STATIONS[Math.min(STATIONS.length - 1, i + 1)];
    const z = here.z;
    const r = here.r * scale;
    const rPrev = prev.r * scale;
    const rNext = next.r * scale;
    const dz = Math.max(1e-4, Math.abs(next.z - prev.z));
    const drdz = (rNext - rPrev) / (next.z - prev.z || 1e-4);
    const ds = i === 0 || i === STATIONS.length - 1 ? dz * 0.5 : dz * 0.5;
    const areaScale = r * dTheta * ds * Math.sqrt(1 + drdz * drdz);
    const nLen = Math.hypot(1, drdz);

    for (let j = 0; j < radial; j++) {
      const theta = (j + 0.5) * dTheta;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      panels.push({
        offset: new THREE.Vector3(r * cos, r * sin, z),
        normal: new THREE.Vector3(cos / nLen, sin / nLen, -drdz / nLen),
        area: areaScale,
        wet: 0,
        prevWet: 0,
        force: new THREE.Vector3(),
        world: new THREE.Vector3(),
        worldNormal: new THREE.Vector3(),
        sample: {},
      });
    }
  }

  // Close the two ends with caps. Without these the volume integral is short
  // by the nose and peduncle disks.
  const noseR = STATIONS[0].r * scale;
  const tailR = STATIONS[STATIONS.length - 1].r * scale;
  panels.push({
    offset: new THREE.Vector3(0, 0, STATIONS[0].z),
    normal: new THREE.Vector3(0, 0, 1),
    area: Math.PI * noseR * noseR,
    wet: 0,
    prevWet: 0,
    force: new THREE.Vector3(),
    world: new THREE.Vector3(),
    worldNormal: new THREE.Vector3(),
    sample: {},
  });
  panels.push({
    offset: new THREE.Vector3(0, 0, STATIONS[STATIONS.length - 1].z),
    normal: new THREE.Vector3(0, 0, -1),
    area: Math.PI * tailR * tailR,
    wet: 0,
    prevWet: 0,
    force: new THREE.Vector3(),
    world: new THREE.Vector3(),
    worldNormal: new THREE.Vector3(),
    sample: {},
  });

  let volume = 0;
  let area = 0;
  for (const p of panels) {
    volume += p.offset.dot(p.normal) * p.area;
    area += p.area;
  }
  return { panels, volume: Math.abs(volume) / 3, area };
}

export class Hull {
  constructor() {
    const built = buildPanels(TUNING.hydro);
    this.panels = built.panels;
    this.volume = built.volume;
    this.area = built.area;
    this.mass = RHO * this.volume * TUNING.hydro.buoyancyRatio;
    this._massRatio = TUNING.hydro.buoyancyRatio;

    this.force = new THREE.Vector3();
    this.accel = new THREE.Vector3();
    this.qInv = new THREE.Quaternion();
    this.fBody = new THREE.Vector3();
    this.aBody = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.flow = new THREE.Vector3();
    this.waterVel = new THREE.Vector3();
    this.liftDir = new THREE.Vector3();
    this.span = new THREE.Vector3();
    this.centerSample = {};

    const n = this.panels.length;
    this.debugPositions = new Float32Array(n * 6);
    this.debugWet = new Float32Array(n);
    this.debugCount = n;
    this.panelPositions = new Float32Array(n * 3);
    this.batch = {
      height: new Float32Array(n),
      nx: new Float32Array(n),
      ny: new Float32Array(n),
      nz: new Float32Array(n),
      velocityX: new Float32Array(n),
      velocityY: new Float32Array(n),
      velocityZ: new Float32Array(n),
      dynamicPressure: new Float32Array(n),
      aeration: new Float32Array(n),
      slope: new Float32Array(n),
      phaseSpeed: new Float32Array(n),
    };

    this.result = {
      accel: this.accel,
      force: this.force,
      wettedArea: 0,
      wetFraction: 0,
      submergedVolume: 0,
      buoyancyForce: 0,
      fkForce: 0,
      dragForce: 0,
      liftForce: 0,
      slamForce: 0,
      lungForce: 0,
      forwardForce: 0,
      aeration: 0,
      breakMask: 0,
      waterVelocityX: 0,
      waterVelocityY: 0,
      waterVelocityZ: 0,
      underwater: false,
      mass: this.mass,
      volume: this.volume,
      hullArea: this.area,
    };
  }

  /**
   * @param {object} dolphin  position/orientation/velocity/forward/up/right
   * @param {Ocean} ocean
   * @param {object} control  thrustAccel, reverseAccel, verticalAccel
   * @param {THREE.Vector3} current
   */
  apply(dolphin, ocean, control, current, refreshWater = true) {
    const tStart = performance.now();
    const cfg = TUNING.hydro;
    const movement = TUNING.movement;
    if (this._massRatio !== cfg.buoyancyRatio) {
      this._massRatio = cfg.buoyancyRatio;
      this.mass = RHO * this.volume * cfg.buoyancyRatio;
      this.result.mass = this.mass;
      dolphin.mass = this.mass;
    }
    const q = dolphin.orientation;
    this.qInv.copy(q).invert();
    this.force.set(0, 0, 0);

    let wettedArea = 0;
    let buoyancyForce = 0;
    let fkForce = 0;
    let pressureForwardForce = 0;
    let dragForce = 0;
    let slamForce = 0;
    let aerationSum = 0;
    let wettedPanels = 0;
    const pos = dolphin.position;
    const vel = dolphin.velocity;

    // Batch query: all panel world positions are written once, then the wave
    // field fills typed arrays (no per-panel object allocation).
    const positions = this.panelPositions;
    for (let i = 0; i < this.panels.length; i++) {
      const p = this.panels[i];
      p.world.copy(p.offset).applyQuaternion(q).add(pos);
      positions[i * 3] = p.world.x;
      positions[i * 3 + 1] = p.world.y;
      positions[i * 3 + 2] = p.world.z;
    }
    // The wave field is static within a render frame, so the expensive
    // kinematic query runs once per frame and the second 120 Hz substep reuses
    // it for force integration. Positions still update every substep.
    if (refreshWater) {
      ocean.water.sampleBatch(positions, this.batch, 3, this.panels.length, true);
    }
    const batch = this.batch;

    for (let i = 0; i < this.panels.length; i++) {
      const p = this.panels[i];
      p.worldNormal.copy(p.normal).applyQuaternion(q);
      p.force.set(0, 0, 0);

      const wx = batch.velocityX[i] + current.x;
      const wy = batch.velocityY[i] + current.y;
      const wz = batch.velocityZ[i] + current.z;
      const depth = batch.height[i] - p.world.y;
      const wet = smoothstep(-0.07, 0.07, depth);
      p.wet = wet;
      if (wet <= 0.001) {
        p.prevWet = wet;
        continue;
      }

      const aeration = batch.aeration[i];
      const rhoWater = RHO * (1 - aeration);
      const rhoMix = wet * rhoWater + (1 - wet) * RHO_AIR;
      wettedArea += p.area * wet;
      aerationSum += aeration * wet;
      wettedPanels++;

      // Hydrostatic + Froude-Krylov pressure. Pressure pushes inward against
      // the outward panel normal.
      const depthPressure = rhoWater * movement.gravity * Math.max(0, depth);
      const dynamicPressure = batch.dynamicPressure[i] * (rhoWater / RHO);
      const pressure = depthPressure + dynamicPressure;
      const pressureForce = pressure * p.area * wet;
      buoyancyForce += -p.worldNormal.y * depthPressure * p.area * wet;
      fkForce += -p.worldNormal.y * dynamicPressure * p.area * wet;
      p.force.addScaledVector(p.worldNormal, -pressureForce);
      pressureForwardForce -= pressureForce * p.worldNormal.dot(dolphin.forward);

      // Panel-local relative velocity.
      const rx = vel.x - wx;
      const ry = vel.y - wy;
      const rz = vel.z - wz;
      const vn = rx * p.worldNormal.x + ry * p.worldNormal.y + rz * p.worldNormal.z;
      const tx = rx - p.worldNormal.x * vn;
      const ty = ry - p.worldNormal.y * vn;
      const tz = rz - p.worldNormal.z * vn;
      const tSpeed = Math.hypot(tx, ty, tz);
      const cdN = cfg.dragNormal;
      const cdT = cfg.dragTangential;
      const normalDrag = 0.5 * rhoMix * cdN * p.area * wet * Math.abs(vn) * vn;
      const tangentDrag = 0.5 * rhoMix * cdT * p.area * wet * tSpeed;
      dragForce += Math.abs(normalDrag) + Math.abs(tangentDrag) * tSpeed;
      p.force.addScaledVector(p.worldNormal, -normalDrag);
      p.force.x -= tx * tangentDrag;
      p.force.y -= ty * tangentDrag;
      p.force.z -= tz * tangentDrag;

      // Wagner-style entry impulse: an extra drag coefficient while a panel
      // crosses the surface, not a permanent drag increase.
      if (p.prevWet < 0.25 && wet > 0.45 && vn > cfg.slamMinSpeed) {
        const slam = 0.5 * rhoWater * cfg.slamDrag * p.area * vn * Math.abs(vn) * wet;
        slamForce += slam;
        p.force.addScaledVector(p.worldNormal, -slam);
      }
      p.prevWet = wet;

      this.force.add(p.force);

      const dp = i * 6;
      this.debugPositions[dp] = p.world.x;
      this.debugPositions[dp + 1] = p.world.y;
      this.debugPositions[dp + 2] = p.world.z;
      this.debugPositions[dp + 3] = p.world.x + p.force.x * cfg.panelDebugScale;
      this.debugPositions[dp + 4] = p.world.y + p.force.y * cfg.panelDebugScale;
      this.debugPositions[dp + 5] = p.world.z + p.force.z * cfg.panelDebugScale;
      this.debugWet[i] = wet;
    }
    // Dry panels' debug lines collapse to their anchor.
    for (let i = 0; i < this.panels.length; i++) {
      if (this.panels[i].wet > 0.001) continue;
      const p = this.panels[i];
      p.world.copy(p.offset).applyQuaternion(q).add(pos);
      const dp = i * 6;
      this.debugPositions[dp] = p.world.x;
      this.debugPositions[dp + 1] = p.world.y;
      this.debugPositions[dp + 2] = p.world.z;
      this.debugPositions[dp + 3] = p.world.x;
      this.debugPositions[dp + 4] = p.world.y;
      this.debugPositions[dp + 5] = p.world.z;
      this.debugWet[i] = 0;
    }

    // Center sample for fins, aeration and the readout. Cached with the panel
    // batch on the first substep of the frame.
    const c = refreshWater
      ? ocean.water.sampleForForces(pos.x, pos.y, pos.z, this.centerSample)
      : this.centerSample;
    this.waterVel.set(c.velocityX + current.x, c.velocityY + current.y, c.velocityZ + current.z);
    const wetFraction = clamp(wettedArea / Math.max(0.2, this.area), 0, 1);
    const underwater = wetFraction > 0.02;
    const aeration = wettedPanels > 0 ? aerationSum / wettedPanels : 0;

    // Fin lift. The pectoral span rolls with the body, so a banked turn makes
    // the lift vector lean sideways and pulls the animal through the carve.
    this.flow.copy(vel).sub(this.waterVel);
    const speed = this.flow.length();
    if (speed > 0.4) {
      this.span.copy(dolphin.right);
      this.liftDir.crossVectors(this.flow, this.span);
      if (this.liftDir.lengthSq() < 1e-4) this.liftDir.copy(dolphin.up);
      else this.liftDir.normalize();
      const alpha = clamp(this.flow.dot(dolphin.up) / speed, -0.9, 0.9);
      const cl = clamp(alpha * cfg.finLiftSlope, -cfg.finLiftMax, cfg.finLiftMax);
      const rhoFin = underwater ? RHO * (1 - aeration) : RHO_AIR;
      let lift = 0.5 * rhoFin * cfg.pectoralArea * cl * speed * speed;
      const flukeAlpha = clamp(
        alpha + Math.sin(dolphin.tailPhase) * cfg.flukeOscillation,
        -1.0,
        1.0
      );
      const flukeCl = clamp(flukeAlpha * cfg.flukeLiftSlope, -cfg.finLiftMax, cfg.finLiftMax);
      lift += 0.5 * rhoFin * cfg.flukeArea * flukeCl * speed * speed;
      lift = clamp(lift, -cfg.liftCap, cfg.liftCap);
      this.force.addScaledVector(this.liftDir, lift);
      this.result.liftForce = lift;
    } else {
      this.result.liftForce = 0;
    }

    // Weight. Air gravity is a little softer than water gravity because the
    // animal is a glider, not a rock; the default is now 9.81 for consistency.
    const gravity = underwater ? movement.gravity : movement.airGravity;
    this.force.y -= this.mass * gravity;

    // Lung buoyancy: extra displaced volume near the surface, compressing with
    // depth. With mass = rho*V this keeps the animal neutral underwater and
    // positively buoyant enough to float and bob at the waterline.
    const centerDepth = Math.max(0, c.height - pos.y);
    const speedFade = 1 - cfg.lungSpeedFade * clamp(dolphin.speed / 8, 0, 1);
    const lungFraction =
      cfg.lungFraction * speedFade * Math.exp(-centerDepth / cfg.lungDepthScale);
    // No displaced water, no buoyancy: fade the lung term out as the hull
    // leaves the surface instead of letting it launch the animal clear.
    const lungSubmersion = clamp(wetFraction / 0.55, 0, 1);
    const lungForce =
      RHO * (1 - aeration) * movement.gravity * this.volume * lungFraction * lungSubmersion;
    this.force.y += lungForce;
    this.result.lungForce = lungForce;

    // Anisotropic effective mass. Added mass is large sideways and vertically
    // (the animal pushes a lot of water when it slips), small along the body.
    this.fBody.copy(this.force).applyQuaternion(this.qInv);
    this.aBody.set(
      this.fBody.x / (this.mass * (1 + cfg.addedMassLateral)),
      this.fBody.y / (this.mass * (1 + cfg.addedMassVertical)),
      this.fBody.z / (this.mass * (1 + cfg.addedMassForward))
    );
    this.accel.copy(this.aBody).applyQuaternion(q);

    // Propulsion is specified as an acceleration (as in the original
    // controller), so it is added after the effective-mass division. This
    // keeps the hand under the player's control while wave forces stay
    // mass-scaled.
    const aerationThrust = 1 - cfg.thrustAerationLoss * aeration;
    // In air the tail has almost nothing to push against; the original
    // controller expressed this as airThrustScale, so keep it here.
    const thrustScale = underwater ? 1 : movement.airThrustScale;
    this.accel.addScaledVector(dolphin.forward, control.thrustAccel * aerationThrust * thrustScale);
    this.accel.addScaledVector(dolphin.forward, control.reverseAccel);
    this.accel.y +=
      control.verticalAccel * aerationThrust * (underwater ? 1 : movement.airVerticalScale);

    this.result.wettedArea = wettedArea;
    this.result.wetFraction = wetFraction;
    this.result.submergedVolume = this.volume * wetFraction;
    this.result.buoyancyForce = buoyancyForce;
    this.result.fkForce = fkForce;
    this.result.pressureForwardForce = pressureForwardForce;
    this.result.dragForce = dragForce;
    this.result.slamForce = slamForce;
    this.result.forwardForce = this.force.dot(dolphin.forward);
    this.result.aeration = aeration;
    this.result.breakMask = c.breakMask || 0;
    this.result.waterVelocityX = this.waterVel.x;
    this.result.waterVelocityY = this.waterVel.y;
    this.result.waterVelocityZ = this.waterVel.z;
    this.result.underwater = underwater;
    this.lastMs = performance.now() - tStart;
    return this.result;
  }
}
