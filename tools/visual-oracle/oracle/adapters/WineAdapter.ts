/**
 * WineAdapter: plays the original Emperor: Battle for Dune via Wine.
 * Observes via screenshots + Claude vision, acts via DInput hook injection.
 *
 * The original game runs at 800x600. The sidebar is on the right (x ~600-800).
 * Production is done by clicking sidebar tab → clicking item in 2-column grid.
 * Unit commands are done by selecting units → right-clicking destination.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { GameAdapter } from './GameAdapter.js';
import type { GameState } from '../state/GameState.js';
import type { Action } from '../actions/Action.js';
import { VisionExtractor, type VisionExtractorConfig } from '../state/VisionExtractor.js';
import { WineBackend, type SessionOp } from '../../backends/WineBackend.js';
import type { HousePrefix } from '../brain/BuildOrders.js';

export interface WineOracleConfig {
  housePrefix: HousePrefix;
  apiKey?: string;
}

/**
 * Sidebar layout coordinates at 800x600 resolution.
 * The sidebar occupies x=600-800, starts at y=32 (below resource bar).
 */
const SIDEBAR = {
  // Tab buttons
  tabs: {
    buildings: { x: 625, y: 72 },
    units: { x: 675, y: 72 },
    infantry: { x: 725, y: 72 },
    starport: { x: 775, y: 72 },
  },
  // Grid items: 2 columns, ~50px row height starting at y=124
  gridItem: (index: number) => {
    const row = Math.floor(index / 2);
    const col = index % 2;
    return {
      x: col === 0 ? 651 : 749,
      y: 124 + row * 50,
    };
  },
} as const;

/**
 * Sidebar production item ordering per tab.
 * These map building/unit type names to their grid position index in the sidebar.
 * Ordering matches the original game's sidebar layout (sorted by tech level, then role).
 */
const BUILDING_ORDER: Record<HousePrefix, string[]> = {
  AT: [
    'ATSmWindtrap', 'ATWall', 'ATRefinery', 'ATBarracks', 'ATFactory',
    'ATOutpost', 'ATRocketTurret', 'ATPillbox', 'ATHanger', 'ATHelipad',
    'ATStarport', 'ATPalace',
  ],
  HK: [
    'HKSmWindtrap', 'HKWall', 'HKRefinery', 'HKBarracks', 'HKFactory',
    'HKOutpost', 'HKFlameTurret', 'HKGunTurret', 'HKHanger', 'HKHelipad',
    'HKStarport', 'HKPalace',
  ],
  OR: [
    'ORSmWindtrap', 'ORWall', 'ORRefinery', 'ORBarracks', 'ORFactory',
    'OROutpost', 'ORGasTurret', 'ORPopUpTurret', 'ORHanger',
    'ORStarport', 'ORPalace',
  ],
};

const INFANTRY_ORDER: Record<HousePrefix, string[]> = {
  AT: ['ATScout', 'ATInfantry', 'ATSniper', 'ATMilitia', 'ATKindjal', 'ATEngineer'],
  HK: ['HKScout', 'HKLightInf', 'HKTrooper', 'HKFlamer', 'HKEngineer'],
  OR: ['ORScout', 'ORChemical', 'ORAATrooper', 'ORMortar', 'ORSaboteur', 'OREngineer'],
};

const VEHICLE_ORDER: Record<HousePrefix, string[]> = {
  AT: ['ATTrike', 'Harvester', 'ATMongoose', 'ATOrni', 'ATADVCarryall'],
  HK: ['HKBuzzsaw', 'Harvester', 'HKAssault', 'HKFlame', 'HKMissile', 'HKDevastator', 'HKGunship'],
  OR: ['ORDustScout', 'Harvester', 'ORLaserTank', 'ORKobra', 'ORDeviator', 'OREITS'],
};

export class WineOracleAdapter implements GameAdapter {
  readonly name = 'wine';
  private backend: WineBackend;
  private vision: VisionExtractor;
  private housePrefix: HousePrefix;
  private tickEstimate = 0;
  private tmpDir: string;
  private isPaused = false;
  private currentTab: 'buildings' | 'units' | 'infantry' = 'buildings';

  constructor(config: WineOracleConfig) {
    this.backend = new WineBackend();
    this.housePrefix = config.housePrefix;
    this.vision = new VisionExtractor({
      housePrefix: config.housePrefix,
      apiKey: config.apiKey,
    });
    this.tmpDir = path.join(os.tmpdir(), 'oracle-wine');
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  async connect(): Promise<void> {
    console.log('[WineAdapter] Booting Wine + Emperor...');
    await this.backend.boot();
    await this.backend.waitForDesktop();
    console.log('[WineAdapter] Game is running');
  }

  async disconnect(): Promise<void> {
    await this.backend.shutdown();
  }

  async observe(): Promise<GameState> {
    this.tickEstimate++;
    const screenshotPath = path.join(this.tmpDir, `observe-${this.tickEstimate}.png`);
    const buf = await this.backend.captureScreenshot(screenshotPath);
    const state = await this.vision.extract(buf, this.tickEstimate);
    try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    return state;
  }

  async pause(): Promise<void> {
    if (this.isPaused) return;
    await this.backend.sendKey(['f9']);
    this.isPaused = true;
  }

  async resume(): Promise<void> {
    if (!this.isPaused) return;
    await this.backend.sendKey(['f9']);
    this.isPaused = false;
  }

  async execute(actions: Action[]): Promise<void> {
    const ops: SessionOp[] = [];

    for (const action of actions) {
      const translated = this.translateAction(action);
      ops.push(...translated);
    }

    if (ops.length > 0) {
      await this.backend.runSession(ops);
    }
  }

  async screenshot(): Promise<Buffer> {
    const screenshotPath = path.join(this.tmpDir, `screenshot-${Date.now()}.png`);
    const buf = await this.backend.captureScreenshot(screenshotPath);
    try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    return buf;
  }

  /**
   * Translate oracle Action to Wine SessionOps (clicks + keys).
   * Production actions click the sidebar. Movement/attack use map clicks.
   */
  private translateAction(action: Action): SessionOp[] {
    const ops: SessionOp[] = [];

    switch (action.type) {
      case 'produce':
        ops.push(...this.translateProduce(action.typeName, action.isBuilding));
        break;

      case 'move':
      case 'attack_move':
        // Select all military: Ctrl+A is "select all units" in Emperor: BfD
        // Then right-click or A-click destination
        if (action.x !== undefined && action.z !== undefined) {
          ops.push(...this.translateMapCommand(action.type, action.x, action.z));
        }
        break;

      case 'repair':
        // Not easily automated — would need to click repair button then click building
        break;

      default:
        break;
    }

    return ops;
  }

  /**
   * Translate a production action to sidebar clicks.
   * 1. Switch to the right tab (buildings/units/infantry)
   * 2. Click the item in the grid
   */
  private translateProduce(typeName: string, isBuilding: boolean): SessionOp[] {
    const ops: SessionOp[] = [];
    const prefix = this.housePrefix;

    let targetTab: 'buildings' | 'units' | 'infantry';
    let order: string[];

    if (isBuilding) {
      targetTab = 'buildings';
      order = BUILDING_ORDER[prefix];
    } else {
      // Check if it's infantry or vehicle
      const infOrder = INFANTRY_ORDER[prefix];
      if (infOrder.includes(typeName)) {
        targetTab = 'infantry';
        order = infOrder;
      } else {
        targetTab = 'units';
        order = VEHICLE_ORDER[prefix];
      }
    }

    // Validate item exists in the grid before committing to tab switch
    const itemIndex = order.indexOf(typeName);
    if (itemIndex < 0) {
      console.log(`[WineAdapter] Unknown sidebar position for ${typeName}`);
      return [];
    }

    // Switch tab if needed (only after validating item exists)
    if (this.currentTab !== targetTab) {
      const tabCoord = SIDEBAR.tabs[targetTab];
      ops.push({ type: 'click', gameX: tabCoord.x, gameY: tabCoord.y });
      ops.push({ type: 'wait', ms: 300 });
      this.currentTab = targetTab;
    }

    // Click the item. Note: items not available (grayed out) will be silently ignored.
    // Items below the visible area would need scrolling — for now we handle up to ~10 items.
    const itemCoord = SIDEBAR.gridItem(itemIndex);
    if (itemCoord.y > 550) {
      // Below visible sidebar area — skip
      console.log(`[WineAdapter] Item ${typeName} at index ${itemIndex} would be off-screen, skipping`);
      return [];
    }

    ops.push({ type: 'click', gameX: itemCoord.x, gameY: itemCoord.y });
    ops.push({ type: 'wait', ms: 200 });

    return ops;
  }

  /**
   * Translate a map command (move/attack_move) to mouse actions.
   * Game coords (x, z) need to be mapped to screen coords in the map viewport.
   * The map viewport is x=0-600, y=32-600 at 800x600 resolution.
   *
   * This is approximate — the exact mapping depends on camera position and zoom.
   * We use Ctrl+A (select all) then right-click for moves.
   */
  private translateMapCommand(type: 'move' | 'attack_move', x: number, z: number): SessionOp[] {
    const ops: SessionOp[] = [];

    // Select all combat units with keyboard shortcut
    // In Emperor: BfD, there's no direct Ctrl+A — but we can use number groups
    // For simplicity, we'll click in the map area at the target location
    // The camera should roughly center on the base, so coords near base map to screen center

    // Rough screen mapping: game coords → viewport coords
    // This is very approximate and would need proper camera-aware translation
    const viewportWidth = 600; // sidebar starts at x=600
    const viewportHeight = 568; // 600 - 32 (resource bar)
    const screenX = Math.max(10, Math.min(viewportWidth - 10, x * 2)); // rough scale
    const screenY = Math.max(42, Math.min(viewportHeight + 32, 32 + z * 2)); // rough scale

    if (type === 'attack_move') {
      // A + click for attack-move
      ops.push({ type: 'key', keys: ['a'] }); // not a real DIK code — would need proper mapping
      ops.push({ type: 'wait', ms: 100 });
    }

    // Right-click for move command (after selecting units)
    // Note: this is a simplification — proper unit selection needed first
    ops.push({ type: 'click', gameX: screenX, gameY: screenY });
    ops.push({ type: 'wait', ms: 200 });

    return ops;
  }
}
