/**
 * WineAdapter: plays the original Emperor: Battle for Dune via Wine.
 * Observes via screenshots + Claude vision, acts via DInput hook injection.
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

// Map game-space click targets for common in-game UI elements
// Emperor: BfD runs at 800x600, sidebar on the right
const UI_COORDS = {
  // Approximate sidebar button positions (800x600 resolution)
  // These would need calibration per scenario
  sidebar: { x: 750, y: 300 },
};

export class WineOracleAdapter implements GameAdapter {
  readonly name = 'wine';
  private backend: WineBackend;
  private vision: VisionExtractor;
  private housePrefix: HousePrefix;
  private tickEstimate = 0;
  private tmpDir: string;
  private isPaused = false;

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
    // Clean up temp file
    try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    return state;
  }

  async pause(): Promise<void> {
    if (this.isPaused) return;
    // F9 is the pause key in Emperor: BfD
    await this.backend.sendKey(['f9']);
    this.isPaused = true;
  }

  async resume(): Promise<void> {
    if (!this.isPaused) return;
    await this.backend.sendKey(['f9']); // toggle
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
   * This is approximate — the Wine backend can't precisely address game entities,
   * so we translate to screen-space clicks and keyboard shortcuts.
   */
  private translateAction(action: Action): SessionOp[] {
    const ops: SessionOp[] = [];

    switch (action.type) {
      case 'move':
        // In the original game, you'd select units then right-click destination
        // We can't easily select specific units by EID in Wine, so we skip
        // individual unit commands. The vision-based approach is more about
        // macro-level decisions (production, building) than micro.
        break;

      case 'attack_move':
        // Similarly requires unit selection + A-click
        break;

      case 'produce':
        // Production happens via sidebar clicks
        // This would require knowing the exact sidebar button positions
        // for each unit/building type — a complex calibration task
        console.log(`[WineAdapter] Would produce ${action.typeName} (sidebar click needed)`);
        break;

      case 'repair':
        // Would need to click the repair button then click the building
        break;

      default:
        // Most actions need screen-space coordinates which require
        // vision-based calibration of the UI layout
        break;
    }

    return ops;
  }
}
