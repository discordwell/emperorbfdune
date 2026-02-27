/**
 * VisionExtractor: screenshot + Claude vision → partial GameState
 * Used by WineAdapter to observe the original game.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { GameState, PlayerState, UnitInfo, BuildingInfo, GameEvent } from './GameState.js';
import type { HousePrefix } from '../brain/BuildOrders.js';

export interface VisionExtractorConfig {
  apiKey?: string;
  model?: string;
  housePrefix: HousePrefix;
}

export class VisionExtractor {
  private client: Anthropic;
  private model: string;
  private housePrefix: HousePrefix;
  private lastEstimate: GameState | null = null;

  constructor(config: VisionExtractorConfig) {
    this.client = new Anthropic(config.apiKey ? { apiKey: config.apiKey } : undefined);
    this.model = config.model ?? 'claude-sonnet-4-5-20250929';
    this.housePrefix = config.housePrefix;
  }

  /**
   * Extract game state from a screenshot using Claude vision.
   * Returns a partial GameState with lower confidence values.
   */
  async extract(screenshot: Buffer, tick: number): Promise<GameState> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshot.toString('base64'),
            },
          },
          {
            type: 'text',
            text: `You are analyzing a screenshot from Emperor: Battle for Dune (2001 RTS game).
The player controls the ${this.housePrefix === 'AT' ? 'Atreides' : this.housePrefix === 'HK' ? 'Harkonnen' : 'Ordos'} faction.

Analyze the screenshot and estimate the game state. Look at:
1. The sidebar on the right — credits/solaris amount, power bar
2. Visible units and buildings on the map
3. The minimap in the bottom-right corner
4. Any production queue visible in the sidebar

Reply with ONLY valid JSON:
{
  "solaris": <number or -1 if not visible>,
  "powerRatio": <0.0-2.0 estimate, -1 if not visible>,
  "playerUnitCount": <estimated visible friendly units>,
  "playerBuildingCount": <estimated visible friendly buildings>,
  "enemyUnitCount": <estimated visible enemy units>,
  "enemyBuildingCount": <estimated visible enemy buildings>,
  "hasRefinery": <boolean>,
  "hasFactory": <boolean>,
  "hasBarracks": <boolean>,
  "isUnderAttack": <boolean>,
  "mapPhase": "early" | "mid" | "late",
  "confidence": <0.3-0.8>
}`,
          },
        ],
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.warn('[VisionExtractor] No JSON in response, using last estimate');
      return this.lastEstimate ?? this.emptyState(tick);
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const state = this.buildState(parsed, tick);
      this.lastEstimate = state;
      return state;
    } catch (e) {
      console.warn('[VisionExtractor] JSON parse failed:', e);
      return this.lastEstimate ?? this.emptyState(tick);
    }
  }

  private buildState(parsed: any, tick: number): GameState {
    const px = this.housePrefix;
    const confidence = Math.max(0.3, Math.min(0.8, parsed.confidence ?? 0.5));

    // Construct approximate player state from vision estimates
    const buildings: BuildingInfo[] = [];
    if (parsed.hasRefinery) buildings.push({ eid: -1, typeName: `${px}Refinery`, x: 0, z: 0, healthPct: 1.0 });
    if (parsed.hasFactory) buildings.push({ eid: -2, typeName: `${px}Factory`, x: 0, z: 0, healthPct: 1.0 });
    if (parsed.hasBarracks) buildings.push({ eid: -3, typeName: `${px}Barracks`, x: 0, z: 0, healthPct: 1.0 });
    // Pad to estimated count
    const bCount = Math.max(0, (parsed.playerBuildingCount ?? 0) - buildings.length);
    for (let i = 0; i < bCount; i++) {
      buildings.push({ eid: -(100 + i), typeName: `${px}SmWindtrap`, x: 0, z: 0, healthPct: 1.0 });
    }

    const ownedBuildingTypes = new Map<string, number>();
    for (const b of buildings) {
      ownedBuildingTypes.set(b.typeName, (ownedBuildingTypes.get(b.typeName) ?? 0) + 1);
    }

    // Approximate units
    const units: UnitInfo[] = [];
    const uCount = parsed.playerUnitCount ?? 0;
    for (let i = 0; i < uCount; i++) {
      units.push({
        eid: -(200 + i),
        typeName: `${px}LightInf`,
        x: 0, z: 0,
        healthPct: 1.0,
        isHarvester: false,
        isIdle: true,
        isInfantry: true,
        canFly: false,
      });
    }

    const player: PlayerState = {
      playerId: 0,
      solaris: parsed.solaris >= 0 ? parsed.solaris : 1000,
      power: {
        produced: 100,
        consumed: parsed.powerRatio > 0 ? Math.round(100 / parsed.powerRatio) : 80,
        ratio: parsed.powerRatio >= 0 ? parsed.powerRatio : 1.0,
      },
      techLevel: parsed.mapPhase === 'late' ? 3 : parsed.mapPhase === 'mid' ? 2 : 1,
      units,
      buildings,
      productionQueues: { building: [], infantry: [], vehicle: [] },
      ownedBuildingTypes,
    };

    // Enemy approximation
    const enemyUnits: UnitInfo[] = [];
    for (let i = 0; i < (parsed.enemyUnitCount ?? 0); i++) {
      enemyUnits.push({
        eid: -(300 + i),
        typeName: 'Unknown',
        x: 0, z: 0,
        healthPct: 1.0,
        isHarvester: false,
        isIdle: false,
        isInfantry: false,
        canFly: false,
      });
    }

    const enemyBuildings: BuildingInfo[] = [];
    for (let i = 0; i < (parsed.enemyBuildingCount ?? 0); i++) {
      enemyBuildings.push({ eid: -(400 + i), typeName: 'Unknown', x: 0, z: 0, healthPct: 1.0 });
    }

    const enemies: PlayerState[] = [{
      playerId: 1,
      solaris: 0,
      power: { produced: 0, consumed: 0, ratio: 1.0 },
      techLevel: player.techLevel,
      units: enemyUnits,
      buildings: enemyBuildings,
      productionQueues: { building: [], infantry: [], vehicle: [] },
      ownedBuildingTypes: new Map(),
    }];

    const events: GameEvent[] = [];
    if (parsed.isUnderAttack) {
      events.push({ type: 'under_attack', x: 0, z: 0, owner: 0 });
    }

    return { tick, player, enemies, confidence, events };
  }

  private emptyState(tick: number): GameState {
    return {
      tick,
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
      enemies: [],
      confidence: 0.1,
      events: [],
    };
  }
}
