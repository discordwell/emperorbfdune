import * as THREE from 'three';
import type { World } from '../core/ECS';
import { Position, Selectable, Owner, selectableQuery } from '../core/ECS';
import type { SceneManager } from '../rendering/SceneManager';
import type { UnitRenderer } from '../rendering/UnitRenderer';
import { EventBus } from '../core/EventBus';

export class SelectionManager {
  private sceneManager: SceneManager;
  private unitRenderer: UnitRenderer;
  private selectedEntities: number[] = [];

  // Drag selection box
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private dragEnd = { x: 0, y: 0 };
  private dragBox: HTMLDivElement;

  // Player ID (local player)
  private localPlayerId = 0;

  constructor(sceneManager: SceneManager, unitRenderer: UnitRenderer) {
    this.sceneManager = sceneManager;
    this.unitRenderer = unitRenderer;

    // Create selection box overlay
    this.dragBox = document.createElement('div');
    this.dragBox.style.cssText = 'position:fixed;border:1px solid #0f0;background:rgba(0,255,0,0.1);pointer-events:none;display:none;z-index:50;';
    document.body.appendChild(this.dragBox);

    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  getSelectedEntities(): number[] {
    return this.selectedEntities;
  }

  clearSelection(world: World): void {
    for (const eid of this.selectedEntities) {
      Selectable.selected[eid] = 0;
    }
    this.selectedEntities = [];
    EventBus.emit('unit:deselected', {});
  }

  selectEntities(world: World, eids: number[]): void {
    this.clearSelection(world);
    for (const eid of eids) {
      // Only select own units
      if (Owner.playerId[eid] !== this.localPlayerId) continue;
      Selectable.selected[eid] = 1;
      this.selectedEntities.push(eid);
    }
    if (this.selectedEntities.length > 0) {
      EventBus.emit('unit:selected', { entityIds: [...this.selectedEntities] });
    }
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    // Ignore clicks on UI
    if (this.isOverUI(e.clientX, e.clientY)) return;

    this.isDragging = true;
    this.dragStart.x = e.clientX;
    this.dragStart.y = e.clientY;
    this.dragEnd.x = e.clientX;
    this.dragEnd.y = e.clientY;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isDragging) return;
    this.dragEnd.x = e.clientX;
    this.dragEnd.y = e.clientY;

    const dx = Math.abs(this.dragEnd.x - this.dragStart.x);
    const dy = Math.abs(this.dragEnd.y - this.dragStart.y);

    if (dx > 5 || dy > 5) {
      this.dragBox.style.display = 'block';
      this.dragBox.style.left = Math.min(this.dragStart.x, this.dragEnd.x) + 'px';
      this.dragBox.style.top = Math.min(this.dragStart.y, this.dragEnd.y) + 'px';
      this.dragBox.style.width = dx + 'px';
      this.dragBox.style.height = dy + 'px';
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 0 || !this.isDragging) return;
    this.isDragging = false;
    this.dragBox.style.display = 'none';

    if (this.isOverUI(e.clientX, e.clientY)) return;

    const dx = Math.abs(this.dragEnd.x - this.dragStart.x);
    const dy = Math.abs(this.dragEnd.y - this.dragStart.y);

    if (dx > 5 || dy > 5) {
      // Box select
      this.boxSelect(e);
    } else {
      // Click select
      this.clickSelect(e);
    }
  };

  private clickSelect(e: MouseEvent): void {
    const eid = this.unitRenderer.getEntityAtScreen(e.clientX, e.clientY);
    if (eid !== null) {
      // Get the world from the global game reference
      const world = (window as any).game?.getWorld();
      if (world) {
        this.selectEntities(world, [eid]);
      }
    } else {
      const world = (window as any).game?.getWorld();
      if (world) this.clearSelection(world);
    }
  }

  private boxSelect(_e: MouseEvent): void {
    const world = (window as any).game?.getWorld();
    if (!world) return;

    const minX = Math.min(this.dragStart.x, this.dragEnd.x);
    const maxX = Math.max(this.dragStart.x, this.dragEnd.x);
    const minY = Math.min(this.dragStart.y, this.dragEnd.y);
    const maxY = Math.max(this.dragStart.y, this.dragEnd.y);

    const entities = selectableQuery(world);
    const selected: number[] = [];

    for (const eid of entities) {
      // Project entity world position to screen
      const worldPos = new THREE.Vector3(Position.x[eid], Position.y[eid], Position.z[eid]);
      const screenPos = worldPos.project(this.sceneManager.camera);
      const sx = (screenPos.x + 1) / 2 * window.innerWidth;
      const sy = (-screenPos.y + 1) / 2 * window.innerHeight;

      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
        selected.push(eid);
      }
    }

    this.selectEntities(world, selected);
  }

  private isOverUI(x: number, y: number): boolean {
    // Check if click is on sidebar (right 200px), minimap (bottom-left 200x200), or resource bar (top 32px)
    if (y < 32) return true; // Resource bar
    if (x > window.innerWidth - 200) return true; // Sidebar
    if (x < 200 && y > window.innerHeight - 200) return true; // Minimap
    return false;
  }
}
