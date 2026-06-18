import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'bitecs';

import { AIPlayer } from '../../src/ai/AIPlayer';
import { EventBus } from '../../src/core/EventBus';
import {
  addComponent,
  addEntity,
  Health,
  MoveTarget,
  Owner,
  Position,
} from '../../src/core/ECS';

type TestWorld = ReturnType<typeof createWorld>;

/** Minimal AI player whose only relevant state is the scout-tracking set. */
function makeAI(playerId: number): AIPlayer {
  // The constructor only stores rules/combatSystem; manageScouting never reads
  // them along the paths these tests exercise, so empty stubs are sufficient.
  const rulesStub = { units: new Map() } as any;
  const combatStub = {} as any;
  const ai = new AIPlayer(rulesStub, combatStub, playerId, 50, 50, 200, 200);
  ai.setMapDimensions(64, 64);
  return ai;
}

function spawnUnit(world: TestWorld, owner: number): number {
  const eid = addEntity(world);
  addComponent(world, Health, eid);
  addComponent(world, Owner, eid);
  addComponent(world, MoveTarget, eid);
  addComponent(world, Position, eid);
  Health.max[eid] = 100;
  Health.current[eid] = 100;
  Owner.playerId[eid] = owner;
  MoveTarget.active[eid] = 0;
  Position.x[eid] = 100;
  Position.z[eid] = 100;
  return eid;
}

describe('AIPlayer scout entity recycling', () => {
  beforeEach(() => {
    EventBus.clear();
  });

  it('drops a recycled, foreign-owned id and never commands it', () => {
    const ai = makeAI(1);
    const world = createWorld();

    // A live unit owned by the human (player 0) that happens to reuse the entity
    // id of a now-dead AI scout — bitecs recycles ids, and the scout prune only
    // ran on Health<=0 before the fix, so the id stayed "registered".
    const recycled = spawnUnit(world, 0);
    (ai as any).scoutEntities.add(recycled);

    (ai as any).manageScouting(world);

    // Must be dropped (no longer ours) and must NOT receive a scouting move order.
    expect((ai as any).scoutEntities.has(recycled)).toBe(false);
    expect(MoveTarget.active[recycled]).toBe(0);
  });

  it('keeps its own idle scout and assigns it a waypoint', () => {
    const ai = makeAI(1);
    const world = createWorld();

    const ownScout = spawnUnit(world, 1); // owned by this AI
    (ai as any).scoutEntities.add(ownScout);

    (ai as any).manageScouting(world);

    // Still ours → retained and sent toward an unexplored waypoint.
    expect((ai as any).scoutEntities.has(ownScout)).toBe(true);
    expect(MoveTarget.active[ownScout]).toBe(1);
  });

  it('drops a dead scout id', () => {
    const ai = makeAI(1);
    const world = createWorld();

    const deadScout = spawnUnit(world, 1);
    Health.current[deadScout] = 0;
    (ai as any).scoutEntities.add(deadScout);

    (ai as any).manageScouting(world);

    expect((ai as any).scoutEntities.has(deadScout)).toBe(false);
  });
});
