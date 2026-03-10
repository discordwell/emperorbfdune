/**
 * QemuAdapter: plays the original Emperor: Battle for Dune inside a headless QEMU VM.
 * Observes via QMP screendump + Claude vision, acts via QMP mouse/keyboard events.
 *
 * This is dramatically simpler than WineAdapter because:
 * - No focus management (headless VM, no display)
 * - No DInput hooking (QMP sends input directly to guest usb-tablet device)
 * - No session batching (each QMP command is atomic and instant)
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type { GameAdapter } from './GameAdapter.js';
import type { GameState } from '../state/GameState.js';
import type { Action } from '../actions/Action.js';
import { VisionExtractor } from '../state/VisionExtractor.js';
import { QemuController } from '../../qemu/QemuController.js';
import { QEMU_CONFIG } from '../../qemu/qemu-config.js';
import { SIDEBAR, BUILDING_ORDER, INFANTRY_ORDER, VEHICLE_ORDER } from './SidebarLayout.js';
import type { HousePrefix } from '../brain/BuildOrders.js';

export interface QemuOracleConfig {
  housePrefix: HousePrefix;
  apiKey?: string;
  /** Skip cold boot by loading a snapshot. Overrides QEMU_CONFIG.snapshotName. */
  snapshotName?: string;
  /** Connect to an already-running QEMU VM instead of booting a new one. */
  connectExisting?: boolean;
  /** Skip menu navigation (snapshot is already in-game). */
  skipNavigation?: boolean;
}

/** Result from vision-based screen detection. */
interface ScreenDetection {
  screen: 'title' | 'main_menu' | 'single_player_menu' | 'skirmish_setup' | 'loading' | 'gameplay' | 'video' | 'unknown';
  /** Where to click to progress toward gameplay. */
  clickTarget?: { x: number; y: number };
  /** Key to press instead of clicking. */
  keyPress?: string[];
  /** How long to wait after this action. */
  waitMs?: number;
  /** Explanation for logging. */
  description?: string;
}

export class QemuOracleAdapter implements GameAdapter {
  readonly name = 'qemu';
  private controller: QemuController;
  private vision: VisionExtractor;
  private anthropic: Anthropic;
  private housePrefix: HousePrefix;
  private snapshotName: string | null;
  private connectExisting: boolean;
  private skipNavigation: boolean;
  private tickEstimate = 0;
  private tmpDir: string;
  private isPaused = false;
  private currentTab: 'buildings' | 'units' | 'infantry' = 'buildings';
  /** Detected framebuffer size (updated from screenshots). */
  private fbSize: { width: number; height: number } = QEMU_CONFIG.gameResolution;

  constructor(config: QemuOracleConfig) {
    this.controller = new QemuController();
    this.housePrefix = config.housePrefix;
    this.snapshotName = config.snapshotName ?? QEMU_CONFIG.snapshotName;
    this.connectExisting = config.connectExisting ?? false;
    this.skipNavigation = config.skipNavigation ?? false;
    this.vision = new VisionExtractor({
      housePrefix: config.housePrefix,
      apiKey: config.apiKey,
    });
    this.anthropic = new Anthropic(config.apiKey ? { apiKey: config.apiKey } : undefined);
    this.tmpDir = path.join(os.tmpdir(), 'oracle-qemu');
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  async connect(): Promise<void> {
    if (this.connectExisting) {
      console.log('[QemuAdapter] Connecting to existing QEMU VM...');
      await this.controller.connectToExisting();
    } else {
      console.log('[QemuAdapter] Booting QEMU VM...');
      await this.controller.boot();
    }

    if (this.snapshotName && !this.connectExisting) {
      console.log(`[QemuAdapter] Loading snapshot "${this.snapshotName}"...`);
      await this.controller.loadSnapshot(this.snapshotName);
      await sleep(3000);
    }

    // Detect actual framebuffer size
    await this.detectFramebuffer();
    console.log(`[QemuAdapter] Framebuffer: ${this.fbSize.width}x${this.fbSize.height}`);

    // Navigate from menus to gameplay unless skipped
    if (!this.skipNavigation) {
      await this.navigateToGame();
    }

    console.log('[QemuAdapter] VM ready for oracle loop');
  }

  async disconnect(): Promise<void> {
    if (this.connectExisting) {
      console.log('[QemuAdapter] Disconnecting (VM left running)');
      this.controller.disconnectQmp();
    } else {
      await this.controller.shutdown();
    }
  }

  async observe(): Promise<GameState> {
    this.tickEstimate++;
    const screenshotPath = path.join(this.tmpDir, `observe-${this.tickEstimate}.png`);
    const buf = await this.controller.captureScreenshot(screenshotPath);
    const state = await this.vision.extract(buf, this.tickEstimate);
    try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    return state;
  }

  async pause(): Promise<void> {
    if (this.isPaused) return;
    await this.controller.sendKey(['f9']);
    this.isPaused = true;
  }

  async resume(): Promise<void> {
    if (!this.isPaused) return;
    await this.controller.sendKey(['f9']);
    this.isPaused = false;
  }

  async execute(actions: Action[]): Promise<void> {
    for (const action of actions) {
      await this.executeAction(action);
    }
  }

  async screenshot(): Promise<Buffer> {
    const screenshotPath = path.join(this.tmpDir, `screenshot-${Date.now()}.png`);
    const buf = await this.controller.captureScreenshot(screenshotPath);
    try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    return buf;
  }

  // ─── Game Navigation ───────────────────────────────────────────────

  /**
   * Navigate from the current screen (typically title/main menu) into a
   * skirmish game. Uses Claude vision to detect each screen and decide
   * the next click/key to progress.
   */
  private async navigateToGame(): Promise<void> {
    const maxSteps = 25;
    console.log('[QemuAdapter] Navigating to skirmish gameplay...');

    for (let step = 0; step < maxSteps; step++) {
      const buf = await this.captureForNav(`nav-step-${step}`);
      const detection = await this.detectScreen(buf);

      console.log(`[QemuAdapter] Nav step ${step}: screen=${detection.screen} — ${detection.description ?? ''}`);

      if (detection.screen === 'gameplay') {
        console.log('[QemuAdapter] Reached gameplay screen');
        // Re-detect framebuffer now that game may have changed resolution
        await this.detectFramebuffer();
        return;
      }

      if (detection.clickTarget) {
        const cx = Math.max(0, Math.min(this.fbSize.width - 1, detection.clickTarget.x));
        const cy = Math.max(0, Math.min(this.fbSize.height - 1, detection.clickTarget.y));
        await this.fbClick(cx, cy);
      } else if (detection.keyPress) {
        await this.controller.sendKey(detection.keyPress);
      } else {
        // No action suggested — try ESC then wait
        console.log('[QemuAdapter] No navigation action, pressing ESC');
        await this.controller.sendKey(['esc']);
      }

      await sleep(detection.waitMs ?? 2000);
    }

    throw new Error('[QemuAdapter] Failed to reach gameplay within 25 navigation steps');
  }

  /**
   * Ask Claude vision what screen the game is on and what to click next.
   */
  private async detectScreen(screenshot: Buffer): Promise<ScreenDetection> {
    const houseName = this.housePrefix === 'AT' ? 'Atreides' :
                      this.housePrefix === 'HK' ? 'Harkonnen' : 'Ordos';
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
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
              text: `You are navigating Emperor: Battle for Dune (2001 RTS) menus to start a skirmish game as ${houseName}.

The game runs at 800x600 resolution. Identify the current screen and tell me what to click or press to progress toward starting a Practice/Skirmish game.

Screens you might see:
- "video" — intro/cutscene video playing (press ESC to skip)
- "title" — title screen with animated logo (click anywhere or press Enter)
- "main_menu" — main menu with buttons: Single Player, Multiplayer, Options, Exit
- "single_player_menu" — sub-menu with: Campaign, Practice/Skirmish, Tutorial, Back
- "skirmish_setup" — map/house/difficulty selection screen with a Start/Play button
- "loading" — loading screen (just wait)
- "gameplay" — in-game with units, buildings, sidebar, minimap visible

Reply with ONLY valid JSON:
{
  "screen": "<screen type from list above>",
  "clickTarget": {"x": <pixel x 0-799>, "y": <pixel y 0-599>} or null,
  "keyPress": ["<qemu key name>"] or null,
  "waitMs": <milliseconds to wait after action>,
  "description": "<brief description of what you see>"
}

For skirmish_setup: select ${houseName} house if not selected, then click the Start/Play button.
If you see a confirmation dialog, click Yes/OK.
If unsure, press ESC to go back and try again.`,
            },
          ],
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { screen: 'unknown', keyPress: ['esc'], waitMs: 2000, description: 'Could not parse response' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        screen: parsed.screen ?? 'unknown',
        clickTarget: parsed.clickTarget ?? undefined,
        keyPress: parsed.keyPress ?? undefined,
        waitMs: parsed.waitMs ?? 2000,
        description: parsed.description ?? undefined,
      };
    } catch (e) {
      console.warn('[QemuAdapter] Screen detection failed:', e);
      return { screen: 'unknown', keyPress: ['esc'], waitMs: 3000, description: 'Vision API error' };
    }
  }

  // ─── Action Execution ──────────────────────────────────────────────

  private async executeAction(action: Action): Promise<void> {
    switch (action.type) {
      case 'produce':
        await this.executeProduce(action.typeName, action.isBuilding);
        break;

      case 'move':
      case 'attack_move':
        if (action.x !== undefined && action.z !== undefined) {
          await this.executeMapCommand(action.type, action.x, action.z);
        }
        break;

      case 'repair':
        break;

      default:
        break;
    }
  }

  /**
   * Click a sidebar production item.
   */
  private async executeProduce(typeName: string, isBuilding: boolean): Promise<void> {
    const prefix = this.housePrefix;

    let targetTab: 'buildings' | 'units' | 'infantry';
    let order: string[];

    if (isBuilding) {
      targetTab = 'buildings';
      order = BUILDING_ORDER[prefix];
    } else {
      const infOrder = INFANTRY_ORDER[prefix];
      if (infOrder.includes(typeName)) {
        targetTab = 'infantry';
        order = infOrder;
      } else {
        targetTab = 'units';
        order = VEHICLE_ORDER[prefix];
      }
    }

    const itemIndex = order.indexOf(typeName);
    if (itemIndex < 0) {
      console.log(`[QemuAdapter] Unknown sidebar position for ${typeName}`);
      return;
    }

    // Switch tab if needed
    if (this.currentTab !== targetTab) {
      const tabCoord = SIDEBAR.tabs[targetTab];
      await this.gameClick(tabCoord.x, tabCoord.y);
      await sleep(300);
      this.currentTab = targetTab;
    }

    const itemCoord = SIDEBAR.gridItem(itemIndex);
    if (itemCoord.y > SIDEBAR.maxVisibleY) {
      console.log(`[QemuAdapter] Item ${typeName} at index ${itemIndex} would be off-screen, skipping`);
      return;
    }

    await this.gameClick(itemCoord.x, itemCoord.y);
    await sleep(200);
  }

  /**
   * Execute a map command (move/attack_move) via click in the viewport.
   */
  private async executeMapCommand(type: 'move' | 'attack_move', x: number, z: number): Promise<void> {
    const viewportWidth = 600; // sidebar starts at x=600
    const viewportHeight = 568; // 600 - 32 (resource bar)
    const screenX = Math.max(10, Math.min(viewportWidth - 10, x * 2));
    const screenY = Math.max(42, Math.min(viewportHeight + 32, 32 + z * 2));

    if (type === 'attack_move') {
      await this.controller.sendKey(['a']);
      await sleep(100);
    }

    await this.gameClick(screenX, screenY);
    await sleep(200);
  }

  // ─── Click Helpers ─────────────────────────────────────────────────

  /**
   * Click at game-space coordinates (800x600).
   * Passes the game resolution directly to QemuController so it can
   * compute correct QMP absolute coordinates without double-scaling.
   */
  private async gameClick(gameX: number, gameY: number, button?: 'left' | 'right' | 'middle'): Promise<void> {
    await this.controller.mouseClick(gameX, gameY, button, QEMU_CONFIG.gameResolution);
  }

  /**
   * Click at framebuffer pixel coordinates (whatever resolution the guest
   * display is currently at). Used during menu navigation when the game
   * hasn't yet switched to its 800x600 mode.
   */
  private async fbClick(x: number, y: number, button?: 'left' | 'right' | 'middle'): Promise<void> {
    await this.controller.mouseClick(x, y, button, this.fbSize);
  }

  // ─── Framebuffer Detection ─────────────────────────────────────────

  private async detectFramebuffer(): Promise<void> {
    try {
      this.fbSize = await this.controller.getFramebufferSize();
    } catch (e) {
      console.warn('[QemuAdapter] Could not detect framebuffer size, using game default:', e);
      this.fbSize = QEMU_CONFIG.gameResolution;
    }
  }

  // ─── Screenshot Helpers ────────────────────────────────────────────

  private async captureForNav(label: string): Promise<Buffer> {
    const p = path.join(this.tmpDir, `${label}.png`);
    const buf = await this.controller.captureScreenshot(p);
    // Keep nav screenshots for debugging
    return buf;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
