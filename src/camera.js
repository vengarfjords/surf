import * as THREE from "three";
import { TUNING } from "./config.js";
import { clamp, damp, dampVec3, lerp, smoothstep, wrapAngle } from "./utils.js";

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Snout-led chase camera with a little waterline cowardice and a handheld
 * operator. It orbits the mouse look target rather than the lagging physical
 * heading, so the head leads while the body trail, current and roll stay alive.
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
    const submerged = dolphin.position.y < water.height - 0.16;
    // Near the surface, let the camera sit in the waterline band so a true
    // half-in/half-out frame is possible instead of forcing it 18 cm down.
    const nearSurface = Math.abs(dolphin.position.y - water.height) < 0.55;

    // The snout is the look handle. Orbit and aim from the mouse target rather
    // than waiting for the physical body to finish its turn; the spine and
    // velocity can trail behind without dragging the view with them.
    const lookPitch = clamp(dolphin.targetPitch, -1.45, 1.45);
    if (!this.initialized) {
      this.orbitYaw = dolphin.targetYaw;
      this.orbitPitch = lookPitch;
    } else {
      const lookAlpha = 1 - Math.exp(-camCfg.lookResponsiveness * dt);
      const yawDelta = wrapAngle(dolphin.targetYaw - this.orbitYaw);
      this.orbitYaw = wrapAngle(this.orbitYaw + yawDelta * lookAlpha);
      this.orbitPitch = damp(this.orbitPitch, lookPitch, camCfg.lookResponsiveness, dt);
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
    if (submerged) {
      const ceiling = camSurf.height + (nearSurface ? 0.12 : -0.32);
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
      const lag = camCfg.positionLag * (started ? 1 : 0.55);
      dampVec3(this.position, targetPos, lag, dt);
      dampVec3(this.look, targetLook, camCfg.rotationLag, dt);
    }

    // Re-check after damping; the smoothed camera can otherwise still pass
    // through a steep bank or a crest.
    const smoothedSurf = this.ocean.getWaterSample(this.position.x, this.position.z);
    const smoothedFloor = seabed.getSurfaceHeight(this.position.x, this.position.z);
    if (submerged && !nearSurface && this.position.y > smoothedSurf.height - 0.18) {
      this.position.y = lerp(this.position.y, smoothedSurf.height - 0.18, 0.3);
    } else if (submerged && nearSurface) {
      // Keep the camera inside a narrow band around the local surface.
      const lo = smoothedSurf.height - 0.22;
      const hi = smoothedSurf.height + 0.12;
      if (this.position.y < lo) this.position.y = lerp(this.position.y, lo, 0.3);
      if (this.position.y > hi) this.position.y = lerp(this.position.y, hi, 0.3);
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

    const rollAmount = dolphin.roll * camCfg.rollFollow * 0.38 + rollNoise + shake * 0.012;
    this.camera.rotateZ(rollAmount);

    // FOV and subtle underwater breathing.
    const targetFov =
      camCfg.baseFov + speedNorm * camCfg.speedFov + Math.sin(this.time * 0.18) * 0.18;
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
    };
  }
}
