import type { World } from '../core/ECS';
import { MoveTarget, Position, AttackTarget, Combat, Owner, Health, BuildingType, Harvester, hasComponent } from '../core/ECS';
import type { SceneManager } from '../rendering/SceneManager';
import type { SelectionManager } from './SelectionManager';
import type { UnitRenderer } from '../rendering/UnitRenderer';
import { EventBus } from '../core/EventBus';
import type { AudioManager, UnitCategory } from '../audio/AudioManager';
import type { CombatSystem } from '../simulation/CombatSystem';

export type CommandMode = 'normal' | 'attack-move' | 'patrol' | 'teleport';

export class CommandManager {
  private sceneManager: SceneManager;
  private selectionManager: SelectionManager;
  private unitRenderer: UnitRenderer;
  private audioManager: AudioManager | null = null;
  private combatSystem: CombatSystem | null = null;
  private world: any = null;

  private commandMode: CommandMode = 'normal';
  private moveMarkerFn: ((x: number, z: number) => void) | null = null;
  private unitClassifier: ((eid: number) => UnitCategory) | null = null;
  private forceReturnFn: ((eid: number) => void) | null = null;

  // Waypoint queue per entity
  private waypointQueues = new Map<number, Array<{ x: number; z: number }>>();
  // Patrol entities loop between start and target
  private patrolEntities = new Map<number, { startX: number; startZ: number; endX: number; endZ: number }>();
  // Rally point per player
  private rallyPoints = new Map<number, { x: number; z: number }>();

  constructor(sceneManager: SceneManager, selectionManager: SelectionManager, unitRenderer: UnitRenderer) {
    this.sceneManager = sceneManager;
    this.selectionManager = selectionManager;
    this.unitRenderer = unitRenderer;

    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  setAudioManager(audio: AudioManager): void {
    this.audioManager = audio;
  }

  setCombatSystem(combat: CombatSystem): void {
    this.combatSystem = combat;
  }

  setMoveMarkerFn(fn: (x: number, z: number) => void): void {
    this.moveMarkerFn = fn;
  }

  setForceReturnFn(fn: (eid: number) => void): void {
    this.forceReturnFn = fn;
  }

  setUnitClassifier(fn: (eid: number) => UnitCategory): void {
    this.unitClassifier = fn;
  }

  private getSelectedCategory(entityIds: number[]): UnitCategory {
    if (entityIds.length === 0 || !this.unitClassifier) return 'vehicle';
    return this.unitClassifier(entityIds[0]);
  }

  setWorld(world: any): void {
    this.world = world;
  }

  getRallyPoint(playerId: number): { x: number; z: number } | null {
    return this.rallyPoints.get(playerId) ?? null;
  }

  getCommandMode(): CommandMode {
    return this.commandMode;
  }

  getWaypointQueues(): Map<number, Array<{ x: number; z: number }>> {
    return this.waypointQueues;
  }

  getPatrolEntities(): Map<number, { startX: number; startZ: number; endX: number; endZ: number }> {
    return this.patrolEntities;
  }

  enterCommandMode(mode: CommandMode, label?: string): void {
    this.commandMode = mode;
    document.body.style.cursor = 'crosshair';
    if (label) {
      const modeEl = document.getElementById('command-mode');
      if (modeEl) {
        modeEl.style.display = 'block';
        modeEl.textContent = label;
      }
    }
  }

  // Check and advance waypoints for entities that have stopped
  updateWaypoints(): void {
    for (const [eid, queue] of this.waypointQueues) {
      // Clean up dead entities
      if (Health.current[eid] <= 0) {
        this.waypointQueues.delete(eid);
        continue;
      }
      if (queue.length === 0) {
        this.waypointQueues.delete(eid);
        continue;
      }
      if (MoveTarget.active[eid] === 0) {
        const next = queue.shift()!;
        MoveTarget.x[eid] = next.x;
        MoveTarget.z[eid] = next.z;
        MoveTarget.active[eid] = 1;
      }
    }

    // Handle patrol: when unit reaches patrol endpoint, swap direction
    for (const [eid, patrol] of this.patrolEntities) {
      // Clean up dead entities
      if (Health.current[eid] <= 0) {
        this.patrolEntities.delete(eid);
        continue;
      }
      if (MoveTarget.active[eid] === 0) {
        // At destination — swap start and end
        const temp = { startX: patrol.endX, startZ: patrol.endZ, endX: patrol.startX, endZ: patrol.startZ };
        this.patrolEntities.set(eid, temp);
        MoveTarget.x[eid] = temp.endX;
        MoveTarget.z[eid] = temp.endZ;
        MoveTarget.active[eid] = 1;
      }
    }
  }

  private isOverUI(x: number, y: number): boolean {
    if (y < 32) return true; // Resource bar
    if (x > window.innerWidth - 200) return true; // Sidebar
    if (x < 200 && y > window.innerHeight - 200) return true; // Minimap
    return false;
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 2) return; // Right-click only
    if (this.isOverUI(e.clientX, e.clientY)) return; // Ignore clicks on UI

    const selected = this.selectionManager.getSelectedEntities();
    if (selected.length === 0) return;

    const shiftHeld = e.shiftKey;

    // Force-fire: Ctrl+right-click forces attack on any target (including ground/friendly)
    const ctrlHeld = e.ctrlKey || e.metaKey;

    // Check if right-clicked on a unit
    const targetEid = this.unitRenderer.getEntityAtScreen(e.clientX, e.clientY);
    if (targetEid !== null) {
      const targetOwner = Owner.playerId[targetEid];
      const selectedOwner = Owner.playerId[selected[0]];
      if (ctrlHeld) {
        // Ctrl+right-click: force-attack any target (even friendly)
        if (!selected.includes(targetEid)) {
          this.issueAttackCommand(selected, targetEid);
          this.audioManager?.playUnitVoiceOrSfx('attack', this.getSelectedCategory(selected), selected[0]);
        }
      } else if (targetOwner === selectedOwner && !selected.includes(targetEid)) {
        // Right-click on friendly unit = escort
        this.issueEscortCommand(selected, targetEid);
        this.audioManager?.playUnitVoiceOrSfx('move', this.getSelectedCategory(selected), selected[0]);
      } else if (targetOwner !== selectedOwner) {
        // Right-click on enemy = attack
        this.issueAttackCommand(selected, targetEid);
        this.audioManager?.playUnitVoiceOrSfx('attack', this.getSelectedCategory(selected), selected[0]);
      }
      return;
    }

    // Ctrl+right-click on ground = force-fire (attack-ground)
    if (ctrlHeld && selected.length > 0) {
      const worldPos = this.sceneManager.screenToWorld(e.clientX, e.clientY);
      if (worldPos) {
        this.issueAttackMoveCommand(selected, worldPos.x, worldPos.z);
        this.audioManager?.playUnitVoiceOrSfx('attack', this.getSelectedCategory(selected), selected[0]);
        return;
      }
    }

    // Move command
    const worldPos = this.sceneManager.screenToWorld(e.clientX, e.clientY);
    if (!worldPos) return;

    // Check if a building is selected — set rally point instead of move
    const hasBuildingSel = this.world && selected.some(eid => hasComponent(this.world, BuildingType, eid));
    if (hasBuildingSel && this.commandMode === 'normal' && !shiftHeld) {
      const rallyOwner = Owner.playerId[selected[0]];
      this.rallyPoints.set(rallyOwner, { x: worldPos.x, z: worldPos.z });
      EventBus.emit('rally:set', { playerId: rallyOwner, x: worldPos.x, z: worldPos.z });
      this.audioManager?.playSfx('move');
      return;
    }

    const cat = this.getSelectedCategory(selected);
    if (this.commandMode === 'teleport') {
      EventBus.emit('teleport:target', { x: worldPos.x, z: worldPos.z });
      this.commandMode = 'normal';
      document.body.style.cursor = 'default';
      const modeEl = document.getElementById('command-mode');
      if (modeEl) modeEl.style.display = 'none';
      return;
    } else if (this.commandMode === 'attack-move') {
      this.issueAttackMoveCommand(selected, worldPos.x, worldPos.z);
      this.audioManager?.playUnitVoiceOrSfx('move', cat, selected[0]);
      this.commandMode = 'normal';
      document.body.style.cursor = 'default';
      const modeEl1 = document.getElementById('command-mode');
      if (modeEl1) modeEl1.style.display = 'none';
    } else if (this.commandMode === 'patrol') {
      this.issuePatrolCommand(selected, worldPos.x, worldPos.z);
      this.audioManager?.playUnitVoiceOrSfx('move', cat, selected[0]);
      this.commandMode = 'normal';
      document.body.style.cursor = 'default';
      const modeEl2 = document.getElementById('command-mode');
      if (modeEl2) modeEl2.style.display = 'none';
    } else if (shiftHeld) {
      this.addWaypoint(selected, worldPos.x, worldPos.z);
      this.audioManager?.playUnitVoiceOrSfx('move', cat, selected[0]);
    } else {
      this.issueMoveCommand(selected, worldPos.x, worldPos.z);
      this.audioManager?.playUnitVoiceOrSfx('move', cat, selected[0]);
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const selected = this.selectionManager.getSelectedEntities();

    switch (e.key.toLowerCase()) {
      case 'a':
        // Attack-move mode (skip when Ctrl+A is used for select-all)
        if (selected.length > 0 && !e.ctrlKey && !e.metaKey) {
          this.commandMode = 'attack-move';
          document.body.style.cursor = 'crosshair';
        }
        break;

      case 's':
        // Stop
        this.issueStopCommand(selected);
        break;

      case 'g':
        // Guard (hold position, attack in range)
        this.issueGuardCommand(selected);
        break;

      case 'p':
        // Patrol mode
        if (selected.length > 0) {
          this.commandMode = 'patrol';
          document.body.style.cursor = 'crosshair';
        }
        break;

      case 'v':
        // Cycle stance: aggressive(0) -> defensive(1) -> hold(2) -> aggressive
        if (selected.length > 0 && this.combatSystem) {
          const current = this.combatSystem.getStance(selected[0]);
          const next = (current + 1) % 3;
          for (const eid of selected) {
            this.combatSystem.setStance(eid, next);
          }
          const names = ['Aggressive', 'Defensive', 'Hold Position'];
          this.audioManager?.playSfx('select');
          // Use a custom DOM element for stance message
          const modeEl = document.getElementById('command-mode');
          if (modeEl) {
            modeEl.style.display = 'block';
            modeEl.textContent = `Stance: ${names[next]}`;
            setTimeout(() => { if (modeEl.textContent?.startsWith('Stance:')) modeEl.style.display = 'none'; }, 1500);
          }
        }
        break;

      case 'r':
        // Return harvesters to refinery
        if (selected.length > 0 && this.forceReturnFn) {
          let returned = 0;
          for (const eid of selected) {
            if (hasComponent(this.world, Harvester, eid)) {
              this.forceReturnFn(eid);
              returned++;
            }
          }
          if (returned > 0) {
            this.audioManager?.playSfx('select');
          }
        }
        break;

      // 'x' scatter is handled in index.ts as fallback when ability system doesn't consume it

      case 'escape':
        if (this.commandMode !== 'normal') {
          this.commandMode = 'normal';
          document.body.style.cursor = 'default';
          const modeEl = document.getElementById('command-mode');
          if (modeEl) modeEl.style.display = 'none';
        }
        break;
    }
  };

  issueMoveCommand(entityIds: number[], x: number, z: number): void {
    // Clear waypoints, patrols, guard positions, escort, and attack-move state
    for (const eid of entityIds) {
      this.waypointQueues.delete(eid);
      this.patrolEntities.delete(eid);
      this.combatSystem?.clearGuardPosition(eid);
      this.combatSystem?.clearEscortTarget(eid);
    }
    this.combatSystem?.clearAttackMove(entityIds);

    this.applyFormation(entityIds, x, z);

    EventBus.emit('unit:move', { entityIds: [...entityIds], x, z });
    this.moveMarkerFn?.(x, z);
  }

  /** Apply directional formation offsets: units spread perpendicular to move direction */
  private applyFormation(entityIds: number[], x: number, z: number): void {
    const count = entityIds.length;
    if (count === 0) return;

    // Compute average unit position (group center)
    let cx = 0, cz = 0;
    for (const eid of entityIds) {
      cx += Position.x[eid];
      cz += Position.z[eid];
    }
    cx /= count;
    cz /= count;

    // Direction from group center to target
    const dx = x - cx;
    const dz = z - cz;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // If too close, fall back to simple grid (no meaningful direction)
    if (dist < 2 || count === 1) {
      for (const eid of entityIds) {
        MoveTarget.x[eid] = x;
        MoveTarget.z[eid] = z;
        MoveTarget.active[eid] = 1;
        AttackTarget.active[eid] = 0;
      }
      return;
    }

    // Unit direction vectors: forward (toward target) and right (perpendicular)
    const fwdX = dx / dist;
    const fwdZ = dz / dist;
    const rightX = -fwdZ; // Perpendicular (rotate 90 degrees)
    const rightZ = fwdX;

    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const spacing = 2.5;

    for (let i = 0; i < count; i++) {
      const eid = entityIds[i];
      const col = i % cols;
      const row = Math.floor(i / cols);

      // Lateral offset (spread perpendicular to movement direction)
      const lateral = (col - (cols - 1) / 2) * spacing;
      // Depth offset (row 0 = front line at target, subsequent rows trail behind)
      const depth = -row * spacing;

      MoveTarget.x[eid] = x + rightX * lateral + fwdX * depth;
      MoveTarget.z[eid] = z + rightZ * lateral + fwdZ * depth;
      MoveTarget.active[eid] = 1;
      AttackTarget.active[eid] = 0;
    }
  }

  private addWaypoint(entityIds: number[], x: number, z: number): void {
    // Compute directional formation offsets (same as applyFormation)
    const count = entityIds.length;
    if (count === 0) return;

    let cx = 0, cz = 0;
    for (const eid of entityIds) {
      cx += Position.x[eid];
      cz += Position.z[eid];
    }
    cx /= count;
    cz /= count;

    const dx = x - cx;
    const dz = z - cz;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const cols = Math.ceil(Math.sqrt(count));
    const spacing = 2.5;

    for (let i = 0; i < count; i++) {
      const eid = entityIds[i];
      const col = i % cols;
      const row = Math.floor(i / cols);

      let offX = 0, offZ = 0;
      if (dist >= 2 && count > 1) {
        const fwdX = dx / dist;
        const fwdZ = dz / dist;
        const rightX = -fwdZ;
        const rightZ = fwdX;
        const lateral = (col - (cols - 1) / 2) * spacing;
        const depth = -row * spacing;
        offX = rightX * lateral + fwdX * depth;
        offZ = rightZ * lateral + fwdZ * depth;
      } else {
        offX = (col - (cols - 1) / 2) * spacing;
        offZ = (row - (Math.ceil(count / cols) - 1) / 2) * spacing;
      }

      if (!this.waypointQueues.has(eid)) {
        this.waypointQueues.set(eid, []);
      }

      if (MoveTarget.active[eid] === 0) {
        MoveTarget.x[eid] = x + offX;
        MoveTarget.z[eid] = z + offZ;
        MoveTarget.active[eid] = 1;
      } else {
        this.waypointQueues.get(eid)!.push({ x: x + offX, z: z + offZ });
      }
    }

    EventBus.emit('unit:move', { entityIds: [...entityIds], x, z });
  }

  issueAttackCommand(entityIds: number[], targetEid: number): void {
    for (const eid of entityIds) {
      AttackTarget.entityId[eid] = targetEid;
      AttackTarget.active[eid] = 1;
      this.waypointQueues.delete(eid);
    }
    EventBus.emit('unit:attack', { attackerIds: [...entityIds], targetId: targetEid });
  }

  private issueAttackMoveCommand(entityIds: number[], x: number, z: number): void {
    // Move to position but attack anything encountered en route
    // Note: issueMoveCommand calls clearAttackMove, so we call setAttackMove AFTER
    this.issueMoveCommand(entityIds, x, z);
    // Tag these units for attack-move in combat system (reads MoveTarget with formation offsets)
    this.combatSystem?.setAttackMove(entityIds);
    for (const eid of entityIds) {
      AttackTarget.active[eid] = 0; // Will auto-acquire in CombatSystem
    }
  }

  private issuePatrolCommand(entityIds: number[], targetX: number, targetZ: number): void {
    for (const eid of entityIds) {
      this.waypointQueues.delete(eid);
      const startX = Position.x[eid];
      const startZ = Position.z[eid];
      this.patrolEntities.set(eid, { startX, startZ, endX: targetX, endZ: targetZ });
      MoveTarget.x[eid] = targetX;
      MoveTarget.z[eid] = targetZ;
      MoveTarget.active[eid] = 1;
      AttackTarget.active[eid] = 0; // Auto-acquire handles combat
    }
  }

  private issueStopCommand(entityIds: number[]): void {
    for (const eid of entityIds) {
      MoveTarget.active[eid] = 0;
      AttackTarget.active[eid] = 0;
      this.waypointQueues.delete(eid);
      this.patrolEntities.delete(eid);
    }
    this.combatSystem?.clearAttackMove(entityIds);
  }

  private issueGuardCommand(entityIds: number[]): void {
    // Stop moving, set guard position to current location, auto-acquire in range
    for (const eid of entityIds) {
      MoveTarget.active[eid] = 0;
      this.waypointQueues.delete(eid);
      this.patrolEntities.delete(eid);
      this.combatSystem?.clearEscortTarget(eid);
      // Store current position as guard point — unit returns here after combat
      this.combatSystem?.setGuardPosition(eid, Position.x[eid], Position.z[eid]);
    }
    this.combatSystem?.clearAttackMove(entityIds);
    this.audioManager?.playSfx('select');
  }

  issueScatterCommand(entityIds: number[]): void {
    if (entityIds.length === 0) return;

    // Calculate group centroid
    let cx = 0, cz = 0;
    for (const eid of entityIds) {
      cx += Position.x[eid];
      cz += Position.z[eid];
    }
    cx /= entityIds.length;
    cz /= entityIds.length;

    // Move each unit away from center
    const scatterDist = 6;
    for (const eid of entityIds) {
      let dx = Position.x[eid] - cx;
      let dz = Position.z[eid] - cz;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.5) {
        // Units at center: give random direction
        const angle = Math.random() * Math.PI * 2;
        dx = Math.cos(angle);
        dz = Math.sin(angle);
      } else {
        dx /= len;
        dz /= len;
      }
      MoveTarget.x[eid] = Position.x[eid] + dx * scatterDist;
      MoveTarget.z[eid] = Position.z[eid] + dz * scatterDist;
      MoveTarget.active[eid] = 1;
      AttackTarget.active[eid] = 0;
      this.waypointQueues.delete(eid);
      this.patrolEntities.delete(eid);
    }
    this.combatSystem?.clearAttackMove(entityIds);
    this.audioManager?.playSfx('select');
  }

  private issueEscortCommand(entityIds: number[], targetEid: number): void {
    for (const eid of entityIds) {
      this.waypointQueues.delete(eid);
      this.patrolEntities.delete(eid);
      this.combatSystem?.clearAttackMove([eid]);
      this.combatSystem?.setEscortTarget(eid, targetEid);
      // Set initial guard position to target's current position
      this.combatSystem?.setGuardPosition(eid, Position.x[targetEid], Position.z[targetEid]);
      // Start moving toward the target
      MoveTarget.x[eid] = Position.x[targetEid] + (Math.random() - 0.5) * 3;
      MoveTarget.z[eid] = Position.z[targetEid] + (Math.random() - 0.5) * 3;
      MoveTarget.active[eid] = 1;
      AttackTarget.active[eid] = 0;
    }
  }
}
