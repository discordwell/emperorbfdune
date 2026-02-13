import type { World } from '../core/ECS';
import { MoveTarget, Position, AttackTarget } from '../core/ECS';
import type { SceneManager } from '../rendering/SceneManager';
import type { SelectionManager } from './SelectionManager';
import type { UnitRenderer } from '../rendering/UnitRenderer';
import { EventBus } from '../core/EventBus';

export class CommandManager {
  private sceneManager: SceneManager;
  private selectionManager: SelectionManager;
  private unitRenderer: UnitRenderer;

  constructor(sceneManager: SceneManager, selectionManager: SelectionManager, unitRenderer: UnitRenderer) {
    this.sceneManager = sceneManager;
    this.selectionManager = selectionManager;
    this.unitRenderer = unitRenderer;

    window.addEventListener('mouseup', this.onMouseUp);
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 2) return; // Right-click only

    const selected = this.selectionManager.getSelectedEntities();
    if (selected.length === 0) return;

    // Check if right-clicked on an enemy unit
    const targetEid = this.unitRenderer.getEntityAtScreen(e.clientX, e.clientY);
    if (targetEid !== null) {
      // Attack command
      this.issueAttackCommand(selected, targetEid);
      return;
    }

    // Move command
    const worldPos = this.sceneManager.screenToWorld(e.clientX, e.clientY);
    if (!worldPos) return;

    this.issueMoveCommand(selected, worldPos.x, worldPos.z);
  };

  issueMoveCommand(entityIds: number[], x: number, z: number): void {
    // Formation spreading: offset each unit slightly
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

  issueAttackCommand(entityIds: number[], targetEid: number): void {
    for (const eid of entityIds) {
      AttackTarget.entityId[eid] = targetEid;
      AttackTarget.active[eid] = 1;
    }
    EventBus.emit('unit:attack', { attackerIds: [...entityIds], targetId: targetEid });
  }
}
