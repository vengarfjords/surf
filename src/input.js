/**
 * An intentionally tiny input layer. Keyboard is always available; pointer
 * lock adds snout-led mouse look/steering, and on phones the on-screen
 * controls (touch.js) write the same inputs into `touch`. The mouse deltas
 * are consumed once per simulation step so the swim feel is independent of
 * frame ordering.
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.pointerLocked = false;
    this.dragging = false;
    this.lastX = 0;
    this.lastY = 0;
    this.enabled = false;
    this.onEscape = null;
    // Written by the on-screen controls (touch.js) on phones and tablets.
    // `turn` is analog (-1 left .. +1 right); the rest are held buttons.
    this.touch = { forward: false, brake: false, turn: 0, rise: false, dive: false, boost: false };
    this._bind();
  }

  _bind() {
    window.addEventListener("keydown", (e) => {
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
      }
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.dragging = false;
      this.releaseTouch();
    });

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) this.dragging = false;
    });
    document.addEventListener("pointerlockerror", () => {
      this.pointerLocked = false;
    });

    this.canvas.addEventListener("mousedown", (e) => {
      if (!this.enabled) return;
      if (this.pointerLocked) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener("mouseup", () => {
      this.dragging = false;
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.enabled) return;
      if (this.pointerLocked) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      } else if (this.dragging) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.mouseDX += dx;
        this.mouseDY += dy;
      }
    });
  }

  requestPointerLock() {
    if (this.canvas.requestPointerLock) {
      try {
        const p = this.canvas.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      } catch (e) {
        // A drag fallback is already wired up.
      }
    }
  }

  releaseTouch() {
    const t = this.touch;
    t.forward = t.brake = t.rise = t.dive = t.boost = false;
    t.turn = 0;
  }

  consumeMouse() {
    const dx = this.mouseDX;
    const dy = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { dx, dy };
  }

  get forward() {
    return this.keys.has("KeyW") || this.touch.forward;
  }

  get brake() {
    return this.keys.has("KeyS") || this.touch.brake;
  }

  /** Turn input, -1 (left) .. +1 (right): A/D, or the touch stick's analog
   *  sideways push, so a light push carves a wide arc. */
  get turnAxis() {
    const keys = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    return Math.max(-1, Math.min(1, keys + this.touch.turn));
  }

  get left() {
    return this.keys.has("KeyA");
  }

  get right() {
    return this.keys.has("KeyD");
  }

  get rise() {
    return this.keys.has("Space") || this.touch.rise;
  }

  get dive() {
    return this.keys.has("KeyC") || this.touch.dive;
  }

  get boost() {
    return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.touch.boost;
  }

  get pitchUpKeys() {
    return this.keys.has("ArrowUp");
  }

  get pitchDownKeys() {
    return this.keys.has("ArrowDown");
  }
}
