import type { World } from '../core/ECS';
import type { GameSystem } from '../core/Game';
import type { SceneManager } from '../rendering/SceneManager';
import { EventBus } from '../core/EventBus';

const EDGE_SCROLL_MARGIN = 10; // Pixels from edge
const EDGE_SCROLL_SPEED = 1.5;
const WASD_SCROLL_SPEED = 2.0;
const ZOOM_SPEED = 5;

export class InputManager implements GameSystem {
  private sceneManager: SceneManager;
  private keys = new Set<string>();
  private mouseX = 0;
  private mouseY = 0;
  private mouseDown = false;
  private rightMouseDown = false;
  private dragStart: { x: number; y: number } | null = null;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('contextmenu', e => e.preventDefault());
  }

  init(_world: World): void {}

  update(_world: World, _dt: number): void {
    let dx = 0;
    let dz = 0;

    // WASD scrolling
    if (this.keys.has('w') || this.keys.has('arrowup')) dz -= WASD_SCROLL_SPEED;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dz += WASD_SCROLL_SPEED;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= WASD_SCROLL_SPEED;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += WASD_SCROLL_SPEED;

    // Edge scrolling
    if (this.mouseX <= EDGE_SCROLL_MARGIN) dx -= EDGE_SCROLL_SPEED;
    if (this.mouseX >= window.innerWidth - EDGE_SCROLL_MARGIN) dx += EDGE_SCROLL_SPEED;
    if (this.mouseY <= EDGE_SCROLL_MARGIN) dz -= EDGE_SCROLL_SPEED;
    if (this.mouseY >= window.innerHeight - EDGE_SCROLL_MARGIN) dz += EDGE_SCROLL_SPEED;

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
    this.keys.add(e.key.toLowerCase());
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onMouseMove = (e: MouseEvent): void => {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseDown = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
    } else if (e.button === 2) {
      this.rightMouseDown = true;
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseDown = false;
      this.dragStart = null;
    } else if (e.button === 2) {
      this.rightMouseDown = false;
      // Right-click handled by CommandManager
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? ZOOM_SPEED : -ZOOM_SPEED;
    this.sceneManager.zoom(delta);
  };
}
