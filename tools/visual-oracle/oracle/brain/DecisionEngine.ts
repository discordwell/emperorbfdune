/**
 * Orchestrator: runs rule engine first, calls LLM for strategic decisions when needed.
 */

import type { GameState } from '../state/GameState.js';
import type { Action } from '../actions/Action.js';
import type { GameAdapter } from '../adapters/GameAdapter.js';
import { RuleEngine, type RuleEngineConfig } from './RuleEngine.js';
import { LlmAdvisor, type StrategicPlan, type LlmAdvisorConfig } from './LlmAdvisor.js';

export interface DecisionEngineConfig extends RuleEngineConfig {
  /** Disable LLM advisor (rules-only mode) */
  noLlm?: boolean;
  /** LLM configuration */
  llmConfig?: LlmAdvisorConfig;
}

export class DecisionEngine {
  private ruleEngine: RuleEngine;
  private llmAdvisor: LlmAdvisor | null;
  private lastLlmTick = 0;
  private currentPlan: StrategicPlan | null = null;

  constructor(config: DecisionEngineConfig) {
    this.ruleEngine = new RuleEngine(config);
    this.llmAdvisor = config.noLlm ? null : new LlmAdvisor(config.llmConfig);
  }

  /**
   * Decide what actions to take given current state.
   * May pause the game for LLM consultation if a strategic inflection is detected.
   */
  async decide(state: GameState, adapter: GameAdapter): Promise<Action[]> {
    // Check for strategic inflection point
    if (this.llmAdvisor && this.ruleEngine.isStrategicInflection(state, this.lastLlmTick)) {
      console.log(`[DecisionEngine] Strategic inflection at tick ${state.tick} — consulting LLM`);
      try {
        await adapter.pause();
        const screenshot = await adapter.screenshot();
        this.currentPlan = await this.llmAdvisor.advise(state, screenshot);
        this.lastLlmTick = state.tick;
        this.ruleEngine.setStrategicPlan(this.currentPlan);
        console.log(`[DecisionEngine] LLM plan: ${this.currentPlan.objective} — ${this.currentPlan.reasoning}`);
      } catch (e) {
        console.warn('[DecisionEngine] LLM consultation failed:', e);
      } finally {
        await adapter.resume();
      }
    }

    // Always run deterministic rules
    const actions = this.ruleEngine.evaluate(state);

    // If we have a strategic plan with an attack objective and enough idle troops, add attack action
    if (this.currentPlan?.objective === 'attack' && this.currentPlan.targetLocation) {
      const idleMilitary = state.player.units.filter(u => u.isIdle && !u.isHarvester);
      if (idleMilitary.length >= 6) {
        actions.push({
          type: 'attack_move',
          entityIds: idleMilitary.map(u => u.eid),
          x: this.currentPlan.targetLocation.x,
          z: this.currentPlan.targetLocation.z,
        });
      }
    }

    return actions;
  }

  /** Reconstruct engine state from current game (call after connect) */
  reconstructFromState(state: GameState): void {
    this.ruleEngine.reconstructBuildPhase(state.player);
  }

  getCurrentPlan(): StrategicPlan | null {
    return this.currentPlan;
  }
}
