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

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 2) return; // Right-click only

    const selected = this.selectionManager.getSelectedEntities();
    if (selected.length === 0) return;

    const shiftHeld = e.shiftKey;

    // Check if right-clicked on a unit
    const targetEid = this.unitRenderer.getEntityAtScreen(e.clientX, e.clientY);
    if (targetEid !== null) {
      const targetOwner = Owner.playerId[targetEid];
      const selectedOwner = Owner.playerId[selected[0]];
      if (targetOwner === selectedOwner && !selected.includes(targetEid)) {
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

    // Move command
    const worldPos = this.sceneManager.screenToWorld(e.clientX, e.clientY);
    if (!worldPos) return;

    // Check if a building is selected — set rally point instead of move
    const hasBuildingSel = this.world && selected.some(eid => hasComponent(this.world, BuildingType, eid));
    if (hasBuildingSel && this.commandMode === 'normal' && !shiftHeld) {
      this.rallyPoints.set(0, { x: worldPos.x, z: worldPos.z });
      EventBus.emit('rally:set', { playerId: 0, x: worldPos.x, z: worldPos.z });
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
    } else if (this.commandMode === 'patrol') {
      this.issuePatrolCommand(selected, worldPos.x, worldPos.z);
      this.audioManager?.playUnitVoiceOrSfx('move', cat, selected[0]);
      this.commandMode = 'normal';
      document.body.style.cursor = 'default';
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
        // Attack-move mode
        if (selected.length > 0) {
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

      case 'escape':
        if (this.commandMode !== 'normal') {
          this.commandMode = 'normal';
          document.body.style.cursor = 'default';
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

    // Formation spreading
    const count = entityIds.length;
    const cols = Math.ceil(Math.sqrt(count));
    const spacing = 2.5;

    for (let i = 0; i < entityIds.length; i++) {
      const eid = entityIds[i];
      const row = Math.floor(i / cols);
      const col = i % cols;
      const offsetX = (col - (cols - 1) / 2) * spacing;
      const offsetZ = (row - (Math.ceil(count / cols) - 1) / 2) * spacing;

      MoveTarget.x[eid] = x + offsetX;
      MoveTarget.z[eid] = z + offsetZ;
      MoveTarget.active[eid] = 1;

      // Clear attack target when move is issued
      AttackTarget.active[eid] = 0;
    }

    EventBus.emit('unit:move', { entityIds: [...entityIds], x, z });
  }

  private addWaypoint(entityIds: number[], x: number, z: number): void {
    const count = entityIds.length;
    const cols = Math.ceil(Math.sqrt(count));
    const spacing = 2.5;

    for (let i = 0; i < entityIds.length; i++) {
      const eid = entityIds[i];
      const row = Math.floor(i / cols);
      const col = i % cols;
      const offsetX = (col - (cols - 1) / 2) * spacing;
      const offsetZ = (row - (Math.ceil(count / cols) - 1) / 2) * spacing;

      if (!this.waypointQueues.has(eid)) {
        this.waypointQueues.set(eid, []);
      }

      // If unit is idle, start moving immediately
      if (MoveTarget.active[eid] === 0) {
        MoveTarget.x[eid] = x + offsetX;
        MoveTarget.z[eid] = z + offsetZ;
        MoveTarget.active[eid] = 1;
      } else {
        this.waypointQueues.get(eid)!.push({ x: x + offsetX, z: z + offsetZ });
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
