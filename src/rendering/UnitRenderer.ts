import * as THREE from 'three';
import type { SceneManager } from './SceneManager';
import type { ModelManager, LoadedModel } from './ModelManager';
import type { ArtEntry } from '../config/ArtIniParser';
import {
  Position, Rotation, Renderable, Health, Selectable, Owner,
  BuildingType, Veterancy, hasComponent,
  renderQuery, renderEnter, renderExit,
  type World,
} from '../core/ECS';
import type { FogOfWar } from './FogOfWar';
import { worldToTile } from '../utils/MathUtils';

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
  // Veterancy rank sprites
  private rankSprites = new Map<number, THREE.Sprite>();

  // Preloaded model templates keyed by xaf name
  private modelTemplates = new Map<string, LoadedModel>();
  // Pending model assignments for entities not yet visualized
  private pendingModels = new Map<number, { xafName: string; scale: number }>();
  // Current ECS world reference (set during update)
  private currentWorld: World | null = null;
  private fogOfWar: FogOfWar | null = null;
  private localPlayerId = 0;
  // Construction animation: eid -> { progress 0..1, duration ticks }
  private constructing = new Map<number, { progress: number; duration: number }>();

  constructor(sceneManager: SceneManager, modelManager: ModelManager, artMap: Map<string, ArtEntry>) {
    this.sceneManager = sceneManager;
    this.modelManager = modelManager;
    this.artMap = artMap;
  }

  setFogOfWar(fog: FogOfWar, localPlayerId = 0): void {
    this.fogOfWar = fog;
    this.localPlayerId = localPlayerId;
  }

  /** Mark a building as under construction — will animate from scaffold to solid */
  startConstruction(eid: number, durationTicks: number): void {
    this.constructing.set(eid, { progress: 0, duration: Math.max(1, durationTicks) });
    // Start with scaffold appearance
    const obj = this.entityObjects.get(eid);
    if (obj) {
      obj.scale.setScalar(0.5);
      obj.traverse(child => {
        if (child instanceof THREE.Mesh && child.material) {
          const mat = child.material as THREE.Material;
          mat.transparent = true;
          mat.opacity = 0.3;
        }
      });
    }
  }

  /** Advance construction animation by one tick */
  tickConstruction(): void {
    for (const [eid, state] of this.constructing) {
      state.progress += 1 / state.duration;
      if (state.progress >= 1) {
        state.progress = 1;
        this.constructing.delete(eid);
      }
      const obj = this.entityObjects.get(eid);
      if (!obj) continue;

      const t = state.progress;
      // Scale from 0.5 -> 1.0
      const s = 0.5 + t * 0.5;
      obj.scale.setScalar(s);
      // Opacity from 0.3 -> 1.0
      const opacity = 0.3 + t * 0.7;
      obj.traverse(child => {
        if (child instanceof THREE.Mesh && child.material) {
          const mat = child.material as THREE.Material;
          if (t >= 1) {
            mat.transparent = false;
            mat.opacity = 1;
          } else {
            mat.transparent = true;
            mat.opacity = opacity;
          }
        }
      });
    }
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

  async preloadBuildingModels(buildingTypeNames: string[]): Promise<void> {
    const promises: Promise<void>[] = [];
    const loaded = new Set<string>();

    for (const typeName of buildingTypeNames) {
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
    console.log(`Preloaded ${this.modelTemplates.size} total model templates (units + buildings)`);
  }

  update(world: World): void {
    this.currentWorld = world;
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

      // Fog of war: hide enemy entities in non-visible tiles
      if (this.fogOfWar && this.fogOfWar.isEnabled() && Owner.playerId[eid] !== this.localPlayerId) {
        const tile = worldToTile(Position.x[eid], Position.z[eid]);
        obj.visible = this.fogOfWar.isTileVisible(tile.tx, tile.tz);
      } else {
        obj.visible = true;
      }

      // Update selection circle visibility
      const circle = this.selectionCircles.get(eid);
      if (circle) {
        circle.visible = Selectable.selected[eid] === 1 && obj.visible;
      }

      // Update health bar
      this.updateHealthBar(eid);

      // Update veterancy indicator
      this.updateRankSprite(eid);
    }
  }

  private createVisual(eid: number): void {
    const isBuilding = this.currentWorld != null && hasComponent(this.currentWorld, BuildingType, eid);
    const group = this.createPlaceholder(eid, isBuilding);
    group.position.set(Position.x[eid], Position.y[eid], Position.z[eid]);
    group.rotation.y = Rotation.y[eid];

    this.entityObjects.set(eid, group);
    this.sceneManager.scene.add(group);

    // Selection circle (green ring, hidden by default) — larger for buildings
    const innerR = isBuilding ? 2.0 : 0.8;
    const outerR = isBuilding ? 2.4 : 1.0;
    const circleGeo = new THREE.RingGeometry(innerR, outerR, 24);
    circleGeo.rotateX(-Math.PI / 2);
    const circleMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide });
    const circle = new THREE.Mesh(circleGeo, circleMat);
    circle.position.y = 0.05;
    circle.visible = false;
    group.add(circle);
    this.selectionCircles.set(eid, circle);

    // Apply pending model if setEntityModel was called before visual existed
    const pending = this.pendingModels.get(eid);
    if (pending) {
      this.pendingModels.delete(eid);
      this.setEntityModel(eid, pending.xafName, pending.scale);
    }
  }

  private createPlaceholder(eid: number, isBuilding: boolean = false): THREE.Group {
    const group = new THREE.Group();
    const ownerId = Owner.playerId[eid];
    const color = HOUSE_COLORS[ownerId] ?? HOUSE_COLORS[0];

    if (isBuilding) {
      // Larger box placeholder for buildings
      const geo = new THREE.BoxGeometry(3, 2, 3);
      const mat = new THREE.MeshLambertMaterial({ color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = 1.0;
      mesh.castShadow = true;
      group.add(mesh);
    } else {
      // Small box placeholder for units
      const geo = new THREE.BoxGeometry(1.2, 1.0, 1.2);
      const mat = new THREE.MeshLambertMaterial({ color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = 0.5;
      mesh.castShadow = true;
      group.add(mesh);
    }

    return group;
  }

  setEntityModel(eid: number, xafName: string, scale: number = 0.02): void {
    const template = this.modelTemplates.get(xafName);
    if (!template) {
      // No template loaded — store pending in case model loads later
      this.pendingModels.set(eid, { xafName, scale });
      return;
    }

    const existing = this.entityObjects.get(eid);
    if (!existing) {
      // Visual not yet created — defer until createVisual runs
      this.pendingModels.set(eid, { xafName, scale });
      return;
    }

    // Remove placeholder children (keep selection circle)
    const circle = this.selectionCircles.get(eid);
    while (existing.children.length > 0) {
      const child = existing.children[0];
      existing.remove(child);
    }

    // Add cloned model
    const clone = this.modelManager.cloneModel(template);
    clone.scale.setScalar(scale);
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
    const isSelected = Selectable.selected[eid] === 1;
    if (ratio >= 1 && !isSelected) {
      // Full health and not selected, hide bar
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

  private updateRankSprite(eid: number): void {
    if (!this.currentWorld || !hasComponent(this.currentWorld, Veterancy, eid)) return;
    const rank = Veterancy.rank[eid];
    if (rank === 0) {
      const existing = this.rankSprites.get(eid);
      if (existing) existing.visible = false;
      return;
    }

    let sprite = this.rankSprites.get(eid);
    if (!sprite) {
      // Gold chevron/star for rank
      const mat = new THREE.SpriteMaterial({ color: 0xffd700 });
      sprite = new THREE.Sprite(mat);
      const obj = this.entityObjects.get(eid);
      if (obj) {
        obj.add(sprite);
        sprite.position.y = 2.5;
      }
      this.rankSprites.set(eid, sprite);
    }

    sprite.visible = true;
    // Scale stars by rank: 1=small, 2=medium, 3=large
    const size = 0.2 + rank * 0.1;
    sprite.scale.set(size * rank, size, 1);
    // Color by rank: bronze -> silver -> gold
    const colors = [0, 0xCD7F32, 0xC0C0C0, 0xFFD700];
    (sprite.material as THREE.SpriteMaterial).color.setHex(colors[rank] ?? 0xFFD700);
  }

  private removeVisual(eid: number): void {
    const obj = this.entityObjects.get(eid);
    if (obj) {
      this.sceneManager.scene.remove(obj);
      this.entityObjects.delete(eid);
    }
    this.selectionCircles.delete(eid);
    this.healthBars.delete(eid);
    this.rankSprites.delete(eid);
    this.pendingModels.delete(eid);
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
