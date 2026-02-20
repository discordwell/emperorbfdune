/**
 * Executes mission script actions against the game context.
 *
 * Each action type maps to calls into existing game systems
 * (spawning, dialog, victory, fog of war, etc.).
 */

import type { Action, EntityGroupDef } from './MissionScriptTypes';
import type { EntityGroupTracker } from './EntityGroupTracker';
import type { GameContext } from '../../core/GameContext';
import type { VictoryCondition } from '../../ui/VictoryScreen';
import { getCampaignString } from '../CampaignData';
import { EventBus } from '../../core/EventBus';
import {
  Health, Owner, Position, MoveTarget,
  unitQuery, buildingQuery, UnitType, BuildingType,
} from '../../core/ECS';

export interface ActionContext {
  ctx: GameContext;
  groups: EntityGroupTracker;
  flags: Map<string, boolean>;
  disabledRules: Set<string>;
  groupDefs: Map<string, EntityGroupDef>;
}

export function executeAction(action: Action, actx: ActionContext): void {
  const { ctx, groups, flags, disabledRules, groupDefs } = actx;

  switch (action.type) {
    case 'spawnGroup': {
      const def = groupDefs.get(action.group);
      if (!def) {
        console.warn(`[MissionScript] Unknown group: ${action.group}`);
        return;
      }
      spawnGroupFromDef(def, actx);
      break;
    }

    case 'showDialog': {
      const text = getCampaignString(action.key);
      if (text) {
        // Show as a prominent game message
        ctx.selectionPanel.addMessage(text, '#ffcc44');
      }
      if (action.event) {
        // Also trigger a dialog spoken event if provided
        const dm = ctx.audioManager.getDialogManager();
        if (dm) {
          dm.trigger(action.event as any);
        }
      }
      break;
    }

    case 'setObjective':
      ctx.victorySystem.setObjectiveLabel(action.label);
      break;

    case 'grantCredits':
      ctx.harvestSystem.addSolaris(action.owner, action.amount);
      if (action.owner === 0) {
        ctx.selectionPanel.addMessage(`+${action.amount} Solaris`, '#ffd700');
      }
      break;

    case 'revealArea':
      ctx.fogOfWar.revealWorldArea(action.x, action.z, action.radius);
      break;

    case 'moveGroup': {
      const alive = groups.getAlive(action.group);
      for (const eid of alive) {
        MoveTarget.x[eid] = action.target.x;
        MoveTarget.z[eid] = action.target.z;
        MoveTarget.active[eid] = 1;
      }
      break;
    }

    case 'attackMoveGroup': {
      const alive = groups.getAlive(action.group);
      for (const eid of alive) {
        MoveTarget.x[eid] = action.target.x;
        MoveTarget.z[eid] = action.target.z;
        MoveTarget.active[eid] = 1;
      }
      ctx.combatSystem.setAttackMove(alive);
      break;
    }

    case 'setFlag':
      flags.set(action.name, action.value);
      break;

    case 'victory':
      ctx.victorySystem.forceVictory();
      break;

    case 'defeat':
      if (action.message) {
        ctx.selectionPanel.addMessage(action.message, '#ff4444');
      }
      ctx.victorySystem.forceDefeat();
      break;

    case 'setVictoryCondition':
      ctx.victorySystem.setVictoryCondition(action.condition as VictoryCondition);
      if (action.ticks) {
        ctx.victorySystem.setSurvivalTicks(action.ticks);
      }
      break;

    case 'playSound':
      ctx.audioManager.playSfx(action.sound as any);
      break;

    case 'cameraLook':
      ctx.scene.panTo(action.x, action.z);
      break;

    case 'spawnCrate': {
      const crateId = ctx.nextCrateId++;
      ctx.activeCrates.set(crateId, { x: action.x, z: action.z, type: action.crateType });
      ctx.effectsManager.spawnCrate(crateId, action.x, action.z, action.crateType);
      break;
    }

    case 'damageGroup': {
      const alive = groups.getAlive(action.group);
      for (const eid of alive) {
        Health.current[eid] = Math.max(0, Health.current[eid] - action.amount);
        if (Health.current[eid] <= 0) {
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
        }
      }
      break;
    }

    case 'changeOwner': {
      const alive = groups.getAlive(action.group);
      for (const eid of alive) {
        Owner.playerId[eid] = action.newOwner;
      }
      break;
    }

    case 'reinforcements': {
      const def = groupDefs.get(action.group);
      if (!def) {
        console.warn(`[MissionScript] Unknown group for reinforcements: ${action.group}`);
        return;
      }
      // Calculate edge spawn position
      const mapW = ctx.terrain.getMapWidth() * 2;
      const mapH = ctx.terrain.getMapHeight() * 2;
      let edgeX = mapW / 2, edgeZ = 5;
      switch (action.edge) {
        case 'north': edgeX = mapW / 2; edgeZ = 5; break;
        case 'south': edgeX = mapW / 2; edgeZ = mapH - 5; break;
        case 'east':  edgeX = mapW - 5; edgeZ = mapH / 2; break;
        case 'west':  edgeX = 5; edgeZ = mapH / 2; break;
        default: console.warn(`[MissionScript] Unknown edge: ${action.edge}`); break;
      }
      // Override spawn position to edge
      const edgeDef: EntityGroupDef = {
        ...def,
        spawnAt: { x: edgeX, z: edgeZ },
      };
      spawnGroupFromDef(edgeDef, actx);
      ctx.selectionPanel.addMessage('Reinforcements arriving!', '#44ff44');
      ctx.audioManager.getDialogManager()?.trigger('reinforcementsApproaching');
      break;
    }

    case 'enableRule':
      disabledRules.delete(action.ruleId);
      break;

    case 'disableRule':
      disabledRules.add(action.ruleId);
      break;

    case 'addMessage':
      ctx.selectionPanel.addMessage(action.text, action.color ?? '#ccc');
      break;
  }
}

/** Spawn entities from a group definition and register them with the tracker. */
function spawnGroupFromDef(def: EntityGroupDef, actx: ActionContext): void {
  const { ctx, groups } = actx;
  const world = ctx.game.getWorld();
  const entityIds: number[] = [];

  if (def.matchExisting) {
    // Match existing entities instead of spawning
    const m = def.matchExisting;
    const { unitTypeNames, buildingTypeNames } = ctx.typeRegistry;
    if (m.unitType) {
      const units = unitQuery(world);
      for (const eid of units) {
        if (Health.current[eid] <= 0) continue;
        if (Owner.playerId[eid] !== m.owner) continue;
        const typeId = UnitType.id[eid];
        const name = unitTypeNames[typeId] ?? '';
        if (!name.includes(m.unitType)) continue;
        if (m.near) {
          const dx = Position.x[eid] - m.near.x;
          const dz = Position.z[eid] - m.near.z;
          if (dx * dx + dz * dz > m.near.radius * m.near.radius) continue;
        }
        entityIds.push(eid);
      }
    }
    if (m.buildingType) {
      const buildings = buildingQuery(world);
      for (const eid of buildings) {
        if (Health.current[eid] <= 0) continue;
        if (Owner.playerId[eid] !== m.owner) continue;
        const typeId = BuildingType.id[eid];
        const name = buildingTypeNames[typeId] ?? '';
        if (!name.includes(m.buildingType)) continue;
        if (m.near) {
          const dx = Position.x[eid] - m.near.x;
          const dz = Position.z[eid] - m.near.z;
          if (dx * dx + dz * dz > m.near.radius * m.near.radius) continue;
        }
        entityIds.push(eid);
      }
    }
  } else {
    const sx = def.spawnAt?.x ?? 50;
    const sz = def.spawnAt?.z ?? 50;

    if (def.units) {
      for (const u of def.units) {
        for (let i = 0; i < u.count; i++) {
          const ox = (i % 5) * 2 - 4;
          const oz = Math.floor(i / 5) * 2;
          const eid = ctx.spawnUnit(world, u.type, u.owner, sx + ox, sz + oz);
          if (eid >= 0) entityIds.push(eid);
        }
      }
    }
    if (def.buildings) {
      for (const b of def.buildings) {
        const eid = ctx.spawnBuilding(world, b.type, b.owner, sx, sz);
        if (eid >= 0) entityIds.push(eid);
      }
    }
  }

  groups.registerGroup(def.name, entityIds);
}
