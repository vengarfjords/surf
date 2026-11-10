import { TUNE_CONTROLS } from "./config.js";
import { timecode } from "./utils.js";

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => o[k], obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

export class HUD {
  constructor({ tuning, input, audio, onStart, onRelock }) {
    this.tuning = tuning;
    this.input = input;
    this.audio = audio;
    this.onStart = onStart;
    this.onRelock = onRelock;
    this.started = false;
    this.startTime = 0;
    this.clock = 0;
    this.hudClock = 0;
    this.uiClock = 0;
    this.toastTimer = null;
    this.tunerOpen = false;
    this.hudHidden = false;
    this.lastBoundaryToast = -99;
    this._cache = {};

    this.el = {
      hud: document.getElementById("hud"),
      timecode: document.getElementById("timecode"),
      depth: document.getElementById("depth"),
      speed: document.getElementById("speed"),
      altitude: document.getElementById("altitude"),
      speedBar: document.getElementById("speedBar"),
      compassNeedle: document.getElementById("compassNeedle"),
      heading: document.getElementById("heading"),
      coords: document.getElementById("coords"),
      surfaceIndicator: document.getElementById("surfaceIndicator"),
      surfaceLabel: document.getElementById("surfaceLabel"),
      title: document.getElementById("titleLockup"),
      hint: document.getElementById("hint"),
      toast: document.getElementById("toast"),
      toastMain: document.getElementById("toastMain"),
      toastSub: document.getElementById("toastSub"),
      startPrompt: document.getElementById("startPrompt"),
      loading: document.getElementById("loading"),
      loadingText: document.getElementById("loadingText"),
      enterButton: document.getElementById("enterButton"),
      tuner: document.getElementById("tuner"),
      tunerBody: document.getElementById("tunerBody"),
      tunerClose: document.getElementById("tunerClose"),
      soundState: document.getElementById("soundState"),
    };

    this._bind();
    this._buildTuner();
  }

  _bind() {
    this.el.enterButton.addEventListener("click", () => {
      this.begin();
    });

    this.el.tunerClose.addEventListener("click", () => {
      this.toggleTuner(false);
    });

    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.code === "KeyT" && this.started) {
        e.preventDefault();
        this.toggleTuner();
      }
      if (e.code === "KeyH" && this.started) {
        this.hudHidden = !this.hudHidden;
        this.el.hud.classList.toggle("is-hidden", this.hudHidden);
      }
      if (e.code === "KeyM" && this.started) {
        const on = this.audio?.toggle();
        this.el.soundState.textContent = on ? "SND—ON" : "SND—OFF";
      }
    });
  }

  begin() {
    if (this.started) return;
    this.started = true;
    this.startTime = performance.now() * 0.001;
    this.el.startPrompt.classList.add("is-hidden");
    this.el.title.classList.add("is-away");
    this.onStart?.();
    this.toast("you are in the water", "sunlight, silt, and a shelf that keeps going");
    setTimeout(() => {
      this.el.hint.style.opacity = "0.16";
    }, 20000);
  }

  setLoading(done, text = "") {
    if (text) this.el.loadingText.textContent = text;
    if (done) {
      this.el.loading.classList.add("is-done");
      setTimeout(() => {
        this.el.loading.style.display = "none";
      }, 1600);
    }
  }

  setSound(on) {
    this.el.soundState.textContent = on ? "SND—ON" : "SND—OFF";
  }

  toggleTuner(force) {
    this.tunerOpen = force ?? !this.tunerOpen;
    this.el.tuner.classList.toggle("is-open", this.tunerOpen);
    this.el.tuner.setAttribute("aria-hidden", String(!this.tunerOpen));
    if (this.tunerOpen) {
      if (document.pointerLockElement) document.exitPointerLock();
    } else if (this.started) {
      this.onRelock?.();
    }
  }

  _buildTuner() {
    for (const control of TUNE_CONTROLS) {
      const row = document.createElement("div");
      row.className = "tuner-row";
      const label = document.createElement("label");
      label.textContent = control.label;
      const output = document.createElement("output");
      const range = document.createElement("input");
      range.type = "range";
      range.min = control.min;
      range.max = control.max;
      range.step = control.step;
      const value = getPath(this.tuning, control.path);
      range.value = value;
      output.textContent = this._format(value, control.step);
      range.addEventListener("input", () => {
        const v = parseFloat(range.value);
        setPath(this.tuning, control.path, v);
        output.textContent = this._format(v, control.step);
      });
      range.addEventListener("pointerdown", () => {
        this.el.tuner.classList.add("is-scrubbing");
      });
      range.addEventListener("pointerup", () => {
        this.el.tuner.classList.remove("is-scrubbing");
      });
      row.append(label, output, range);
      this.el.tunerBody.appendChild(row);
    }
  }

  _format(v, step) {
    return step < 0.1 ? v.toFixed(2) : v.toFixed(1);
  }

  update(dt, telemetry, elapsed, underwater, speedNorm) {
    this.clock += dt;
    this.hudClock += dt;
    if (this.clock - this.uiClock > 0.1) {
      this.uiClock = this.clock;
      this._updateReadouts(telemetry, speedNorm);
      this.el.timecode.textContent = timecode(this.started ? elapsed : 0);
      const cX = Math.round(telemetry.x || 0);
      const cZ = Math.round(telemetry.z || 0);
      this.el.coords.textContent = `X ${cX >= 0 ? "+" : "−"}${String(Math.abs(cX)).padStart(4, "0")} · Z ${cZ >= 0 ? "+" : "−"}${String(Math.abs(cZ)).padStart(4, "0")}`;
      if (this.started) {
        this.el.surfaceLabel.textContent = telemetry.underwater ? "SURFACE" : "AIR";
        this.el.surfaceIndicator.classList.toggle(
          "is-visible",
          telemetry.depth < 1.35 || !telemetry.underwater
        );
      }
    }
  }

  _updateReadouts(telemetry, speedNorm) {
    const depth = Math.max(0, telemetry.depth ?? 0);
    const speed = telemetry.speed ?? 0;
    const alt = Math.max(0, telemetry.altitude ?? 0);
    const depthText = depth.toFixed(1).padStart(4, "0");
    const speedText = speed.toFixed(1);
    const altText = alt.toFixed(1).padStart(4, "0");
    if (this._cache.depth !== depthText) {
      this.el.depth.textContent = depthText;
      this._cache.depth = depthText;
    }
    if (this._cache.speed !== speedText) {
      this.el.speed.textContent = speedText;
      this.el.speedBar.style.width = `${Math.min(100, speedNorm * 100)}%`;
      this._cache.speed = speedText;
    }
    if (this._cache.alt !== altText) {
      this.el.altitude.textContent = altText;
      this._cache.alt = altText;
    }
    const heading = ((telemetry.heading ?? 0) + 360) % 360;
    const headingText = `${String(Math.round(heading) % 360).padStart(3, "0")}°`;
    if (this._cache.heading !== headingText) {
      this.el.heading.textContent = headingText;
      this.el.compassNeedle.style.transform = `rotate(${180 + heading}deg)`;
      this._cache.heading = headingText;
    }
  }

  toast(main, sub = "", duration = 4200) {
    this.el.toastMain.textContent = main;
    this.el.toastSub.textContent = sub;
    this.el.toast.classList.add("is-visible");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.el.toast.classList.remove("is-visible");
    }, duration);
  }

  boundaryToast(elapsed) {
    if (!this.started) return;
    if (elapsed - this.lastBoundaryToast < 26) return;
    this.lastBoundaryToast = elapsed;
    this.toast("edge of the surveyed shelf", "open water continues, unmeasured");
  }
}
