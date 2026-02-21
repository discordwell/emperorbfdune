import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from 'bitecs';

import { CombatSystem } from '../../src/simulation/CombatSystem';
import type { GameRules } from '../../src/config/RulesParser';
import { EventBus } from '../../src/core/EventBus';
import {
  addComponent,
  addEntity,
  AttackTarget,
  Combat,
  Health,
  Owner,
  Position,
} from '../../src/core/ECS';

function makeRules(): GameRules {
  return {
    general: {},
    spiceMound: {},
    houseTypes: [],
    terrainTypes: [],
    armourTypes: ['None'],
    units: new Map(),
    buildings: new Map(),
    turrets: new Map(),
    bullets: new Map(),
    warheads: new Map(),
  } as unknown as GameRules;
}

function spawnAttacker(world: ReturnType<typeof createWorld>, owner: number, x: number, z: number): number {
  const eid = addEntity(world);
  addComponent(world, Position, eid);
  addComponent(world, Health, eid);
  addComponent(world, Owner, eid);
  addComponent(world, Combat, eid);
  addComponent(world, AttackTarget, eid);
  Position.x[eid] = x;
  Position.y[eid] = 0;
  Position.z[eid] = z;
  Health.current[eid] = 200;
  Health.max[eid] = 200;
  Owner.playerId[eid] = owner;
  return eid;
}

function spawnTarget(world: ReturnType<typeof createWorld>, owner: number, x: number, z: number): number {
  const eid = addEntity(world);
  addComponent(world, Position, eid);
  addComponent(world, Health, eid);
  addComponent(world, Owner, eid);
  Position.x[eid] = x;
  Position.y[eid] = 0;
  Position.z[eid] = z;
  Health.current[eid] = 200;
  Health.max[eid] = 200;
  Owner.playerId[eid] = owner;
  return eid;
}

describe('CombatSystem events', () => {
  beforeEach(() => {
    EventBus.clear();
  });

  it('emits unit:attacked and combat:fire from update() fire path', () => {
    const world = createWorld();
    const system = new CombatSystem(makeRules());
    system.init(world);

    const attacker = spawnAttacker(world, 0, 10, 10);
    const target = spawnTarget(world, 1, 11, 11);

    AttackTarget.entityId[attacker] = target;
    AttackTarget.active[attacker] = 1;
    Combat.attackRange[attacker] = 25;
    Combat.fireTimer[attacker] = 0;
    Combat.rof[attacker] = 7;

    const attacked = vi.fn();
    const fire = vi.fn();
    EventBus.on('unit:attacked', attacked);
    EventBus.on('combat:fire', fire);

    system.update(world, 0);

    expect(attacked).toHaveBeenCalledTimes(1);
    expect(attacked).toHaveBeenCalledWith({ attackerEid: attacker, targetEid: target });
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({
      attackerEntity: attacker,
      targetEntity: target,
    }));
    expect(Combat.fireTimer[attacker]).toBe(7);
    expect(Health.current[target]).toBeLessThan(200);
  });

  it('does not emit attack events while attacker is on cooldown', () => {
    const world = createWorld();
    const system = new CombatSystem(makeRules());
    system.init(world);

    const attacker = spawnAttacker(world, 0, 20, 20);
    const target = spawnTarget(world, 1, 21, 21);

    AttackTarget.entityId[attacker] = target;
    AttackTarget.active[attacker] = 1;
    Combat.attackRange[attacker] = 25;
    Combat.fireTimer[attacker] = 2;
    Combat.rof[attacker] = 7;

    const attacked = vi.fn();
    EventBus.on('unit:attacked', attacked);

    system.update(world, 0);

    expect(attacked).not.toHaveBeenCalled();
    expect(Combat.fireTimer[attacker]).toBe(1);
    expect(Health.current[target]).toBe(200);
  });
});
