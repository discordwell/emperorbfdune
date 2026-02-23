import * as THREE from 'three';
import type { EffectsManager } from '../rendering/EffectsManager';
import type { SceneManager } from '../rendering/SceneManager';
import type { UnitRenderer } from '../rendering/UnitRenderer';
import type { AudioManager } from '../audio/AudioManager';
import type { CombatSystem } from './CombatSystem';
import type { BuildingDef } from '../config/BuildingDefs';

/**
 * Destruction size category — determines how dramatic the collapse sequence is.
 * - small: Turrets, walls — quick 1-phase pop with small debris
 * - medium: Barracks, refinery, windtrap — 2-phase destruction
 * - large: Construction yard, palace, starport — full 4-phase dramatic collapse with screen shake
 */
export type DestructionSize = 'small' | 'medium' | 'large';

/** Phase progression thresholds (in simulation ticks at 25 TPS) */
const PHASE_THRESHOLDS = {
  small:  { total: 15 },
  medium: { phase1End: 15, total: 35 },
  large:  { phase1End: 20, phase2End: 40, phase3End: 60, scorchFade: 260, total: 260 },
};

/** Data tracked per dying building */
interface DyingBuilding {
  entityId: number;
  x: number;
  y: number;
  z: number;
  owner: number;
  size: DestructionSize;
  footprintW: number; // Building footprint half-width in world units
  footprintH: number; // Building footprint half-height in world units
  tick: number; // Ticks elapsed since destruction began
  obj: THREE.Object3D | null; // Reference to the Three.js object for visual manipulation
  /** Scorch mark mesh left behind after the building is fully gone */
  scorchMesh: THREE.Mesh | null;
  /** Smoke cloud meshes for phase 3+ */
  smokeClouds: THREE.Mesh[];
  /** Whether the entity has been removed from ECS */
  entityRemoved: boolean;
  /** Next tick at which a small explosion should spawn */
  nextExplosionTick: number;
}

export class BuildingDestructionSystem {
  private dying = new Map<number, DyingBuilding>();
  private effectsManager: EffectsManager;
  private sceneManager: SceneManager;
  private unitRenderer: UnitRenderer;
  private audioManager: AudioManager;
  private combatSystem: CombatSystem;
  /** Shared geometry for smoke cloud spheres */
  private smokeGeo: THREE.SphereGeometry;
  /** Shared geometry for scorch decals */
  private scorchGeo: THREE.PlaneGeometry;

  constructor(
    effectsManager: EffectsManager,
    sceneManager: SceneManager,
    unitRenderer: UnitRenderer,
    audioManager: AudioManager,
    combatSystem: CombatSystem,
  ) {
    this.effectsManager = effectsManager;
    this.sceneManager = sceneManager;
    this.unitRenderer = unitRenderer;
    this.audioManager = audioManager;
    this.combatSystem = combatSystem;
    this.smokeGeo = new THREE.SphereGeometry(0.6, 5, 5);
    this.scorchGeo = new THREE.PlaneGeometry(1, 1);
  }

  /**
   * Classify a building into a destruction size category.
   * Walls and turrets -> small, most production buildings -> medium,
   * ConYards, Palaces, Starports -> large.
   */
  classifySize(buildingName: string, def: BuildingDef | null): DestructionSize {
    if (!def) return 'medium';

    // Walls are always small
    if (def.wall) return 'small';

    // Popup turrets are small
    if (def.popupTurret) return 'small';

    // Large: construction yards, palaces, starports
    const lowerName = buildingName.toLowerCase();
    if (
      lowerName.includes('conyard') ||
      lowerName.includes('palace') ||
      lowerName.includes('starport') ||
      lowerName.includes('factory') ||
      lowerName.includes('hightechfac')
    ) {
      return 'large';
    }

    // Check footprint size: 4+ tiles in any dimension is large
    const footH = def.occupy.length || 0;
    const footW = (def.occupy[0]?.length || 0);
    if (footH >= 4 || footW >= 4) return 'large';

    // Everything else is medium
    return 'medium';
  }

  /**
   * Begin a staged building destruction sequence.
   * Called instead of the instant death path when a building reaches 0 HP.
   * Returns true if the destruction was started (building not already dying).
   */
  startDestruction(
    entityId: number,
    x: number, y: number, z: number,
    owner: number,
    buildingName: string,
    def: BuildingDef | null,
  ): boolean {
    if (this.dying.has(entityId)) return false;

    const size = this.classifySize(buildingName, def);
    const footH = def?.occupy.length || 3;
    const footW = def?.occupy[0]?.length || 3;
    // World-space half-extents (tile size = 2)
    const footprintW = footW;
    const footprintH = footH;

    const obj = this.unitRenderer.getEntityObject(entityId) ?? null;

    // Immediately suppress combat (no more firing)
    this.combatSystem.setSuppressed(entityId, true);

    this.dying.set(entityId, {
      entityId,
      x, y, z,
      owner,
      size,
      footprintW,
      footprintH,
      tick: 0,
      obj,
      scorchMesh: null,
      smokeClouds: [],
      entityRemoved: false,
      nextExplosionTick: 0,
    });

    return true;
  }

  /** Check whether an entity is currently undergoing staged destruction */
  isDying(entityId: number): boolean {
    return this.dying.has(entityId);
  }

  /** Get all entity IDs currently in staged destruction (for skipping in selection, targeting, etc.) */
  getDyingEntities(): ReadonlySet<number> {
    const set = new Set<number>();
    for (const eid of this.dying.keys()) set.add(eid);
    return set;
  }

  /**
   * Advance all active destruction sequences by one simulation tick.
   * Called from the game tick handler.
   */
  update(removeEntityFn: (eid: number) => void): void {
    for (const [eid, state] of this.dying) {
      state.tick++;
      const { size } = state;

      if (size === 'small') {
        this.updateSmall(state, removeEntityFn);
      } else if (size === 'medium') {
        this.updateMedium(state, removeEntityFn);
      } else {
        this.updateLarge(state, removeEntityFn);
      }
    }
  }

  // ─── Small destruction: quick 1-phase pop ──────────────────────────

  private updateSmall(state: DyingBuilding, removeEntityFn: (eid: number) => void): void {
    const t = state.tick;
    const thresholds = PHASE_THRESHOLDS.small;

    if (t === 1) {
      // Single explosion + small debris
      this.effectsManager.spawnExplosion(state.x, state.y, state.z, 'small');
      this.effectsManager.spawnDecal(state.x, state.z, 'small');
      this.audioManager.playSfx('deathBuilding');
    }

    // Quickly shrink
    if (state.obj && t <= 10) {
      const progress = t / 10;
      state.obj.scale.y = Math.max(0.05, 1 - progress * 0.9);
      state.obj.position.y = state.y - progress * 0.5;
    }

    // Remove entity and clean up
    if (t >= thresholds.total) {
      this.removeEntity(state, removeEntityFn);
      this.dying.delete(state.entityId);
    }
  }

  // ─── Medium destruction: 2-phase ──────────────────────────────────

  private updateMedium(state: DyingBuilding, removeEntityFn: (eid: number) => void): void {
    const t = state.tick;
    const thresholds = PHASE_THRESHOLDS.medium;

    // Phase 1: Small explosions at random points, building starts sinking
    if (t <= thresholds.phase1End) {
      if (t === 1) {
        this.audioManager.playSfx('deathBuilding');
        this.sceneManager.shake(0.15);
      }
      // Spawn small explosions every 3-4 ticks
      if (t >= state.nextExplosionTick) {
        const ex = state.x + (Math.random() - 0.5) * state.footprintW * 1.5;
        const ez = state.z + (Math.random() - 0.5) * state.footprintH * 1.5;
        this.effectsManager.spawnExplosion(ex, state.y + Math.random() * 1.5, ez, 'small');
        state.nextExplosionTick = t + 3 + Math.floor(Math.random() * 2);
        this.audioManager.playSfx('explosion');
      }
      // Building tilts and sinks
      if (state.obj) {
        const progress = t / thresholds.phase1End;
        state.obj.scale.y = Math.max(0.3, 1 - progress * 0.4);
        state.obj.position.y = state.y - progress * 0.8;
        state.obj.rotation.x = Math.sin(state.entityId * 1.7) * progress * 0.12;
        state.obj.rotation.z = Math.cos(state.entityId * 2.3) * progress * 0.12;
      }
    }

    // Phase 2: Larger central explosion, collapse, debris
    if (t > thresholds.phase1End && t <= thresholds.total) {
      if (t === thresholds.phase1End + 1) {
        // Main explosion
        this.effectsManager.spawnExplosion(state.x, state.y + 1, state.z, 'large');
        this.effectsManager.spawnWreckage(state.x, state.y, state.z, true);
        this.effectsManager.spawnDecal(state.x, state.z, 'medium');
        this.sceneManager.shake(0.25);
        this.audioManager.playSfx('deathBuilding');
        // Spawn debris particles outward
        this.spawnDebris(state, 6);
      }
      // Continue collapsing
      if (state.obj) {
        const localT = (t - thresholds.phase1End) / (thresholds.total - thresholds.phase1End);
        state.obj.scale.y = Math.max(0.05, 0.6 - localT * 0.55);
        state.obj.scale.x = Math.max(0.5, 1 - localT * 0.3);
        state.obj.scale.z = Math.max(0.5, 1 - localT * 0.3);
        state.obj.position.y = state.y - 0.8 - localT * 1.0;
      }
    }

    // Remove entity and clean up
    if (t >= thresholds.total) {
      this.removeEntity(state, removeEntityFn);
      this.dying.delete(state.entityId);
    }
  }

  // ─── Large destruction: full 4-phase dramatic collapse ────────────

  private updateLarge(state: DyingBuilding, removeEntityFn: (eid: number) => void): void {
    const t = state.tick;
    const th = PHASE_THRESHOLDS.large;

    // Phase 1 (0-20 ticks): Multiple small explosions, building starts tilting/sinking
    if (t <= th.phase1End) {
      if (t === 1) {
        this.audioManager.playSfx('deathBuilding');
        this.sceneManager.shake(0.2);
      }
      // Spawn small explosions at random footprint positions
      if (t >= state.nextExplosionTick) {
        const ex = state.x + (Math.random() - 0.5) * state.footprintW * 2;
        const ez = state.z + (Math.random() - 0.5) * state.footprintH * 2;
        const ey = state.y + Math.random() * 2;
        this.effectsManager.spawnExplosion(ex, ey, ez, 'small');
        state.nextExplosionTick = t + 2 + Math.floor(Math.random() * 2);
        // Play explosion sfx for some of the smaller blasts
        if (Math.random() < 0.6) {
          this.audioManager.playSfx('explosion');
        }
      }
      // Building starts tilting and sinking
      if (state.obj) {
        const progress = t / th.phase1End;
        state.obj.position.y = state.y - progress * 0.5;
        state.obj.rotation.x = Math.sin(state.entityId * 1.7) * progress * 0.08;
        state.obj.rotation.z = Math.cos(state.entityId * 2.3) * progress * 0.08;
      }
    }

    // Phase 2 (20-40 ticks): Larger central explosion, Y-axis collapse, debris flies out
    if (t > th.phase1End && t <= th.phase2End) {
      const localT = (t - th.phase1End) / (th.phase2End - th.phase1End);

      if (t === th.phase1End + 1) {
        // Big central explosion
        this.effectsManager.spawnExplosion(state.x, state.y + 2, state.z, 'large');
        this.sceneManager.shake(0.4);
        this.audioManager.playSfx('deathBuilding');
        // Debris particles
        this.spawnDebris(state, 10);
      }

      // Additional explosions during collapse
      if (t >= state.nextExplosionTick) {
        const ex = state.x + (Math.random() - 0.5) * state.footprintW * 1.5;
        const ez = state.z + (Math.random() - 0.5) * state.footprintH * 1.5;
        this.effectsManager.spawnExplosion(ex, state.y + 1, ez, 'medium');
        state.nextExplosionTick = t + 4 + Math.floor(Math.random() * 3);
      }

      // Collapse: scale Y down, sink further, spread XZ slightly
      if (state.obj) {
        state.obj.scale.y = Math.max(0.05, 1 - localT * 0.85);
        state.obj.scale.x = 1 + localT * 0.15; // Slight outward spread
        state.obj.scale.z = 1 + localT * 0.15;
        state.obj.position.y = state.y - 0.5 - localT * 1.5;
        // Increase tilt
        const tilt = 0.08 + localT * 0.12;
        state.obj.rotation.x = Math.sin(state.entityId * 1.7) * tilt;
        state.obj.rotation.z = Math.cos(state.entityId * 2.3) * tilt;
      }
    }

    // Transition: remove the entity from ECS and spawn wreckage/scorch at end of phase 2
    if (t === th.phase2End + 1) {
      this.effectsManager.spawnWreckage(state.x, state.y, state.z, true);
      this.spawnScorchMark(state);
      this.removeEntity(state, removeEntityFn);
    }

    // Phase 3 (40-60 ticks): Smoke cloud remains, rubble/scorch visible
    if (t > th.phase2End && t <= th.phase3End) {
      const localT = (t - th.phase2End) / (th.phase3End - th.phase2End);

      // Spawn smoke clouds once at phase 3 start
      if (t === th.phase2End + 1) {
        this.spawnSmokeClouds(state, 4);
      }

      // Animate smoke clouds: rise and expand
      for (const cloud of state.smokeClouds) {
        cloud.position.y += 0.04;
        const scale = 1.0 + localT * 0.8;
        cloud.scale.setScalar(scale);
        const mat = cloud.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.5 * (1 - localT * 0.3);
      }
    }

    // Phase 4 (60+ ticks): Smoke fades, scorch mark persists then fades
    if (t > th.phase3End && t <= th.scorchFade) {
      const localT = (t - th.phase3End) / (th.scorchFade - th.phase3End);

      // Fade out smoke clouds
      for (const cloud of state.smokeClouds) {
        cloud.position.y += 0.02;
        const mat = cloud.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 0.35 * (1 - localT));
        if (mat.opacity <= 0.01) {
          this.sceneManager.scene.remove(cloud);
          mat.dispose();
        }
      }

      // Fade scorch mark during last portion
      if (state.scorchMesh) {
        const scorchFadeStart = 0.6; // Start fading scorch at 60% of phase 4
        if (localT > scorchFadeStart) {
          const fadeProg = (localT - scorchFadeStart) / (1 - scorchFadeStart);
          const mat = state.scorchMesh.material as THREE.MeshBasicMaterial;
          mat.opacity = 0.6 * (1 - fadeProg);
        }
      }
    }

    // Final cleanup
    if (t >= th.scorchFade) {
      this.cleanupState(state);
      this.dying.delete(state.entityId);
    }
  }

  // ─── Helper methods ───────────────────────────────────────────────

  /** Spawn debris particles flying outward from the building position */
  private spawnDebris(state: DyingBuilding, count: number): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 1 + Math.random() * state.footprintW;
      const dx = Math.cos(angle) * dist;
      const dz = Math.sin(angle) * dist;
      // Use existing explosion system for debris particles
      this.effectsManager.spawnExplosion(
        state.x + dx,
        state.y + 0.5 + Math.random() * 2,
        state.z + dz,
        'small',
      );
    }
  }

  /** Spawn a scorch mark on the terrain under the destroyed building */
  private spawnScorchMark(state: DyingBuilding): void {
    const scale = state.size === 'large' ? 7.0 : state.size === 'medium' ? 4.0 : 2.0;
    // Create a dark radial decal
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(15, 10, 5, 0.9)');
    gradient.addColorStop(0.3, 'rgba(25, 15, 8, 0.6)');
    gradient.addColorStop(0.6, 'rgba(35, 20, 10, 0.3)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.scorchGeo, mat);
    mesh.rotation.set(-Math.PI / 2, Math.random() * Math.PI * 2, 0);
    mesh.position.set(state.x, 0.03, state.z);
    mesh.scale.set(scale, scale, 1);
    this.sceneManager.scene.add(mesh);
    state.scorchMesh = mesh;
  }

  /** Spawn lingering smoke cloud meshes */
  private spawnSmokeClouds(state: DyingBuilding, count: number): void {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x333333,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.smokeGeo, mat);
      mesh.position.set(
        state.x + (Math.random() - 0.5) * state.footprintW * 1.5,
        state.y + 1 + Math.random() * 1.5,
        state.z + (Math.random() - 0.5) * state.footprintH * 1.5,
      );
      const baseScale = 0.8 + Math.random() * 0.6;
      mesh.scale.setScalar(baseScale);
      this.sceneManager.scene.add(mesh);
      state.smokeClouds.push(mesh);
    }
  }

  /** Remove the building entity from ECS and clean up its visual */
  private removeEntity(state: DyingBuilding, removeEntityFn: (eid: number) => void): void {
    if (state.entityRemoved) return;
    state.entityRemoved = true;
    try {
      removeEntityFn(state.entityId);
    } catch {
      // Entity may already be gone
    }
  }

  /** Clean up all Three.js objects associated with a dying building */
  private cleanupState(state: DyingBuilding): void {
    // Clean up smoke clouds
    for (const cloud of state.smokeClouds) {
      this.sceneManager.scene.remove(cloud);
      (cloud.material as THREE.Material).dispose();
    }
    state.smokeClouds = [];

    // Clean up scorch mesh
    if (state.scorchMesh) {
      this.sceneManager.scene.remove(state.scorchMesh);
      const mat = state.scorchMesh.material as THREE.MeshBasicMaterial;
      if (mat.map) mat.map.dispose();
      mat.dispose();
      state.scorchMesh = null;
    }
  }

  /** Clean up everything — call on game teardown */
  dispose(): void {
    for (const [, state] of this.dying) {
      this.cleanupState(state);
    }
    this.dying.clear();
    this.smokeGeo.dispose();
    this.scorchGeo.dispose();
  }
}
