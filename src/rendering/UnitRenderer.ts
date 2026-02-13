import * as THREE from 'three';
import type { SceneManager } from './SceneManager';
import type { ModelManager, LoadedModel } from './ModelManager';
import type { ArtEntry } from '../config/ArtIniParser';
import {
  Position, Rotation, Renderable, Health, Selectable, Owner,
  renderQuery, renderEnter, renderExit,
  type World,
} from '../core/ECS';

// House colors for team tinting
const HOUSE_COLORS: THREE.Color[] = [
  new THREE.Color(0x0085E2), // 0: Atreides blue
  new THREE.Color(0xAF2416), // 1: Harkonnen red
  new THREE.Color(0x92FDCA), // 2: Ordos green
  new THREE.Color(0xFF7919), // 3: Ix orange
  new THREE.Color(0x40FF00), // 4: Tleilaxu lime
  new THREE.Color(0x7F48BD), // 5: Fremen purple
  new THREE.Color(0xFFF06A), // 6: Imperial yellow
  new THREE.Color(0xFFA3E0), // 7: Guild pink
];

export class UnitRenderer {
  private sceneManager: SceneManager;
  private modelManager: ModelManager;
  private artMap: Map<string, ArtEntry>;

  // Map entity ID -> Three.js Group
  private entityObjects = new Map<number, THREE.Group>();
  // Selection circles
  private selectionCircles = new Map<number, THREE.Mesh>();
  // Health bars
  private healthBars = new Map<number, THREE.Sprite>();

  // Preloaded model templates keyed by xaf name
  private modelTemplates = new Map<string, LoadedModel>();

  constructor(sceneManager: SceneManager, modelManager: ModelManager, artMap: Map<string, ArtEntry>) {
    this.sceneManager = sceneManager;
    this.modelManager = modelManager;
    this.artMap = artMap;
  }

  async preloadModels(unitTypeNames: string[]): Promise<void> {
    const promises: Promise<void>[] = [];
    const loaded = new Set<string>();

    for (const typeName of unitTypeNames) {
      const art = this.artMap.get(typeName);
      if (!art?.xaf || loaded.has(art.xaf)) continue;
      loaded.add(art.xaf);

      promises.push(
        this.modelManager.loadModel(art.xaf, 'H0').then(model => {
          if (model) this.modelTemplates.set(art.xaf, model);
        })
      );
    }

    await Promise.allSettled(promises);
    console.log(`Preloaded ${this.modelTemplates.size} unit model templates`);
  }

  update(world: World): void {
    // Handle new renderable entities
    const entered = renderEnter(world);
    for (const eid of entered) {
      this.createVisual(eid);
    }

    // Handle removed entities
    const exited = renderExit(world);
    for (const eid of exited) {
      this.removeVisual(eid);
    }

    // Sync positions
    const entities = renderQuery(world);
    for (const eid of entities) {
      const obj = this.entityObjects.get(eid);
      if (!obj) continue;

      obj.position.set(
        Position.x[eid],
        Position.y[eid],
        Position.z[eid],
      );
      obj.rotation.y = Rotation.y[eid];

      // Update selection circle visibility
      const circle = this.selectionCircles.get(eid);
      if (circle) {
        circle.visible = Selectable.selected[eid] === 1;
      }

      // Update health bar
      this.updateHealthBar(eid);
    }
  }

  private createVisual(eid: number): void {
    const modelId = Renderable.modelId[eid];
    // modelId is an index; we'll use a lookup from a name registry
    // For now, create a placeholder if no model loaded
    const group = this.createPlaceholder(eid);
    group.position.set(Position.x[eid], Position.y[eid], Position.z[eid]);
    group.rotation.y = Rotation.y[eid];

    this.entityObjects.set(eid, group);
    this.sceneManager.scene.add(group);

    // Selection circle (green ring, hidden by default)
    const circleGeo = new THREE.RingGeometry(0.8, 1.0, 24);
    circleGeo.rotateX(-Math.PI / 2);
    const circleMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide });
    const circle = new THREE.Mesh(circleGeo, circleMat);
    circle.position.y = 0.05;
    circle.visible = false;
    group.add(circle);
    this.selectionCircles.set(eid, circle);
  }

  private createPlaceholder(eid: number): THREE.Group {
    const group = new THREE.Group();
    const ownerId = Owner.playerId[eid];
    const color = HOUSE_COLORS[ownerId] ?? HOUSE_COLORS[0];

    // Simple box placeholder
    const geo = new THREE.BoxGeometry(1.2, 1.0, 1.2);
    const mat = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.5;
    mesh.castShadow = true;
    group.add(mesh);

    return group;
  }

  setEntityModel(eid: number, xafName: string): void {
    const template = this.modelTemplates.get(xafName);
    if (!template) return;

    const existing = this.entityObjects.get(eid);
    if (!existing) return;

    // Remove placeholder children (keep selection circle)
    const circle = this.selectionCircles.get(eid);
    while (existing.children.length > 0) {
      const child = existing.children[0];
      existing.remove(child);
    }

    // Add cloned model
    const clone = this.modelManager.cloneModel(template);
    // Scale models down - game models are large
    clone.scale.setScalar(0.02);
    existing.add(clone);

    // Re-add selection circle
    if (circle) {
      existing.add(circle);
    }

    // Apply team color
    const ownerId = Owner.playerId[eid];
    const color = HOUSE_COLORS[ownerId] ?? HOUSE_COLORS[0];
    clone.traverse(child => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
        // Tint the model slightly with team color
        child.material.color.lerp(color, 0.3);
      }
    });
  }

  private updateHealthBar(eid: number): void {
    if (Health.max[eid] <= 0) return;
    const ratio = Health.current[eid] / Health.max[eid];
    if (ratio >= 1) {
      // Full health, hide bar
      const bar = this.healthBars.get(eid);
      if (bar) bar.visible = false;
      return;
    }

    let bar = this.healthBars.get(eid);
    if (!bar) {
      bar = this.createHealthBar();
      const obj = this.entityObjects.get(eid);
      if (obj) {
        obj.add(bar);
        bar.position.y = 2.0;
      }
      this.healthBars.set(eid, bar);
    }

    bar.visible = true;
    // Color based on health: green->yellow->red
    const color = ratio > 0.5
      ? new THREE.Color(0x00ff00).lerp(new THREE.Color(0xffff00), 1 - (ratio - 0.5) * 2)
      : new THREE.Color(0xffff00).lerp(new THREE.Color(0xff0000), 1 - ratio * 2);
    (bar.material as THREE.SpriteMaterial).color = color;
    bar.scale.set(ratio * 1.5, 0.15, 1);
  }

  private createHealthBar(): THREE.Sprite {
    const mat = new THREE.SpriteMaterial({ color: 0x00ff00 });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.5, 0.15, 1);
    return sprite;
  }

  private removeVisual(eid: number): void {
    const obj = this.entityObjects.get(eid);
    if (obj) {
      this.sceneManager.scene.remove(obj);
      this.entityObjects.delete(eid);
    }
    this.selectionCircles.delete(eid);
    this.healthBars.delete(eid);
  }

  getEntityAtScreen(screenX: number, screenY: number): number | null {
    const ndc = new THREE.Vector2(
      (screenX / window.innerWidth) * 2 - 1,
      -(screenY / window.innerHeight) * 2 + 1
    );
    this.sceneManager.raycaster.setFromCamera(ndc, this.sceneManager.camera);

    // Collect all meshes
    const meshes: THREE.Object3D[] = [];
    for (const [, obj] of this.entityObjects) {
      obj.traverse(child => {
        if (child instanceof THREE.Mesh) meshes.push(child);
      });
    }

    const intersects = this.sceneManager.raycaster.intersectObjects(meshes, false);
    if (intersects.length === 0) return null;

    // Find which entity owns this mesh
    const hitObj = intersects[0].object;
    for (const [eid, obj] of this.entityObjects) {
      let found = false;
      obj.traverse(child => {
        if (child === hitObj) found = true;
      });
      if (found) return eid;
    }

    return null;
  }

  getEntityObject(eid: number): THREE.Group | undefined {
    return this.entityObjects.get(eid);
  }
}
