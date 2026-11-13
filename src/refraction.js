import * as THREE from "three";

/**
 * What lies just under the surface, for the water to show through itself.
 *
 * The sea surface is drawn opaque, which used to hide a dolphin swimming a
 * metre down as completely as if it were under concrete. Before the main
 * pass, the objects on REFRACTION_LAYER (the dolphin) are drawn alone into a
 * small target with their depth. The ocean shader then looks through the
 * surface at them: bent by the ripples, dimmed and tinted by the water
 * between the surface and the body, and veiled by the light the water
 * itself scatters. Only drawn while the camera is in the air and the
 * dolphin is near enough to the surface to be seen.
 */
export const REFRACTION_LAYER = 1;

export class WaterRefraction {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.depthTexture = new THREE.DepthTexture(2, 2);
    this.target.depthTexture.type = THREE.UnsignedIntType;
    this.active = false;
    this._clear = new THREE.Color();
  }

  setSize(width, height) {
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
  }

  render(scene, camera) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this._clear);
    const prevBackground = scene.background;
    const prevMask = camera.layers.mask;
    scene.background = null;
    camera.layers.set(REFRACTION_LAYER);
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(scene, camera);
    camera.layers.mask = prevMask;
    scene.background = prevBackground;
    r.setClearColor(this._clear, prevAlpha);
    r.setRenderTarget(prevTarget);
  }
}
