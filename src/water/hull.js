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
  const moment = new THREE.Vector3();
  for (const p of panels) {
    volume += p.offset.dot(p.normal) * p.area;
    area += p.area;
    // Divergence theorem: integral of x dV = 1/2 closed-integral of x^2 n_x dA.
    moment.x += p.offset.x * p.offset.x * p.normal.x * p.area;
    moment.y += p.offset.y * p.offset.y * p.normal.y * p.area;
    moment.z += p.offset.z * p.offset.z * p.normal.z * p.area;
  }
  volume = Math.abs(volume) / 3;
  // Centre of buoyancy (volume centroid) in the body frame. The animal is
  // treated as uniform, so this is also the centre of mass and the pivot for
  // the water torque; a fully submerged body then feels no net pitch moment.
  const centroid = moment.multiplyScalar(0.5 / Math.max(1e-6, volume));
  return { panels, volume, area, centroid };
}

export class Hull {
  constructor() {
    const built = buildPanels(TUNING.hydro);
    this.panels = built.panels;
    this.volume = built.volume;
    this.area = built.area;
    this.centroid = built.centroid;
    this.centroidWorld = new THREE.Vector3();
    this.mass = RHO * this.volume * TUNING.hydro.buoyancyRatio;
    this._massRatio = TUNING.hydro.buoyancyRatio;

    this.force = new THREE.Vector3();
    this.torque = new THREE.Vector3();
    this.accel = new THREE.Vector3();
    this.lever = new THREE.Vector3();
    this.qInv = new THREE.Quaternion();
    this.fBody = new THREE.Vector3();
    this.aBody = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.flow = new THREE.Vector3();
    this.waterVel = new THREE.Vector3();
    // Where waterVel was sampled, so a stale value after a teleport is not
    // mistaken for the water around the body.
    this.waterVelAt = new THREE.Vector3(Infinity, 0, 0);
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
    // What the last full water query returned, and where, so later substeps
    // in the same frame can correct it for how far each panel has moved.
    this.sampledPositions = new Float32Array(n * 3);
    this.sampledHeight = new Float32Array(n);
    this.sampledPressure = new Float32Array(n);
    this.sampledValid = false;

    this.result = {
      accel: this.accel,
      force: this.force,
      torque: this.torque,
      breaking: 0,
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
  apply(dolphin, ocean, control, current, refreshWater = true, waterAge = 0) {
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
    this.torque.set(0, 0, 0);
    // Body rotation that is not the player's steering (the water-driven part
    // of the attitude). Feeding it into the panel velocities gives the water's
    // own rotational damping; steering stays a muscle-driven intent.
    const omega = dolphin.waterSpin;

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
    const cg = this.centroidWorld.copy(this.centroid).applyQuaternion(q).add(pos);

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
    // The expensive kinematic query runs once per frame and the later 120 Hz
    // substeps reuse it. But within a frame neither the body nor the water
    // stands still: at 80 m/s a panel moves 0.7 m in one substep, and a
    // 500 m face rises 0.4 m under it in the same 8 ms. So each reused
    // surface height is carried along the sampled slope to where the panel
    // is now, and forward in time by `waterAge` s at the rate the surface
    // rises there (the kinematic surface condition, w - u . grad eta),
    // keeping the pressure's decay below the surface as sampled. Without
    // that, every other substep saw the face where the body had been and
    // as it had been, and the hull forces flickered between substeps (a
    // body held on the face was dry in one substep of four).
    const batch = this.batch;
    const n = this.panels.length;
    if (refreshWater || !this.sampledValid) {
      ocean.sampleWaterBatch(positions, batch, 3, true);
      this.sampledPositions.set(positions);
      this.sampledHeight.set(batch.height);
      this.sampledPressure.set(batch.dynamicPressure);
      this.sampledValid = true;
    } else {
      const P0 = this.sampledPositions;
      const H0 = this.sampledHeight;
      const D0 = this.sampledPressure;
      const rhoG = RHO * movement.gravity;
      for (let i = 0; i < n; i++) {
        const ny = Math.max(0.05, batch.ny[i]);
        const sx = -batch.nx[i] / ny;
        const sz = -batch.nz[i] / ny;
        const rise = batch.velocityY[i] - batch.velocityX[i] * sx - batch.velocityZ[i] * sz;
        const dh =
          sx * (positions[i * 3] - P0[i * 3]) +
          sz * (positions[i * 3 + 2] - P0[i * 3 + 2]) +
          Math.max(-150, Math.min(150, rise)) * waterAge;
        batch.height[i] = H0[i] + dh;
        batch.dynamicPressure[i] = D0[i] + rhoG * dh;
      }
    }

    // Planing. Running fast along the surface, a body rides up onto the
    // water: the wetted area shrinks and resistance stops growing with v^2,
    // as a planing hull's does. Fully submerged, or below `planeSpeed`
    // through the water, nothing changes, so swimming and the reef waves
    // keep their feel. Down a 500 m face gravity takes the dolphin past it,
    // and the speed it then carries is what lets it carve back up. Only the
    // along-body (axial and skin) resistance is cut: crossflow still grips
    // like a rail, so turns hold. Uses last frame's centre sample.
    let planing = 0;
    if (cfg.planeDragCut > 0 && this.centerSample.height !== undefined && this.waterVelAt.x !== Infinity) {
      const centerDepth = this.centerSample.height - pos.y;
      const surfaceBand = 1 - smoothstep(1.2, 2.5, centerDepth);
      const vRel = Math.hypot(vel.x - this.waterVel.x, vel.y - this.waterVel.y, vel.z - this.waterVel.z);
      // Gliding on a wave with Space held, the body is held flat on the
      // surface like a board, so it starts to plane at a lower speed.
      const glide = (dolphin.surfGlide || 0) * (dolphin.surfLock || 0);
      const p0 = cfg.planeSpeed + (cfg.planeSpeedGlide - cfg.planeSpeed) * glide;
      planing = surfaceBand * smoothstep(p0, p0 + cfg.planeSpeedRange, vRel);
    }
    const planeKeep = 1 - cfg.planeDragCut * planing;
    this.result.planing = planing;

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
      // The wave field's dynamic pressure is rho g sum(a pF sin). The
      // hydrostatic term above already measures depth from the displaced
      // surface (rho g (eta - y)), which carries the full wave elevation, so
      // only the decay below it is dynamic: rho g sum(a (pF - 1) sin). This
      // is the Wheeler-stretched linear pressure: zero at the surface and
      // -rho g y far below it. Adding the raw term counted the wave twice,
      // which threw the body up on every crest and sucked it into troughs.
      const dynamicPressure =
        (batch.dynamicPressure[i] - RHO * movement.gravity * batch.height[i]) * (rhoWater / RHO);
      const pressure = depthPressure + dynamicPressure;
      const pressureForce = pressure * p.area * wet;
      buoyancyForce += -p.worldNormal.y * depthPressure * p.area * wet;
      fkForce += -p.worldNormal.y * dynamicPressure * p.area * wet;
      p.force.addScaledVector(p.worldNormal, -pressureForce);
      pressureForwardForce -= pressureForce * p.worldNormal.dot(dolphin.forward);

      // Panel-local relative velocity, including the panel's swing about the
      // centre of mass.
      const lx = p.world.x - cg.x;
      const ly = p.world.y - cg.y;
      const lz = p.world.z - cg.z;
      let rx = vel.x - wx;
      let ry = vel.y - wy;
      let rz = vel.z - wz;
      if (omega) {
        rx += omega.y * lz - omega.z * ly;
        ry += omega.z * lx - omega.x * lz;
        rz += omega.x * ly - omega.y * lx;
      }
      const vn = rx * p.worldNormal.x + ry * p.worldNormal.y + rz * p.worldNormal.z;
      const tx = rx - p.worldNormal.x * vn;
      const ty = ry - p.worldNormal.y * vn;
      const tz = rz - p.worldNormal.z * vn;
      const tSpeed = Math.hypot(tx, ty, tz);
      const cdN = cfg.dragNormal;
      const cdT = cfg.dragTangential;
      // Split the panel's normal flow into the part carried by motion along
      // the body axis and the crossflow part. Crossflow (sideslip, heave,
      // pitching) sees the full bluff-body coefficient. Flow along the axis
      // of a streamlined body mostly slides round it, so it only sees a small
      // fraction: a panel-by-panel Cd of 0.65 on axial flow made the dolphin
      // a parachute at surf speed (12-30 kN at 16 m/s) and the water rushing
      // up a big face simply carried it over the crest.
      const fx = dolphin.forward.x, fy = dolphin.forward.y, fz = dolphin.forward.z;
      const axial = rx * fx + ry * fy + rz * fz;
      const vnAxial = axial * (p.worldNormal.x * fx + p.worldNormal.y * fy + p.worldNormal.z * fz);
      const vnCross = vn - vnAxial;
      const axialScale = (cfg.axialDragScale ?? 1) * planeKeep;
      const normalDrag =
        0.5 * rhoMix * cdN * p.area * wet * (Math.abs(vnCross) * vnCross + axialScale * Math.abs(vnAxial) * vnAxial);
      const tangentDrag = 0.5 * rhoMix * cdT * p.area * wet * tSpeed * planeKeep;
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
      // Torque about the centre of mass: r x F.
      this.torque.x += ly * p.force.z - lz * p.force.y;
      this.torque.y += lz * p.force.x - lx * p.force.z;
      this.torque.z += lx * p.force.y - ly * p.force.x;

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
    this.waterVelAt.copy(pos);
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
      // Angle of attack of the oncoming water. `flow` is the body's velocity
      // through the water, so the water meets the fins along -flow: a body
      // pitched nose-up (or sinking) has water striking the underside, which
      // is positive incidence and lift toward `up`. This sign was inverted,
      // which made the fins push a sinking dolphin further down, a rising
      // one further up (porpoising and run-away sinking at surf speed), and
      // push a banked turn outwards instead of carving it.
      const alpha = clamp(-this.flow.dot(dolphin.up) / speed, -0.9, 0.9);
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
    // It is water the body has to move, so it fades out as the body leaves
    // the water: in the air a leaping dolphin falls at g, not at about half
    // of it. Only in a real leap (clear of the water, or a leap off the
    // surface lock): skimming hops along a face keep their feel.
    this.fBody.copy(this.force).applyQuaternion(this.qInv);
    const wetAdded = dolphin.leapFlight || dolphin.leaping ? smoothstep(0, 0.08, wetFraction) : 1;
    this.aBody.set(
      this.fBody.x / (this.mass * (1 + cfg.addedMassLateral * wetAdded)),
      this.fBody.y / (this.mass * (1 + cfg.addedMassVertical * wetAdded)),
      this.fBody.z / (this.mass * (1 + cfg.addedMassForward * wetAdded))
    );
    this.accel.copy(this.aBody).applyQuaternion(q);
    // Non-hydrostatic part of the mega wave's pressure gradient
    // (WaveField._sample megaFk): the wetted body is carried with the water
    // where the water accelerates harder than the surface slope implies.
    if (c.megaFkX || c.megaFkZ || c.megaFkY) {
      this.accel.x += c.megaFkX * wetFraction;
      this.accel.y += (c.megaFkY || 0) * wetFraction;
      this.accel.z += c.megaFkZ * wetFraction;
    }

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
    this.result.breaking = c.breaking || 0;
    this.result.waterVelocityX = this.waterVel.x;
    this.result.waterVelocityY = this.waterVel.y;
    this.result.waterVelocityZ = this.waterVel.z;
    this.result.underwater = underwater;
    this.lastMs = performance.now() - tStart;
    return this.result;
  }
}
