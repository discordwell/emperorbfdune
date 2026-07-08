import { describe, expect, it, vi } from 'vitest';
import { createWorld } from 'bitecs';

import { buildSaveData, restoreFromSave } from '../../src/core/SaveLoadSystem';
import { SandwormSystem, type SandwormSaveState } from '../../src/simulation/SandwormSystem';
import type { SaveData } from '../../src/core/GameContext';
import {
  addComponent, addEntity, Health, MoveTarget, Owner, Position, UnitType,
} from '../../src/core/ECS';

type World = ReturnType<typeof createWorld>;

/**
 * Regression tests for sandworm-subsystem save/load. The worm system holds
 * non-ECS simulation state (worms[], tickCounter, thumpers, per-side flags) and
 * draws from the shared simRng on a schedule gated by worms.length/tickCounter.
 * Previously none of it was persisted, so a save->load lost all worms, reset the
 * spawn timer (silencing worms until tickCounter re-crossed MIN_TICKS_WORM_CAN_APPEAR),
 * and desynced the global RNG stream. Now it round-trips, with eid references
 * (hunt target, rider) remapped through the save-index tables.
 */

// serialize/deserialize touch only in-memory fields, so terrain/effects can be bare stubs.
function makeSystem(): SandwormSystem {
  return new SandwormSystem({} as any, { spawnExplosion: () => {} } as any);
}

function wormEntry(over: Partial<SandwormSaveState['worms'][number]> = {}): SandwormSaveState['worms'][number] {
  return {
    x: 10, z: 20, targetX: 30, targetZ: 40, speed: 0.3, life: 500,
    huntingIndex: -1, huntingOwner: -1, state: 'roaming', emergeTicks: 0,
    riderIndex: -1, riderOwner: -1, ...over,
  };
}

function state(over: Partial<SandwormSaveState> = {}): SandwormSaveState {
  return { worms: [], tickCounter: 0, thumpers: [], attractSides: [], repelSides: [], ...over };
}

describe('SandwormSystem serialize/deserialize', () => {
  it('round-trips scalar worm fields, tickCounter, thumpers, and side flags', () => {
    const sys = makeSystem();
    sys.deserialize(state({
      worms: [wormEntry({ x: 11, z: 22, targetX: 33, targetZ: 44, speed: 0.7, life: 321, emergeTicks: 5 })],
      tickCounter: 5000,
      thumpers: [{ x: 1, z: 2, ticksLeft: 100 }],
      attractSides: [0, 2],
      repelSides: [1],
    }), () => undefined);

    const worms = sys.getWorms();
    expect(worms).toHaveLength(1);
    expect(worms[0]).toMatchObject({ x: 11, z: 22, targetX: 33, targetZ: 44, speed: 0.7, life: 321, emergeTicks: 5 });
    expect(sys.doesSideAttractWorms(0)).toBe(true);
    expect(sys.doesSideAttractWorms(2)).toBe(true);
    expect(sys.doesSideRepelWorms(1)).toBe(true);

    // tickCounter + thumpers survive (verified through a serialize round-trip).
    const out = sys.serialize(() => undefined);
    expect(out.tickCounter).toBe(5000);
    expect(out.thumpers).toEqual([{ x: 1, z: 2, ticksLeft: 100 }]);
  });

  it('remaps a hunt-target eid through save-index -> new eid on load', () => {
    const sys = makeSystem();
    // Saved worm hunts the unit stored at save-array index 2; on load that index
    // maps to the freshly-created eid 77.
    sys.deserialize(state({ worms: [wormEntry({ state: 'hunting', huntingIndex: 2, huntingOwner: 1 })] }),
      idx => (idx === 2 ? 77 : undefined));

    expect(sys.getWorms()[0].huntingEid).toBe(77);
    expect(sys.getWorms()[0].huntingOwner).toBe(1);
  });

  it('drops the hunt target when its entity did not survive the load', () => {
    const sys = makeSystem();
    sys.deserialize(state({ worms: [wormEntry({ state: 'hunting', huntingIndex: 5, huntingOwner: 1 })] }),
      () => undefined); // index 5 unmappable

    expect(sys.getWorms()[0].huntingEid).toBeNull();
  });

  it('remaps a rider eid and keeps the mount when the rider survives', () => {
    const sys = makeSystem();
    sys.deserialize(state({ worms: [wormEntry({ state: 'mounted', speed: 0.9, riderIndex: 3, riderOwner: 2 })] }),
      idx => (idx === 3 ? 88 : undefined));

    const worm = sys.getWorms()[0];
    expect(worm.state).toBe('mounted');
    expect(worm.riderEid).toBe(88);
    expect(worm.riderOwner).toBe(2);
  });

  it('un-mounts (reverts to roaming) when the rider entity did not survive the load', () => {
    const sys = makeSystem();
    sys.deserialize(state({ worms: [wormEntry({ state: 'mounted', speed: 0.9, riderIndex: 3, riderOwner: 2 })] }),
      () => undefined); // rider unmappable

    const worm = sys.getWorms()[0];
    expect(worm.state).toBe('roaming'); // no dangling-eid tracking
    expect(worm.riderEid).toBeUndefined();
  });

  it('serialize maps a live hunt-target eid back to its save index (or -1 if unsaved)', () => {
    const sys = makeSystem();
    sys.deserialize(state({ worms: [wormEntry({ state: 'hunting', huntingIndex: 2 })] }),
      idx => (idx === 2 ? 77 : undefined)); // worm now hunts eid 77

    // eid 77 is being saved at index 9.
    expect(sys.serialize(eid => (eid === 77 ? 9 : undefined)).worms[0].huntingIndex).toBe(9);
    // eid 77 is NOT among the saved entities -> stored as -1 (dropped on next load).
    expect(sys.serialize(() => undefined).worms[0].huntingIndex).toBe(-1);
  });
});

// ---- Integration through the real buildSaveData / restoreFromSave path ----

function makeSaveCtx(world: World, sandwormSystem: SandwormSystem) {
  return {
    game: { getWorld: () => world, getTickCount: () => 0 },
    typeRegistry: { unitTypeNames: [] as string[], buildingTypeNames: [] as string[] },
    totalPlayers: 2, activeMapId: null, activeMissionConfig: null,
    groundSplats: [] as unknown[], stormWaitTimer: 0,
    activeCrates: new Map(), nextCrateId: 0,
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
    sandwormSystem,
    superweaponSystem: { getChargeState: () => ({}) },
    victorySystem: { getTickCounter: () => 0 },
    selectionManager: { getControlGroups: () => new Map() },
    terrain: { getMapWidth: () => 2, getMapHeight: () => 2, getSpice: () => 0 },
    missionScriptRunner: undefined,
  } as any;
}

function makeRestoreCtx(world: World, sandwormSystem: SandwormSystem) {
  return {
    game: { getWorld: () => world, setTickCount: vi.fn() },
    typeRegistry: { unitTypeNames: [] as string[], buildingTypeNames: [] as string[] },
    harvestSystem: { addSolaris: vi.fn(), getSolaris: () => 0 },
    terrain: { getMapWidth: () => 0, getMapHeight: () => 0, setSpice: vi.fn(), updateSpiceVisuals: vi.fn(), getHeightAt: () => 0 },
    deferredActions: [] as unknown[], descendingUnits: new Map(),
    fogOfWar: { setExploredData: vi.fn() },
    superweaponSystem: { setChargeState: vi.fn() },
    victorySystem: { setTickCounter: vi.fn() },
    selectionManager: { setControlGroups: vi.fn() },
    abilitySystem: { restoreAbilityState: vi.fn() },
    productionSystem: { restoreState: vi.fn() },
    sandwormSystem,
    combatSystem: { setSuppressed: vi.fn(), setStance: vi.fn(), setGuardPosition: vi.fn(), restoreAttackMove: vi.fn() },
    movement: { isFlyer: () => false },
    commandManager: { getRallyPoint: () => null },
    effectsManager: {
      clearAllGroundSplats: vi.fn(), stopSandstorm: vi.fn(), spawnGroundSplat: vi.fn(),
      clearAllCrates: vi.fn(), spawnCrate: vi.fn(),
    },
    scene: { cameraTarget: { set: vi.fn() }, updateCameraPosition: vi.fn() },
    groundSplats: [] as unknown[], activeCrates: new Map(), nextCrateId: 0,
    aiPlayers: [], activeStormListener: null, missionScriptRunner: null, stormWaitTimer: 0,
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

describe('save/load sandworm integration', () => {
  it('a worm + tickCounter present at save survives buildSaveData -> restoreFromSave', () => {
    // Source system carrying a roaming worm and an advanced spawn timer.
    const src = makeSystem();
    src.deserialize(state({
      worms: [wormEntry({ x: 15, z: 25, state: 'roaming' })],
      tickCounter: 5000,
    }), () => undefined);

    const save = buildSaveData(makeSaveCtx(createWorld(), src));
    expect(save.sandworm?.worms).toHaveLength(1);
    expect(save.sandworm?.tickCounter).toBe(5000);

    // Fresh destination system starts empty (as a reopened session would).
    const dst = makeSystem();
    expect(dst.getWorms()).toHaveLength(0);

    restoreFromSave(makeRestoreCtx(createWorld(), dst), save);

    expect(dst.getWorms()).toHaveLength(1);
    expect(dst.getWorms()[0]).toMatchObject({ x: 15, z: 25, state: 'roaming' });
    // tickCounter restored so worms aren't silenced for MIN_TICKS_WORM_CAN_APPEAR after load.
    expect(dst.serialize(() => undefined).tickCounter).toBe(5000);
  });

  it('keeps a restored worm rider aloft with its command intact (not grounded + rallied)', () => {
    const world = createWorld();
    const dst = makeSystem();

    // Real spawnUnit so the rider becomes a queryable ECS unit; low terrain + a set
    // rally point are exactly the conditions under which the snap-to-ground pass would
    // otherwise clobber an elevated player-0 unit's move order.
    let riderEid = -1;
    const ctx = {
      ...makeRestoreCtx(world, dst),
      typeRegistry: { unitTypeNames: ['ATFremen'], buildingTypeNames: [] as string[] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnUnit: (w: any, _name: string, owner: number, x: number, z: number) => {
        const eid = addEntity(w);
        addComponent(w, Position, eid); addComponent(w, Health, eid);
        addComponent(w, Owner, eid); addComponent(w, UnitType, eid);
        addComponent(w, MoveTarget, eid);
        Position.x[eid] = x; Position.z[eid] = z;
        Owner.playerId[eid] = owner; UnitType.id[eid] = 0;
        riderEid = eid;
        return eid;
      },
      commandManager: { getRallyPoint: () => ({ x: 5, z: 5 }) },
    } as any;

    const save = baseSave({
      rngState: [1, 2, 3, 4], stormWaitTimer: 500,
      entities: [
        // The rider: a player-0 unit parked on its worm (y=1.5) with a live order to (99,99).
        {
          x: 15, z: 25, y: 1.5, rotY: 0, hp: 100, maxHp: 100, owner: 0, unitTypeId: 0,
          speed: { max: 1, turn: 1, accel: 1, cur: 1 }, vet: { xp: 0, rank: 0 },
          moveTarget: { x: 99, z: 99, active: 1 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      sandworm: state({
        worms: [wormEntry({ x: 15, z: 25, state: 'mounted', speed: 0.9, riderIndex: 0, riderOwner: 0 })],
        tickCounter: 5000,
      }),
    });

    restoreFromSave(ctx, save);

    // The worm re-linked to the freshly-spawned rider...
    expect(dst.getWorms()[0].riderEid).toBe(riderEid);
    // ...and the snap pass left the rider aloft with its original command, NOT grounded
    // and NOT rallied to (5,5). Before the fix its MoveTarget was clobbered to the rally.
    expect(Position.y[riderEid]).toBe(1.5);
    expect(MoveTarget.x[riderEid]).toBe(99);
    expect(MoveTarget.z[riderEid]).toBe(99);
  });
});
