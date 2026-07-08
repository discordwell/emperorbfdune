import { describe, expect, it, vi } from 'vitest';
import { createWorld } from 'bitecs';

import { buildSaveData, restoreFromSave } from '../../src/core/SaveLoadSystem';
import type { SaveData } from '../../src/core/GameContext';
import { simRng } from '../../src/utils/DeterministicRNG';

type World = ReturnType<typeof createWorld>;
type Crate = { x: number; z: number; type: string };

/**
 * Regression test for uncollected pickup crates (ctx.activeCrates / ctx.nextCrateId):
 *  - These are non-ECS gameplay state, spawned deterministically off simRng in the
 *    tick handler and gated by `activeCrates.size < 3`. buildSaveData/restoreFromSave
 *    never persisted them, so a save->load dropped every crate on the map (forfeiting
 *    its solaris/XP/heal payout) AND desynced the shared RNG stream: after load the
 *    next `%1000===500` spawn check sees size 0 instead of the saved size, so it draws
 *    (or skips) differently, shifting every later simRng consumer. Now they round-trip.
 */

function makeSaveCtx(world: World, crates: Map<number, Crate>, nextCrateId: number) {
  return {
    game: { getWorld: () => world, getTickCount: () => 0 },
    typeRegistry: { unitTypeNames: [] as string[], buildingTypeNames: [] as string[] },
    totalPlayers: 2,
    activeMapId: null,
    activeMissionConfig: null,
    groundSplats: [] as unknown[],
    stormWaitTimer: 0,
    activeCrates: crates,
    nextCrateId,
    house: {
      prefix: 'AT', enemyPrefix: 'HK', name: 'Atreides', enemyName: 'Harkonnen',
      gameMode: 'skirmish', difficulty: 'normal', mapChoice: 0, skirmishOptions: {},
      opponents: [], campaignTerritoryId: undefined, subhouse: undefined,
    },
    abilitySystem: {
      getTransportPassengers: () => new Map<number, number[]>(),
      getAbilityState: () => ({ deviated: [], leech: [], kobraDeployed: [], kobraBaseRange: [] }),
    },
    deliverySystem: { getActiveCarryallEids: () => [] as number[] },
    aircraftAmmo: new Map<number, number>(),
    combatSystem: {
      getStance: () => 1, getGuardPosition: () => null,
      isAttackMove: () => false, getAttackMoveDestination: () => null,
    },
    harvestSystem: { getSolaris: () => 0 },
    productionSystem: { getState: () => ({}) },
    fogOfWar: { getExploredData: () => [] },
    sandwormSystem: { serialize: () => ({ worms: [], tickCounter: 0, thumpers: [], attractSides: [], repelSides: [] }) },
    superweaponSystem: { getChargeState: () => ({}) },
    victorySystem: { getTickCounter: () => 0 },
    selectionManager: { getControlGroups: () => new Map() },
    terrain: { getMapWidth: () => 2, getMapHeight: () => 2, getSpice: () => 0 },
    missionScriptRunner: undefined,
  } as any;
}

function makeRestoreCtx(world: World) {
  const spawnCrate = vi.fn();
  const clearAllCrates = vi.fn();
  const ctx = {
    game: { getWorld: () => world, setTickCount: vi.fn() },
    typeRegistry: { unitTypeNames: [] as string[], buildingTypeNames: [] as string[] },
    harvestSystem: { addSolaris: vi.fn(), getSolaris: () => 0 },
    terrain: {
      getMapWidth: () => 0, getMapHeight: () => 0,
      setSpice: vi.fn(), updateSpiceVisuals: vi.fn(), getHeightAt: () => 0,
    },
    deferredActions: [] as unknown[],
    descendingUnits: new Map(),
    fogOfWar: { setExploredData: vi.fn() },
    superweaponSystem: { setChargeState: vi.fn() },
    victorySystem: { setTickCounter: vi.fn() },
    selectionManager: { setControlGroups: vi.fn() },
    abilitySystem: { restoreAbilityState: vi.fn() },
    productionSystem: { restoreState: vi.fn() },
    sandwormSystem: { deserialize: vi.fn() },
    combatSystem: {
      setSuppressed: vi.fn(), setStance: vi.fn(),
      setGuardPosition: vi.fn(), restoreAttackMove: vi.fn(),
    },
    movement: { isFlyer: () => false },
    commandManager: { getRallyPoint: () => null },
    effectsManager: {
      clearAllGroundSplats: vi.fn(), stopSandstorm: vi.fn(), spawnGroundSplat: vi.fn(),
      clearAllCrates, spawnCrate,
    },
    scene: { cameraTarget: { set: vi.fn() }, updateCameraPosition: vi.fn() },
    groundSplats: [] as unknown[],
    activeCrates: new Map<number, Crate>(),
    nextCrateId: 0,
    aiPlayers: [],
    activeStormListener: null,
    missionScriptRunner: null,
    stormWaitTimer: 0,
  } as any;
  return { ctx, spawnCrate, clearAllCrates };
}

function baseSave(extra: Partial<SaveData>): SaveData {
  return {
    version: 1, tick: 500,
    housePrefix: 'AT', enemyPrefix: 'HK', houseName: 'Atreides', enemyName: 'Harkonnen',
    solaris: [], entities: [], spice: [],
    ...extra,
  } as SaveData;
}

describe('save/load crates', () => {
  it('buildSaveData persists active crates and the id counter', () => {
    const world = createWorld();
    const crates = new Map<number, Crate>([
      [3, { x: 30, z: 40, type: 'credits' }],
      [4, { x: 50, z: 60, type: 'heal' }],
    ]);
    const save = buildSaveData(makeSaveCtx(world, crates, 7));

    expect(save.nextCrateId).toBe(7);
    expect(save.crates).toEqual([
      { id: 3, x: 30, z: 40, type: 'credits' },
      { id: 4, x: 50, z: 60, type: 'heal' },
    ]);
  });

  it('omits the crates array when there are none (compact save)', () => {
    const world = createWorld();
    const save = buildSaveData(makeSaveCtx(world, new Map(), 0));
    expect(save.crates).toBeUndefined();
  });

  it('restoreFromSave repopulates the map, rebuilds visuals, and restores the counter', () => {
    const world = createWorld();
    const { ctx, spawnCrate, clearAllCrates } = makeRestoreCtx(world);

    restoreFromSave(ctx, baseSave({
      rngState: [1, 2, 3, 4],
      crates: [
        { id: 3, x: 30, z: 40, type: 'credits' },
        { id: 4, x: 50, z: 60, type: 'heal' },
      ],
      nextCrateId: 7,
    }));

    // The Map is rebuilt exactly (before the fix it stayed empty).
    expect(ctx.activeCrates.size).toBe(2);
    expect(ctx.activeCrates.get(3)).toEqual({ x: 30, z: 40, type: 'credits' });
    expect(ctx.activeCrates.get(4)).toEqual({ x: 50, z: 60, type: 'heal' });
    expect(ctx.nextCrateId).toBe(7);

    // Stale visuals cleared first, then one mesh spawned per restored crate.
    expect(clearAllCrates).toHaveBeenCalledTimes(1);
    expect(spawnCrate).toHaveBeenCalledTimes(2);
    expect(spawnCrate).toHaveBeenCalledWith(3, 30, 40, 'credits');
    expect(spawnCrate).toHaveBeenCalledWith(4, 50, 60, 'heal');
  });

  it('restore consumes no RNG draw (crates restored verbatim, not re-rolled)', () => {
    const world = createWorld();
    const { ctx } = makeRestoreCtx(world);
    const rngState: [number, number, number, number] = [123, 456, 789, 1011];

    // stormWaitTimer is supplied so the (unrelated) legacy storm reseed doesn't draw,
    // isolating the crate restore path.
    restoreFromSave(ctx, baseSave({
      rngState, stormWaitTimer: 500,
      crates: [{ id: 1, x: 10, z: 10, type: 'veterancy' }], nextCrateId: 2,
    }));

    // Crate restoration must not touch simRng — the size-gate desync fix depends on
    // the restored crates matching the saved size without perturbing the stream.
    expect(simRng.getState()).toEqual(rngState);
  });

  it('round-trips crates through save then restore', () => {
    const world = createWorld();
    const crates = new Map<number, Crate>([
      [1, { x: 12, z: 34, type: 'credits' }],
      [2, { x: 56, z: 78, type: 'veterancy' }],
    ]);
    const save = buildSaveData(makeSaveCtx(world, crates, 9));

    const { ctx } = makeRestoreCtx(createWorld());
    restoreFromSave(ctx, baseSave({ rngState: [1, 2, 3, 4], crates: save.crates, nextCrateId: save.nextCrateId }));

    expect(ctx.activeCrates).toEqual(crates);
    expect(ctx.nextCrateId).toBe(9);
  });

  it('handles legacy saves with no crate fields (clears map, no crash)', () => {
    const world = createWorld();
    const { ctx, spawnCrate, clearAllCrates } = makeRestoreCtx(world);
    ctx.activeCrates.set(99, { x: 1, z: 1, type: 'credits' }); // stale pre-restore state
    ctx.nextCrateId = 42;

    restoreFromSave(ctx, baseSave({ rngState: [1, 2, 3, 4] })); // no crates / nextCrateId

    expect(ctx.activeCrates.size).toBe(0); // cleared, not left stale
    expect(clearAllCrates).toHaveBeenCalledTimes(1);
    expect(spawnCrate).not.toHaveBeenCalled();
    expect(ctx.nextCrateId).toBe(42); // legacy save leaves the counter untouched
  });
});
