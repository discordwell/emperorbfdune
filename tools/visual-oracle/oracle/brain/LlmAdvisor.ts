/**
 * LLM-based strategic advisor.
 * Called periodically (or on inflection points) while the game is paused.
 * Uses Claude vision API to analyze the situation and produce a strategic plan.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { GameState } from '../state/GameState.js';

export type StrategicObjective = 'expand' | 'defend' | 'attack' | 'tech_up' | 'harass';

export interface StrategicPlan {
  objective: StrategicObjective;
  /** Target location for attack/expand/harass */
  targetLocation?: { x: number; z: number };
  /** Composition hint overrides default COMPOSITION_GOAL */
  compositionHint?: {
    antiVeh: number;
    antiInf: number;
    antiBldg: number;
    scout: number;
  };
  /** Economy priority: 'spice' (more harvesters) or 'military' (spend on army) */
  economyPriority: 'spice' | 'military' | 'balanced';
  /** Free-text reasoning for logging */
  reasoning: string;
}

export interface LlmAdvisorConfig {
  apiKey?: string;
  model?: string;
}

export class LlmAdvisor {
  private client: Anthropic;
  private model: string;

  constructor(config?: LlmAdvisorConfig) {
    this.client = new Anthropic(config?.apiKey ? { apiKey: config.apiKey } : undefined);
    this.model = config?.model ?? 'claude-sonnet-4-5-20250929';
  }

  /**
   * Analyze current game state + screenshot and produce a strategic plan.
   * Should be called while game is paused (1-3s API latency).
   */
  async advise(state: GameState, screenshot?: Buffer): Promise<StrategicPlan> {
    const stateDescription = this.describeState(state);

    const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }> = [];

    if (screenshot) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: screenshot.toString('base64'),
        },
      });
    }

    content.push({
      type: 'text',
      text: `You are an AI advisor for Emperor: Battle for Dune, a 2001 RTS game similar to Command & Conquer.

CURRENT GAME STATE:
${stateDescription}

Based on the game state${screenshot ? ' and screenshot' : ''}, decide on a strategic plan.

Consider:
- Current army size vs enemy army
- Economy (solaris, number of refineries/harvesters)
- Tech level and available buildings
- Whether we should expand, defend, tech up, or attack

Reply with ONLY valid JSON:
{
  "objective": "expand" | "defend" | "attack" | "tech_up" | "harass",
  "targetLocation": { "x": <number>, "z": <number> } | null,
  "compositionHint": { "antiVeh": <0-1>, "antiInf": <0-1>, "antiBldg": <0-1>, "scout": <0-1> },
  "economyPriority": "spice" | "military" | "balanced",
  "reasoning": "<1-2 sentence explanation>"
}`,
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      messages: [{ role: 'user', content }],
    });

    return this.parseResponse(response);
  }

  private describeState(state: GameState): string {
    const p = state.player;
    const lines: string[] = [];
    lines.push(`Tick: ${state.tick} (~${Math.floor(state.tick / 25)}s elapsed)`);
    lines.push(`Solaris: ${p.solaris}`);
    lines.push(`Power: ${p.power.produced}/${p.power.consumed} (ratio: ${p.power.ratio.toFixed(2)})`);
    lines.push(`Units: ${p.units.length} (${p.units.filter(u => u.isHarvester).length} harvesters, ${p.units.filter(u => !u.isHarvester && u.isIdle).length} idle military)`);
    lines.push(`Buildings: ${p.buildings.length}`);

    const buildingTypes: string[] = [];
    for (const [name, count] of p.ownedBuildingTypes) {
      buildingTypes.push(`${name}x${count}`);
    }
    lines.push(`Building types: ${buildingTypes.join(', ')}`);

    for (const enemy of state.enemies) {
      lines.push(`\nEnemy P${enemy.playerId}:`);
      lines.push(`  Units: ${enemy.units.length}, Buildings: ${enemy.buildings.length}`);
      if (enemy.buildings.length > 0) {
        const center = enemy.buildings.reduce(
          (acc, b) => ({ x: acc.x + b.x, z: acc.z + b.z }),
          { x: 0, z: 0 },
        );
        center.x /= enemy.buildings.length;
        center.z /= enemy.buildings.length;
        lines.push(`  Base center: (${center.x.toFixed(0)}, ${center.z.toFixed(0)})`);
      }
    }

    // Recent events
    if (state.events.length > 0) {
      lines.push(`\nRecent events: ${state.events.length}`);
      const losses = state.events.filter(e => e.type === 'unit_destroyed' && e.owner === p.playerId);
      const kills = state.events.filter(e => e.type === 'unit_destroyed' && e.owner !== p.playerId);
      if (losses.length) lines.push(`  Losses: ${losses.length}`);
      if (kills.length) lines.push(`  Kills: ${kills.length}`);
    }

    return lines.join('\n');
  }

  private parseResponse(response: Anthropic.Message): StrategicPlan {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    console.log('[LlmAdvisor] Raw response:', text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[LlmAdvisor] No JSON found, using default plan');
      return this.defaultPlan();
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        objective: parsed.objective ?? 'defend',
        targetLocation: parsed.targetLocation ?? undefined,
        compositionHint: parsed.compositionHint ?? undefined,
        economyPriority: parsed.economyPriority ?? 'balanced',
        reasoning: parsed.reasoning ?? 'No reasoning provided',
      };
    } catch (e) {
      console.warn('[LlmAdvisor] JSON parse failed:', e);
      return this.defaultPlan();
    }
  }

  private defaultPlan(): StrategicPlan {
    return {
      objective: 'defend',
      economyPriority: 'balanced',
      reasoning: 'Defaulting to defensive posture',
    };
  }
}
