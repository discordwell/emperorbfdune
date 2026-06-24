import { describe, expect, it, vi } from 'vitest';
import { createWorld } from 'bitecs';

import { registerEventHandlers } from '../../src/core/EventHandlers';
import { EventBus } from '../../src/core/EventBus';
import type { GameContext } from '../../src/core/GameContext';
import {
  addComponent,
  addEntity,
  Health,
  Owner,
  Position,
  UnitType,
} from '../../src/core/ECS';

type World = ReturnType<typeof createWorld>;

function makeUnit(world: World, owner: number, x = 50, z = 50): number {
  const eid = addEntity(world);
  addComponent(world, Position, eid);
  addComponent(world, UnitType, eid);
  addComponent(world, Owner, eid);
  addComponent(world, Health, eid);
  Position.x[eid] = x; Position.y[eid] = 0; Position.z[eid] = z;
  Owner.playerId[eid] = owner;
  Health.current[eid] = 0; Health.max[eid] = 100; // dying
  return eid;
}

/**
 * Build a stub GameContext sufficient for the unit:died and production:started
 * event listeners. Everything is a spy/no-op; the gameStats and productionSystem
 * spies are returned so tests can assert on them.
 */
function setup() {
  const world = createWorld();
  const gameStats = {
    recordUnitLost: vi.fn(),
    recordBuildingLost: vi.fn(),
    recordCreditsSpent: vi.fn(),
    recordCreditsEarned: vi.fn(),
    recordDamage: vi.fn(),
  };
  const productionSystem = {
    // Difficulty-adjusted cost actually deducted (e.g. easy = 50% of base 50).
    getAdjustedCost: vi.fn(() => 25),
    startProduction: vi.fn(() => false),
    removePlayerBuilding: vi.fn(),
  };
  const effectsManager = {
    clearBuildingDamage: vi.fn(),
    spawnExplosion: vi.fn(),
    spawnWreckage: vi.fn(),
    spawnDecal: vi.fn(),
    spawnGroundSplat: vi.fn(),
  };
  const gameRules = {
    units: new Map<string, any>([['ATLightInf', { cost: 50, infantry: true }]]),
    buildings: new Map<string, any>(),
  };
  const ctx = {
    gameRules,
    typeRegistry: { unitTypeNames: [] as string[], buildingTypeNames: [] as string[] },
    game: { getWorld: () => world, getTickCount: () => 0 },
    scene: { shake: vi.fn() },
    terrain: {},
    unitRenderer: { playDeathAnim: vi.fn(() => false), getEntityObject: vi.fn(() => null) },
    combatSystem: { unregisterUnit: vi.fn() },
    movement: { unregisterEntity: vi.fn(), clearPath: vi.fn(), invalidateAllPaths: vi.fn() },
    commandManager: { unregisterEntity: vi.fn() },
    harvestSystem: { addSolaris: vi.fn() },
    productionSystem,
    effectsManager,
    audioManager: { playSfx: vi.fn(), playAbilitySfxAt: vi.fn() },
    minimapRenderer: { flashPing: vi.fn() },
    selectionManager: {},
    selectionPanel: { addMessage: vi.fn() },
    abilitySystem: { handleUnitDeath: vi.fn() },
    buildingPlacement: {},
    victorySystem: {},
    gameStats,
    aiPlayers: [],
    aircraftAmmo: new Map(),
    rearmingAircraft: new Set(),
    descendingUnits: new Map(),
    dyingTilts: new Map(),
    processedDeaths: new Set(),
    repairingBuildings: new Set(),
    groundSplats: [],
    bloomMarkers: new Map(),
    MAX_AMMO: 8,
    opponents: [],
    house: { prefix: 'AT', enemyPrefix: 'HK' },
    deferAction: vi.fn(),
    pushGameEvent: vi.fn(),
    findRefinery: vi.fn(() => null),
    spawnUnit: vi.fn(() => -1),
    spawnBuilding: vi.fn(() => -1),
  };
  // registerEventHandlers reads a couple of DOM elements at registration scope
  // (attack-flash, minimap-container) for listeners we don't exercise here.
  if (typeof (globalThis as any).document === 'undefined') {
    (globalThis as any).document = { getElementById: () => null };
  }
  EventBus.clear();
  registerEventHandlers(ctx as unknown as GameContext);
  return { world, ctx, gameStats, productionSystem, effectsManager };
}

describe('unit:died silent consume (AI MCV -> ConYard)', () => {
  it('does not record a unit loss or spawn death VFX when silent', () => {
    const { world, ctx, gameStats, effectsManager } = setup();
    const eid = makeUnit(world, 1);

    EventBus.emit('unit:died', { entityId: eid, killerEntity: -1, silent: true });

    expect(gameStats.recordUnitLost).not.toHaveBeenCalled();
    expect(effectsManager.spawnExplosion).not.toHaveBeenCalled();
    expect(ctx.pushGameEvent).not.toHaveBeenCalled();   // no 'death' game event
    expect(ctx.deferAction).toHaveBeenCalled();          // entity still scheduled for removal
  });

  it('records a unit loss and VFX for a normal (non-silent) death', () => {
    const { world, gameStats, effectsManager, ctx } = setup();
    const eid = makeUnit(world, 1);

    EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });

    expect(gameStats.recordUnitLost).toHaveBeenCalledTimes(1);
    expect(effectsManager.spawnExplosion).toHaveBeenCalled();
    expect(ctx.pushGameEvent).toHaveBeenCalled();         // real death -> game event
  });
});

describe('production:started credits accounting', () => {
  it('records the difficulty-adjusted cost actually deducted, not the base cost', () => {
    const { gameStats, productionSystem } = setup();

    EventBus.emit('production:started', { unitType: 'ATLightInf', owner: 0, isBuilding: false });

    expect(productionSystem.getAdjustedCost).toHaveBeenCalledWith(0, 'ATLightInf', false);
    // Base cost is 50; adjusted (deducted) cost is 25. The stat must record 25.
    expect(gameStats.recordCreditsSpent).toHaveBeenCalledWith(0, 25);
  });

  it('records nothing for unresolved names (e.g. upgrades) where adjusted cost is 0', () => {
    const { gameStats, productionSystem } = setup();
    productionSystem.getAdjustedCost.mockReturnValueOnce(0);

    EventBus.emit('production:started', { unitType: 'ATBarracks Upgrade', owner: 0, isBuilding: true });

    expect(gameStats.recordCreditsSpent).not.toHaveBeenCalled();
  });
});
