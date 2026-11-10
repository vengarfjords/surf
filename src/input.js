/**
 * An intentionally tiny input layer. Keyboard is always available; pointer
 * lock adds snout-led mouse look/steering. The mouse deltas are consumed once
 * per simulation step so the swim feel is independent of frame ordering.
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
    this.touchActive = false;
    this.touchX = 0;
    this.touchY = 0;
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

    // Mobile fallback: dragging steers; a held double-tap/HUD button is outside
    // this prototype's scope, but the world remains inspectable on touch.
    this.canvas.addEventListener("touchstart", (e) => {
      if (!this.enabled) return;
      const t = e.touches[0];
      this.touchActive = true;
      this.lastX = t.clientX;
      this.lastY = t.clientY;
    }, { passive: true });
    this.canvas.addEventListener("touchmove", (e) => {
      if (!this.enabled || !this.touchActive) return;
      const t = e.touches[0];
      this.mouseDX += (t.clientX - this.lastX) * 1.2;
      this.mouseDY += (t.clientY - this.lastY) * 1.2;
      this.lastX = t.clientX;
      this.lastY = t.clientY;
    }, { passive: true });
    this.canvas.addEventListener("touchend", () => {
      this.touchActive = false;
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

  consumeMouse() {
    const dx = this.mouseDX;
    const dy = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { dx, dy };
  }

  get forward() {
    // On touch devices, keeping a finger down keeps the dolphin gliding;
    // horizontal/vertical drag steers the body.
    return this.keys.has("KeyW") || this.touchActive;
  }

  get brake() {
    return this.keys.has("KeyS");
  }

  get left() {
    return this.keys.has("KeyA");
  }

  get right() {
    return this.keys.has("KeyD");
  }

  get rise() {
    return this.keys.has("Space");
  }

  get dive() {
    return this.keys.has("KeyC");
  }

  get boost() {
    return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
  }

  get pitchUpKeys() {
    return this.keys.has("ArrowUp");
  }

  get pitchDownKeys() {
    return this.keys.has("ArrowDown");
  }
}
