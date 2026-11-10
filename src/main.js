import * as THREE from "three";
import { TUNING, PALETTE, SUN_DIRECTION } from "./config.js";
import { Ocean } from "./ocean.js";
import { Seabed } from "./sand.js";
import { Reefs, Seagrass, FishSchools, SunShafts, HiddenThings, Jellyfish, sharedShader } from "./habitat.js";
import { Dolphin } from "./dolphin.js";
import { CameraRig } from "./camera.js";
import { ParticleFX, MarineSnow, NearMotes } from "./particles.js";
import { Input } from "./input.js";
import { OceanAudio } from "./audio.js";
import { HUD } from "./hud.js";
import { Post } from "./post.js";
import { WaterDebug } from "./water/debug.js";
import { createScenarios } from "./water/scenarios.js";
import { clamp, lerp, smoothstep } from "./utils.js";

const frame = () => new Promise((resolve) => setTimeout(resolve, 0));

async function boot() {
  const canvas = document.getElementById("scene");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TUNING.visuals.exposure;
  renderer.shadowMap.enabled = false;
  renderer.setClearColor(PALETTE.fogDeep, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.fogDeep);
  scene.fog = new THREE.FogExp2(PALETTE.fogDeep, TUNING.visuals.underwaterDensity);

  const camera = new THREE.PerspectiveCamera(
    TUNING.camera.baseFov,
    window.innerWidth / window.innerHeight,
    0.08,
    12000
  );
  camera.position.set(0, -2, 0);
  camera.rotation.order = "YXZ";

  const lights = createLights(scene);
  const ocean = new Ocean(renderer, scene);
  const loadingText = document.getElementById("loadingText");
  loadingText.textContent = "reading the swell";
  await frame();

  const seabed = new Seabed(scene, camera);
  const reefs = new Reefs(scene);
  loadingText.textContent = "reading the reef";
  await reefs.loadReferenceCorals();
  const seagrass = new Seagrass(scene);
  loadingText.textContent = "growing the meadows";
  await frame();

  const fish = new FishSchools(scene);
  const jellyfish = new Jellyfish(scene);
  const effects = new ParticleFX(scene);
  effects.ocean = ocean;
  seabed.sim.onSediment = (event) => {
    const surface = seabed.getSurfaceHeight(event.x, event.z);
    effects.sandPlume(event.x, event.z, event.amount, event.radius, surface);
  };
  seabed.sim.onRipple = (event) => {
    const surface = seabed.getSurfaceHeight(event.x, event.z);
    effects.rippleDust(event.x, event.z, event.strength, surface);
  };
  const snow = new MarineSnow(scene, 3400);
  const motes = new NearMotes(scene, 240);
  const shafts = new SunShafts(scene);
  const audio = new OceanAudio();
  audio.prepare();
  const input = new Input(canvas);
  loadingText.textContent = "finding the dolphin";
  await frame();

  const dolphin = await Dolphin.create(scene);
  const cameraRig = new CameraRig(camera, ocean);
  const post = new Post(renderer, scene, camera);
  const waterDebug = new WaterDebug(scene, ocean, dolphin);
  const scenarios = createScenarios({ ocean, dolphin, input, water: ocean.water, effects });
  const hidden = new HiddenThings(scene, seabed.sim, (main, sub) => hud.toast(main, sub));

  let started = false;
  let elapsed = 0;
  let lastBreaches = 0;
  let lastImpactSound = 0;
  let wasSurge = false;
  let fishAccumulator = 0;
  let ventClock = 0;
  let cullClock = 0;
  let frozen = false;
  let freeView = null;
  let postEnabled = TUNING.debug.postProcessing;

  const idleInput = {
    consumeMouse: () => ({ dx: 0, dy: 0 }),
    forward: false,
    brake: false,
    left: false,
    right: false,
    rise: false,
    dive: false,
    boost: false,
    pitchUpKeys: false,
    pitchDownKeys: false,
  };
  const bubbleVents = [
    { x: 7.5, z: 18 },
    { x: -18, z: 41 },
    { x: 36, z: 76 },
    { x: -52, z: 92 },
    { x: 12, z: -20 },
    { x: 84, z: 36 },
  ];

  const hud = new HUD({
    tuning: TUNING,
    input,
    audio,
    onStart: () => {
      started = true;
      elapsed = 0;
      input.enabled = true;
      audio.start();
      input.requestPointerLock();
    },
    onRelock: () => {
      input.requestPointerLock();
    },
  });

  const fogAbove = new THREE.Color(0x9fb3b8);
  const fogShallow = new THREE.Color(PALETTE.fogShallow);
  const fogDeep = new THREE.Color(PALETTE.fogDeep);
  const skyHorizon = new THREE.Color(PALETTE.skyHorizon);
  const sunWarm = new THREE.Color(PALETTE.sunColor);
  const sunCool = new THREE.Color(0xd6ecf5);
  const fogColor = new THREE.Color();
  const current = new THREE.Vector3(
    TUNING.movement.currentX,
    TUNING.movement.currentY,
    TUNING.movement.currentZ
  );

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    post.setSize(w, h);
  }
  window.addEventListener("resize", resize);

  canvas.addEventListener("click", () => {
    if (started && !hud.tunerOpen && !document.pointerLockElement) input.requestPointerLock();
  });

  // Warm the shader cache behind the loading card. If this fails, the first
  // frame still compiles everything, just less gracefully.
  const warmCam = cameraRig.update(1 / 60, dolphin, seabed, false);
  try {
    // First draw every reef/grass chunk once with culling disabled so their
    // instance buffers are resident, then run one full post frame so the
    // volumetric, bloom and film shaders are compiled before play starts.
    const warmEntries = [];
    const warmGroup = (group) => {
      group.traverse((object) => {
        if (!object.isInstancedMesh) return;
        warmEntries.push([object, object.visible, object.frustumCulled]);
        object.visible = true;
        object.frustumCulled = false;
      });
    };
    warmGroup(reefs.group);
    warmGroup(seagrass.group);
    post.render(1 / 60, {
      underwater: warmCam.underwater,
      wetness: 0,
      speedNorm: 0,
      waterLevel: warmCam.waterHeight,
    });
    for (const [object, visible, frustumCulled] of warmEntries) {
      object.visible = visible;
      object.frustumCulled = frustumCulled;
    }
    reefs.updateCulling(camera);
    seagrass.updateCulling(camera);
  } catch (error) {
    console.warn("warm-up frame failed", error);
  }
  try {
    await Promise.race([
      renderer.compileAsync(scene, camera),
      new Promise((resolve) => setTimeout(resolve, 3200)),
    ]);
  } catch (e) {}
  await frame();
  hud.setLoading(true);
  hud.setSound(true);

  // Lightweight instrumentation. GPU timing uses one timer query in flight;
  // the extension is optional, so every consumer must tolerate null.
  const gl = renderer.getContext();
  const timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  let pendingGpuQuery = null;
  let gpuFrameMs = 0;
  let lastOceanMs = 0;
  let perfAccum = 0;
  let perfFrames = 0;
  let frameMsAvg = 16.7;
  const perf = {
    frameMs: 16.7,
    gpuMs: 0,
    waveUpdateMs: 0,
    oceanMs: 0,
    seabedMs: 0,
    dolphinMs: 0,
    hullMs: 0,
    effectsMs: 0,
    drawCalls: 0,
    triangles: 0,
    components: 0,
    waveField: 0,
  };
  window.OCEAN_PERF = perf;

  let lastFrameTime = performance.now();
  let total = 0;
  function animate(now = performance.now()) {
    const rawDt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    const dt = Math.min(Math.max(rawDt, 0.0001), 1 / 25);
    total += dt;
    if (started) {
      elapsed += dt;
    }
    sharedShader.time.value = total;

    const stepInput = started ? input : idleInput;
    const dolphinStart = performance.now();
    const telemetry = frozen
      ? dolphin.telemetry
      : dolphin.update(dt, stepInput, ocean, seabed, effects);
    const dolphinMs = performance.now() - dolphinStart;
    telemetry.x = dolphin.position.x;
    telemetry.z = dolphin.position.z;
    telemetry.y = dolphin.position.y;

    const camState = cameraRig.update(dt, dolphin, seabed, started);

    // Fixed cinematic camera for screenshots / comparisons. Physics and the
    // wave clock keep running; only the view is pinned.
    if (freeView) {
      camera.position.copy(freeView.position);
      camera.up.set(0, 1, 0);
      camera.lookAt(freeView.look);
      camera.fov = freeView.fov ?? TUNING.camera.baseFov;
      camera.updateProjectionMatrix();
      const wh = ocean.getWaterHeight(camera.position.x, camera.position.z);
      camState.underwater = camera.position.y < wh ? 1 : 0;
      camState.underwaterTarget = camState.underwater;
      camState.waterHeight = wh;
      camState.wetness = 0;
    }

    // Reef and seagrass chunks are submitted only when they are still inside
    // the readable fog envelope. A slow cadence is enough at swim speeds and
    // keeps the culling loop off the hot path.
    cullClock -= dt;
    if (cullClock <= 0) {
      cullClock = 0.2;
      reefs.updateCulling(camera);
      seagrass.updateCulling(camera);
    }

    const camDepth = Math.max(
      0,
      ocean.getWaterHeight(camera.position.x, camera.position.z) - camera.position.y
    );
    const waterFade = smoothstep(0, 31, camDepth);
    fogColor.copy(fogShallow).lerp(fogDeep, waterFade);
    fogColor.lerp(fogAbove, 1 - camState.underwater);
    const fogDensity = lerp(TUNING.visuals.aboveDensity, TUNING.visuals.underwaterDensity, camState.underwater);
    scene.fog.color.copy(fogColor);
    scene.fog.density = fogDensity;
    scene.background.copy(fogColor);
    renderer.setClearColor(fogColor, 1);

    // Lights warm and soften once the camera breaks through.
    lights.sun.intensity = lerp(6.0, 4.8, camState.underwater);
    lights.hemi.intensity = lerp(0.95, 0.9, camState.underwater);
    lights.ambient.intensity = lerp(0.28, 0.34, camState.underwater);
    // The sun stays warm in the air, but once the camera is under the surface
    // the light is filtered toward the cyan end of the spectrum.
    lights.sun.color
      .copy(skyHorizon)
      .lerp(sunWarm, 0.55)
      .lerp(sunCool, camState.underwater * 0.78);

    const seabedStart = performance.now();
    seabed.update(dt, dolphin, camera, fogColor, fogDensity);
    const seabedMs = performance.now() - seabedStart;
    const oceanStart = performance.now();
    ocean.update(
      dt,
      dolphin.position,
      camera,
      camState.underwater,
      Math.max(camState.wetness, dolphin.wetness * 0.65),
      { fogColor, fogDensity, dolphinSpeed: dolphin.speed }
    );
    const oceanMs = performance.now() - oceanStart;
    waterDebug.setStarted(started);
    waterDebug.update(dt);

    fishAccumulator += dt;
    if (fishAccumulator > 1 / 24) {
      fish.update(fishAccumulator, dolphin.position, total);
      fishAccumulator = 0;
    }
    jellyfish.update(dt, total);
    hidden.update(dt, dolphin, effects);

    const currentStrength = 1 + Math.sin(total * 0.13) * 0.22;
    current.set(
      TUNING.movement.currentX * currentStrength,
      TUNING.movement.currentY,
      TUNING.movement.currentZ * currentStrength
    );
    ventClock -= dt;
    if (ventClock <= 0 && camState.underwater > 0.4) {
      ventClock = 0.22;
      for (const vent of bubbleVents) {
        const dx = vent.x - dolphin.position.x;
        const dz = vent.z - dolphin.position.z;
        if (dx * dx + dz * dz > 42 * 42) continue;
        if (Math.random() > 0.55) continue;
        const floor = seabed.getSurfaceHeight(vent.x, vent.z);
        effects.bubbleBurst(vent.x + (Math.random() - 0.5) * 1.5, floor + 0.18, vent.z + (Math.random() - 0.5) * 1.5, 1, 0.3, 0.45 + Math.random() * 0.7);
      }
    }
    const effectsStart = performance.now();
    effects.update(dt, camera, fogColor, fogDensity, current);
    snow.update(dt, camera, fogColor, fogDensity, camState.underwater);
    motes.update(dt, camera, fogColor, fogDensity, camState.underwater);
    shafts.update(camera, total, camState.underwater);
    const effectsMs = performance.now() - effectsStart;

    hud.update(dt, telemetry, elapsed, camState.underwater, clamp(dolphin.speed / TUNING.movement.boostSpeed, 0, 1.2));

    if (started) {
      if (telemetry.breaches > lastBreaches) {
        audio.event("breach", clamp(dolphin.speed / 8, 0.45, 1.3));
        hud.toast("breach", "the surface closes over again");
        lastBreaches = telemetry.breaches;
      }
      if (dolphin.impact > 0.42 && total - lastImpactSound > 1.1) {
        audio.event("impact", clamp(dolphin.impact, 0.2, 1));
        lastImpactSound = total;
      }
      if (input.boost && !wasSurge) audio.event("whoosh", 0.75);
      wasSurge = input.boost;
      if (dolphin.edgeWarning) hud.boundaryToast(elapsed);
      audio.update(dt, {
        underwater: camState.underwater,
        depth: telemetry.depth,
        speed: dolphin.speed,
      });
    }

    // Gentle exposure response to depth, so deep water goes velvety rather
    // than uniformly black.
    renderer.toneMappingExposure =
      TUNING.visuals.exposure * lerp(1.04, 0.92, smoothstep(5, 34, camDepth) * camState.underwater);

    if (TUNING.debug.postProcessing !== postEnabled) {
      postEnabled = TUNING.debug.postProcessing;
      post.setEnabled(postEnabled);
    }

    const startGpuQuery = timerExt && !pendingGpuQuery;
    if (startGpuQuery) {
      pendingGpuQuery = gl.createQuery();
      gl.beginQuery(timerExt.TIME_ELAPSED_EXT, pendingGpuQuery);
    }
    post.render(dt, {
      underwater: camState.underwater,
      wetness: Math.max(camState.wetness, dolphin.wetness * 0.6),
      speedNorm: camState.speedNorm,
      waterLevel: camState.waterHeight,
    });
    if (startGpuQuery) {
      gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    } else if (pendingGpuQuery) {
      const available = gl.getQueryParameter(pendingGpuQuery, gl.QUERY_RESULT_AVAILABLE);
      if (available) {
        const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
        if (!disjoint) gpuFrameMs = gl.getQueryParameter(pendingGpuQuery, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(pendingGpuQuery);
        pendingGpuQuery = null;
      }
    }

    lastOceanMs = oceanMs;
    perfAccum += dt;
    perfFrames++;
    if (perfAccum > 0.75) {
      frameMsAvg = (perfAccum * 1000) / perfFrames;
      perf.frameMs = frameMsAvg;
      perf.gpuMs = gpuFrameMs;
      perf.oceanMs = lastOceanMs;
      perf.seabedMs = seabedMs;
      perf.dolphinMs = dolphinMs;
      perf.hullMs = dolphin.hullMs || 0;
      perf.effectsMs = effectsMs;
      perf.waveUpdateMs = ocean.water.lastUniformMs || 0;
      perf.drawCalls = renderer.info.render.calls;
      perf.triangles = renderer.info.render.triangles;
      perf.components = ocean.water.count;
      perf.waveField = ocean.water.stats.height;
      perfAccum = 0;
      perfFrames = 0;
    }

    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // Headless capture mode: ?shot=underwater|waterline|breach. This only poses
  // the camera/animal; it is used for documentation screenshots.
  const shotMode = new URLSearchParams(location.search).get("shot");
  if (shotMode) {
    setTimeout(() => {
      const O = window.OCEAN;
      if (!O) return;
      O.start();
      O.tuning.debug.postProcessing = shotMode !== "breach";
      O.tuning.debug.probe = false;
      O.tuning.debug.readout = false;
      O.hud.el.startPrompt.classList.add("is-hidden");
      O.hud.el.title.classList.add("is-away");
      O.hud.el.toast.classList.remove("is-visible");
      if (shotMode === "underwater") {
        const h = O.ocean.getWaterHeight(120, 40);
        O.setFreeView([120, h - 3.5, 40], [120, h + 20, 40.2], 64);
      } else if (shotMode === "waterline") {
        const h = O.ocean.getWaterHeight(120, 40);
        O.freeze(true);
        O.pose(120, h + 0.12, 40, Math.atan2(O.water.peak.dx, O.water.peak.dz), 0.03);
        O.setFreeView([116, h + 0.04, 32], [121, h + 0.15, 42], 62);
      } else if (shotMode === "breach") {
        const h = O.ocean.getWaterHeight(120, 40);
        O.freeze(true);
        O.pose(120, h + 14, 40, Math.atan2(O.water.peak.dx, O.water.peak.dz), -0.9);
        O.setFreeView([112, h + 18.5, 32], [120, h + 15.2, 40], 56);
      }
    }, 2800);
  }

  window.OCEAN = {
    tuning: TUNING,
    scene,
    camera,
    renderer,
    ocean,
    water: ocean.water,
    waterDebug,
    scenarios,
    seabed,
    dolphin,
    cameraRig,
    perf,
    fish,
    jellyfish,
    reefs,
    referenceCorals: reefs.referenceCorals,
    seagrass,
    effects,
    motes,
    snow,
    shafts,
    hidden,
    audio,
    hud,
    input,
    post,
    start: () => hud.begin(),
    teleport: (x, y, z, yaw) => {
      dolphin.position.set(x, y, z);
      if (typeof yaw === "number") {
        dolphin.yaw = yaw;
        dolphin.targetYaw = yaw;
      }
      dolphin.velocity.set(0, 0, 0);
      dolphin.resetVisualChain();
      cameraRig.initialized = false;
    },
    // Debug / capture helpers. `freeze` stops dolphin physics only; waves and
    // rendering keep running so screenshots feel alive.
    freeze: (value = true) => {
      frozen = value;
    },
    pose: (x, y, z, yaw = dolphin.yaw, pitch = 0) => {
      dolphin.position.set(x, y, z);
      dolphin.yaw = yaw;
      dolphin.targetYaw = yaw;
      dolphin.pitch = pitch;
      dolphin.targetPitch = pitch;
      dolphin.roll = 0;
      dolphin.targetRoll = 0;
      dolphin.velocity.set(0, 0, 0);
      dolphin.update(0.0001, idleInput, ocean, seabed, effects);
      dolphin.root.position.copy(dolphin.position);
      cameraRig.initialized = false;
    },
    setFreeView: (position, look, fov = TUNING.camera.baseFov) => {
      freeView = {
        position: new THREE.Vector3(position[0], position[1], position[2]),
        look: new THREE.Vector3(look[0], look[1], look[2]),
        fov,
      };
    },
    clearFreeView: () => {
      freeView = null;
      cameraRig.initialized = false;
    },
    setPreset: (name) => ocean.water.setPreset(name),
    get info() {
      return {
        fpsHint: "~",
        vertices: renderer.info.render.vertices,
        calls: renderer.info.render.calls,
        dolphin: dolphin.position.toArray(),
        cam: camera.position.toArray(),
        started,
      };
    },
  };
}

function createLights(scene) {
  const hemi = new THREE.HemisphereLight(0xbde3ea, 0x0a2230, 0.46);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0x214f66, 0.16);
  scene.add(ambient);
  const sunColor = new THREE.Color(PALETTE.sunColor);
  const sun = new THREE.DirectionalLight(sunColor, 3.55);
  sun.position.set(SUN_DIRECTION.x * 120, SUN_DIRECTION.y * 120, SUN_DIRECTION.z * 120);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = false;
  scene.add(sun);
  scene.add(sun.target);
  return { sun, hemi, ambient };
}

boot().catch((err) => {
  console.error(err);
  const loading = document.getElementById("loading");
  const text = document.getElementById("loadingText");
  if (text) text.textContent = "the water is not responding — see console";
  if (loading) {
    loading.style.color = "#ffc6a8";
    loading.classList.remove("is-done");
  }
});
