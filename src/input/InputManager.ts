import type { World } from '../core/ECS';
import type { GameSystem } from '../core/Game';
import type { SceneManager } from '../rendering/SceneManager';
import { EventBus } from '../core/EventBus';

const EDGE_SCROLL_MARGIN = 10; // Pixels from edge
const ZOOM_SPEED = 5;
const ROTATE_SPEED = 0.04;

export class InputManager implements GameSystem {
  private sceneManager: SceneManager;
  private enabled = true;
  private keys = new Set<string>();
  private scrollSpeedMultiplier = 1.0;
  private mouseX = 0;
  private mouseY = 0;
  private mouseDown = false;
  private rightMouseDown = false;
  private middleMouseDown = false;
  private middleDragPrev: { x: number; y: number } | null = null;
  private dragStart: { x: number; y: number } | null = null;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('contextmenu', this.onContextMenu);
    // Clear all pressed keys when window loses focus to prevent stuck keys
    // (keyup events fire in the other window, not this one)
    window.addEventListener('blur', this.onBlur);
  }

  init(_world: World): void {}

  setScrollSpeed(multiplier: number): void {
    this.scrollSpeedMultiplier = Math.max(0.25, Math.min(2.0, multiplier));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.keys.clear();
      this.mouseDown = false;
      this.rightMouseDown = false;
      this.middleMouseDown = false;
      this.middleDragPrev = null;
      this.dragStart = null;
    }
  }

  update(_world: World, _dt: number): void {
    if (!this.enabled) return;
    let dx = 0;
    let dz = 0;
    const wasdSpeed = 2.0 * this.scrollSpeedMultiplier;
    const edgeSpeed = 1.5 * this.scrollSpeedMultiplier;

    // WASD scrolling
    if (this.keys.has('w') || this.keys.has('arrowup')) dz -= wasdSpeed;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dz += wasdSpeed;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= wasdSpeed;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += wasdSpeed;

    // Edge scrolling
    if (this.mouseX <= EDGE_SCROLL_MARGIN) dx -= edgeSpeed;
    if (this.mouseX >= window.innerWidth - EDGE_SCROLL_MARGIN) dx += edgeSpeed;
    if (this.mouseY <= EDGE_SCROLL_MARGIN) dz -= edgeSpeed;
    if (this.mouseY >= window.innerHeight - EDGE_SCROLL_MARGIN) dz += edgeSpeed;

    // Camera rotation ([ and ] keys, or Ctrl+Q/E)
    if (this.keys.has('[')) this.sceneManager.rotateCamera(-ROTATE_SPEED);
    if (this.keys.has(']')) this.sceneManager.rotateCamera(ROTATE_SPEED);

    // Scale by zoom level
    const zoomFactor = this.sceneManager.getZoom() / 80;
    dx *= zoomFactor;
    dz *= zoomFactor;

    if (dx !== 0 || dz !== 0) {
      this.sceneManager.panCamera(dx, dz);
      EventBus.emit('camera:moved', {
        x: this.sceneManager.cameraTarget.x,
        z: this.sceneManager.cameraTarget.z,
      });
    }
  }

  getMouseWorldPos(): { x: number; z: number } | null {
    const hit = this.sceneManager.screenToWorld(this.mouseX, this.mouseY);
    if (!hit) return null;
    return { x: hit.x, z: hit.z };
  }

  isKeyDown(key: string): boolean {
    return this.keys.has(key.toLowerCase());
  }

  isDragging(): boolean {
    return this.dragStart !== null && this.mouseDown;
  }

  getDragRect(): { x1: number; y1: number; x2: number; y2: number } | null {
    if (!this.dragStart || !this.mouseDown) return null;
    return {
      x1: Math.min(this.dragStart.x, this.mouseX),
      y1: Math.min(this.dragStart.y, this.mouseY),
      x2: Math.max(this.dragStart.x, this.mouseX),
      y2: Math.max(this.dragStart.y, this.mouseY),
    };
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    this.keys.add(e.key.toLowerCase());
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    this.keys.delete(e.key.toLowerCase());
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled) return;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;

    // Middle-click: pan normally, rotate if Shift held
    if (this.middleMouseDown && this.middleDragPrev) {
      if (e.shiftKey) {
        // Shift+middle-drag: rotate camera
        const rotDelta = (e.clientX - this.middleDragPrev.x) * 0.005;
        this.sceneManager.rotateCamera(rotDelta);
      } else {
        const dx = (e.clientX - this.middleDragPrev.x) * -0.5;
        const dz = (e.clientY - this.middleDragPrev.y) * -0.5;
        const zoomFactor = this.sceneManager.getZoom() / 80;
        this.sceneManager.panCamera(dx * zoomFactor, dz * zoomFactor);
      }
      this.middleDragPrev = { x: e.clientX, y: e.clientY };
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (e.button === 0) {
      this.mouseDown = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
    } else if (e.button === 1) {
      this.middleMouseDown = true;
      this.middleDragPrev = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    } else if (e.button === 2) {
      this.rightMouseDown = true;
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (e.button === 0) {
      this.mouseDown = false;
      this.dragStart = null;
    } else if (e.button === 1) {
      this.middleMouseDown = false;
      this.middleDragPrev = null;
    } else if (e.button === 2) {
      this.rightMouseDown = false;
      // Right-click handled by CommandManager
    }
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? ZOOM_SPEED : -ZOOM_SPEED;
    this.sceneManager.zoom(delta);
  };

  private onContextMenu = (e: Event): void => {
    if (!this.enabled) return;
    e.preventDefault();
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.mouseDown = false;
    this.rightMouseDown = false;
    this.middleMouseDown = false;
    this.middleDragPrev = null;
    this.dragStart = null;
  };

  /** Remove a key from the pressed set (used when ability system consumes a key) */
  consumeKey(key: string): void {
    this.keys.delete(key);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
  }
}
