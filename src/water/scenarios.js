import { TUNING } from "../config.js";

/**
 * Seeded scenario harness for the water/dolphin coupling. These are developer
 * tools exposed as window.OCEAN.scenarios; they intentionally move the animal
 * and are not part of the normal game loop.
 *
 * All scenarios use the deterministic spectrum (TUNING.water.seed), so a reload
 * reproduces the same set/face positions for a given sim time.
 */
export function createScenarios({ ocean, dolphin, input, water, effects, seabed, freeze, cameraRig }) {
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
        const s = { ...ocean.getWaterSample(x, z) };
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

  /**
   * Deterministic offline stepping: the render loop's dolphin update is
   * frozen and the wave clock is advanced here at a fixed 60 Hz, so results
   * do not depend on the browser's frame rate.
   */
  function stepWorld(dt, control) {
    ocean.time += dt;
    water.setTime(ocean.time);
    ocean.foamField.update(dt, ocean.time);
    dolphin.update(dt, control, ocean, seabed, effects);
    if (cameraRig) trackCamera(dt);
  }

  // The camera rig is stepped with the world so the surf shot can be
  // measured: how soon it engages, and whether the lens stays out of the
  // water while it is engaged.
  let cam = null;
  function resetCamera() {
    cam = { elapsed: 0, surfMax: 0, surfTime: 0, underTime: 0, clearMin: Infinity, engagedAt: -1 };
    if (cameraRig) {
      cameraRig.initialized = false;
      cameraRig.surf = 0;
      cameraRig.surfHold = 0;
    }
  }
  function trackCamera(dt) {
    if (!cam) resetCamera();
    const cs = cameraRig.update(dt, dolphin, seabed, true);
    cam.elapsed += dt;
    cam.surfMax = Math.max(cam.surfMax, cs.surf);
    if (cs.surf > 0.8) {
      if (cam.engagedAt < 0) cam.engagedAt = cam.elapsed;
      cam.surfTime += dt;
      if (cs.underwaterTarget > 0.5) cam.underTime += dt;
      cam.clearMin = Math.min(cam.clearMin, cameraRig.camera.position.y - cs.waterHeight);
    }
  }
  function cameraReport() {
    if (!cam) return null;
    const out = {
      surfMax: cam.surfMax,
      surfTime: cam.surfTime,
      engagedAt: cam.engagedAt,
      underwaterWhileSurf: cam.underTime,
      clearanceMin: Number.isFinite(cam.clearMin) ? cam.clearMin : null,
    };
    resetCamera();
    cam = null;
    return out;
  }

  function botInput() {
    return {
      forward: false,
      brake: false,
      left: false,
      right: false,
      rise: false,
      dive: false,
      boost: false,
      pitchUpKeys: false,
      pitchDownKeys: false,
      mdx: 0,
      mdy: 0,
      consumeMouse() {
        return { dx: this.mdx, dy: this.mdy };
      },
    };
  }

  const api = {
    // Optional async hook awaited after each faceDrop step (screenshots).
    onStep: null,

    /**
     * Scenario 7: catch and ride a wave like a player would. Starting `start`
     * metres up-wave of the bank centre, the bot floats until a set wave's
     * front face approaches, paddles to ~80% of the wave speed, then glides
     * on the face (paddling if it slips back, braking if it runs ahead),
     * holding its depth with mouse pitch. `angle` (rad) angles the heading
     * along the face once riding. With `carve`, the bot instead surfs like a
     * player: it angles down the line to drop from the top of the face, then
     * turns back up the face from the bottom, to the side of `angle`'s sign.
     * Returns the longest continuous ride: time spent on the front face, near
     * the surface, moving with the wave, plus how far it dropped and climbed.
     */
    async surfCatch(start = -70, angle = 0, seconds = 30, time0 = 0, carve = false) {
      if (!seabed || !freeze) return { error: "scenario needs seabed and freeze hooks" };
      const saved = saveState();
      const savedTime = TUNING.water.timeScale;
      freeze(true);
      TUNING.water.timeScale = 0;
      const savedClock = ocean.time;
      ocean.time = time0;
      water.setTime(time0);
      const dirX = dx();
      const dirZ = dz();
      const waveYaw = yawAlong();
      const sx = TUNING.water.surfZoneX + dirX * start;
      const sz = TUNING.water.surfZoneZ + dirZ * start;
      setPose(sx, ocean.getWaterHeight(sx, sz) - 0.35, sz, waveYaw, 0);
      dolphin.velocity.set(0, 0, 0);
      dolphin.targetYaw = dolphin.yaw = waveYaw;
      dolphin.targetPitch = dolphin.pitch = 0;
      const control = botInput();
      const sens = TUNING.movement.mouseSensitivity;
      const dt = 1 / 60;
      resetCamera();
      let go = false;
      let ride = 0;
      let rideStart = 0;
      let best = 0;
      let bestDistance = 0;
      let maxSpeed = 0;
      // Vertical travel on the best ride: how far the animal dropped down
      // and climbed back up the face, and its peak speed while riding.
      let yMin = 0;
      let yMax = 0;
      let rideSpeed = 0;
      let bestDrop = 0;
      let bestSpeed = 0;
      let carveDown = true;
      for (let t = 0; t < seconds; t += dt) {
        const q = ocean.getWaterSample(dolphin.position.x, dolphin.position.z);
        const along = dolphin.velocity.x * dirX + dolphin.velocity.z * dirZ;
        const rel = dolphin.position.y - q.height;
        const fp = q.facePhase ?? 9;
        const c = q.phaseSpeed;
        if (!go) {
          const size = (2 * (q.envelope || 0)) / Math.max(0.1, water.stats.height * q.shoal);
          go = size > 0.5 && fp > 1.5 && fp < 2.7;
        }
        const onFace = fp > -0.1 && fp < 1.5;
        control.brake = false;
        if (!go) control.forward = false;
        else if (onFace) {
          control.forward = fp < 0.25 && along < c;
          control.brake = fp > 1.2 && along > c;
        } else control.forward = along < c * 0.8;
        const slope = q.slopeX * dirX + q.slopeZ * dirZ;
        const wantPitch = Math.max(-0.45, Math.min(0.45, -(rel + 0.3) * 0.7 + Math.atan(slope)));
        control.mdy = ((dolphin.targetPitch - wantPitch) / (sens * 0.78)) * 0.15;
        control.mdx = 0;
        if (carve && go) {
          const onWave = fp > -0.4 && fp < 2.0;
          const side = Math.sign(angle) || 1;
          if (fp < 0.35) carveDown = true;
          else if (fp > 1.25) carveDown = false;
          const target = onWave ? side * (carveDown ? 0.35 : 1.05) : 0;
          let err = waveYaw + target - dolphin.targetYaw;
          err = Math.atan2(Math.sin(err), Math.cos(err));
          control.mdx = (-err / sens) * 0.1;
          if (onWave) {
            control.forward = carveDown ? along < c * 1.1 : fp > 1.6 || along < c * 0.7;
            control.brake = false;
          }
        } else if (angle && go) {
          const onWave = fp > -0.3 && fp < 1.6;
          let err = waveYaw + (onWave ? angle : 0) - dolphin.targetYaw;
          err = Math.atan2(Math.sin(err), Math.cos(err));
          control.mdx = (-err / sens) * 0.08;
          if (onWave) {
            control.forward = along < c * 0.98;
            control.brake = along > c * 1.25;
          }
        }
        stepWorld(dt, control);
        maxSpeed = Math.max(maxSpeed, dolphin.speed);
        const s = ocean.getWaterSample(dolphin.position.x, dolphin.position.z);
        const relNow = dolphin.position.y - s.height;
        const alongNow = dolphin.velocity.x * dirX + dolphin.velocity.z * dirZ;
        const sNow = (dolphin.position.x - TUNING.water.surfZoneX) * dirX + (dolphin.position.z - TUNING.water.surfZoneZ) * dirZ;
        const fpNow = s.facePhase ?? 9;
        const riding = fpNow > -0.3 && fpNow < 1.9 && Math.abs(relNow) < 0.9 && alongNow > 0.6 * s.phaseSpeed;
        if (riding) {
          if (ride === 0) {
            rideStart = sNow;
            yMin = yMax = dolphin.position.y;
            rideSpeed = 0;
          }
          ride += dt;
          yMin = Math.min(yMin, dolphin.position.y);
          yMax = Math.max(yMax, dolphin.position.y);
          rideSpeed = Math.max(rideSpeed, dolphin.speed);
          if (ride > best) {
            best = ride;
            bestDistance = sNow - rideStart;
            bestDrop = yMax - yMin;
            bestSpeed = rideSpeed;
          }
        } else ride = 0;
      }
      TUNING.water.timeScale = savedTime;
      ocean.time = savedClock;
      water.setTime(savedClock);
      restoreState(saved);
      for (const p of dolphin.hull.panels) p.prevWet = 0;
      dolphin.waterTilt.set(0, 0, 0);
      dolphin.waterTiltRate.set(0, 0, 0);
      freeze(false);
      return {
        start,
        angle,
        time0,
        bestRide: best,
        rideDistance: bestDistance,
        rideDrop: bestDrop,
        rideSpeed: bestSpeed,
        maxSpeed,
        camera: cameraReport(),
      };
    },

    /**
     * Scenario 8: drop in and climb back up. Waits for a big set wave to
     * reach `start` metres up-wave of the bank centre, places the animal at
     * the top of its front face moving at the wave speed, then rides angled
     * `angle` rad down the line, holding the surface with mouse pitch only.
     * At the bottom of the face it turns back up the face and climbs it.
     * Without `thrust` it coasts the whole way (no tail strokes); with it, W
     * is held as a player would. Reports the vertical drop, the speed gained
     * on the way down and how much height it climbed back.
     */
    async faceDrop(start = -90, angle = 0.35, time0 = 0, thrust = false, takeoff = 0.3) {
      if (!seabed || !freeze) return { error: "scenario needs seabed and freeze hooks" };
      const saved = saveState();
      const savedTime = TUNING.water.timeScale;
      freeze(true);
      TUNING.water.timeScale = 0;
      const savedClock = ocean.time;
      const dirX = dx();
      const dirZ = dz();
      const waveYaw = yawAlong();
      const x0 = TUNING.water.surfZoneX + dirX * start;
      const z0 = TUNING.water.surfZoneZ + dirZ * start;
      // Find the first set wave (about Hs or bigger) with the take-off point
      // at face phase `takeoff` (0 = crest, pi/2 = mid-face).
      let t = time0;
      let found = false;
      for (; t < time0 + 240; t += 0.1) {
        water.setTime(t);
        const q = ocean.getWaterSample(x0, z0);
        const size = (2 * (q.envelope || 0)) / Math.max(0.1, water.stats.height * q.shoal);
        if (size > 1.05 && Math.abs(q.facePhase - takeoff) < 0.15) {
          found = true;
          break;
        }
      }
      if (!found) {
        water.setTime(savedClock);
        freeze(false);
        return { error: "no set wave found" };
      }
      ocean.time = t;
      water.setTime(t);
      const q0 = { ...ocean.getWaterSample(x0, z0) };
      const yaw = waveYaw + angle;
      setPose(x0, q0.height - 0.25, z0, yaw, -Math.atan(q0.slope) * 0.8);
      dolphin.targetYaw = dolphin.yaw = yaw;
      dolphin.velocity.copy(dolphin.forward).multiplyScalar(q0.phaseSpeed);
      const control = botInput();
      const sens = TUNING.movement.mouseSensitivity;
      const dt = 1 / 60;
      const y0 = dolphin.position.y;
      const v0 = dolphin.velocity.length();
      const trace = [];
      resetCamera();
      let yMin = y0;
      let vMax = v0;
      let bottomAt = -1;
      let yClimb = -Infinity;
      let phase = "drop";
      let elapsed = 0;
      for (; elapsed < 9; elapsed += dt) {
        const q = ocean.getWaterSample(dolphin.position.x, dolphin.position.z);
        const rel = dolphin.position.y - q.height;
        const fp = q.facePhase ?? 9;
        if (phase === "drop" && (fp > 2.0 || elapsed > 5)) {
          phase = "climb";
          bottomAt = elapsed;
        }
        const side = Math.sign(angle) || 1;
        const target = waveYaw + (phase === "drop" ? angle : side * 1.2);
        let err = target - dolphin.targetYaw;
        err = Math.atan2(Math.sin(err), Math.cos(err));
        control.mdx = (-err / sens) * 0.1;
        const slope = (dolphin.forward.x * q.slopeX + dolphin.forward.z * q.slopeZ) /
          Math.max(0.2, Math.hypot(dolphin.forward.x, dolphin.forward.z));
        const wantPitch = Math.max(-0.6, Math.min(0.6, -(rel + 0.05) * 0.8 + Math.atan(slope)));
        control.mdy = ((dolphin.targetPitch - wantPitch) / (sens * 0.78)) * 0.15;
        control.forward = thrust;
        const waveSpeed = q.phaseSpeed;
        const breaking = q.breaking || 0;
        stepWorld(dt, control);
        const y = dolphin.position.y;
        if (Math.round(elapsed * 60) % 15 === 0) {
          trace.push([
            +elapsed.toFixed(2),
            phase,
            +y.toFixed(2),
            +rel.toFixed(2),
            +fp.toFixed(2),
            +dolphin.velocity.length().toFixed(2),
            +(dolphin.velocity.x * dirX + dolphin.velocity.z * dirZ).toFixed(2),
            +waveSpeed.toFixed(2),
            +breaking.toFixed(2),
            cameraRig ? +cameraRig.surf.toFixed(2) : 0,
          ]);
        }
        if (api.onStep) await api.onStep({ elapsed, phase });
        if (phase === "drop") {
          yMin = Math.min(yMin, y);
          vMax = Math.max(vMax, dolphin.velocity.length());
        } else {
          yClimb = Math.max(yClimb, y);
          const sNow = ocean.getWaterSample(dolphin.position.x, dolphin.position.z);
          // Over the crest and off the back: the climb is finished.
          if (sNow.facePhase < -0.4 && elapsed - bottomAt > 0.5) break;
        }
      }
      const waveH = 2 * (q0.envelope || 0);
      TUNING.water.timeScale = savedTime;
      ocean.time = savedClock;
      water.setTime(savedClock);
      restoreState(saved);
      for (const p of dolphin.hull.panels) p.prevWet = 0;
      dolphin.waterTilt.set(0, 0, 0);
      dolphin.waterTiltRate.set(0, 0, 0);
      freeze(false);
      return {
        time: t,
        waveHeight: waveH,
        waveSpeed: q0.phaseSpeed,
        drop: y0 - yMin,
        speedStart: v0,
        speedMax: vMax,
        dropTime: bottomAt,
        climb: Number.isFinite(yClimb) ? yClimb - yMin : 0,
        total: elapsed,
        camera: cameraReport(),
        trace,
      };
    },

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
        const cpu = ocean.getWaterHeight(x, z);
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
    async shoalingBreak(name = "groundswell", seconds = 6) {
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
          const s = { ...ocean.getWaterSample(x, z) };
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
    async faceHold(name = "groundswell", seconds = 4) {
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
          const s = ocean.getWaterSample(dolphin.position.x, dolphin.position.z);
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

    /** Scenario 5: breach/re-entry on a face vs a trough. */
    async breachCompare(name = "groundswell") {
      const saved = saveState();
      const savedPreset = TUNING.water.preset;
      await preset(name);
      const dirX = water.peak.dx;
      const dirZ = water.peak.dz;
      const dirYaw = Math.atan2(dirX, dirZ);
      const find = (wantFace) => {
        let best = null;
        for (let gx = -80; gx <= 80; gx += 4) {
          for (let gz = -80; gz <= 80; gz += 4) {
            const x = 120 + gx;
            const z = 40 + gz;
            const s = { ...ocean.getWaterSample(x, z) };
            const score = wantFace ? s.height - s.slopeX * dirX * 4 : -s.height;
            if (!best || score > best.score) best = { x, z, s, score };
          }
        }
        return best;
      };
      const run = async (spot) => {
        effects.resetStats();
        dolphin.position.set(spot.x, spot.s.height - 2.2, spot.z);
        dolphin.yaw = dolphin.targetYaw = dirYaw;
        dolphin.pitch = dolphin.targetPitch = 0.9;
        dolphin.velocity.set(dirX * 12, 2.0, dirZ * 12);
        input.keys.add("KeyW");
        input.keys.add("ShiftLeft");
        let maxRel = -99;
        for (let i = 0; i < 34; i++) {
          await sleep(120);
          const surf = ocean.getWaterHeight(dolphin.position.x, dolphin.position.z);
          maxRel = Math.max(maxRel, dolphin.position.y - surf);
        }
        input.keys.delete("KeyW");
        input.keys.delete("ShiftLeft");
        // Let the re-entry/ring-wave effects finish.
        await sleep(1400);
        return {
          maxRel,
          breaches: dolphin.breachCount,
          spray: effects.stats.spray,
          foam: effects.stats.foam,
          bubbles: effects.stats.bubbles,
          crowns: effects.stats.crowns,
          tails: effects.stats.tails,
        };
      };
      const face = find(true);
      const trough = find(false);
      try {
        const faceRun = await run(face);
        const troughRun = await run(trough);
        return { face: faceRun, trough: troughRun };
      } finally {
        restoreState(saved);
        await preset(savedPreset, 300);
      }
    },

    restore: () => {
      input.keys.clear();
    },
  };
  return api;
}
