import { TUNING } from "./config.js";

/**
 * On-screen controls for phones and tablets. They mirror the keyboard and
 * mouse one to one, so the swim feel tuned on the desktop carries over:
 *
 *   left thumb   a floating stick, wherever the thumb lands on the left side:
 *                push up to swim (W), sideways to turn (A/D, analog), pull
 *                back to brake (S)
 *   right thumb  drag anywhere to steer the snout, like the mouse (or, as an
 *                option, a second stick that keeps turning while held)
 *   SURF         hold to rise and ride the surface, let go to leap (Space)
 *   SURGE        hold to surge; pressed fresh in the air, tucks into a dive
 *                (Shift)
 *   DOWN         hold to go down (C)
 *
 * A thumb on a button can still drag to steer, so you can hold SURGE and
 * aim with the same thumb. Pointer events track each finger separately.
 */

/** Phones and tablets without a mouse, or any device with ?touch. */
export function detectTouchMode() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("touch")) return params.get("touch") !== "0";
  const mq = (q) => window.matchMedia?.(q).matches;
  return !!(mq("(pointer: coarse)") && !mq("(any-pointer: fine)")) || (navigator.maxTouchPoints > 0 && !mq("(hover: hover)"));
}

const BUTTONS = [
  { act: "rise", cls: "surf", label: "surf", sub: "let go · leap" },
  { act: "boost", cls: "surge", label: "surge", sub: "air · tuck" },
  { act: "dive", cls: "down", label: "down", sub: "" },
];

// How far (CSS px) a thumb on a button must move before it also steers, so
// pressing a button never nudges the snout.
const BUTTON_DRAG_SLOP = 14;

export class TouchControls {
  constructor({ input, hud, stage = document.getElementById("stage") }) {
    this.input = input;
    this.hud = hud;
    this.stage = stage;
    this.active = false;
    // pointerId -> { kind: "stick" | "look" | "button", ... }
    this.pointers = new Map();
    this.stick = null;
    this.look = null;
    this.held = { rise: 0, boost: 0, dive: 0 };
    this.fpsFrames = 0;
    this.fpsStart = 0;
    this.learnTimer = null;
    document.body.classList.add("touch");
    this._build();
    this._bind();
    this._retext();
  }

  _build() {
    const layer = document.createElement("div");
    layer.className = "touch-layer";
    layer.id = "touchLayer";

    const stick = document.createElement("div");
    stick.className = "touch-stick";
    stick.innerHTML =
      '<span class="stick-base"></span><span class="stick-knob"></span>' +
      '<span class="stick-tag stick-up">swim</span><span class="stick-tag stick-left">turn</span>' +
      '<span class="stick-tag stick-right">turn</span><span class="stick-tag stick-down">brake</span>';
    layer.appendChild(stick);

    const lookTag = document.createElement("div");
    lookTag.className = "touch-look-tag";
    lookTag.textContent = "drag to steer";
    layer.appendChild(lookTag);

    const pad = document.createElement("div");
    pad.className = "touch-pad";
    this.buttons = {};
    for (const b of BUTTONS) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `touch-btn touch-${b.cls}`;
      el.dataset.act = b.act;
      el.innerHTML = `<span>${b.label}</span>${b.sub ? `<small>${b.sub}</small>` : ""}`;
      pad.appendChild(el);
      this.buttons[b.act] = el;
    }
    layer.appendChild(pad);

    const menu = document.createElement("div");
    menu.className = "touch-menu";
    menu.innerHTML =
      '<span class="touch-fps" id="touchFps"></span>' +
      '<button type="button" data-menu="sound" aria-label="Sound on or off">snd</button>' +
      '<button type="button" data-menu="hud" aria-label="Show or hide the readouts">hud</button>' +
      '<button type="button" data-menu="tune" aria-label="Tuning panel">tune</button>';
    if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
      const fs = document.createElement("button");
      fs.type = "button";
      fs.dataset.menu = "fullscreen";
      fs.setAttribute("aria-label", "Full screen");
      fs.textContent = "full";
      menu.appendChild(fs);
    }
    layer.appendChild(menu);

    const rotate = document.createElement("div");
    rotate.className = "rotate-hint";
    rotate.innerHTML = '<span class="rotate-phone"></span><span>turn your phone sideways</span>';

    this.stage.appendChild(layer);
    this.stage.appendChild(rotate);
    this.layer = layer;
    this.stickEl = stick;
    this.knobEl = stick.querySelector(".stick-knob");
    this.menuEl = menu;
    this.fpsEl = menu.querySelector(".touch-fps");
  }

  /** Start screen and tuning panel wording for thumbs instead of keys. */
  _retext() {
    const caption = document.querySelector(".enter-caption");
    const sub = document.querySelector(".enter-sub");
    if (caption) caption.textContent = "tap to enter the water";
    if (sub) sub.innerHTML = "sound on · <b>left thumb</b> swims and turns · <b>right thumb</b> steers";
    const foot = document.querySelector(".tuner-foot");
    if (foot) foot.innerHTML = "changes are live · tap <b>tune</b> to close";
  }

  _bind() {
    const layer = this.layer;
    layer.addEventListener("pointerdown", (e) => this._down(e));
    layer.addEventListener("pointermove", (e) => this._move(e));
    layer.addEventListener("pointerup", (e) => this._up(e));
    layer.addEventListener("pointercancel", (e) => this._up(e));
    layer.addEventListener("lostpointercapture", (e) => this._up(e));
    // No long-press menu, text loupe or double-tap zoom on the controls.
    layer.addEventListener("contextmenu", (e) => e.preventDefault());
    for (const type of ["touchstart", "touchmove"]) {
      layer.addEventListener(type, (e) => {
        // The menu buttons still need their click.
        if (e.cancelable && !e.target.closest("[data-menu]")) e.preventDefault();
      }, { passive: false });
    }
    // Safari ignores user-scalable=no; its own pinch gesture events can be
    // cancelled.
    for (const type of ["gesturestart", "gesturechange"]) {
      document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
    document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });

    this.menuEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-menu]");
      if (!b || !this.hud.started) return;
      const what = b.dataset.menu;
      if (what === "tune") this.hud.toggleTuner();
      else if (what === "sound") b.classList.toggle("is-off", !this.hud.toggleSound());
      else if (what === "hud") b.classList.toggle("is-off", !this.hud.toggleHud());
      else if (what === "fullscreen") this.toggleFullscreen();
    });

    const release = () => this.releaseAll();
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    window.addEventListener("orientationchange", release);
  }

  setActive(on) {
    this.active = on;
    this.layer.classList.toggle("is-active", on);
    if (on) {
      this.layer.classList.add("is-learning");
      clearTimeout(this.learnTimer);
      this.learnTimer = setTimeout(() => this.layer.classList.remove("is-learning"), 16000);
    }
  }

  toggleFullscreen() {
    const doc = document;
    const el = document.documentElement;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
    } else {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      try {
        const p = req?.call(el, { navigationUI: "hide" });
        if (p && p.catch) p.catch(() => {});
      } catch (err) {
        // Not allowed here (an iPhone only takes video full screen): Add to
        // Home Screen runs the game without the browser bars instead.
      }
    }
  }

  // --- Pointers -------------------------------------------------------------

  _down(e) {
    if (!this.active || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (e.target.closest("[data-menu]")) return;
    e.preventDefault();
    try {
      this.layer.setPointerCapture(e.pointerId);
    } catch (err) {
      // Capture is a convenience; moves still arrive while over the layer.
    }
    const x = e.clientX;
    const y = e.clientY;
    const btn = e.target.closest("[data-act]");
    if (btn) {
      const act = btn.dataset.act;
      this.held[act]++;
      btn.classList.add("is-down");
      this.pointers.set(e.pointerId, { kind: "button", act, el: btn, x0: x, y0: y, x, y, dragging: false });
      this._sync();
      return;
    }
    const w = window.innerWidth;
    if (x < w * 0.45 && !this.stick) {
      const r = TUNING.touch.stickRadius;
      // The base sits where the thumb landed, kept wholly on screen.
      const cx = Math.max(r + 8, Math.min(w * 0.45, x));
      const cy = Math.max(r + 8, Math.min(window.innerHeight - r - 8, y));
      this.stick = { id: e.pointerId, cx, cy, nx: 0, ny: 0, box: this.stickEl.offsetWidth * 0.5 };
      this.pointers.set(e.pointerId, { kind: "stick" });
      this.stickEl.classList.add("is-held");
      this._stickTo(x, y);
      return;
    }
    // Anything else on the screen steers, like the mouse.
    const look = { kind: "look", x0: x, y0: y, x, y, nx: 0, ny: 0 };
    this.pointers.set(e.pointerId, look);
    if (!this.look) this.look = look;
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    if (p.kind === "stick") {
      this._stickTo(x, y);
      return;
    }
    if (p.kind === "button" && !p.dragging) {
      if (Math.hypot(x - p.x0, y - p.y0) < BUTTON_DRAG_SLOP) return;
      p.dragging = true;
      p.x = x;
      p.y = y;
      return;
    }
    const dx = x - p.x;
    const dy = y - p.y;
    p.x = x;
    p.y = y;
    if (p.kind === "look" && TUNING.touch.lookStick) {
      const r = TUNING.touch.stickRadius;
      p.nx = Math.max(-1, Math.min(1, (x - p.x0) / r));
      p.ny = Math.max(-1, Math.min(1, (y - p.y0) / r));
      return;
    }
    this._steer(dx, dy);
  }

  _up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.kind === "button") {
      this.held[p.act] = Math.max(0, this.held[p.act] - 1);
      if (!this.held[p.act]) p.el.classList.remove("is-down");
      this._sync();
    } else if (p.kind === "stick") {
      this.stick = null;
      this.stickEl.classList.remove("is-held");
      this._place(null);
      this.knobEl.style.transform = "";
      this._sync();
    } else if (p === this.look) {
      this.look = null;
      for (const q of this.pointers.values()) if (q.kind === "look") this.look = q;
    }
  }

  releaseAll() {
    this.pointers.clear();
    this.stick = null;
    this.look = null;
    this.held.rise = this.held.boost = this.held.dive = 0;
    for (const el of Object.values(this.buttons)) el.classList.remove("is-down");
    this.stickEl.classList.remove("is-held");
    this._place(null);
    this.knobEl.style.transform = "";
    this.input.releaseTouch();
  }

  _stickTo(x, y) {
    const s = this.stick;
    const r = TUNING.touch.stickRadius;
    let dx = x - s.cx;
    let dy = y - s.cy;
    const d = Math.hypot(dx, dy);
    // Past the rim the base follows the thumb, so the stick is never lost
    // off the side of it.
    if (d > r * 1.25) {
      const k = (d - r * 1.25) / d;
      s.cx += dx * k;
      s.cy += dy * k;
      dx = x - s.cx;
      dy = y - s.cy;
    }
    const m = Math.hypot(dx, dy);
    const kx = m > r ? (dx / m) * r : dx;
    const ky = m > r ? (dy / m) * r : dy;
    s.nx = kx / r;
    s.ny = -ky / r;
    this._place(s.cx - s.box, s.cy - s.box);
    this.knobEl.style.transform = `translate(${kx}px, ${ky}px)`;
    this._sync();
  }

  /** Moves the stick under the thumb, or (null) back to its resting place. */
  _place(left, top) {
    const st = this.stickEl.style;
    if (left === null) {
      st.left = st.top = st.bottom = "";
      return;
    }
    st.left = `${left}px`;
    st.top = `${top}px`;
    st.bottom = "auto";
  }

  _steer(dx, dy) {
    const t = TUNING.touch;
    this.input.mouseDX += dx * t.lookSensitivity;
    this.input.mouseDY += dy * t.lookSensitivity * (t.invertLook ? -1 : 1);
  }

  /** Writes the stick and buttons into the input the dolphin reads. */
  _sync() {
    const t = TUNING.touch;
    const out = this.input.touch;
    const s = this.stick;
    if (s) {
      const dz = t.stickDeadZone;
      const ax = Math.abs(s.nx);
      const turn = ax > dz ? Math.pow((ax - dz) / (1 - dz), t.turnCurve) : 0;
      out.turn = Math.sign(s.nx) * Math.min(1, turn);
      out.forward = s.ny > t.swimPush;
      out.brake = s.ny < -t.brakePull;
    } else {
      out.turn = 0;
      out.forward = false;
      out.brake = false;
    }
    out.rise = this.held.rise > 0;
    out.boost = this.held.boost > 0;
    out.dive = this.held.dive > 0;
    this.stickEl.classList.toggle("is-swim", out.forward);
    this.stickEl.classList.toggle("is-brake", out.brake);
  }

  /** Once per frame: the right-thumb stick, and the fps readout. */
  update(dt) {
    const now = performance.now();
    if (TUNING.touch.stickRadius !== this.radius) {
      this.radius = TUNING.touch.stickRadius;
      document.body.style.setProperty("--stick-r", `${this.radius}px`);
    }
    const look = this.look;
    if (look && TUNING.touch.lookStick && (look.nx || look.ny)) {
      const rate = TUNING.touch.lookStickRate * dt;
      const curve = (v) => Math.sign(v) * v * v;
      this._steer(curve(look.nx) * rate, curve(look.ny) * rate);
    }
    // Frames per wall-clock second (dt is capped on long frames).
    if (!this.fpsStart) this.fpsStart = now;
    this.fpsFrames++;
    const span = (now - this.fpsStart) / 1000;
    if (span >= 0.5) {
      this.fpsEl.textContent = TUNING.touch.showFps ? `${Math.round(this.fpsFrames / span)} fps` : "";
      this.fpsFrames = 0;
      this.fpsStart = now;
    }
  }
}
