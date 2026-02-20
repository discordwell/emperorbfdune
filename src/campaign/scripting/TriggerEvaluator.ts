/**
 * Pure-function trigger evaluator for mission scripts.
 *
 * Evaluates a Trigger against the current game state and returns
 * whether it should fire. Handles composite triggers (and/or/not).
 */

import type { Trigger } from './MissionScriptTypes';
import type { EntityGroupTracker } from './EntityGroupTracker';
import type { GameContext } from '../../core/GameContext';
import {
  Health, Owner, UnitType, BuildingType,
  unitQuery, buildingQuery,
} from '../../core/ECS';

export interface TriggerContext {
  ctx: GameContext;
  currentTick: number;
  groups: EntityGroupTracker;
  flags: Map<string, boolean>;
  firedRules: Set<string>;
  repeatCounts: Map<string, number>;
  lastEventData: Map<string, any>;
}

function compare(actual: number, op: string, value: number): boolean {
  switch (op) {
    case '<': return actual < value;
    case '<=': return actual <= value;
    case '==': return actual === value;
    case '>=': return actual >= value;
    case '>': return actual > value;
    default: return false;
  }
}

export function evaluateTrigger(trigger: Trigger, tctx: TriggerContext): boolean {
  switch (trigger.type) {
    case 'timer':
      return tctx.currentTick >= trigger.tick;

    case 'timerRepeat': {
      const start = trigger.start ?? 0;
      if (tctx.currentTick < start) return false;
      const elapsed = tctx.currentTick - start;
      return elapsed % trigger.interval === 0;
    }

    case 'event': {
      const data = tctx.lastEventData.get(trigger.event);
      if (!data) return false;
      if (trigger.filter) {
        for (const [key, value] of Object.entries(trigger.filter)) {
          if (data[key] !== value) return false;
        }
      }
      return true;
    }

    case 'groupDefeated':
      return tctx.groups.isDefeated(trigger.group);

    case 'groupReachedArea':
      return tctx.groups.isGroupInArea(
        trigger.group,
        trigger.area.x,
        trigger.area.z,
        trigger.area.radius,
      );

    case 'buildingCount': {
      const world = tctx.ctx.game.getWorld();
      const buildings = buildingQuery(world);
      const { buildingTypeNames } = tctx.ctx.typeRegistry;
      let count = 0;
      for (const eid of buildings) {
        if (Health.current[eid] <= 0) continue;
        if (Owner.playerId[eid] !== trigger.owner) continue;
        if (trigger.typeName) {
          const typeId = BuildingType.id[eid];
          const name = buildingTypeNames[typeId] ?? '';
          if (!name.includes(trigger.typeName)) continue;
        }
        count++;
      }
      return compare(count, trigger.comparison, trigger.value);
    }

    case 'unitCount': {
      const world = tctx.ctx.game.getWorld();
      const units = unitQuery(world);
      const { unitTypeNames } = tctx.ctx.typeRegistry;
      let count = 0;
      for (const eid of units) {
        if (Health.current[eid] <= 0) continue;
        if (Owner.playerId[eid] !== trigger.owner) continue;
        if (trigger.typeName) {
          const typeId = UnitType.id[eid];
          const name = unitTypeNames[typeId] ?? '';
          if (!name.includes(trigger.typeName)) continue;
        }
        count++;
      }
      return compare(count, trigger.comparison, trigger.value);
    }

    case 'flag': {
      const expected = trigger.value ?? true;
      const actual = tctx.flags.get(trigger.name) ?? false;
      return actual === expected;
    }

    case 'and':
      return trigger.triggers.every(t => evaluateTrigger(t, tctx));

    case 'or':
      return trigger.triggers.some(t => evaluateTrigger(t, tctx));

    case 'not':
      return !evaluateTrigger(trigger.trigger, tctx);

    default:
      return false;
  }
}
