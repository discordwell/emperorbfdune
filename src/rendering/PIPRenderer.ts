/**
 * Picture-in-Picture (PIP) camera system for Emperor: Battle for Dune.
 *
 * Renders a small secondary viewport (top-right) showing the scene from
 * a different camera position. Mission scripts control the PIP camera
 * via PIPCameraLookAtPoint, PIPCameraTrackObject, PIPCameraSpin, etc.
 *
 * Uses the same THREE.Scene as the main renderer but with a separate
 * PerspectiveCamera and scissor-test viewport.
 */

import * as THREE from 'three';

export interface PIPCameraSnapshot {
  x: number;
  z: number;
  zoom: number;
  rotation: number;
}

export class PIPRenderer {
  // --- Viewport dimensions and position ---
  private readonly WIDTH = 200;
  private readonly HEIGHT = 150;
  private readonly MARGIN = 8;
  private readonly BORDER_WIDTH = 2;

  // --- Three.js camera for PIP ---
  readonly camera: THREE.PerspectiveCamera;

  // Camera rig (mirrors SceneManager orbit-style)
  private readonly cameraTarget = new THREE.Vector3(55, 0, 55);
  private cameraDistance = 50;
  private cameraAngle = Math.PI * 0.44; // ~79 degrees — same as main camera
  private cameraRotation = 0;

  // Zoom limits
  private readonly MIN_ZOOM = 20;
  private readonly MAX_ZOOM = 200;

  // Smooth pan target
  private panTarget: THREE.Vector3 | null = null;
  private panSpeed = 0.12;

  // Map bounds (copied from SceneManager when set)
  private mapBoundsX = 128 * 2;
  private mapBoundsZ = 128 * 2;

  // Visibility — hidden by default, shown when scripts use PIP functions
  private _visible = false;

  // --- HTML overlay element for the PIP border/frame ---
  private overlayElement: HTMLDivElement | null = null;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(50, this.WIDTH / this.HEIGHT, 1, 2000);
    this.updateCameraPosition();
    this.createOverlayElement();
  }

  // -----------------------------------------------------------------------
  // Visibility
  // -----------------------------------------------------------------------

  get visible(): boolean {
    return this._visible;
  }

  show(): void {
    if (this._visible) return;
    this._visible = true;
    if (this.overlayElement) this.overlayElement.style.display = 'block';
  }

  hide(): void {
    if (!this._visible) return;
    this._visible = false;
    if (this.overlayElement) this.overlayElement.style.display = 'none';
  }

  // -----------------------------------------------------------------------
  // Camera controls (independent from main camera)
  // -----------------------------------------------------------------------

  /** Smoothly pan the PIP camera to a world position */
  panTo(x: number, z: number): void {
    this.show();
    const cx = Math.max(-20, Math.min(this.mapBoundsX + 20, x));
    const cz = Math.max(-20, Math.min(this.mapBoundsZ + 20, z));
    this.panTarget = new THREE.Vector3(cx, 0, cz);
  }

  /** Instantly snap PIP camera (cancels any smooth pan) */
  snapTo(x: number, z: number): void {
    this.show();
    this.panTarget = null;
    const cx = Math.max(-20, Math.min(this.mapBoundsX + 20, x));
    const cz = Math.max(-20, Math.min(this.mapBoundsZ + 20, z));
    this.cameraTarget.set(cx, 0, cz);
    this.updateCameraPosition();
  }

  /** Get current PIP camera target position */
  getCameraTarget(): { x: number; z: number } {
    return { x: this.cameraTarget.x, z: this.cameraTarget.z };
  }

  zoom(delta: number): void {
    this.cameraDistance = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.cameraDistance + delta));
    this.updateCameraPosition();
  }

  getZoom(): number {
    return this.cameraDistance;
  }

  setZoom(zoom: number): void {
    this.cameraDistance = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, zoom));
    this.updateCameraPosition();
  }

  rotateCamera(delta: number): void {
    const TWO_PI = Math.PI * 2;
    this.cameraRotation = ((this.cameraRotation + delta) % TWO_PI + TWO_PI) % TWO_PI;
    this.updateCameraPosition();
  }

  getCameraRotation(): number {
    return this.cameraRotation;
  }

  setRotation(rotation: number): void {
    const TWO_PI = Math.PI * 2;
    this.cameraRotation = ((rotation % TWO_PI) + TWO_PI) % TWO_PI;
    this.updateCameraPosition();
  }

  isPanning(): boolean {
    return this.panTarget !== null;
  }

  setMapBounds(worldW: number, worldH: number): void {
    this.mapBoundsX = worldW;
    this.mapBoundsZ = worldH;
  }

  // -----------------------------------------------------------------------
  // Capture / Restore for PIPCameraStore / PIPCameraRestore
  // -----------------------------------------------------------------------

  captureState(): PIPCameraSnapshot {
    return {
      x: this.cameraTarget.x,
      z: this.cameraTarget.z,
      zoom: this.cameraDistance,
      rotation: this.cameraRotation,
    };
  }

  restoreState(snap: PIPCameraSnapshot): void {
    this.show();
    this.panTarget = null;
    this.cameraTarget.set(snap.x, 0, snap.z);
    this.cameraDistance = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, snap.zoom));
    this.cameraRotation = snap.rotation;
    this.updateCameraPosition();
  }

  // -----------------------------------------------------------------------
  // Per-frame update — called from SceneManager.render()
  // -----------------------------------------------------------------------

  /** Advance smooth pan animation. Returns true if camera moved. */
  updatePan(): boolean {
    if (!this.panTarget) return false;
    this.cameraTarget.lerp(this.panTarget, this.panSpeed);
    const dist = this.cameraTarget.distanceTo(this.panTarget);
    if (dist < 0.5) {
      this.cameraTarget.copy(this.panTarget);
      this.panTarget = null;
    }
    this.updateCameraPosition();
    return true;
  }

  // -----------------------------------------------------------------------
  // Render the PIP viewport using scissor test
  // -----------------------------------------------------------------------

  /**
   * Renders the PIP viewport into the given renderer, using the same scene.
   * Must be called AFTER the main scene render.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    if (!this._visible) return;

    // Advance smooth pan
    this.updatePan();

    const canvas = renderer.domElement;
    const pixelRatio = renderer.getPixelRatio();
    const canvasW = canvas.width;
    const canvasH = canvas.height;

    // Viewport in framebuffer pixels (top-right, accounting for sidebar width 200px)
    const sidebarWidth = 200;
    const vpW = Math.round(this.WIDTH * pixelRatio);
    const vpH = Math.round(this.HEIGHT * pixelRatio);
    const vpX = canvasW - Math.round((sidebarWidth + this.WIDTH + this.MARGIN) * pixelRatio);
    // Y is from bottom in GL coordinates; place below resource bar (32px)
    const resourceBarHeight = 32;
    const vpY = canvasH - Math.round((resourceBarHeight + this.MARGIN + this.HEIGHT) * pixelRatio);

    // Save current renderer state
    const currentScissorTest = renderer.getScissorTest();
    const currentViewport = new THREE.Vector4();
    const currentScissor = new THREE.Vector4();
    renderer.getViewport(currentViewport);
    renderer.getScissor(currentScissor);

    // Set scissor and viewport for PIP
    renderer.setScissorTest(true);
    renderer.setViewport(vpX, vpY, vpW, vpH);
    renderer.setScissor(vpX, vpY, vpW, vpH);

    // Clear depth so PIP renders on top
    renderer.clearDepth();

    // Render scene with PIP camera
    renderer.render(scene, this.camera);

    // Restore previous renderer state
    renderer.setViewport(currentViewport);
    renderer.setScissor(currentScissor);
    renderer.setScissorTest(currentScissorTest);
  }

  // -----------------------------------------------------------------------
  // Release — hide PIP and reset state
  // -----------------------------------------------------------------------

  release(): void {
    this.hide();
    this.panTarget = null;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private updateCameraPosition(): void {
    const offset = new THREE.Vector3(
      Math.sin(this.cameraRotation) * Math.cos(this.cameraAngle) * this.cameraDistance,
      Math.sin(this.cameraAngle) * this.cameraDistance,
      Math.cos(this.cameraRotation) * Math.cos(this.cameraAngle) * this.cameraDistance,
    );
    this.camera.position.copy(this.cameraTarget).add(offset);
    this.camera.lookAt(this.cameraTarget);
  }

  /** Create the HTML overlay element that draws the PIP border */
  private createOverlayElement(): void {
    const overlay = document.getElementById('ui-overlay');
    if (!overlay) return;

    const el = document.createElement('div');
    el.id = 'pip-viewport';
    el.style.cssText = `
      position: absolute;
      top: ${32 + this.MARGIN}px;
      right: ${200 + this.MARGIN}px;
      width: ${this.WIDTH}px;
      height: ${this.HEIGHT}px;
      border: ${this.BORDER_WIDTH}px solid #f0c040;
      box-shadow: 0 0 8px rgba(240, 192, 64, 0.4), inset 0 0 4px rgba(0, 0, 0, 0.5);
      pointer-events: none;
      z-index: 12;
      display: none;
    `;

    // Label
    const label = document.createElement('div');
    label.style.cssText = `
      position: absolute;
      bottom: 2px;
      left: 4px;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      font-size: 9px;
      color: #f0c040;
      letter-spacing: 1px;
      text-transform: uppercase;
      opacity: 0.7;
    `;
    label.textContent = 'PIP';
    el.appendChild(label);

    overlay.appendChild(el);
    this.overlayElement = el;
  }

  dispose(): void {
    if (this.overlayElement) {
      this.overlayElement.remove();
      this.overlayElement = null;
    }
  }
}
