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
    this.surfBlend = 0;
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
    const deep = dolphin.position.y < water.height - 2.5;
    // Near the surface, let the camera sit in the waterline band so a true
    // half-in/half-out frame is possible instead of forcing it 18 cm down.
    const nearSurface = Math.abs(dolphin.position.y - water.height) < 0.55;

    // The snout is the look handle. Orbit and aim from the mouse target rather
    // than waiting for the physical body to finish its turn; the spine and
    // velocity can trail behind without dragging the view with them. While
    // surfing, the face pitch pulls the view down the wave with the body.
    this.surfBlend = damp(this.surfBlend, dolphin.surfing ? 1 : 0, 3.5, dt);
    // On a wave the camera should stay behind the ridden line, not the raw
    // mouse yaw: the body is carried toward the wave direction while surfing.
    const lookYaw =
      dolphin.targetYaw +
      wrapAngle(dolphin.yaw - dolphin.targetYaw) * this.surfBlend;
    const lookPitch = clamp(
      lerp(dolphin.targetPitch, dolphin.pitch, camCfg.surfLookPitch * this.surfBlend),
      -1.45,
      1.45
    );
    if (!this.initialized) {
      this.orbitYaw = lookYaw;
      this.orbitPitch = lookPitch;
    } else {
      const lookAlpha = 1 - Math.exp(-camCfg.lookResponsiveness * dt);
      const yawDelta = wrapAngle(lookYaw - this.orbitYaw);
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

    const baseDistance = camCfg.chaseDistance + speedNorm * camCfg.speedPullback;
    const baseHeight = camCfg.chaseHeight * (0.78 + 0.22 * Math.cos(dolphin.roll * 0.6));
    const distance = lerp(baseDistance, camCfg.surfDistance, this.surfBlend);
    const height = lerp(baseHeight, camCfg.surfHeight, this.surfBlend);

    const targetPos = this.desiredPos.copy(dolphin.position);
    targetPos.addScaledVector(fwd, -distance);
    targetPos.addScaledVector(worldUp, height + speedNorm * 0.26);
    targetPos.addScaledVector(this.orbitRight, camCfg.shoulder);
    targetPos.addScaledVector(dolphin.up, 0.2);

    // On a wave, sit on the offshore shoulder rather than directly behind the
    // animal: the face itself otherwise blocks the line of sight.
    if (this.surfBlend > 0.01) {
      const downhill = this.tmp.set(-water.slopeX, 0, -water.slopeZ);
      if (downhill.lengthSq() > 1e-5) {
        downhill.normalize();
        targetPos.addScaledVector(downhill, camCfg.surfShoulder * this.surfBlend);
      }
    }

    const targetLook = this.desiredLook.copy(dolphin.position);
    targetLook.addScaledVector(fwd, camCfg.targetAhead + speedNorm * 1.4);
    targetLook.addScaledVector(worldUp, lerp(camCfg.lookUp, 0.2, this.surfBlend));

    if (!started) {
      // Cinematic pre-start view: look across the big-wave ridge from the
      // seaward side so the default screen shows the 20-30 m faces.
      const cfg = TUNING.water;
      const wx = Math.cos(cfg.swellDirection);
      const wz = Math.sin(cfg.swellDirection);
      const px = -wz;
      const pz = wx;
      const drift = Math.sin(this.time * 0.05) * 35;
      targetPos.set(
        cfg.surfZoneX - 135 * wx + drift * px,
        34,
        cfg.surfZoneZ - 135 * wz + drift * pz
      );
      targetLook.set(cfg.surfZoneX + 10 * wx, 2, cfg.surfZoneZ + 10 * wz);
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

    if (started) {
      // Avoid the seafloor and the underside of the surface. The dolphin may
      // breach; when it does, the camera is allowed to break through with it.
      const camSurf = this.ocean.getWaterSample(targetPos.x, targetPos.z);
      if (deep) {
        const ceiling = camSurf.height + (nearSurface ? 0.12 : -0.32);
        if (targetPos.y > ceiling) targetPos.y = ceiling;
      } else {
        // Keep the chase camera above the local surface while the animal is on
        // or above the water. In a 20-30 m swell the camera's own wave can
        // otherwise swallow it even when the dolphin is clear. While surfing,
        // drop to the waterline: that low, face-level view is what sells the
        // carve instead of a top-down shot of the back.
        const clearance = lerp(1.0, 0.12, this.surfBlend);
        targetPos.y = Math.max(targetPos.y, camSurf.height + clearance);
      }
      const floorAt = seabed.getSurfaceHeight(targetPos.x, targetPos.z);
      if (targetPos.y < floorAt + 0.52) targetPos.y = floorAt + 0.52;
    }

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
    if (started) {
      if (deep && !nearSurface && this.position.y > smoothedSurf.height - 0.18) {
        this.position.y = lerp(this.position.y, smoothedSurf.height - 0.18, 0.3);
      } else if (deep && nearSurface) {
        // Keep the camera inside a narrow band around the local surface.
        const lo = smoothedSurf.height - 0.22;
        const hi = smoothedSurf.height + 0.12;
        if (this.position.y < lo) this.position.y = lerp(this.position.y, lo, 0.3);
        if (this.position.y > hi) this.position.y = lerp(this.position.y, hi, 0.3);
      } else if (!deep && !nearSurface) {
        // The target was lifted above the surface, but the damped camera can
        // still sit under a different crest behind the dolphin. Keep it above
        // its own local surface; the deliberate waterline band is excluded.
        this.position.y = Math.max(
          this.position.y,
          smoothedSurf.height + lerp(1.0, 0.12, this.surfBlend)
        );
      }
      if (this.position.y < smoothedFloor + 0.48) {
        this.position.y = lerp(this.position.y, smoothedFloor + 0.48, 0.4);
      }
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

    const rollAmount =
      dolphin.roll * camCfg.rollFollow * 0.38 +
      (dolphin.surfFaceBank * camCfg.surfRollFollow + dolphin.roll * 0.22) * this.surfBlend +
      rollNoise +
      shake * 0.012;
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
