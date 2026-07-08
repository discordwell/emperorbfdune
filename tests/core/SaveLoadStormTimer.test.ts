import { describe, expect, it, vi } from 'vitest';
import { createWorld } from 'bitecs';

import { buildSaveData, restoreFromSave } from '../../src/core/SaveLoadSystem';
import type { SaveData } from '../../src/core/GameContext';
import { GameConstants } from '../../src/utils/Constants';
import { simRng } from '../../src/utils/DeterministicRNG';

type World = ReturnType<typeof createWorld>;

/**
 * Regression test for the sandstorm countdown (stormWaitTimer):
 *  - buildSaveData never persisted it, and restoreFromSave re-rolled it with a
 *    fresh simRng.random() draw on every load. That (a) randomised the storm
 *    cadence after each save and (b) consumed an RNG draw, so a save->load
 *    diverged from an unsaved run. Now it round-trips and restore draws no RNG.
 */

function makeSaveCtx(world: World) {
  return {
    game: { getWorld: () => world, getTickCount: () => 0 },
    typeRegistry: { unitTypeNames: [] as string[], buildingTypeNames: [] as string[] },
    totalPlayers: 2,
    activeMapId: null,
    activeMissionConfig: null,
    groundSplats: [] as unknown[],
    stormWaitTimer: 0,
    activeCrates: new Map<number, { x: number; z: number; type: string }>(),
    nextCrateId: 0,
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
  return {
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
    sandwormSystem: { deserialize: vi.fn(), getRiderEids: () => new Set<number>() },
    combatSystem: {
      setSuppressed: vi.fn(), setStance: vi.fn(),
      setGuardPosition: vi.fn(), restoreAttackMove: vi.fn(),
    },
    movement: { isFlyer: () => false },
    commandManager: { getRallyPoint: () => null },
    effectsManager: {
      clearAllGroundSplats: vi.fn(), stopSandstorm: vi.fn(), spawnGroundSplat: vi.fn(),
      clearAllCrates: vi.fn(), spawnCrate: vi.fn(),
    },
    scene: { cameraTarget: { set: vi.fn() }, updateCameraPosition: vi.fn() },
    groundSplats: [] as unknown[],
    activeCrates: new Map<number, { x: number; z: number; type: string }>(),
    nextCrateId: 0,
    aiPlayers: [],
    activeStormListener: null,
    missionScriptRunner: null,
    stormWaitTimer: 0,
  } as any;
}

function baseSave(extra: Partial<SaveData>): SaveData {
  return {
    version: 1, tick: 500,
    housePrefix: 'AT', enemyPrefix: 'HK', houseName: 'Atreides', enemyName: 'Harkonnen',
    solaris: [], entities: [], spice: [],
    ...extra,
  } as SaveData;
}

describe('save/load stormWaitTimer', () => {
  it('buildSaveData persists the storm countdown', () => {
    const world = createWorld();
    const ctx = makeSaveCtx(world);
    ctx.stormWaitTimer = 12345;
    expect(buildSaveData(ctx).stormWaitTimer).toBe(12345);
  });

  it('restoreFromSave restores it without consuming an RNG draw', () => {
    const world = createWorld();
    const ctx = makeRestoreCtx(world);
    const rngState: [number, number, number, number] = [123, 456, 789, 1011];

    restoreFromSave(ctx, baseSave({ rngState, stormWaitTimer: 777 }));

    expect(ctx.stormWaitTimer).toBe(777);
    // RNG must equal exactly the restored state — no extra storm reroll draw.
    expect(simRng.getState()).toEqual(rngState);
  });

  it('reseeds the storm timer for legacy saves that lack the field', () => {
    const world = createWorld();
    const ctx = makeRestoreCtx(world);
    ctx.stormWaitTimer = -1;

    restoreFromSave(ctx, baseSave({ rngState: [1, 2, 3, 4] }));

    expect(ctx.stormWaitTimer).toBeGreaterThanOrEqual(GameConstants.STORM_MIN_WAIT);
  });
});
