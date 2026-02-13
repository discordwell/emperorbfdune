import type { World } from '../core/ECS';
import { MoveTarget, Position, AttackTarget, Combat, Owner, Health, hasComponent } from '../core/ECS';
import type { SceneManager } from '../rendering/SceneManager';
import type { SelectionManager } from './SelectionManager';
import type { UnitRenderer } from '../rendering/UnitRenderer';
import { EventBus } from '../core/EventBus';
import type { AudioManager } from '../audio/AudioManager';

export type CommandMode = 'normal' | 'attack-move';

export class CommandManager {
  private sceneManager: SceneManager;
  private selectionManager: SelectionManager;
  private unitRenderer: UnitRenderer;
  private audioManager: AudioManager | null = null;

  private commandMode: CommandMode = 'normal';

  // Waypoint queue per entity
  private waypointQueues = new Map<number, Array<{ x: number; z: number }>>();

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

  getCommandMode(): CommandMode {
    return this.commandMode;
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
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 2) return; // Right-click only

    const selected = this.selectionManager.getSelectedEntities();
    if (selected.length === 0) return;

    const shiftHeld = e.shiftKey;

    // Check if right-clicked on an enemy unit
    const targetEid = this.unitRenderer.getEntityAtScreen(e.clientX, e.clientY);
    if (targetEid !== null) {
      this.issueAttackCommand(selected, targetEid);
      this.audioManager?.playSfx('attack');
      return;
    }

    // Move command
    const worldPos = this.sceneManager.screenToWorld(e.clientX, e.clientY);
    if (!worldPos) return;

    if (this.commandMode === 'attack-move') {
      this.issueAttackMoveCommand(selected, worldPos.x, worldPos.z);
      this.audioManager?.playSfx('move');
      this.commandMode = 'normal';
      document.body.style.cursor = 'default';
    } else if (shiftHeld) {
      this.addWaypoint(selected, worldPos.x, worldPos.z);
      this.audioManager?.playSfx('move');
    } else {
      this.issueMoveCommand(selected, worldPos.x, worldPos.z);
      this.audioManager?.playSfx('move');
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

      case 'escape':
        if (this.commandMode !== 'normal') {
          this.commandMode = 'normal';
          document.body.style.cursor = 'default';
        }
        break;
    }
  };

  issueMoveCommand(entityIds: number[], x: number, z: number): void {
    // Clear waypoints
    for (const eid of entityIds) {
      this.waypointQueues.delete(eid);
    }

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
    // Implementation: set move target AND set a temporary flag to auto-engage
    this.issueMoveCommand(entityIds, x, z);
    // The combat system's auto-acquire logic handles the "attack" part
    // For attack-move, we just ensure attack targets aren't cleared
    for (const eid of entityIds) {
      AttackTarget.active[eid] = 0; // Will auto-acquire in CombatSystem
    }
  }

  private issueStopCommand(entityIds: number[]): void {
    for (const eid of entityIds) {
      MoveTarget.active[eid] = 0;
      AttackTarget.active[eid] = 0;
      this.waypointQueues.delete(eid);
    }
  }

  private issueGuardCommand(entityIds: number[]): void {
    // Stop moving, but keep combat active (auto-acquire will handle it)
    for (const eid of entityIds) {
      MoveTarget.active[eid] = 0;
      this.waypointQueues.delete(eid);
      // Leave AttackTarget alone — auto-acquire in range handles the rest
    }
  }
}
