import * as THREE from "three";

/**
 * Frame-rate benchmark: open the game with `?bench` in the URL and it plays
 * a fixed set of scenes by itself, then saves what it measured.
 *
 * For each scene it measures:
 *   - live: the real game loop for a few seconds, every frame's interval
 *     and the JavaScript time inside it (physics, effects, render calls),
 *     and every hitch (a frame that missed the display's refresh), with
 *     whether a shader was compiled in it;
 *   - gpu: the frame held still and drawn repeatedly with a GPU sync after
 *     the batch, so the time includes the GPU's work (Safari has no GPU
 *     timer): the whole frame, each post pass, each part of the scene (by
 *     hiding it) and the ocean's own GPU passes;
 *   - features: what the frame costs with one feature off at a time.
 *
 * The results are shown on screen and, in the dev server, saved to
 * bench-results/ (see vite.config.js). URL options: bench=quick for short
 * runs, scenes=a,b to pick scenes, live=<seconds>, label=<name>,
 * features=0 to skip the feature toggles, batch=<ms> and reps=<n> for the
 * GPU timing batches.
 */

const now = () => performance.now();
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  return {
    mean: +mean.toFixed(2),
    p50: +percentile(s, 0.5).toFixed(2),
    p95: +percentile(s, 0.95).toFixed(2),
    p99: +percentile(s, 0.99).toFixed(2),
    max: +(s[s.length - 1] || 0).toFixed(2),
  };
}

/** Every Object3D reachable from an owner's own fields (two levels deep). */
function objectsOf(owner, depth = 2, out = new Set(), seen = new Set()) {
  if (!owner || typeof owner !== "object" || seen.has(owner)) return out;
  seen.add(owner);
  // An owner's reference to the scene itself is not one of its parts (hiding
  // it hid everything, and the seabed's share read as the whole frame).
  if (owner.isScene) return out;
  if (owner.isObject3D) {
    out.add(owner);
    return out;
  }
  if (depth <= 0) return out;
  const values = Array.isArray(owner) ? owner : Object.values(owner);
  for (const v of values) {
    if (v && typeof v === "object" && !(v instanceof THREE.Material) && !(v instanceof THREE.BufferGeometry)) {
      objectsOf(v, depth - 1, out, seen);
    }
  }
  return out;
}

export async function runBench(O, api) {
  const params = new URLSearchParams(location.search);
  const quick = params.get("bench") === "quick";
  // bench=gpu: no live play, only the held-frame GPU timings. The game is
  // stepped by hand, so it also runs in a hidden page (which gets no
  // animation frames).
  const gpuOnly = params.get("bench") === "gpu";
  const frame = gpuOnly
    ? () => {
        api.step();
        return new Promise((resolve) => setTimeout(resolve, 0));
      }
    : nextFrame;
  const liveSeconds = Number(params.get("live")) || (quick ? 2 : 6);
  const settleSeconds = quick ? 0.8 : 2;
  // batch=<ms> and reps=<n> shorten the GPU timing batches (for a software
  // renderer, where one frame takes seconds).
  const minBatchMs = params.has("batch") ? Math.max(0, Number(params.get("batch")) || 0) : quick ? 60 : 150;
  const maxReps = Math.max(1, Number(params.get("reps")) || 400);
  const label = params.get("label") || "";
  const pick = params.get("scenes") ? params.get("scenes").split(",") : null;
  const features = params.get("features") !== "0";

  const { renderer, scene, camera, post, ocean, dolphin, seabed, tuning } = O;
  const gl = renderer.getContext();

  // ---- overlay ------------------------------------------------------------
  const panel = document.createElement("pre");
  panel.style.cssText =
    "position:fixed;left:12px;top:12px;z-index:99;margin:0;padding:10px 12px;max-width:calc(100vw - 48px);" +
    "max-height:calc(100vh - 48px);overflow:auto;font:12px/1.45 ui-monospace,Menlo,monospace;" +
    "color:#e8f4f2;background:rgba(4,18,22,0.82);border-radius:6px;white-space:pre-wrap;pointer-events:auto";
  document.body.appendChild(panel);
  const lines = [];
  const say = (text) => {
    lines.push(text);
    panel.textContent = lines.join("\n");
    console.log("[bench] " + text);
  };
  const status = (text) => {
    panel.textContent = lines.concat(["", text]).join("\n");
  };

  // ---- setup ---------------------------------------------------------------
  while (!O.info.started) {
    O.start();
    O.hud.el.startPrompt?.classList.add("is-hidden");
    await frame();
  }
  O.hud.el.title?.classList.add("is-away");
  const saved = {
    renderScale: tuning.visuals.renderScale,
    dynamicQuality: tuning.visuals.dynamicQuality,
    readout: tuning.debug.readout,
  };
  tuning.visuals.dynamicQuality = false;
  tuning.visuals.renderScale = 1;
  await frame();
  await frame();

  const syncU8 = new Uint8Array(4);
  const syncF32 = new Float32Array(4);
  // Wait for the GPU to finish everything sent so far, by reading one pixel
  // of `target` (null: the canvas) back to the CPU.
  const sync = (target = null) => {
    if (target) {
      const props = renderer.properties.get(target);
      renderer.state.bindFramebuffer(gl.FRAMEBUFFER, props.__webglFramebuffer);
      if (target.texture.type === THREE.UnsignedByteType) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncU8);
      else gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, syncF32);
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncU8);
    }
  };

  const syncCost = (() => {
    sync();
    const t0 = now();
    for (let i = 0; i < 20; i++) sync();
    return (now() - t0) / 20;
  })();

  // Repeat `fn` until at least minBatchMs has passed (Safari's clock is
  // coarse), then sync once; the time per call includes its GPU work.
  const stopwatch = (fn, target = null, minMs = minBatchMs) => {
    fn();
    sync(target);
    let n = 0;
    const t0 = now();
    let submit = 0;
    do {
      fn();
      n++;
      submit = now() - t0;
    } while (submit < minMs && n < maxReps);
    sync(target);
    const total = now() - t0;
    return {
      ms: +Math.max(0, (total - syncCost) / n).toFixed(3),
      cpu: +(submit / n).toFixed(3),
      n,
    };
  };

  // ---- device --------------------------------------------------------------
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const composerTarget = post.composer.renderTarget1;
  const device = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    dpr: window.devicePixelRatio,
    screen: [screen.width, screen.height],
    window: [innerWidth, innerHeight],
    canvas: [renderer.domElement.width, renderer.domElement.height],
    composer: [composerTarget.width, composerTarget.height],
    glVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    glRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxSamples: renderer.capabilities.maxSamples,
    msaaSamples: post.sceneTarget.samples,
    gpuTimer: !!gl.getExtension("EXT_disjoint_timer_query_webgl2"),
    parallelCompile: !!gl.getExtension("KHR_parallel_shader_compile"),
    syncMs: +syncCost.toFixed(3),
  };
  say(`ocean benchmark ${label ? "(" + label + ") " : ""}— leave this tab in front until it finishes.`);
  say(`${device.glRenderer} · window ${device.window.join("x")} @${device.dpr}x · frame ${device.composer.join("x")} · canvas ${device.canvas.join("x")}`);

  // ---- per-frame log -----------------------------------------------------------
  let frameSink = null;
  let perFrame = null;
  api.setFrameHook((rec) => {
    if (perFrame) perFrame(rec);
    if (frameSink) frameSink.push(rec);
  });

  // The display's refresh interval, from the frames of an idle second.
  const refresh = gpuOnly ? 1000 / 60 : await (async () => {
    const t = [];
    let last = 0;
    for (let i = 0; i < (quick ? 12 : 40); i++) {
      await frame();
      const n = now();
      if (last) t.push(n - last);
      last = n;
    }
    t.sort((a, b) => a - b);
    return percentile(t, 0.25);
  })();
  const refreshMs = refresh > 12 && refresh < 14 ? 1000 / 75 : refresh < 10 ? 1000 / 120 : refresh > 25 ? 1000 / 30 : 1000 / 60;
  if (!gpuOnly) say(`display refresh ≈ ${(1000 / refreshMs).toFixed(0)} Hz (idle frame ${refresh.toFixed(1)} ms)`);
  else say("GPU timings only (game stepped by hand)");

  const record = async (seconds, onFrame = null) => {
    const rows = [];
    frameSink = rows;
    perFrame = onFrame;
    const t0 = now();
    if (gpuOnly) for (let i = 0; i < Math.round(seconds * 60); i++) await frame();
    else while (now() - t0 < seconds * 1000) await frame();
    frameSink = null;
    perFrame = null;
    return rows;
  };

  const analyse = (rows) => {
    const dt = rows.map((r) => r.dt).slice(1);
    const cpu = rows.map((r) => r.cpu);
    const budget = refreshMs * 1.5;
    const hitches = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.dt > budget) {
        hitches.push({
          at: +((r.t - rows[0].t) / 1000).toFixed(2),
          dt: +r.dt.toFixed(1),
          cpu: +r.cpu.toFixed(1),
          prevCpu: +rows[i - 1].cpu.toFixed(1),
          render: +r.render.toFixed(1),
          dolphin: +r.dolphin.toFixed(1),
          seabed: +r.seabed.toFixed(1),
          ocean: +r.ocean.toFixed(1),
          effects: +r.effects.toFixed(1),
          newPrograms: r.programs - rows[i - 1].programs,
          newTextures: r.textures - rows[i - 1].textures,
          newGeometries: r.geometries - rows[i - 1].geometries,
        });
      }
    }
    const span = rows.length > 1 ? (rows[rows.length - 1].t - rows[0].t) / 1000 : 0;
    const part = (key) => summarize(rows.map((r) => r[key]));
    return {
      frames: rows.length,
      fps: span > 0 ? +((rows.length - 1) / span).toFixed(1) : 0,
      interval: summarize(dt),
      missed: dt.filter((d) => d > budget).length,
      over25: dt.filter((d) => d > 25).length,
      over34: dt.filter((d) => d > 34).length,
      cpu: summarize(cpu),
      parts: {
        dolphin: part("dolphin"),
        seabed: part("seabed"),
        ocean: part("ocean"),
        effects: part("effects"),
        render: part("render"),
        other: summarize(rows.map((r) => r.cpu - r.dolphin - r.seabed - r.ocean - r.effects - r.render)),
      },
      calls: rows.length ? rows[rows.length - 1].calls : 0,
      triangles: rows.length ? rows[rows.length - 1].triangles : 0,
      programs: rows.length ? rows[rows.length - 1].programs : 0,
      // When every hitch happened, and the details of the worst ones (the
      // report has to stay small enough to pass around).
      hitchTimes: hitches.slice(0, 80).map((h) => h.at),
      hitches: [...hitches].sort((a, b) => b.dt - a.dt).slice(0, 12),
    };
  };

  // ---- the scene, in parts -------------------------------------------------------
  const groups = (() => {
    const named = [
      ["ocean surface", [ocean.mesh]],
      ["sky", [ocean.sky]],
      ["seabed", [...objectsOf(seabed, 2)]],
      ["corals", [O.reefs.group]],
      ["seagrass", [O.seagrass.group]],
      ["dolphin", [dolphin.root, dolphin.model].filter(Boolean)],
      ["particles & spray", [...objectsOf(O.effects, 3)]],
      ["marine snow", [...objectsOf(O.snow, 1)]],
      ["near motes", [...objectsOf(O.motes, 1)]],
      ["spindrift", [...objectsOf(api.spindrift, 2)]],
    ];
    const claimed = new Set();
    const out = [];
    for (const [name, list] of named) {
      // Only objects that are actually in the scene, once each.
      const objs = list.filter((o) => {
        if (!o || claimed.has(o)) return false;
        let p = o;
        while (p && p !== scene) p = p.parent;
        return p === scene;
      });
      objs.forEach((o) => claimed.add(o));
      if (objs.length) out.push({ name, objs });
    }
    const rest = scene.children.filter((o) => !claimed.has(o) && !o.isLight && !o.isCamera);
    const restMeshes = rest.filter((o) => {
      let has = false;
      o.traverse((c) => {
        if (c.isMesh || c.isPoints || c.isLine) has = true;
      });
      return has;
    });
    if (restMeshes.length) out.push({ name: "other", objs: restMeshes });
    return out;
  })();

  const measureGpu = (underwater) => {
    const result = {};
    result.frame = stopwatch(() => api.drawFrame(), null);
    // Each pass of the post chain, drawn as the composer draws it.
    const composer = post.composer;
    const passes = [];
    const passName = (p) =>
      p === post.scenePass ? "scene (with MSAA resolve)" :
      p === post.volumetric ? "water volume & shafts" :
      p === post.bloom ? "bloom" :
      p === post.output ? "tone map" :
      p === post.film ? "upscale, FXAA & lens" : p.constructor.name;
    api.drawFrame();
    for (let i = 0; i < composer.passes.length; i++) {
      const pass = composer.passes[i];
      if (!pass.enabled) continue;
      pass.renderToScreen = composer.renderToScreen && composer.isLastEnabledPass(i);
      const target =
        pass === post.scenePass ? post.sceneTarget : pass.renderToScreen ? null : pass === post.bloom ? composer.readBuffer : composer.writeBuffer;
      const t = stopwatch(() => pass.render(renderer, composer.writeBuffer, composer.readBuffer, 1 / 60, false), target);
      passes.push({ name: passName(pass), ...t });
      if (pass.needsSwap) composer.swapBuffers();
    }
    renderer.setRenderTarget(null);
    result.passes = passes;

    // The scene pass with one part hidden at a time. Each is also drawn
    // through a one-pixel scissor, which leaves what a part costs before
    // any pixel is shaded (vertex shading and binning), and counted.
    api.drawFrame();
    const target = post.sceneTarget;
    const sceneOnly = () => post.scenePass.render(renderer);
    const sceneVertices = () => {
      target.scissor.set(0, 0, 1, 1);
      target.scissorTest = true;
      sceneOnly();
      target.scissorTest = false;
      target.scissor.set(0, 0, target.width, target.height);
    };
    const triangles = () => {
      renderer.info.reset();
      sceneOnly();
      return renderer.info.render.triangles;
    };
    const base = stopwatch(sceneOnly, target);
    const baseVertices = stopwatch(sceneVertices, target);
    const baseTriangles = triangles();
    result.sceneBase = { ...base, vertexMs: baseVertices.ms, triangles: baseTriangles };
    result.groups = [];
    for (const g of groups) {
      const was = g.objs.map((o) => o.visible);
      g.objs.forEach((o) => (o.visible = false));
      const t = stopwatch(sceneOnly, target);
      const tv = stopwatch(sceneVertices, target);
      const tris = triangles();
      g.objs.forEach((o, i) => (o.visible = was[i]));
      if (was.some(Boolean)) {
        result.groups.push({
          name: g.name,
          ms: +(base.ms - t.ms).toFixed(3),
          cpu: +(base.cpu - t.cpu).toFixed(3),
          vertexMs: +(baseVertices.ms - tv.ms).toFixed(3),
          triangles: baseTriangles - tris,
        });
      }
    }

    // The ocean's own GPU work before the frame: the ripple FFTs and the
    // contact heightfield.
    let rt = ocean.time;
    result.ripples = stopwatch(() => {
      rt += 1 / 60;
      ocean.ripples.update(rt);
    }, ocean.ripples.output || ocean.ripples.cascades[ocean.ripples.cascades.length - 1].target);
    ocean.ripples.update(ocean.time + 1e-4);
    result.contactSim = stopwatch(() => ocean.sim._step(1 / 60), ocean.sim.targets[0]);
    if (!underwater) {
      const r = api.refraction;
      result.refraction = stopwatch(() => r.render(scene, camera), r.target);
    }
    return result;
  };

  const featureToggles = [
    ["MSAA off", () => (tuning.visuals.msaa = false), () => (tuning.visuals.msaa = true)],
    ["FXAA off", () => (tuning.visuals.edgeSmoothing = false), () => (tuning.visuals.edgeSmoothing = true)],
    ["bloom off", () => (post.bloom.enabled = false), () => (post.bloom.enabled = true)],
    ["sun shafts off", () => { saved.shaft = tuning.visuals.shaftStrength; tuning.visuals.shaftStrength = 0; }, () => (tuning.visuals.shaftStrength = saved.shaft)],
    ["caustic light off", () => { saved.caustic = tuning.visuals.volumetricCaustics; tuning.visuals.volumetricCaustics = 0; }, () => (tuning.visuals.volumetricCaustics = saved.caustic)],
    ["render scale 0.75", () => { tuning.visuals.renderScale = 0.75; api.resize(); }, () => { tuning.visuals.renderScale = 1; api.resize(); }],
    ["render scale 2 (Retina)", () => { tuning.visuals.renderScale = 2; api.resize(); }, () => { tuning.visuals.renderScale = 1; api.resize(); }],
  ];
  const measureFeatures = () => {
    const base = stopwatch(() => api.drawFrame(), null);
    const out = [{ name: "all on", ms: base.ms, cpu: base.cpu }];
    for (const [name, on, off] of featureToggles) {
      on();
      api.drawFrame();
      api.drawFrame();
      const t = stopwatch(() => api.drawFrame(), null);
      off();
      api.drawFrame();
      out.push({ name, ms: t.ms, cpu: t.cpu, saves: +(base.ms - t.ms).toFixed(2) });
    }
    return out;
  };

  // ---- scenes -------------------------------------------------------------------
  const keys = O.input.keys;
  const hold = (...codes) => {
    keys.clear();
    codes.forEach((c) => keys.add(c));
  };
  const surfaceAt = (x, z) => ocean.getWaterHeight(x, z);
  const start = tuning.world.start;
  // The storm's shelf edge, where the big waves break: the nearest point
  // toward the surf zone at about 33 m of water.
  const shelfEdge = (() => {
    const sx = tuning.water.surfZoneX;
    const sz = tuning.water.surfZoneZ;
    let best = { x: sx, z: sz, d: Infinity };
    for (let t = 0; t <= 1; t += 0.01) {
      const x = start.x + (sx - start.x) * t;
      const z = start.z + (sz - start.z) * t;
      const depth = ocean.bathy.sampleDepth(x, z);
      const d = Math.abs(depth - 33);
      if (d < best.d) best = { x, z, d };
    }
    return best;
  })();

  const breachLauncher = () => {
    let next = 0;
    return (rec) => {
      if (rec.t < next) return;
      next = rec.t + 2900;
      const x = start.x + 30;
      const z = start.z + 40;
      const h = surfaceAt(x, z);
      O.pose(x, h - 2.2, z, 0.4, 0.75);
      const f = dolphin.forward;
      dolphin.velocity.set(f.x, f.y, f.z).multiplyScalar(11);
    };
  };

  const scenes = [
    {
      id: "reef",
      label: "under water at the reef (the start)",
      setup: () => {
        O.clearFreeView();
        O.teleport(start.x, start.y, start.z, tuning.world.startYaw);
        hold("KeyW");
      },
      features: true,
    },
    {
      id: "surface",
      label: "swimming along the surface",
      setup: () => {
        O.clearFreeView();
        const x = start.x + 20;
        const z = start.z + 60;
        O.pose(x, surfaceAt(x, z) - 0.25, z, 0.3, 0);
        hold("KeyW", "Space");
      },
      features: true,
    },
    {
      id: "breach",
      label: "breaching and splashing down",
      setup: () => {
        O.clearFreeView();
        hold("KeyW", "ShiftLeft");
      },
      onFrame: breachLauncher,
    },
    {
      id: "surf",
      label: "breaking storm waves at the shelf edge",
      setup: () => {
        O.clearFreeView();
        const { x, z } = shelfEdge;
        const yaw = Math.atan2(start.x - x, start.z - z);
        O.pose(x, surfaceAt(x, z) - 0.25, z, yaw, 0);
        hold("KeyW", "Space");
      },
      features: true,
    },
    {
      id: "lookup",
      label: "looking up at the surface from 4 m down",
      setup: () => {
        const x = start.x + 6;
        const z = start.z + 10;
        const h = surfaceAt(x, z);
        O.pose(x, h - 3, z + 4, 0, 0.2);
        O.freeze(true);
        O.setFreeView([x, h - 4, z], [x + 4, h + 12, z + 9], 64);
        keys.clear();
      },
      features: true,
    },
    {
      id: "wide",
      label: "above the storm sea, 26 m up",
      setup: () => {
        const x = start.x + 40;
        const z = start.z + 30;
        const h = surfaceAt(x, z);
        O.pose(x + 10, h - 0.3, z + 30, 0, 0);
        O.freeze(true);
        O.setFreeView([x, h + 26, z], [x + 60, h + 4, z + 180], 60);
        keys.clear();
      },
    },
    {
      id: "waterline",
      label: "camera half in the water",
      setup: () => {
        const x = start.x + 12;
        const z = start.z + 30;
        const h = surfaceAt(x, z);
        O.pose(x + 2, h - 0.2, z + 6, 0.2, 0);
        O.freeze(true);
        O.setFreeView([x, h + 0.03, z], [x + 3, h + 0.1, z + 10], 62);
        keys.clear();
      },
    },
  ].filter((s) => !pick || pick.includes(s.id));

  const results = [];
  const t0 = now();
  for (let si = 0; si < scenes.length; si++) {
    const sc = scenes[si];
    const res = { id: sc.id, label: sc.label };
    try {
      status(`[${si + 1}/${scenes.length}] ${sc.label}: setting up`);
      O.freeze(false);
      sc.setup();
      const onFrame = sc.onFrame ? sc.onFrame() : null;
      const settleRows = await record(settleSeconds, onFrame);
      const settle = analyse(settleRows);
      res.settle = {
        frames: settle.frames,
        maxInterval: settle.interval.max,
        newPrograms: settleRows.length ? settleRows[settleRows.length - 1].programs - settleRows[0].programs : 0,
        hitches: settle.hitches,
      };
      if (!gpuOnly) {
        status(`[${si + 1}/${scenes.length}] ${sc.label}: playing ${liveSeconds} s`);
        res.live = analyse(await record(liveSeconds, onFrame));
      }
      status(`[${si + 1}/${scenes.length}] ${sc.label}: timing the GPU`);
      O.freeze(true);
      await frame();
      await frame();
      const underwater = camera.position.y < surfaceAt(camera.position.x, camera.position.z);
      res.underwater = underwater;
      res.gpu = measureGpu(underwater);
      if (features && sc.features) {
        await frame();
        status(`[${si + 1}/${scenes.length}] ${sc.label}: timing features`);
        res.features = measureFeatures();
      }
      const L = res.live;
      const playLine = L
        ? `${String(L.fps).padStart(5)} fps · missed ${L.missed}/${L.frames} · worst ${L.interval.max.toFixed(0)} ms · ` +
          `JS ${L.cpu.mean.toFixed(1)} (max ${L.cpu.max.toFixed(0)}) · `
        : "";
      const top = [...res.gpu.passes, ...res.gpu.groups.map((g) => ({ ...g, name: "scene: " + g.name }))]
        .filter((p) => !p.name.startsWith("scene ("))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 3)
        .map((p) => `${p.name} ${p.ms.toFixed(1)}`)
        .join(", ");
      say(`${sc.id.padEnd(9)} ${playLine}frame ${res.gpu.frame.ms.toFixed(1)} ms · top: ${top}`);
    } catch (error) {
      res.error = String(error && error.stack ? error.stack : error);
      say(`${sc.id}: failed (${error})`);
    }
    results.push(res);
    keys.clear();
    await frame();
  }

  // ---- restore and save -----------------------------------------------------------
  keys.clear();
  O.freeze(false);
  O.clearFreeView();
  tuning.visuals.renderScale = saved.renderScale;
  tuning.visuals.dynamicQuality = saved.dynamicQuality;
  api.setFrameHook(null);

  const report = {
    version: 1,
    label,
    url: location.href,
    startedAt: new Date(Date.now() - (now() - t0)).toISOString(),
    seconds: +((now() - t0) / 1000).toFixed(1),
    refreshMs: +refreshMs.toFixed(2),
    device,
    settings: {
      renderScale: 1,
      effectiveScale: post.composerScale(),
      msaa: tuning.visuals.msaa,
      shaftSteps: tuning.visuals.shaftSteps,
      seaState: ocean.water.presetName || null,
    },
    scenes: results,
  };
  window.OCEAN_BENCH = report;
  let savedAs = "";
  try {
    const res = await fetch("/__bench", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
    if (res.ok) savedAs = (await res.json()).saved;
  } catch (e) {}
  say("");
  say(savedAs ? `saved to bench-results/${savedAs}` : "not saved (no dev server); results are in window.OCEAN_BENCH");
  say("done. Reload without ?bench to play.");
  return report;
}
