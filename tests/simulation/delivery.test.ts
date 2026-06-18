import { describe, it, expect } from 'vitest';
import { createWorld } from 'bitecs';

import { DeliverySystem } from '../../src/simulation/DeliverySystem';
import { MovementSystem } from '../../src/simulation/MovementSystem';
import { PathfindingSystem } from '../../src/simulation/PathfindingSystem';
import {
  addComponent,
  addEntity,
  Health,
  movableQuery,
  Owner,
  Position,
} from '../../src/core/ECS';

/**
 * Regression test for the Carryall delivery speed bug.
 *
 * DeliverySystem assigns CARRYALL_SPEED to Speed.max, and MovementSystem scales
 * velocity by a per-tick factor (0.04). The old value (0.6) produced ~0.024
 * world-units/tick — roughly 33x slower than a normal ground unit — so scripted
 * carryall reinforcements took minutes to arrive and effectively never spawned.
 * The fix uses the real Carryall rules speed (~24), giving ~0.96 units/tick.
 *
 * This drives a real MovementSystem (the thing that actually moves the carryall)
 * and asserts the delivery completes — units spawn — within a sane tick budget.
 * Under the old speed, the carryall would still be crawling toward the drop point
 * at the end of the budget and nothing would spawn.
 */
function makeContext() {
  const world = createWorld();
  const movement = new MovementSystem(new PathfindingSystem(null as any));
  movement.setMapBounds(1000, 1000); // large map so the carryall isn't clamped

  let tick = 0;
  const descendingUnits = new Map<number, { startTick: number; duration: number }>();
  const spawned: number[] = [];

  const ctx: any = {
    game: {
      getWorld: () => world,
      getTickCount: () => tick,
    },
    movement,
    typeRegistry: {
      unitTypeIdMap: new Map<string, number>([['Carryall', 1]]),
      buildingTypeIdMap: new Map<string, number>(),
    },
    unitRenderer: { setEntityModel: () => {} },
    combatSystem: { setSuppressed: () => {} },
    effectsManager: { spawnExplosion: () => {} },
    descendingUnits,
    spawnUnit: (w: typeof world, _name: string, side: number, x: number, z: number) => {
      const e = addEntity(w);
      addComponent(w, Position, e);
      addComponent(w, Health, e);
      addComponent(w, Owner, e);
      Position.x[e] = x;
      Position.z[e] = z;
      Health.current[e] = 100;
      Health.max[e] = 100;
      Owner.playerId[e] = side;
      spawned.push(e);
      return e;
    },
  };

  return {
    ctx,
    world,
    movement,
    spawned,
    setTick: (t: number) => { tick = t; },
  };
}

describe('DeliverySystem carryall speed', () => {
  it('completes a carryall delivery (spawns units) within a sane tick budget', () => {
    const { ctx, world, movement, spawned, setTick } = makeContext();
    const delivery = new DeliverySystem();

    delivery.queueDelivery(ctx, {
      side: 0,
      typeNames: ['ATLightInf'],
      destX: 40,
      destZ: 0,
      entranceX: 0,
      entranceZ: 0,
      kind: 'carryall',
    });

    let completedTick = -1;
    for (let t = 0; t < 250; t++) {
      setTick(t);
      movement.update(world, 40);
      delivery.update(ctx);
      if (spawned.length > 0 && completedTick < 0) completedTick = t;
    }

    // The unit must actually be delivered...
    expect(spawned.length).toBe(1);
    // ...and reasonably quickly. A 40-unit flight at ~0.96 units/tick plus the
    // hover/drop phases lands well under 120 ticks. The old 0.6 speed would not
    // even finish flying in within the 250-tick budget (so spawned would be 0).
    expect(completedTick).toBeGreaterThan(0);
    expect(completedTick).toBeLessThan(120);
    // Delivery cleans itself up after flying back out.
    expect(delivery.getActiveCount()).toBeLessThanOrEqual(1);
  });

  it('makes meaningful per-tick progress (not the ~33x-too-slow old value)', () => {
    const { ctx, world, movement, setTick } = makeContext();
    const delivery = new DeliverySystem();

    delivery.queueDelivery(ctx, {
      side: 0,
      typeNames: ['ATLightInf'],
      destX: 200,
      destZ: 0,
      entranceX: 0,
      entranceZ: 0,
      kind: 'carryall',
    });

    // The carryall is the only entity with the full movement component set
    // (delivered units only get Position/Health/Owner in this harness).
    const carryall = movableQuery(world)[0];
    expect(carryall).toBeDefined();

    // After 25 ticks (~1 simulated second) a correctly-tuned carryall has moved
    // many world units toward the far destination; the old 0.024 units/tick value
    // would have advanced well under 1 unit total.
    for (let t = 0; t <= 25; t++) {
      setTick(t);
      movement.update(world, 40);
      delivery.update(ctx);
    }
    expect(Position.x[carryall]).toBeGreaterThan(5);
  });
});
