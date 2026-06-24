import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'bitecs';

import { AIPlayer } from '../../src/ai/AIPlayer';
import { EventBus } from '../../src/core/EventBus';
import { addComponent, addEntity, Health, Owner, Position } from '../../src/core/ECS';

type TestWorld = ReturnType<typeof createWorld>;

/**
 * Regression test for the StrategyRunner recycle-hijack bug.
 *
 * The data-driven AI's StrategyRunner tracks assigned units by bitecs entity id
 * and prunes/commands them through the StrategyWorldView. Its `isUnitAlive`
 * predicate (the gate `executeStep` and `cleanupDeadUnits` use before issuing
 * move/attack orders) checked only Health > 0 — never ownership. bitecs recycles
 * ids on removeEntity, so a dead assignee's id can be reused by ANOTHER player's
 * unit before the next strategy tick prunes it; the runner would then keep the
 * (now foreign) unit assigned and issue it orders. Same class as the already-fixed
 * scoutEntities bug. The fix re-validates Owner.playerId in the world view.
 */

function makeAI(playerId: number): AIPlayer {
  const rulesStub = { units: new Map() } as any;
  const ai = new AIPlayer(rulesStub, {} as any, playerId, 50, 50, 200, 200);
  ai.setMapDimensions(64, 64);
  return ai;
}

function spawnUnit(world: TestWorld, owner: number, health = 100): number {
  const eid = addEntity(world);
  addComponent(world, Health, eid);
  addComponent(world, Owner, eid);
  addComponent(world, Position, eid);
  Health.max[eid] = 100;
  Health.current[eid] = health;
  Owner.playerId[eid] = owner;
  Position.x[eid] = 120;
  Position.z[eid] = 120;
  return eid;
}

describe('AIPlayer strategy world view ownership', () => {
  beforeEach(() => {
    EventBus.clear();
  });

  it('treats a live, foreign-owned (recycled) id as not a valid assignee', () => {
    const ai = makeAI(1);
    const world = createWorld();
    const worldView = (ai as any).createStrategyWorldView(world);

    // A living unit owned by player 0 that reused a dead AI assignee's id.
    const recycled = spawnUnit(world, 0);

    // The StrategyRunner's command/prune gate must reject it...
    expect(worldView.isUnitAlive(recycled)).toBe(false);
    // ...and position reads (used for step-completion) must not see it either.
    expect(worldView.getUnitPosition(recycled)).toBeNull();
  });

  it('still tracks and commands this AI\'s own living units', () => {
    const ai = makeAI(1);
    const world = createWorld();
    const worldView = (ai as any).createStrategyWorldView(world);

    const own = spawnUnit(world, 1);
    expect(worldView.isUnitAlive(own)).toBe(true);
    expect(worldView.getUnitPosition(own)).toEqual({ x: 120, z: 120 });

    // moveUnit on an owned unit activates its MoveTarget as before.
    worldView.moveUnit(own, 200, 210);
    // (MoveTarget is written via the ECS arrays; the unit is now under orders.)
  });

  it('drops an own unit once it dies', () => {
    const ai = makeAI(1);
    const world = createWorld();
    const worldView = (ai as any).createStrategyWorldView(world);

    const dead = spawnUnit(world, 1, 0); // owned but dead
    expect(worldView.isUnitAlive(dead)).toBe(false);
    expect(worldView.getUnitPosition(dead)).toBeNull();
  });
});
