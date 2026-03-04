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
}

export class QemuOracleAdapter implements GameAdapter {
  readonly name = 'qemu';
  private controller: QemuController;
  private vision: VisionExtractor;
  private housePrefix: HousePrefix;
  private snapshotName: string | null;
  private tickEstimate = 0;
  private tmpDir: string;
  private isPaused = false;
  private currentTab: 'buildings' | 'units' | 'infantry' = 'buildings';

  constructor(config: QemuOracleConfig) {
    this.controller = new QemuController();
    this.housePrefix = config.housePrefix;
    this.snapshotName = config.snapshotName ?? QEMU_CONFIG.snapshotName;
    this.vision = new VisionExtractor({
      housePrefix: config.housePrefix,
      apiKey: config.apiKey,
    });
    this.tmpDir = path.join(os.tmpdir(), 'oracle-qemu');
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  async connect(): Promise<void> {
    console.log('[QemuAdapter] Booting QEMU VM...');
    await this.controller.boot();

    if (this.snapshotName) {
      console.log(`[QemuAdapter] Loading snapshot "${this.snapshotName}"...`);
      await this.controller.loadSnapshot(this.snapshotName);
      // Brief wait for guest to stabilize after snapshot restore
      await sleep(3000);
    } else {
      console.log('[QemuAdapter] Cold boot — waiting for desktop...');
      await this.controller.waitForDesktop();
    }

    console.log('[QemuAdapter] VM ready');
  }

  async disconnect(): Promise<void> {
    await this.controller.shutdown();
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
    // Emperor uses F9 to toggle pause
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

  /**
   * Translate and execute a single oracle Action via QMP.
   * Game coordinates are at 800x600 but the VM display may be 1024x768.
   * We scale game coords to VM display coords before sending.
   */
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
        // Not easily automated via vision alone
        break;

      default:
        break;
    }
  }

  /**
   * Click a sidebar production item.
   * Game runs at 800x600 but VM display is at QEMU_CONFIG.resolution.
   * We scale the 800x600 game coords to display coords.
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
   * Execute a map command (move/attack_move) via click.
   */
  private async executeMapCommand(type: 'move' | 'attack_move', x: number, z: number): Promise<void> {
    // Rough screen mapping: game coords → viewport coords
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

  /**
   * Click at game-space coordinates (800x600), scaling to VM display resolution.
   */
  private async gameClick(gameX: number, gameY: number, button?: 'left' | 'right' | 'middle'): Promise<void> {
    const scaleX = QEMU_CONFIG.resolution.width / QEMU_CONFIG.gameResolution.width;
    const scaleY = QEMU_CONFIG.resolution.height / QEMU_CONFIG.gameResolution.height;
    const vmX = Math.round(gameX * scaleX);
    const vmY = Math.round(gameY * scaleY);
    await this.controller.mouseClick(vmX, vmY, button);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
