/**
 * E2E test for OracleLoop with a mock adapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OracleLoop } from '../OracleLoop.js';
import type { GameAdapter } from '../adapters/GameAdapter.js';
import type { GameState, PlayerState } from '../state/GameState.js';
import type { Action } from '../actions/Action.js';

function makeState(tick: number, overrides: Partial<GameState> = {}): GameState {
  return {
    tick,
    player: {
      playerId: 0,
      solaris: 5000,
      power: { produced: 100, consumed: 80, ratio: 1.25 },
      techLevel: 1,
      units: [
        { eid: 1, typeName: 'ATLightInf', x: 50, z: 50, healthPct: 1, isHarvester: false, isIdle: true, isInfantry: true, canFly: false },
        { eid: 2, typeName: 'ATHarvester', x: 60, z: 60, healthPct: 1, isHarvester: true, isIdle: false, harvesterState: 2, spiceCarried: 50, maxCapacity: 700, isInfantry: false, canFly: false },
      ],
      buildings: [
        { eid: 100, typeName: 'ATConYard', x: 50, z: 50, healthPct: 1 },
        { eid: 101, typeName: 'ATSmWindtrap', x: 45, z: 50, healthPct: 1 },
        { eid: 102, typeName: 'ATRefinery', x: 55, z: 50, healthPct: 1 },
      ],
      productionQueues: { building: [], infantry: [], vehicle: [] },
      ownedBuildingTypes: new Map([
        ['ATConYard', 1],
        ['ATSmWindtrap', 1],
        ['ATRefinery', 1],
      ]),
    },
    enemies: [{
      playerId: 1,
      solaris: 3000,
      power: { produced: 80, consumed: 60, ratio: 1.33 },
      techLevel: 1,
      units: [{ eid: 9001, typeName: 'HKLightInf', x: 200, z: 200, healthPct: 1, isHarvester: false, isIdle: false, isInfantry: true, canFly: false }],
      buildings: [{ eid: 9002, typeName: 'HKConYard', x: 200, z: 200, healthPct: 1 }],
      productionQueues: { building: [], infantry: [], vehicle: [] },
      ownedBuildingTypes: new Map([['HKConYard', 1]]),
    }],
    confidence: 1.0,
    events: [],
    ...overrides,
  };
}

class MockAdapter implements GameAdapter {
  readonly name = 'mock';
  private tick = 100;
  connected = false;
  paused = false;
  executedActions: Action[][] = [];
  observeCount = 0;
  private stateOverride: Partial<GameState> | null = null;

  setStateOverride(overrides: Partial<GameState>): void {
    this.stateOverride = overrides;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async observe(): Promise<GameState> {
    this.observeCount++;
    this.tick += 50; // Simulate time passing
    return makeState(this.tick, this.stateOverride ?? {});
  }

  async pause(): Promise<void> {
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
  }

  async execute(actions: Action[]): Promise<void> {
    this.executedActions.push([...actions]);
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from('fake-screenshot');
  }
}

describe('OracleLoop', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  it('runs for specified iterations then stops', async () => {
    const loop = new OracleLoop(adapter, {
      housePrefix: 'AT',
      noLlm: true,
      maxIterations: 5,
      intervalMs: 10, // Fast for testing
    });

    await adapter.connect();
    await loop.start();

    expect(loop.getIteration()).toBe(5);
    expect(loop.isRunning()).toBe(false);
    // Observe is called maxIterations + 1 (initial + each tick)
    expect(adapter.observeCount).toBe(6);
  });

  it('executes actions from rule engine', async () => {
    const loop = new OracleLoop(adapter, {
      housePrefix: 'AT',
      noLlm: true,
      maxIterations: 3,
      intervalMs: 10,
    });

    await adapter.connect();
    await loop.start();

    // Should have executed some actions (build order, production, etc.)
    expect(adapter.executedActions.length).toBeGreaterThan(0);
    // At least one produce action should have been issued
    const allActions = adapter.executedActions.flat();
    const produceActions = allActions.filter(a => a.type === 'produce');
    expect(produceActions.length).toBeGreaterThan(0);
  });

  it('detects game over when no units or buildings', async () => {
    adapter.setStateOverride({
      tick: 500,
      player: {
        playerId: 0,
        solaris: 0,
        power: { produced: 0, consumed: 0, ratio: 1.0 },
        techLevel: 1,
        units: [],
        buildings: [],
        productionQueues: { building: [], infantry: [], vehicle: [] },
        ownedBuildingTypes: new Map(),
      },
    });

    const loop = new OracleLoop(adapter, {
      housePrefix: 'AT',
      noLlm: true,
      maxIterations: 100, // Should stop before this
      intervalMs: 10,
    });

    await adapter.connect();
    await loop.start();

    // Should have stopped early due to game over
    expect(loop.getIteration()).toBeLessThan(100);
  });

  it('detects victory when enemies eliminated', async () => {
    adapter.setStateOverride({
      tick: 500,
      enemies: [{
        playerId: 1,
        solaris: 0,
        power: { produced: 0, consumed: 0, ratio: 1.0 },
        techLevel: 1,
        units: [],
        buildings: [],
        productionQueues: { building: [], infantry: [], vehicle: [] },
        ownedBuildingTypes: new Map(),
      }],
    });

    const loop = new OracleLoop(adapter, {
      housePrefix: 'AT',
      noLlm: true,
      maxIterations: 100,
      intervalMs: 10,
    });

    await adapter.connect();
    await loop.start();

    expect(loop.getIteration()).toBeLessThan(100);
  });

  it('calls onIteration callback', async () => {
    const iterations: number[] = [];
    const loop = new OracleLoop(adapter, {
      housePrefix: 'AT',
      noLlm: true,
      maxIterations: 3,
      intervalMs: 10,
      onIteration: (i) => iterations.push(i),
    });

    await adapter.connect();
    await loop.start();

    expect(iterations).toEqual([0, 1, 2]);
  });

  it('can be stopped externally', async () => {
    const loop = new OracleLoop(adapter, {
      housePrefix: 'AT',
      noLlm: true,
      maxIterations: 1000,
      intervalMs: 50,
    });

    await adapter.connect();

    // Stop after 200ms
    setTimeout(() => loop.stop(), 200);
    await loop.start();

    expect(loop.isRunning()).toBe(false);
    expect(loop.getIteration()).toBeLessThan(1000);
    expect(loop.getIteration()).toBeGreaterThan(0);
  });
});
