import * as THREE from "three";
import { TUNING } from "./config.js";
import { clamp, damp, dampVec3, lerp, smoothstep, wrapAngle } from "./utils.js";

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Snout-led chase camera with a little waterline cowardice and a handheld
 * operator. It orbits the mouse look target rather than the lagging physical
 * heading, so the head leads while the body trail, current and roll stay alive.
 *
 * While the dolphin rides at the surface (on a wave face, or running the top
 * of the water) it eases out into a surf follow shot: further back, higher,
 * above the water with the horizon held level, looking down the line. There
 * is no mode switch; `surf` is a continuous 0-1 blend driven by what the body
 * is actually doing, so the shot drifts out as a ride builds and sinks back
 * under the surface when the dolphin dives.
 */
export class CameraRig {
  constructor(camera, ocean) {
    this.camera = camera;
    this.ocean = ocean;
    this.position = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.desiredPos = new THREE.Vector3();
    this.desiredLook = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.orbitForward = new THREE.Vector3(0, 0, 1);
    this.orbitRight = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.underwater = 1;
    this.underwaterTarget = 1;
    this.initialized = false;
    this.time = 0;
    this.fov = TUNING.camera.baseFov;
    this.wetness = 0;
    this.lastY = 0;
    this.surfaceCrossCooldown = 0;
    this.impact = 0;
    // Surf follow blend (0 = chase, 1 = surf shot) and the seconds of
    // evidence that the dolphin is riding the surface, used as hysteresis.
    this.surf = 0;
    this.surfHold = 0;
    this.surfFwd = new THREE.Vector3();
    this.surfPos = new THREE.Vector3();
    this.surfLook = new THREE.Vector3();
  }

  /**
   * How much the dolphin is riding the surface right now. Riding a wave means
   * near the surface, on the front face of a swell of some size and moving
   * shoreward at a good fraction of the wave speed; running the top of the
   * water fast also counts. Evidence builds a short hold so the shot does not
   * flicker as each crest passes, and drains quickly once the body dives.
   */
  _updateSurf(dt, dolphin, rel, sample, started) {
    const camCfg = TUNING.camera;
    const wave = this.ocean.water;
    // Fully counts down to ~0.9 m under the surface, gone by ~1.8 m.
    const atSurface = 1 - smoothstep(0.9, 1.8, -rel);
    const vx = dolphin.velocity.x;
    const vz = dolphin.velocity.z;
    let riding = 0;
    if (wave.peak) {
      const along = vx * wave.peak.dx + vz * wave.peak.dz;
      const c = Math.max(0.5, sample.phaseSpeed || 0);
      const size = smoothstep(0.7, 1.6, 2 * (sample.envelope || 0));
      const fp = sample.facePhase ?? 0;
      const onFace = smoothstep(-0.7, -0.15, fp) * (1 - smoothstep(2.3, 2.9, fp));
      const withWave = smoothstep(0.35, 0.7, along / c);
      riding = size * onFace * withWave;
    }
    const running = smoothstep(5.5, 8.5, Math.hypot(vx, vz));
    const evidence = atSurface * Math.max(riding, running * 0.85);
    if (evidence > 0.45) this.surfHold = Math.min(1.2, this.surfHold + dt);
    else this.surfHold = Math.max(0, this.surfHold - dt * (atSurface < 0.3 ? 3.0 : 0.6));
    const target = camCfg.surfCam && started ? smoothstep(0.25, 0.7, this.surfHold) : 0;
    const rate = target > this.surf ? camCfg.surfBlendIn : camCfg.surfBlendOut;
    this.surf = damp(this.surf, target, rate, dt);
    if (this.surf < 1e-4) this.surf = 0;
    return this.surf;
  }

  update(dt, dolphin, seabed, started) {
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    this.surfaceCrossCooldown -= dt;
    const camCfg = TUNING.camera;
    const speed = dolphin.speed;
    const speedNorm = clamp(speed / TUNING.movement.boostSpeed, 0, 1.15);
    const worldUp = WORLD_UP;
    const water = this.ocean.getWaterSample(dolphin.position.x, dolphin.position.z);
    // Where the surface will be when this frame is drawn (see Dolphin.surfaceLead).
    water.height += dolphin.surfaceLead || 0;
    const waterAtDolphin = water.height;
    const submerged = dolphin.position.y < water.height - 0.16;
    // Near the surface, let the camera sit in the waterline band so a true
    // half-in/half-out frame is possible instead of forcing it 18 cm down.
    const nearSurface = Math.abs(dolphin.position.y - water.height) < 0.55;
    // `water` is a shared sample object; read the surf inputs before any
    // other surface query reuses it.
    const surf = this._updateSurf(dt, dolphin, dolphin.position.y - water.height, water, started);

    // The snout is the look handle. Orbit and aim from the mouse target rather
    // than waiting for the physical body to finish its turn; the spine and
    // velocity can trail behind without dragging the view with them.
    const lookPitch = clamp(dolphin.viewPitch ?? dolphin.targetPitch, -1.45, 1.45);
    if (!this.initialized) {
      this.orbitYaw = dolphin.targetYaw;
      this.orbitPitch = lookPitch;
    } else {
      // The surf shot swings round more lazily, like an operator panning.
      const lookRate = lerp(camCfg.lookResponsiveness, camCfg.surfLookResponsiveness, surf);
      const lookAlpha = 1 - Math.exp(-lookRate * dt);
      const yawDelta = wrapAngle(dolphin.targetYaw - this.orbitYaw);
      this.orbitYaw = wrapAngle(this.orbitYaw + yawDelta * lookAlpha);
      this.orbitPitch = damp(this.orbitPitch, lookPitch, lookRate, dt);
    }
    const cosPitch = Math.cos(this.orbitPitch);
    const fwd = this.orbitForward.set(
      Math.sin(this.orbitYaw) * cosPitch,
      Math.sin(this.orbitPitch),
      Math.cos(this.orbitYaw) * cosPitch
    );
    this.orbitRight.set(Math.cos(this.orbitYaw), 0, -Math.sin(this.orbitYaw));

    const distance = camCfg.chaseDistance + speedNorm * camCfg.speedPullback;
    const height = camCfg.chaseHeight * (0.78 + 0.22 * Math.cos(dolphin.roll * 0.6));

    const targetPos = this.desiredPos.copy(dolphin.position);
    targetPos.addScaledVector(fwd, -distance);
    targetPos.addScaledVector(worldUp, height + speedNorm * 0.26);
    targetPos.addScaledVector(this.orbitRight, camCfg.shoulder);
    targetPos.addScaledVector(dolphin.up, 0.2);

    const targetLook = this.desiredLook.copy(dolphin.position);
    targetLook.addScaledVector(fwd, camCfg.targetAhead + speedNorm * 1.4);
    targetLook.addScaledVector(worldUp, camCfg.lookUp);

    if (surf > 0) {
      // Surf follow: behind along the steering heading, level, lifted toward
      // the up-wave side and kept clear of the water under the lens (which
      // may be the crest behind the dolphin), looking down the line.
      const sf = this.surfFwd.set(Math.sin(this.orbitYaw), 0, Math.cos(this.orbitYaw));
      const base = Math.max(dolphin.position.y, waterAtDolphin - 0.2);
      const sp = this.surfPos.copy(dolphin.position);
      sp.addScaledVector(sf, -(camCfg.surfDistance + speedNorm * 1.6));
      const peak = this.ocean.water.peak;
      if (peak) {
        sp.x -= peak.dx * camCfg.surfUpWave;
        sp.z -= peak.dz * camCfg.surfUpWave;
      }
      sp.y = base + camCfg.surfHeight + speedNorm * 0.6;
      const lensWater = this.ocean.getWaterHeight(sp.x, sp.z);
      sp.y = Math.max(sp.y, lensWater + camCfg.surfClearance);
      const sl = this.surfLook.copy(dolphin.position);
      sl.addScaledVector(sf, camCfg.surfLookAhead + speedNorm * 2.0);
      sl.y = base + camCfg.surfLookUp;
      const lock = dolphin.viewLock ?? dolphin.surfLock ?? 0;
      if (lock > 0.001 && dolphin._sl) {
        // Locked to the surface (Space): frame the shot in the surface's own
        // plane, behind along the heading and lifted along its normal, so on
        // a 60 degree face the dolphin stays in frame on the way down instead
        // of dropping out of the bottom of a level shot.
        const gx = dolphin._sl.sx;
        const gz = dolphin._sl.sz;
        const tn = this.tmpTan || (this.tmpTan = new THREE.Vector3());
        const nn = this.tmpNorm || (this.tmpNorm = new THREE.Vector3());
        tn.set(sf.x, gx * sf.x + gz * sf.z, sf.z).normalize();
        nn.set(-gx, 1, -gz).normalize();
        const at = this.tmpAt || (this.tmpAt = new THREE.Vector3());
        at.copy(dolphin.position).addScaledVector(nn, Math.max(0, waterAtDolphin - dolphin.position.y));
        const lp = this.tmpLockPos || (this.tmpLockPos = new THREE.Vector3());
        lp.copy(at)
          .addScaledVector(tn, -(camCfg.surfDistance + speedNorm * 1.6))
          .addScaledVector(nn, camCfg.surfHeight + speedNorm * 0.6);
        const lensLock = this.ocean.getWaterHeight(lp.x, lp.z) + (dolphin.surfaceLead || 0);
        lp.y = Math.max(lp.y, lensLock + camCfg.surfClearance);
        const ll = this.tmpLockLook || (this.tmpLockLook = new THREE.Vector3());
        // Aim just ahead of the dolphin itself: at 70-90 m/s down a curving
        // face a point metres ahead along the local plane is already off
        // the real surface, and the dolphin slid out of frame.
        ll.copy(at).addScaledVector(tn, 1.5).addScaledVector(nn, 0.3);
        sp.lerp(lp, lock);
        sl.lerp(ll, lock);
      }
      targetPos.lerp(sp, surf);
      targetLook.lerp(sl, surf);
    }

    if (!started) {
      // An unhurried attract shot, just off the creature's flank. The reef is
      // already in front of the animal; the observer waits at the edge of it.
      const a = 1.48 + Math.sin(this.time * 0.045) * 0.12;
      this.tmp2.set(Math.sin(a) * 5.1, 1.35, Math.cos(a) * 5.1);
      targetPos.copy(dolphin.position).add(this.tmp2).addScaledVector(worldUp, 0.25);
      targetLook.copy(dolphin.position).addScaledVector(fwd, 1.35);
      targetLook.y += 0.55;
    }

    // Handheld drift / fluid camera noise.
    const hh = camCfg.handheld * (started ? 1 : 0.45);
    const breathe = Math.sin(this.time * 0.41) * 0.045 + Math.sin(this.time * 0.19 + 2.1) * 0.07;
    const rollNoise = Math.sin(this.time * 0.37 + 0.8) * 0.006 + Math.sin(this.time * 0.13) * 0.004;
    targetPos.x += Math.sin(this.time * 0.29 + 0.4) * 0.055 * hh;
    targetPos.y += breathe * hh;
    targetPos.z += Math.cos(this.time * 0.33) * 0.055 * hh;
    targetLook.x += Math.sin(this.time * 0.24 + 1.7) * 0.13 * hh;
    targetLook.y += Math.cos(this.time * 0.3 + 0.2) * 0.08 * hh;
    targetLook.z += Math.sin(this.time * 0.27 + 0.9) * 0.11 * hh;

    // Avoid the seafloor and the underside of the surface. The dolphin may
    // breach; when it does, the camera is allowed to break through with it.
    const camSurf = this.ocean.getWaterSample(targetPos.x, targetPos.z);
    camSurf.height += dolphin.surfaceLead || 0;
    if (submerged) {
      // The surf shot lifts the ceiling continuously, so the lens rises out
      // through the surface as the blend builds instead of popping.
      const ceiling = camSurf.height + (nearSurface ? 0.12 : -0.32) + surf * 10;
      if (targetPos.y > ceiling) targetPos.y = ceiling;
    } else {
      // When the dolphin is on or above the surface, let the camera break
      // through with it so a breach actually reveals the sky.
      if (this.position.y > camSurf.height - 0.2 && targetPos.y < camSurf.height + 0.52) {
        targetPos.y = camSurf.height + 0.52;
      }
      if (targetPos.y < camSurf.height - 0.35 && this.position.y > camSurf.height + 0.3) {
        targetPos.y = camSurf.height + 0.35;
      }
    }
    const floorAt = seabed.getSurfaceHeight(targetPos.x, targetPos.z);
    if (targetPos.y < floorAt + 0.52) targetPos.y = floorAt + 0.52;

    if (!this.initialized) {
      this.position.copy(targetPos);
      this.look.copy(targetLook);
      this.initialized = true;
    } else {
      // At big-wave speeds (40-75 m/s on a mega face) a plain damped follow
      // trails tens of metres behind. Carry the lens with the body first, so
      // the damping only smooths the framing, not the travel.
      const carry = smoothstep(14, 30, speed);
      if (carry > 0) {
        this.position.addScaledVector(dolphin.velocity, dt * carry);
        this.look.addScaledVector(dolphin.velocity, dt * carry);
      }
      const lag = lerp(camCfg.positionLag, camCfg.surfPositionLag, surf) * (started ? 1 : 0.55);
      dampVec3(this.position, targetPos, lag, dt);
      dampVec3(this.look, targetLook, camCfg.rotationLag, dt);
    }

    // Re-check after damping; the smoothed camera can otherwise still pass
    // through a steep bank or a crest.
    const smoothedSurf = this.ocean.getWaterSample(this.position.x, this.position.z);
    smoothedSurf.height += dolphin.surfaceLead || 0;
    const smoothedFloor = seabed.getSurfaceHeight(this.position.x, this.position.z);
    // The underwater bands hand over to the surf shot's clearance.
    const under = 1 - smoothstep(0.05, 0.4, surf);
    if (submerged && !nearSurface && this.position.y > smoothedSurf.height - 0.18) {
      this.position.y = lerp(this.position.y, smoothedSurf.height - 0.18, 0.3 * under);
    } else if (submerged && nearSurface) {
      // Keep the camera inside a narrow band around the local surface.
      const lo = smoothedSurf.height - 0.22;
      const hi = smoothedSurf.height + 0.12;
      if (this.position.y < lo) this.position.y = lerp(this.position.y, lo, 0.3 * under);
      if (this.position.y > hi) this.position.y = lerp(this.position.y, hi, 0.3 * under);
    }
    if (surf > 0.6) {
      // A crest rolling under the lens lifts the camera rather than burying it.
      const lo = smoothedSurf.height + camCfg.surfClearance * 0.6;
      if (this.position.y < lo) this.position.y = lerp(this.position.y, lo, 0.35 * surf);
    }
    if (this.position.y < smoothedFloor + 0.48) {
      this.position.y = lerp(this.position.y, smoothedFloor + 0.48, 0.4);
    }

    // Camera shake is a decaying, frequency-shaped impulse, not random noise.
    this.impact = Math.max(this.impact * Math.exp(-4.5 * dt), dolphin.impact);
    const shake = this.impact * camCfg.shake;
    const shakeX = (Math.sin(this.time * 48.0) + Math.sin(this.time * 31.7) * 0.5) * 0.018 * shake;
    const shakeY = (Math.cos(this.time * 42.3) + Math.sin(this.time * 27.2) * 0.5) * 0.014 * shake;

    this.camera.position.copy(this.position);
    this.camera.position.x += shakeX;
    this.camera.position.y += shakeY;
    this.camera.up.copy(worldUp);
    this.camera.lookAt(this.look);

    const rollFollow = lerp(camCfg.rollFollow, camCfg.surfRollFollow, surf);
    const rollAmount = dolphin.roll * rollFollow * 0.38 + rollNoise + shake * 0.012;
    this.camera.rotateZ(rollAmount);

    // FOV and subtle underwater breathing.
    const targetFov =
      camCfg.baseFov +
      speedNorm * camCfg.speedFov +
      surf * camCfg.surfFov +
      Math.sin(this.time * 0.18) * 0.18;
    this.fov = damp(this.fov, targetFov, 2.8, dt);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();

    this.underwaterTarget = this.camera.position.y < smoothedSurf.height - 0.02 ? 1 : 0;
    this.underwater = damp(this.underwater, this.underwaterTarget, 8.0, dt);

    // A little lens splash when breaking the surface.
    const camUnder = this.underwaterTarget > 0.5;
    if (camUnder !== this.wasUnder && this.surfaceCrossCooldown <= 0) {
      this.surfaceCrossCooldown = 0.4;
      this.wetness = 1;
    }
    this.wasUnder = camUnder;
    this.wetness = Math.max(0, this.wetness - dt * 0.23);

    return {
      underwater: this.underwater,
      underwaterTarget: this.underwaterTarget,
      waterHeight: this.ocean.getWaterHeight(this.camera.position.x, this.camera.position.z),
      speedNorm,
      wetness: this.wetness,
      roll: rollAmount,
      surf,
    };
  }
}
