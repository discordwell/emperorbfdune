/**
 * Core oracle loop: observe → decide → act
 * Runs against either the TS remake or Wine original.
 */

import type { GameAdapter } from './adapters/GameAdapter.js';
import { DecisionEngine, type DecisionEngineConfig } from './brain/DecisionEngine.js';
import type { GameState } from './state/GameState.js';

export interface OracleLoopConfig extends DecisionEngineConfig {
  /** Milliseconds between iterations. Default: 2000 */
  intervalMs?: number;
  /** Maximum iterations before stopping. 0 = unlimited. Default: 0 */
  maxIterations?: number;
  /** Callback after each iteration */
  onIteration?: (iteration: number, state: GameState, actionCount: number) => void;
}

export class OracleLoop {
  private adapter: GameAdapter;
  private engine: DecisionEngine;
  private config: OracleLoopConfig;
  private running = false;
  private iteration = 0;

  constructor(adapter: GameAdapter, config: OracleLoopConfig) {
    this.adapter = adapter;
    this.engine = new DecisionEngine(config);
    this.config = config;
  }

  async start(): Promise<void> {
    console.log(`[OracleLoop] Starting on ${this.adapter.name} backend`);
    this.running = true;
    this.iteration = 0;

    // Initial state observation to reconstruct build phase
    const initialState = await this.adapter.observe();
    this.engine.reconstructFromState(initialState);
    console.log(`[OracleLoop] Initial state: tick=${initialState.tick}, units=${initialState.player.units.length}, buildings=${initialState.player.buildings.length}`);

    const intervalMs = this.config.intervalMs ?? 2000;
    const maxIterations = this.config.maxIterations ?? 0;

    while (this.running) {
      if (maxIterations > 0 && this.iteration >= maxIterations) {
        console.log(`[OracleLoop] Reached max iterations (${maxIterations}), stopping`);
        break;
      }

      try {
        await this.tick();
      } catch (e) {
        console.error(`[OracleLoop] Error in iteration ${this.iteration}:`, e);
        // Continue running — transient errors shouldn't kill the loop
      }

      this.iteration++;
      await sleep(intervalMs);
    }

    this.running = false;
    console.log(`[OracleLoop] Stopped after ${this.iteration} iterations`);
  }

  stop(): void {
    this.running = false;
  }

  private async tick(): Promise<void> {
    // 1. Observe
    const state = await this.adapter.observe();

    // Check for game over conditions
    if (state.player.buildings.length === 0 && state.player.units.length === 0 && state.tick > 100) {
      console.log('[OracleLoop] All units and buildings lost — game over');
      this.stop();
      return;
    }

    // Check for victory (all enemies eliminated)
    const enemiesAlive = state.enemies.some(
      e => e.buildings.length > 0 || e.units.length > 0
    );
    if (!enemiesAlive && state.tick > 100) {
      console.log('[OracleLoop] All enemies eliminated — victory!');
      this.stop();
      return;
    }

    // 2. Decide
    const actions = await this.engine.decide(state, this.adapter);

    // 3. Act
    if (actions.length > 0) {
      await this.adapter.execute(actions);
    }

    // 4. Report
    this.config.onIteration?.(this.iteration, state, actions.length);

    if (this.iteration % 10 === 0) {
      const plan = this.engine.getCurrentPlan();
      console.log(
        `[OracleLoop] #${this.iteration} tick=${state.tick} ` +
        `units=${state.player.units.length} bldgs=${state.player.buildings.length} ` +
        `sol=${state.player.solaris} actions=${actions.length}` +
        (plan ? ` plan=${plan.objective}` : ''),
      );
    }
  }

  getIteration(): number {
    return this.iteration;
  }

  isRunning(): boolean {
    return this.running;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
