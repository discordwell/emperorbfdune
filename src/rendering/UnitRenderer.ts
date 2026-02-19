import * as THREE from 'three';
import type { SceneManager } from './SceneManager';
import type { ModelManager, LoadedModel } from './ModelManager';
import type { ArtEntry } from '../config/ArtIniParser';
import {
  Position, Rotation, Renderable, Health, Selectable, Owner,
  BuildingType, UnitType, MoveTarget, Veterancy, Combat, TurretRotation, AttackTarget, hasComponent,
  renderQuery, renderEnter, renderExit,
  type World,
} from '../core/ECS';
import type { FogOfWar } from './FogOfWar';
import { worldToTile } from '../utils/MathUtils';

// Animation state tracking
type AnimState = 'idle' | 'move' | 'fire' | 'explode' | 'idle2';

interface EntityAnimData {
  mixer: THREE.AnimationMixer;
  clips: Map<string, THREE.AnimationClip>;
  currentState: AnimState;
  currentAction: THREE.AnimationAction | null;
}

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
  // Deconstruction (sell) animation: eid -> { progress 0..1, duration ticks, callback }
  private deconstructing = new Map<number, { progress: number; duration: number; onComplete: () => void }>();
  // Death animation: objects fading out
  private dying = new Map<THREE.Group, { opacity: number; sinkRate: number }>();
  // Idle animation timer
  private animTime = 0;
  // Frustum culling: skip expensive updates for off-screen entities
  private frustum = new THREE.Frustum();
  private frustumMatrix = new THREE.Matrix4();
  private cullingSphere = new THREE.Sphere();
  // Unit category classifier (returns 'infantry'|'vehicle'|'aircraft')
  private unitCategoryFn: ((eid: number) => 'infantry' | 'vehicle' | 'aircraft' | 'building') | null = null;
  // Attack-move status checker
  private isAttackMoveFn: ((eid: number) => boolean) | null = null;
  // Attack range circles (shown when selected)
  private rangeCircles = new Map<number, THREE.Line>();
  private rangeCircleEnabled = true;
  // Rearm progress callback: returns 0-1 progress or null if not rearming
  private rearmProgressFn: ((eid: number) => number | null) | null = null;
  private rearmBars = new Map<number, THREE.Sprite>();
  // Idle harvester indicator circles
  private idleHarvesterCircles = new Map<number, THREE.Mesh>();
  private idleHarvesterFn: ((eid: number) => boolean) | null = null;
  // Animation system: per-entity mixer and clip management
  private entityAnims = new Map<number, EntityAnimData>();
  // Clock for animation delta
  private animClock = new THREE.Clock();

  constructor(sceneManager: SceneManager, modelManager: ModelManager, artMap: Map<string, ArtEntry>) {
    this.sceneManager = sceneManager;
    this.modelManager = modelManager;
    this.artMap = artMap;
  }

  setFogOfWar(fog: FogOfWar, localPlayerId = 0): void {
    this.fogOfWar = fog;
    this.localPlayerId = localPlayerId;
  }

  setUnitCategoryFn(fn: (eid: number) => 'infantry' | 'vehicle' | 'aircraft' | 'building'): void {
    this.unitCategoryFn = fn;
  }

  setAttackMoveFn(fn: (eid: number) => boolean): void {
    this.isAttackMoveFn = fn;
  }

  isRangeCircleEnabled(): boolean {
    return this.rangeCircleEnabled;
  }

  setRangeCircleEnabled(enabled: boolean): void {
    this.rangeCircleEnabled = enabled;
    if (!enabled) {
      for (const [, line] of this.rangeCircles) {
        this.sceneManager.scene.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
      this.rangeCircles.clear();
    }
  }

  setRearmProgressFn(fn: (eid: number) => number | null): void {
    this.rearmProgressFn = fn;
  }

  setIdleHarvesterFn(fn: (eid: number) => boolean): void {
    this.idleHarvesterFn = fn;
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

  /** Start deconstruction (sell) animation — reverse of construction */
  startDeconstruction(eid: number, durationTicks: number, onComplete: () => void): void {
    this.deconstructing.set(eid, { progress: 0, duration: Math.max(1, durationTicks), onComplete });
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

  /** Advance deconstruction (sell) animation by one tick */
  tickDeconstruction(): void {
    for (const [eid, state] of this.deconstructing) {
      state.progress += 1 / state.duration;
      if (state.progress >= 1) {
        this.deconstructing.delete(eid);
        state.onComplete();
        continue;
      }
      const obj = this.entityObjects.get(eid);
      if (!obj) continue;

      const t = state.progress;
      // Scale from 1.0 -> 0.3
      const s = 1.0 - t * 0.7;
      obj.scale.setScalar(s);
      // Opacity from 1.0 -> 0.0
      const opacity = 1.0 - t;
      obj.traverse(child => {
        if (child instanceof THREE.Mesh && child.material) {
          const mat = child.material as THREE.Material;
          mat.transparent = true;
          mat.opacity = opacity;
        }
      });
    }
  }

  async preloadModels(unitTypeNames: string[], onProgress?: (loaded: number, total: number, name: string) => void): Promise<void> {
    const promises: Promise<void>[] = [];
    const loaded = new Set<string>();
    let doneCount = 0;

    for (const typeName of unitTypeNames) {
      const art = this.artMap.get(typeName);
      if (!art?.xaf || loaded.has(art.xaf)) continue;
      loaded.add(art.xaf);
    }

    const total = loaded.size;
    loaded.clear();

    for (const typeName of unitTypeNames) {
      const art = this.artMap.get(typeName);
      if (!art?.xaf || loaded.has(art.xaf)) continue;
      loaded.add(art.xaf);
      const displayName = typeName;

      promises.push(
        this.modelManager.loadModel(art.xaf, 'H0').then(model => {
          if (model) this.modelTemplates.set(art.xaf, model);
          doneCount++;
          onProgress?.(doneCount, total, displayName);
        })
      );
    }

    await Promise.allSettled(promises);
    console.log(`Preloaded ${this.modelTemplates.size} unit model templates`);
  }

  async preloadBuildingModels(buildingTypeNames: string[], onProgress?: (loaded: number, total: number, name: string) => void): Promise<void> {
    const promises: Promise<void>[] = [];
    const loaded = new Set<string>();
    let doneCount = 0;

    for (const typeName of buildingTypeNames) {
      const art = this.artMap.get(typeName);
      if (!art?.xaf || loaded.has(art.xaf)) continue;
      loaded.add(art.xaf);
    }

    const total = loaded.size;
    loaded.clear();

    for (const typeName of buildingTypeNames) {
      const art = this.artMap.get(typeName);
      if (!art?.xaf || loaded.has(art.xaf)) continue;
      loaded.add(art.xaf);
      const displayName = typeName;

      promises.push(
        this.modelManager.loadModel(art.xaf, 'H0').then(model => {
          if (model) this.modelTemplates.set(art.xaf, model);
          doneCount++;
          onProgress?.(doneCount, total, displayName);
        })
      );
    }

    await Promise.allSettled(promises);
    console.log(`Preloaded ${this.modelTemplates.size} total model templates (units + buildings)`);
  }

  /** Retry pending models for entities still using placeholders */
  resolvePendingModels(): number {
    let resolved = 0;
    for (const [eid, { xafName, scale }] of [...this.pendingModels]) {
      const template = this.modelTemplates.get(xafName);
      if (template) {
        this.pendingModels.delete(eid);
        this.setEntityModel(eid, xafName, scale);
        resolved++;
      }
    }
    if (resolved > 0) console.log(`Resolved ${resolved} pending models`);
    return resolved;
  }

  update(world: World): void {
    this.currentWorld = world;
    const dt = Math.min(this.animClock.getDelta() || 0.016, 0.1);
    this.animTime += dt;

    // Compute view frustum for culling expensive updates on off-screen entities
    const cam = this.sceneManager.camera;
    this.frustumMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);

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

      // Always sync position (needed for ECS accuracy)
      obj.position.set(
        Position.x[eid],
        Position.y[eid],
        Position.z[eid],
      );
      obj.rotation.y = Rotation.y[eid];

      // Independent turret rotation: rotate the model's first child group (turret heuristic)
      if (hasComponent(world, TurretRotation, eid)) {
        const turretAngle = TurretRotation.y[eid] - Rotation.y[eid]; // Relative to hull
        // Find the model wrapper (first non-circle child), then its first child (turret)
        for (const child of obj.children) {
          if (child instanceof THREE.Group && child.children.length > 0) {
            // The model wrapper's first child group is the turret
            const turret = child.children[0];
            if (turret instanceof THREE.Group || turret instanceof THREE.Mesh) {
              turret.rotation.y = turretAngle;
            }
            break;
          }
        }
      }

      // Fog of war: hide enemy entities in non-visible tiles
      if (this.fogOfWar && this.fogOfWar.isEnabled() && Owner.playerId[eid] !== this.localPlayerId) {
        const tile = worldToTile(Position.x[eid], Position.z[eid]);
        obj.visible = this.fogOfWar.isTileVisible(tile.tx, tile.tz);
      } else {
        obj.visible = true;
      }

      // Frustum culling: skip expensive visual updates for off-screen entities
      // Use bounding sphere (radius 4) to avoid popping at screen edges for buildings/large units
      this.cullingSphere.set(obj.position, 4);
      const inFrustum = this.frustum.intersectsSphere(this.cullingSphere);
      if (!inFrustum && !obj.visible) continue; // Fog-hidden + off-screen: skip everything

      // Update animation state and advance mixer
      const hasRealAnim = this.entityAnims.has(eid);
      if (inFrustum && hasRealAnim) {
        this.updateAnimState(eid, world);
        const animData = this.entityAnims.get(eid)!;
        animData.mixer.update(dt);
      }

      // Procedural idle animations — only for entities WITHOUT real animations
      if (inFrustum && !hasRealAnim && this.unitCategoryFn && !hasComponent(world, BuildingType, eid)) {
        const isIdle = !hasComponent(world, MoveTarget, eid) || MoveTarget.active[eid] === 0;
        const cat = this.unitCategoryFn(eid);
        const t = this.animTime + eid * 1.37; // Phase offset per entity
        if (cat === 'aircraft') {
          obj.position.y += Math.sin(t * 2.0) * 0.15;
          if (isIdle) obj.rotation.y += Math.sin(t * 0.5) * 0.003;
        } else if (cat === 'infantry' && isIdle) {
          obj.position.y += Math.sin(t * 3.0) * 0.03;
        } else if (cat === 'vehicle' && isIdle) {
          obj.position.y += Math.sin(t * 8.0) * 0.008;
        }
      } else if (inFrustum && hasRealAnim && this.unitCategoryFn) {
        // Even with real animations, aircraft need the hover bob
        const cat = this.unitCategoryFn(eid);
        if (cat === 'aircraft') {
          const t = this.animTime + eid * 1.37;
          obj.position.y += Math.sin(t * 2.0) * 0.15;
        }
      }

      // Update selection circle visibility and color (orange for attack-move)
      const circle = this.selectionCircles.get(eid);
      if (circle) {
        const selected = Selectable.selected[eid] === 1;
        circle.visible = selected && obj.visible;
        if (selected && this.isAttackMoveFn) {
          const mat = circle.material as THREE.MeshBasicMaterial;
          mat.color.set(this.isAttackMoveFn(eid) ? 0xff8800 : 0x00ff00);
        }
      }

      // Skip remaining expensive updates for off-screen entities
      if (!inFrustum) {
        // Clean up visible indicators before skipping
        const rc = this.rangeCircles.get(eid);
        if (rc) rc.visible = false;
        const ring = this.idleHarvesterCircles.get(eid);
        if (ring) ring.visible = false;
        continue;
      }

      // Idle harvester pulsing yellow ring (visible even when not selected)
      if (this.idleHarvesterFn && Owner.playerId[eid] === this.localPlayerId) {
        const isIdle = this.idleHarvesterFn(eid);
        if (isIdle && obj.visible) {
          let ring = this.idleHarvesterCircles.get(eid);
          if (!ring) {
            const geo = new THREE.RingGeometry(1.2, 1.5, 24);
            geo.rotateX(-Math.PI / 2);
            const mat = new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
            ring = new THREE.Mesh(geo, mat);
            ring.position.y = 0.08;
            this.sceneManager.scene.add(ring);
            this.idleHarvesterCircles.set(eid, ring);
          }
          ring.position.set(Position.x[eid], 0.08, Position.z[eid]);
          ring.visible = true;
          const pulse = 0.3 + Math.sin(this.animTime * 4 + eid * 0.5) * 0.3;
          (ring.material as THREE.MeshBasicMaterial).opacity = pulse;
        } else {
          const ring = this.idleHarvesterCircles.get(eid);
          if (ring) ring.visible = false;
        }
      }

      // Update attack range circle
      if (this.rangeCircleEnabled) {
        const selected = Selectable.selected[eid] === 1;
        if (selected && obj.visible && this.currentWorld && hasComponent(this.currentWorld, Combat, eid)) {
          const range = Combat.attackRange[eid];
          if (range > 0) {
            let rc = this.rangeCircles.get(eid);
            if (!rc) {
              rc = this.createRangeCircle(range);
              this.sceneManager.scene.add(rc);
              this.rangeCircles.set(eid, rc);
            }
            rc.position.set(Position.x[eid], 0.15, Position.z[eid]);
            rc.visible = true;
            const currentRadius = (rc.userData as any).range;
            if (Math.abs(currentRadius - range) > 0.5) {
              this.sceneManager.scene.remove(rc);
              rc.geometry.dispose();
              (rc.material as THREE.Material).dispose();
              rc = this.createRangeCircle(range);
              this.sceneManager.scene.add(rc);
              rc.position.set(Position.x[eid], 0.15, Position.z[eid]);
              this.rangeCircles.set(eid, rc);
            }
          }
        } else {
          const rc = this.rangeCircles.get(eid);
          if (rc) {
            this.sceneManager.scene.remove(rc);
            rc.geometry.dispose();
            (rc.material as THREE.Material).dispose();
            this.rangeCircles.delete(eid);
          }
        }
      }

      // Update health bar
      this.updateHealthBar(eid);

      // Update rearm progress bar
      this.updateRearmBar(eid);

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
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material instanceof THREE.MeshStandardMaterial) {
          // Tint the model slightly with team color
          child.material.color.lerp(color, 0.3);
        }
      }
    });

    // Set up animation mixer if the template has animation clips
    if (template.animations.length > 0) {
      const mixer = new THREE.AnimationMixer(existing);
      const clips = new Map<string, THREE.AnimationClip>();
      for (const clip of template.animations) {
        clips.set(clip.name, clip);
      }
      this.entityAnims.set(eid, {
        mixer,
        clips,
        currentState: 'idle',
        currentAction: null,
      });
      // Try to play an initial idle clip
      this.playAnimClip(eid, 'idle');
    }
  }

  /** Map a logical animation state to the best available clip name */
  private getClipForState(clips: Map<string, THREE.AnimationClip>, state: AnimState): THREE.AnimationClip | null {
    const candidates: Record<AnimState, string[]> = {
      'idle': ['Idle 0', 'Idle 1', 'Idle', 'Stationary', 'Hover'],
      'idle2': ['Idle 1', 'Idle 0', 'Idle', 'Stationary'],
      'move': ['Move', 'Move Start', 'Fly', 'Crawl', 'Move Special'],
      'fire': ['Fire 0', 'Fire 1', 'Shot 1', 'Shot 2', 'Lay Down Fire', 'CrouchFire'],
      'explode': ['Explode', 'Blow Up 1', 'Blow Up 2', 'Burnt 1'],
    };
    for (const name of candidates[state]) {
      const clip = clips.get(name);
      if (clip) return clip;
    }
    return null;
  }

  /** Play a named animation clip on an entity */
  private playAnimClip(eid: number, state: AnimState): void {
    const anim = this.entityAnims.get(eid);
    if (!anim) return;
    if (anim.currentState === state && anim.currentAction?.isRunning()) return;

    const clip = this.getClipForState(anim.clips, state);
    if (!clip) return;

    // Cross-fade from current to new
    const newAction = anim.mixer.clipAction(clip);
    if (anim.currentAction && anim.currentAction !== newAction) {
      anim.currentAction.fadeOut(0.15);
    }
    newAction.reset();
    newAction.fadeIn(0.15);
    // Looping for idle/move, clamp for fire/explode
    if (state === 'fire' || state === 'explode') {
      newAction.setLoop(THREE.LoopOnce, 1);
      newAction.clampWhenFinished = true;
    } else {
      newAction.setLoop(THREE.LoopRepeat, Infinity);
    }
    newAction.play();

    anim.currentState = state;
    anim.currentAction = newAction;
  }

  /** Update animation state based on ECS component data */
  private updateAnimState(eid: number, world: World): void {
    const anim = this.entityAnims.get(eid);
    if (!anim) return;

    // Determine desired state from ECS
    const isMoving = hasComponent(world, MoveTarget, eid) && MoveTarget.active[eid] === 1;
    const isFiring = hasComponent(world, AttackTarget, eid) && AttackTarget.active[eid] === 1;

    let desiredState: AnimState;
    if (isFiring && !isMoving) {
      desiredState = 'fire';
    } else if (isMoving) {
      desiredState = 'move';
    } else {
      desiredState = 'idle';
    }

    if (desiredState !== anim.currentState) {
      // If currently firing, wait for the clip to finish before transitioning
      if (anim.currentState === 'fire' && anim.currentAction?.isRunning()) {
        return;
      }
      this.playAnimClip(eid, desiredState);
    }
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

  private updateRearmBar(eid: number): void {
    if (!this.rearmProgressFn) return;
    const progress = this.rearmProgressFn(eid);
    if (progress === null || progress >= 1) {
      const bar = this.rearmBars.get(eid);
      if (bar) bar.visible = false;
      return;
    }

    let bar = this.rearmBars.get(eid);
    if (!bar) {
      const obj = this.entityObjects.get(eid);
      if (!obj) return; // Don't create orphan sprites
      const mat = new THREE.SpriteMaterial({ color: 0x4488ff });
      bar = new THREE.Sprite(mat);
      obj.add(bar);
      bar.position.y = 2.3; // Above health bar
      this.rearmBars.set(eid, bar);
    }
    bar.visible = true;
    bar.scale.set(progress * 1.5, 0.1, 1);
  }

  private createRangeCircle(range: number): THREE.Line {
    const segments = 48;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(theta) * range, 0, Math.sin(theta) * range));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.25,
    });
    const line = new THREE.Line(geo, mat);
    (line.userData as any).range = range;
    return line;
  }

  // Cached rank textures (1 chevron, 2 chevrons, 3 chevrons)
  private static rankTextures: THREE.Texture[] | null = null;

  private static getRankTextures(): THREE.Texture[] {
    if (UnitRenderer.rankTextures) return UnitRenderer.rankTextures;
    const colors = ['#CD7F32', '#C0C0C0', '#FFD700']; // bronze, silver, gold
    UnitRenderer.rankTextures = colors.map((color, idx) => {
      const count = idx + 1;
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, 32, 32);
      // Draw chevrons (V shapes stacked vertically)
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      const startY = 16 - count * 4;
      for (let i = 0; i < count; i++) {
        const y = startY + i * 8;
        ctx.beginPath();
        ctx.moveTo(6, y);
        ctx.lineTo(16, y + 6);
        ctx.lineTo(26, y);
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      return tex;
    });
    return UnitRenderer.rankTextures;
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
    const textures = UnitRenderer.getRankTextures();
    const tex = textures[Math.min(rank, 3) - 1];

    if (!sprite) {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
      sprite = new THREE.Sprite(mat);
      const obj = this.entityObjects.get(eid);
      if (obj) {
        obj.add(sprite);
        sprite.position.y = 2.5;
      }
      this.rankSprites.set(eid, sprite);
    } else {
      (sprite.material as THREE.SpriteMaterial).map = tex;
      (sprite.material as THREE.SpriteMaterial).needsUpdate = true;
    }

    sprite.visible = true;
    sprite.scale.set(0.8, 0.8, 1);
  }

  private removeVisual(eid: number): void {
    const obj = this.entityObjects.get(eid);
    if (obj) {
      // Remove selection circle and health bar immediately
      const circle = this.selectionCircles.get(eid);
      if (circle) { obj.remove(circle); circle.geometry.dispose(); (circle.material as THREE.Material).dispose(); }
      const bar = this.healthBars.get(eid);
      if (bar) { obj.remove(bar); (bar.material as THREE.Material).dispose(); }
      const rearmBar = this.rearmBars.get(eid);
      if (rearmBar) { obj.remove(rearmBar); (rearmBar.material as THREE.Material).dispose(); }
      const rank = this.rankSprites.get(eid);
      if (rank) { obj.remove(rank); (rank.material as THREE.Material).dispose(); }

      // Start death fade animation instead of instant removal
      obj.traverse(child => {
        if (child instanceof THREE.Mesh && child.material) {
          const mat = child.material as THREE.Material;
          mat.transparent = true;
        }
      });
      this.dying.set(obj, { opacity: 1.0, sinkRate: 0.02 });
      this.entityObjects.delete(eid);
    }
    this.selectionCircles.delete(eid);
    this.healthBars.delete(eid);
    this.rearmBars.delete(eid);
    this.rankSprites.delete(eid);
    this.pendingModels.delete(eid);
    this.deconstructing.delete(eid);
    // Clean up animation mixer — uncacheRoot releases PropertyBinding cache
    const animData = this.entityAnims.get(eid);
    if (animData) {
      animData.mixer.stopAllAction();
      animData.mixer.uncacheRoot(animData.mixer.getRoot());
      this.entityAnims.delete(eid);
    }
    const rc = this.rangeCircles.get(eid);
    if (rc) { this.sceneManager.scene.remove(rc); rc.geometry.dispose(); (rc.material as THREE.Material).dispose(); this.rangeCircles.delete(eid); }
    const ihc = this.idleHarvesterCircles.get(eid);
    if (ihc) { this.sceneManager.scene.remove(ihc); ihc.geometry.dispose(); (ihc.material as THREE.Material).dispose(); this.idleHarvesterCircles.delete(eid); }
  }

  /** Animate dying entities (call each frame) */
  tickDeathAnimations(): void {
    for (const [obj, state] of this.dying) {
      state.opacity -= 0.04; // ~25 frames to fade out
      obj.position.y -= state.sinkRate; // Sink into ground
      obj.traverse(child => {
        if (child instanceof THREE.Mesh && child.material) {
          (child.material as THREE.Material).opacity = Math.max(0, state.opacity);
        }
      });
      if (state.opacity <= 0) {
        obj.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.geometry?.dispose();
            if (child.material) (child.material as THREE.Material).dispose();
          }
        });
        this.sceneManager.scene.remove(obj);
        this.dying.delete(obj);
      }
    }
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

  /** Add a visual upgrade indicator (gold ring) to a building */
  markUpgraded(eid: number): void {
    const obj = this.entityObjects.get(eid);
    if (!obj) return;
    // Remove existing upgrade ring if present
    for (const child of obj.children) {
      if (child.userData.upgradeRing) {
        obj.remove(child);
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
        break;
      }
    }
    // Add a gold ring at the building's base to indicate upgrade
    const ringGeo = new THREE.RingGeometry(2.2, 2.5, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.06;
    ring.userData.upgradeRing = true;
    obj.add(ring);
  }

  /** Trigger the death/explode animation on an entity. Returns true if a clip was found. */
  playDeathAnim(eid: number): boolean {
    const anim = this.entityAnims.get(eid);
    if (!anim) return false;
    const clip = this.getClipForState(anim.clips, 'explode');
    if (!clip) return false;
    this.playAnimClip(eid, 'explode');
    return true;
  }

  getEntityObject(eid: number): THREE.Group | undefined {
    return this.entityObjects.get(eid);
  }

  /** Get all entities currently under construction (for visual effects). */
  getConstructingEntities(): Map<number, { progress: number }> {
    return this.constructing;
  }
}
