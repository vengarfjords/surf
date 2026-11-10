import * as THREE from "three";
import { TUNING } from "../config.js";
import { clamp } from "../utils.js";

/**
 * Water debug instrumentation: a probe marker locked to the exact CPU
 * surface, a GPU readback of the same point, and a compact readout of the
 * things a surfer needs to read (height, slope, phase speed, direction).
 */
export class WaterDebug {
  constructor(scene, ocean, dolphin) {
    this.scene = scene;
    this.ocean = ocean;
    this.dolphin = dolphin;
    this.surface = {};
    this.gpuHeight = null;
    this.gpuDelta = 0;
    this.clock = 0;
    this.gpuClock = 0;
    this.probeX = 0;
    this.probeZ = 0;

    this.group = new THREE.Group();
    this.group.name = "water-probe";
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.035, 6, 28),
      new THREE.MeshBasicMaterial({ color: 0x72ffcf, depthTest: false, transparent: true, opacity: 0.95 })
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.renderOrder = 20;
    this.group.add(this.ring);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -2.4, 0),
      new THREE.Vector3(0, 0, 0),
    ]);
    this.line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0x72ffcf, depthTest: false, transparent: true, opacity: 0.55 })
    );
    this.line.renderOrder = 20;
    this.group.add(this.line);

    // Phase-speed / crest-normal arrow: length is two seconds of travel at
    // the local phase speed, so it reads as both direction and scale.
    this.arrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0.12, 0),
      3,
      0x72ffcf,
      0.34,
      0.18
    );
    this.arrow.line.material.depthTest = false;
    this.arrow.cone.material.depthTest = false;
    this.arrow.line.renderOrder = 20;
    this.arrow.cone.renderOrder = 20;
    this.group.add(this.arrow);
    scene.add(this.group);

    this.readout = document.createElement("div");
    this.readout.id = "waterReadout";
    this.readout.className = "water-readout";
    this.readout.innerHTML = "";
    const hud = document.getElementById("hud");
    if (hud) hud.appendChild(this.readout);
    this.started = false;
  }

  setStarted(started) {
    this.started = started;
  }

  update(dt) {
    const debug = TUNING.debug;
    const show = this.started && (debug.probe || debug.readout);
    this.group.visible = this.started && debug.probe;
    this.readout.style.display = this.started && debug.readout ? "" : "none";

    // The probe sits a few metres ahead of the snout so it is visible in the
    // chase shot. It samples at the dolphin's height, not at the camera.
    const d = this.dolphin;
    this.probeX = d.position.x + d.forward.x * 3.2;
    this.probeZ = d.position.z + d.forward.z * 3.2;
    const surf = this.ocean.water.sampleSurface(this.probeX, this.probeZ, this.surface);
    const sampleY = Math.min(d.position.y, surf.height - 0.1);
    const full = this.ocean.water.sample(this.probeX, sampleY, this.probeZ, this.fullSample || (this.fullSample = {}));

    this.ring.position.set(this.probeX, surf.height + 0.05, this.probeZ);
    this.line.position.set(this.probeX, surf.height + 0.05, this.probeZ);
    this.arrow.position.set(this.probeX, surf.height + 0.22, this.probeZ);
    this.arrow.setDirection(new THREE.Vector3(full.waveDirectionX, 0.04, full.waveDirectionZ).normalize());
    this.arrow.setLength(Math.max(1.5, full.phaseSpeed * 2.0), 0.34, 0.18);

    this.clock += dt;
    this.gpuClock += dt;
    if (debug.gpuProbe && this.gpuClock > 0.7) {
      this.gpuClock = 0;
      const gpu = this.ocean.gpuProbeHeight(this.probeX, this.probeZ);
      this.gpuHeight = gpu;
      this.gpuDelta = Math.abs(gpu - surf.height);
    }
    if (!show) return;

    if (this.clock > 0.1) {
      this.clock = 0;
      this.updateReadout(surf, full);
    }
  }

  updateReadout(surf, full) {
    const stats = this.ocean.water.stats;
    const speed = this.dolphin.speed;
    const phase = stats.peakPhaseSpeed;
    const ratio = phase > 0.05 ? speed / phase : 0;
    const slopeDeg = (Math.atan(surf.slope) * 180) / Math.PI;
    const gpuText = this.gpuHeight === null ? "—" : `${(this.gpuDelta * 100).toFixed(1)} cm`;
    const dirDeg = ((Math.atan2(full.waveDirectionZ, full.waveDirectionX) * 180) / Math.PI + 360) % 360;
    this.readout.innerHTML =
      `<b>SEA</b> Hs ${stats.height.toFixed(1)} m · λ ${stats.peakWavelength.toFixed(0)} m · ` +
      `T ${stats.peakPeriod.toFixed(1)} s · c ${phase.toFixed(1)} m/s · ${dirDeg.toFixed(0)}°` +
      `<br><b>LOCAL</b> h ${surf.height >= 0 ? "+" : ""}${surf.height.toFixed(2)} m · ` +
      `face ${slopeDeg.toFixed(1)}° · foam ${clamp((1 - surf.jacobian) * 1.5, 0, 1).toFixed(2)} · ` +
      `GPU Δ ${gpuText}` +
      `<br><b>SURF</b> dolphin ${speed.toFixed(1)} m/s · phase ${phase.toFixed(1)} m/s · ` +
      `${ratio.toFixed(2)}×${ratio > 0.92 && ratio < 1.15 ? " — on the face" : ""}`;
  }
}
