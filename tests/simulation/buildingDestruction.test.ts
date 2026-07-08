import { describe, expect, it } from 'vitest';

import { BuildingDestructionSystem } from '../../src/simulation/BuildingDestructionSystem';
import { CombatSystem } from '../../src/simulation/CombatSystem';
import type { GameRules } from '../../src/config/RulesParser';
import type { BuildingDef } from '../../src/config/BuildingDefs';

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

/** Minimal rendering-layer stubs — the destruction system only calls no-op visual hooks. */
function makeStubs() {
  const effectsManager = {
    spawnExplosion() {}, spawnDecal() {}, spawnWreckage() {},
  } as any;
  const sceneManager = { shake() {}, scene: { add() {}, remove() {} } } as any;
  const unitRenderer = { getEntityObject: () => null } as any;
  const audioManager = { playSfx() {} } as any;
  return { effectsManager, sceneManager, unitRenderer, audioManager };
}

function makeSystem(combat: CombatSystem): BuildingDestructionSystem {
  const { effectsManager, sceneManager, unitRenderer, audioManager } = makeStubs();
  return new BuildingDestructionSystem(
    effectsManager, sceneManager, unitRenderer, audioManager, combat,
  );
}

// A small (single-tile) building def — classifies as 'small', which removes the
// entity at tick 15 (PHASE_THRESHOLDS.small.total) via the shared removeEntity().
const SMALL_DEF = { wall: true, occupy: [[1]] } as unknown as BuildingDef;

describe('BuildingDestructionSystem — combat suppression cleanup', () => {
  it('suppresses combat while dying, then clears suppression when the entity is removed', () => {
    const combat = new CombatSystem(makeRules());
    const bds = makeSystem(combat);
    const suppressed = (combat as any).suppressedEntities as Set<number>;

    const eid = 42;
    // The real death handler runs unregisterUnit BEFORE startDestruction, so the
    // set is empty going in.
    expect(suppressed.has(eid)).toBe(false);

    const started = bds.startDestruction(eid, 10, 0, 10, 1, 'ATWall', SMALL_DEF);
    expect(started).toBe(true);
    // Building is now suppressed so its (still-in-query) corpse can't fire.
    expect(suppressed.has(eid)).toBe(true);

    // Mid-sequence the suppression must persist.
    const removed: number[] = [];
    const removeFn = (e: number) => removed.push(e);
    for (let t = 0; t < 5; t++) bds.update(removeFn);
    expect(bds.isDying(eid)).toBe(true);
    expect(suppressed.has(eid)).toBe(true);

    // Run out the rest of the small-destruction sequence (removes at tick 15).
    for (let t = 5; t < 15; t++) bds.update(removeFn);

    expect(removed).toContain(eid);
    expect(bds.isDying(eid)).toBe(false);
    // The fix: the eid must NOT be left behind in suppressedEntities. Otherwise a
    // future combat entity that recycles this bitecs id is silently skipped in the
    // firing loop and never shoots.
    expect(suppressed.has(eid)).toBe(false);
  });

  it('does not leak suppression across many building deaths', () => {
    const combat = new CombatSystem(makeRules());
    const bds = makeSystem(combat);
    const suppressed = (combat as any).suppressedEntities as Set<number>;

    for (let eid = 100; eid < 120; eid++) {
      bds.startDestruction(eid, 0, 0, 0, 1, 'ATWall', SMALL_DEF);
      for (let t = 0; t < 15; t++) bds.update(() => {});
    }

    // Every destroyed building cleaned up after itself.
    expect(suppressed.size).toBe(0);
  });
});
