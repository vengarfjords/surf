import { TUNING } from "../config.js";

/**
 * Seeded scenario harness for the water/dolphin coupling. These are developer
 * tools exposed as window.OCEAN.scenarios; they intentionally move the animal
 * and are not part of the normal game loop.
 *
 * All scenarios use the deterministic spectrum (TUNING.water.seed), so a reload
 * reproduces the same set/face positions for a given sim time.
 */
export function createScenarios({ ocean, dolphin, input, water }) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dx = () => water.peak.dx;
  const dz = () => water.peak.dz;
  const yawAlong = () => Math.atan2(water.peak.dx, water.peak.dz);

  function saveState() {
    return {
      position: dolphin.position.clone(),
      velocity: dolphin.velocity.clone(),
      orientation: dolphin.orientation.clone(),
      yaw: dolphin.yaw,
      targetYaw: dolphin.targetYaw,
      pitch: dolphin.pitch,
      targetPitch: dolphin.targetPitch,
      roll: dolphin.roll,
      tailPhase: dolphin.tailPhase,
    };
  }

  function restoreState(s) {
    dolphin.position.copy(s.position);
    dolphin.velocity.copy(s.velocity);
    dolphin.orientation.copy(s.orientation);
    dolphin.yaw = s.yaw;
    dolphin.targetYaw = s.targetYaw;
    dolphin.pitch = s.pitch;
    dolphin.targetPitch = s.targetPitch;
    dolphin.roll = s.roll;
    dolphin.tailPhase = s.tailPhase;
    dolphin.forward.set(0, 0, 1).applyQuaternion(dolphin.orientation);
    dolphin.up.set(0, 1, 0).applyQuaternion(dolphin.orientation);
    dolphin.right.set(1, 0, 0).applyQuaternion(dolphin.orientation);
  }

  function setPose(x, y, z, yaw, pitch, roll = 0) {
    dolphin.position.set(x, y, z);
    dolphin.qYaw.setFromAxisAngle(dolphin.tmp.set(0, 1, 0), yaw);
    dolphin.qPitch.setFromAxisAngle(dolphin.tmp2.set(1, 0, 0), -pitch);
    dolphin.qRoll.setFromAxisAngle(dolphin.tmp.set(0, 0, 1), roll);
    dolphin.orientation.copy(dolphin.qYaw).multiply(dolphin.qPitch).multiply(dolphin.qRoll);
    dolphin.forward.set(0, 0, 1).applyQuaternion(dolphin.orientation);
    dolphin.up.set(0, 1, 0).applyQuaternion(dolphin.orientation);
    dolphin.right.set(1, 0, 0).applyQuaternion(dolphin.orientation);
  }

  function measureAt(x, y, z, yaw, pitch, speed) {
    const saved = saveState();
    setPose(x, y, z, yaw, pitch);
    dolphin.velocity.copy(dolphin.forward).multiplyScalar(speed);
    dolphin.tailPhase = 0;
    const current = dolphin.tmpCurrent.clone().set(0, 0, 0);
    const h = dolphin.hull.apply(
      dolphin,
      ocean,
      { thrustAccel: 0, reverseAccel: 0, verticalAccel: 0 },
      current
    );
    const result = {
      aF: h.accel.dot(dolphin.forward),
      fF: h.forwardForce,
      pF: h.pressureForwardForce,
      drag: h.dragForce,
      wet: h.wetFraction,
      buoy: h.buoyancyForce,
      fk: h.fkForce,
      lung: h.lungForce,
    };
    restoreState(saved);
    for (const p of dolphin.hull.panels) p.prevWet = 0;
    return result;
  }

  function findFace(targetSlope = -0.24, allowBreaking = true) {
    const dirX = dx();
    const dirZ = dz();
    let face = null;
    for (let gx = -80; gx <= 80; gx += 2) {
      for (let gz = -80; gz <= 80; gz += 2) {
        const x = TUNING.water.surfZoneX + gx;
        const z = TUNING.water.surfZoneZ + gz;
        const s = water.sampleSurface(x, z, {});
        if (!allowBreaking && s.breakMask > 0.2) continue;
        const along = s.slopeX * dirX + s.slopeZ * dirZ;
        if (s.height < -0.7 || s.height > 0.7) continue;
        const score = Math.abs(along - targetSlope) + Math.abs(s.height) * 0.03;
        if (!face || score < face.score) face = { x, z, s, along, score };
      }
    }
    return face;
  }

  async function preset(name, settle = 500) {
    water.setPreset(name);
    await sleep(settle);
  }

  return {
    /** Scenario 1: passive float/bob. */
    async passiveFloat(name = "calm", seconds = 6) {
      const saved = saveState();
      const savedPreset = TUNING.water.preset;
      await preset(name);
      const x = 120;
      const z = 40;
      const h = ocean.getWaterHeight(x, z);
      dolphin.position.set(x, h - 0.1, z);
      dolphin.velocity.set(0, 0, 0);
      dolphin.yaw = dolphin.targetYaw = yawAlong();
      dolphin.pitch = dolphin.targetPitch = 0;
      await sleep(1200);
      const rows = [];
      const n = Math.round((seconds * 1000) / 150);
      for (let i = 0; i < n; i++) {
        await sleep(150);
        const surf = ocean.getWaterHeight(dolphin.position.x, dolphin.position.z);
        rows.push({
          rel: dolphin.position.y - surf,
          speed: dolphin.speed,
          wet: dolphin.hydro.wetFraction,
          air: dolphin.airborne,
        });
      }
      restoreState(saved);
      await preset(savedPreset, 300);
      const rel = rows.map((r) => r.rel);
      return {
        preset: name,
        relMin: Math.min(...rel),
        relMax: Math.max(...rel),
        relMean: rel.reduce((a, b) => a + b, 0) / rel.length,
        speedMax: Math.max(...rows.map((r) => r.speed)),
        airFraction: rows.filter((r) => r.air).length / rows.length,
      };
    },

    /** Scenario 2: CPU height vs the rendered mesh, via the 1x1 GPU probe. */
    probeParity(count = 20) {
      // Make sure the uniform array matches the CPU field even if a scenario
      // just rebuilt the spectrum.
      ocean.updateWaveUniforms();
      let seed = 987654321;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const errors = [];
      for (let i = 0; i < count; i++) {
        const x = (rnd() - 0.5) * 800;
        const z = (rnd() - 0.5) * 800;
        const cpu = water.sampleHeight(x, z);
        const gpu = ocean.gpuProbeHeight(x, z);
        errors.push(Math.abs(cpu - gpu));
      }
      errors.sort((a, b) => a - b);
      return {
        meanCm: (errors.reduce((a, b) => a + b, 0) / errors.length) * 100,
        p95Cm: errors[Math.floor(errors.length * 0.95)] * 100,
        maxCm: errors[errors.length - 1] * 100,
      };
    },

    /** Scenario 3: fixed-pose wave-face vs matched-wet flat-water thrust. */
    async thrustSaving() {
      const saved = saveState();
      const savedPreset = TUNING.water.preset;
      await preset("moderate");
      const speed = water.stats.peakPhaseSpeed;
      const yaw = yawAlong();
      const face = findFace(-0.32);
      const faceMeasure = measureAt(face.x, face.s.height - 0.12, face.z, yaw, 0.06, speed);

      // Flat water: temporarily remove both wave trains, then search the body
      // height that gives the same wetted area as the face measurement.
      const savedSwell = TUNING.water.swellHeight;
      const savedWind = TUNING.water.windSeaHeight;
      let flat = null;
      try {
        TUNING.water.swellHeight = 0;
        TUNING.water.windSeaHeight = 0;
        water.rebuild(TUNING.water);
        for (let y = -0.6; y <= 0.7; y += 0.02) {
          const m = measureAt(120, y, 40, yaw, 0.06, speed);
          if (!flat || Math.abs(m.wet - faceMeasure.wet) < Math.abs(flat.wet - faceMeasure.wet)) {
            flat = { y, ...m };
          }
        }
      } finally {
        TUNING.water.swellHeight = savedSwell;
        TUNING.water.windSeaHeight = savedWind;
        water.rebuild(TUNING.water);
        await preset(savedPreset, 300);
      }
      restoreState(saved);
      const effectiveMass = dolphin.mass * (1 + TUNING.hydro.addedMassForward);
      const flatReq = Math.max(0, -flat.aF);
      const faceReq = Math.max(0, -faceMeasure.aF);
      const cruiseThrust =
        TUNING.movement.acceleration * 0.38; // thrust at the cruise-speed cap
      return {
        face: { ...faceMeasure, slope: face.s.slope, along: face.along },
        flat: { ...flat, requiredAccel: flatReq },
        faceRequiredAccel: faceReq,
        thrustSaving: flatReq - faceReq,
        thrustSavingPct: (1 - faceReq / Math.max(1e-6, flatReq)) * 100,
        waveAccel: (faceMeasure.pF - flat.pF) / effectiveMass,
        cruiseThrust,
        waveShareOfCruise: ((faceMeasure.pF - flat.pF) / effectiveMass / cruiseThrust) * 100,
      };
    },

    /**
     * Scenario 4: drop into a shoaling, breaking face and hold W. Records
     * aeration, buoyancy, breaker-jet force and whether the animal is thrown.
     */
    async shoalingBreak(name = "moderate", seconds = 6) {
      const saved = saveState();
      const savedPreset = TUNING.water.preset;
      await preset(name);
      const dirX = water.peak.dx;
      const dirZ = water.peak.dz;
      let face = null;
      for (let gx = -70; gx <= 70; gx += 2) {
        for (let gz = -70; gz <= 70; gz += 2) {
          const x = TUNING.water.surfZoneX + gx;
          const z = TUNING.water.surfZoneZ + gz;
          const s = water.sampleSurface(x, z, {});
          const along = s.slopeX * dirX + s.slopeZ * dirZ;
          if (s.breakMask > 0.25 && s.depth > 2.5 && s.depth < 6 && along < -0.1) {
            const score = s.breakMask * 1.4 - along;
            if (!face || score > face.score) face = { x, z, s, along, score };
          }
        }
      }
      if (!face) {
        restoreState(saved);
        return { error: "no breaking face found" };
      }
      const yaw = Math.atan2(dirX, dirZ);
      dolphin.position.set(face.x, face.s.height - 0.15, face.z);
      dolphin.yaw = dolphin.targetYaw = yaw;
      dolphin.pitch = dolphin.targetPitch = 0.06;
      dolphin.velocity.set(dirX * water.stats.peakPhaseSpeed * 0.9, 0.2, dirZ * water.stats.peakPhaseSpeed * 0.9);
      input.keys.add("KeyW");
      const rows = [];
      const n = Math.round((seconds * 1000) / 150);
      try {
        for (let i = 0; i < n; i++) {
          await sleep(150);
          const surf = ocean.getWaterHeight(dolphin.position.x, dolphin.position.z);
          rows.push({
            rel: dolphin.position.y - surf,
            speed: dolphin.speed,
            air: dolphin.airborne,
            aeration: dolphin.hydro.aeration,
            breakMask: dolphin.hydro.breakMask || 0,
            buoy: dolphin.hydro.buoyancyForce,
            lung: dolphin.hydro.lungForce,
            jet: dolphin.hydro.waterVelocityX * dirX + dolphin.hydro.waterVelocityZ * dirZ,
            fwd: dolphin.hydro.forwardForce,
            vy: dolphin.velocity.y,
            impact: dolphin.impact,
          });
        }
      } finally {
        input.keys.delete("KeyW");
        restoreState(saved);
        await preset(savedPreset, 300);
      }
      const rel = rows.map((r) => r.rel);
      return {
        slope: face.along,
        depth: face.s.depth,
        breakMask: face.s.breakMask,
        relMin: Math.min(...rel),
        relMax: Math.max(...rel),
        speedMax: Math.max(...rows.map((r) => r.speed)),
        airFraction: rows.filter((r) => r.air).length / rows.length,
        aerationMax: Math.max(...rows.map((r) => r.aeration)),
        jetMax: Math.max(...rows.map((r) => r.jet)),
        impactMax: Math.max(...rows.map((r) => r.impact)),
        buoyMin: Math.min(...rows.map((r) => r.buoy)),
        samples: rows,
      };
    },

    /** Scenario 3 live: find a face, hold W with a slight nose-up trim. */
    async faceHold(name = "moderate", seconds = 4) {
      const saved = saveState();
      const savedPreset = TUNING.water.preset;
      await preset(name);
      let face = findFace(-0.2, false);
      if (!face) face = findFace(-0.2, true);
      const yaw = yawAlong();
      dolphin.position.set(face.x, face.s.height, face.z);
      dolphin.yaw = dolphin.targetYaw = yaw;
      dolphin.pitch = dolphin.targetPitch = 0.06;
      dolphin.velocity.set(water.peak.dx * water.stats.peakPhaseSpeed, 0.2, water.peak.dz * water.stats.peakPhaseSpeed);
      input.keys.add("KeyW");
      const rows = [];
      const n = Math.round((seconds * 1000) / 150);
      try {
        for (let i = 0; i < n; i++) {
          await sleep(150);
          const surf = ocean.getWaterHeight(dolphin.position.x, dolphin.position.z);
          const s = water.sampleSurface(dolphin.position.x, dolphin.position.z, {});
          rows.push({
            rel: dolphin.position.y - surf,
            speed: dolphin.speed,
            air: dolphin.airborne,
            pF: dolphin.hydro.pressureForwardForce,
            netA: dolphin.hydro.accel.dot(dolphin.forward),
            along: s.slopeX * water.peak.dx + s.slopeZ * water.peak.dz,
          });
        }
      } finally {
        input.keys.delete("KeyW");
        restoreState(saved);
        await preset(savedPreset, 300);
      }
      const rel = rows.map((r) => r.rel);
      const speed = rows.map((r) => r.speed);
      return {
        preset: name,
        slope: face.along,
        relMin: Math.min(...rel),
        relMax: Math.max(...rel),
        speedMin: Math.min(...speed),
        speedMax: Math.max(...speed),
        airFraction: rows.filter((r) => r.air).length / rows.length,
        pressureForwardMax: Math.max(...rows.map((r) => r.pF)),
        netAccelMax: Math.max(...rows.map((r) => r.netA)),
        samples: rows,
      };
    },

    restore: () => {
      input.keys.clear();
    },
  };
}
