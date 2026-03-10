/**
 * Unit tests for QemuAdapter — coordinate mapping, action execution, and config.
 * Mocks QemuController and VisionExtractor to test adapter logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock QemuController
const mockController = {
  boot: vi.fn().mockResolvedValue(undefined),
  connectToExisting: vi.fn().mockResolvedValue(undefined),
  loadSnapshot: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  disconnectQmp: vi.fn(),
  mouseClick: vi.fn().mockResolvedValue(undefined),
  mouseMove: vi.fn().mockResolvedValue(undefined),
  sendKey: vi.fn().mockResolvedValue(undefined),
  captureScreenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  getFramebufferSize: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
  waitForDesktop: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../qemu/QemuController.js', () => ({
  QemuController: class MockQemuController {
    boot = mockController.boot;
    connectToExisting = mockController.connectToExisting;
    loadSnapshot = mockController.loadSnapshot;
    shutdown = mockController.shutdown;
    disconnectQmp = mockController.disconnectQmp;
    mouseClick = mockController.mouseClick;
    mouseMove = mockController.mouseMove;
    sendKey = mockController.sendKey;
    captureScreenshot = mockController.captureScreenshot;
    getFramebufferSize = mockController.getFramebufferSize;
    waitForDesktop = mockController.waitForDesktop;
  },
}));

// Mock VisionExtractor
const mockVisionExtract = vi.fn().mockResolvedValue({
  tick: 1,
  player: {
    playerId: 0,
    solaris: 5000,
    power: { produced: 100, consumed: 80, ratio: 1.25 },
    techLevel: 1,
    units: [],
    buildings: [
      { eid: -1, typeName: 'ATRefinery', x: 0, z: 0, healthPct: 1.0 },
    ],
    productionQueues: { building: [], infantry: [], vehicle: [] },
    ownedBuildingTypes: new Map([['ATRefinery', 1]]),
  },
  enemies: [],
  confidence: 0.6,
  events: [],
});

vi.mock('../state/VisionExtractor.js', () => ({
  VisionExtractor: class MockVisionExtractor {
    extract = mockVisionExtract;
    constructor() {}
  },
}));

// Mock Anthropic (for screen detection during navigation)
const mockAnthropicCreate = vi.fn().mockResolvedValue({
  content: [{
    type: 'text',
    text: '{"screen": "gameplay", "description": "In-game with sidebar visible"}',
  }],
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockAnthropicCreate };
    constructor() {}
  },
}));

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => true),
  },
}));

import { QemuOracleAdapter } from '../adapters/QemuAdapter.js';
import { QEMU_CONFIG } from '../../qemu/qemu-config.js';
import { SIDEBAR, BUILDING_ORDER, INFANTRY_ORDER, VEHICLE_ORDER } from '../adapters/SidebarLayout.js';

describe('QemuAdapter', () => {
  let adapter: QemuOracleAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gameplay screen detected immediately (skip navigation)
    mockAnthropicCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: '{"screen": "gameplay", "description": "In-game"}',
      }],
    });
  });

  describe('connect', () => {
    it('boots new VM and navigates to game by default', async () => {
      adapter = new QemuOracleAdapter({ housePrefix: 'AT' });
      await adapter.connect();

      expect(mockController.boot).toHaveBeenCalledOnce();
      expect(mockController.connectToExisting).not.toHaveBeenCalled();
      expect(mockController.loadSnapshot).toHaveBeenCalledWith('game-ready');
      expect(mockController.getFramebufferSize).toHaveBeenCalled();
    });

    it('connects to existing VM when connectExisting=true', async () => {
      adapter = new QemuOracleAdapter({ housePrefix: 'AT', connectExisting: true });
      await adapter.connect();

      expect(mockController.connectToExisting).toHaveBeenCalledOnce();
      expect(mockController.boot).not.toHaveBeenCalled();
      // Should not try to load snapshot when connecting to existing
      expect(mockController.loadSnapshot).not.toHaveBeenCalled();
    });

    it('skips navigation when skipNavigation=true', async () => {
      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        skipNavigation: true,
        connectExisting: true,
      });
      await adapter.connect();

      // No screenshots or vision calls for navigation
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
    });

    it('uses custom snapshot name', async () => {
      adapter = new QemuOracleAdapter({
        housePrefix: 'HK',
        snapshotName: 'mid-game',
      });
      await adapter.connect();

      expect(mockController.loadSnapshot).toHaveBeenCalledWith('mid-game');
    });
  });

  describe('disconnect', () => {
    it('shuts down VM when adapter booted it', async () => {
      adapter = new QemuOracleAdapter({ housePrefix: 'AT', skipNavigation: true });
      await adapter.connect();
      await adapter.disconnect();

      expect(mockController.shutdown).toHaveBeenCalledOnce();
    });

    it('does not shut down VM when connectExisting=true', async () => {
      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        connectExisting: true,
        skipNavigation: true,
      });
      await adapter.connect();
      await adapter.disconnect();

      expect(mockController.shutdown).not.toHaveBeenCalled();
    });
  });

  describe('execute — produce actions', () => {
    beforeEach(async () => {
      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        skipNavigation: true,
        connectExisting: true,
      });
      await adapter.connect();
      vi.clearAllMocks();
    });

    it('clicks correct sidebar position for ATSmWindtrap (building index 0)', async () => {
      await adapter.execute([{ type: 'produce', typeName: 'ATSmWindtrap', isBuilding: true }]);

      // ATSmWindtrap is index 0 in BUILDING_ORDER.AT
      // Already on buildings tab, so no tab switch
      const expectedCoord = SIDEBAR.gridItem(0);
      expect(mockController.mouseClick).toHaveBeenCalledWith(
        expectedCoord.x,
        expectedCoord.y,
        undefined,
        QEMU_CONFIG.gameResolution,
      );
    });

    it('switches tab before clicking infantry item', async () => {
      await adapter.execute([{ type: 'produce', typeName: 'ATScout', isBuilding: false }]);

      // Should click infantry tab first, then the item
      expect(mockController.mouseClick).toHaveBeenCalledTimes(2);

      // First call: infantry tab button
      const tabCall = mockController.mouseClick.mock.calls[0];
      expect(tabCall[0]).toBe(SIDEBAR.tabs.infantry.x);
      expect(tabCall[1]).toBe(SIDEBAR.tabs.infantry.y);

      // Second call: ATScout at index 0 in infantry order
      const itemCall = mockController.mouseClick.mock.calls[1];
      const expectedCoord = SIDEBAR.gridItem(0);
      expect(itemCall[0]).toBe(expectedCoord.x);
      expect(itemCall[1]).toBe(expectedCoord.y);
    });

    it('clicks correct grid position for items in second column', async () => {
      await adapter.execute([{ type: 'produce', typeName: 'ATWall', isBuilding: true }]);

      // ATWall is index 1 → col=1, row=0 → x=749, y=124
      const expectedCoord = SIDEBAR.gridItem(1);
      expect(expectedCoord.x).toBe(749);
      expect(expectedCoord.y).toBe(124);

      expect(mockController.mouseClick).toHaveBeenCalledWith(
        749, 124, undefined, QEMU_CONFIG.gameResolution,
      );
    });

    it('passes game resolution to mouseClick, not desktop resolution', async () => {
      await adapter.execute([{ type: 'produce', typeName: 'ATRefinery', isBuilding: true }]);

      const call = mockController.mouseClick.mock.calls[0];
      // 4th arg is fbSize — should be gameResolution (800x600), not desktop (1024x768)
      expect(call[3]).toEqual({ width: 800, height: 600 });
    });

    it('skips unknown unit types', async () => {
      await adapter.execute([{ type: 'produce', typeName: 'ATFakeUnit', isBuilding: false }]);

      expect(mockController.mouseClick).not.toHaveBeenCalled();
    });
  });

  describe('execute — map commands', () => {
    beforeEach(async () => {
      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        skipNavigation: true,
        connectExisting: true,
      });
      await adapter.connect();
      vi.clearAllMocks();
    });

    it('executes move command with click in viewport', async () => {
      await adapter.execute([{
        type: 'move',
        entityIds: [1],
        x: 100,
        z: 100,
      }]);

      expect(mockController.mouseClick).toHaveBeenCalledOnce();
      // screenX = clamp(100*2, 10, 590) = 200
      // screenY = clamp(32 + 100*2, 42, 600) = 232
      expect(mockController.mouseClick).toHaveBeenCalledWith(
        200, 232, undefined, QEMU_CONFIG.gameResolution,
      );
    });

    it('sends A key before click for attack_move', async () => {
      await adapter.execute([{
        type: 'attack_move',
        entityIds: [1],
        x: 50,
        z: 50,
      }]);

      expect(mockController.sendKey).toHaveBeenCalledWith(['a']);
      expect(mockController.mouseClick).toHaveBeenCalledOnce();
    });
  });

  describe('observe', () => {
    it('captures screenshot and passes to vision extractor', async () => {
      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        skipNavigation: true,
        connectExisting: true,
      });
      await adapter.connect();
      vi.clearAllMocks();

      const state = await adapter.observe();

      expect(mockController.captureScreenshot).toHaveBeenCalledOnce();
      expect(mockVisionExtract).toHaveBeenCalledOnce();
      expect(state.player.solaris).toBe(5000);
    });
  });

  describe('pause/resume', () => {
    beforeEach(async () => {
      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        skipNavigation: true,
        connectExisting: true,
      });
      await adapter.connect();
      vi.clearAllMocks();
    });

    it('sends F9 to toggle pause', async () => {
      await adapter.pause();
      expect(mockController.sendKey).toHaveBeenCalledWith(['f9']);
    });

    it('does not double-pause', async () => {
      await adapter.pause();
      await adapter.pause();
      expect(mockController.sendKey).toHaveBeenCalledTimes(1);
    });

    it('resumes after pause', async () => {
      await adapter.pause();
      vi.clearAllMocks();
      await adapter.resume();
      expect(mockController.sendKey).toHaveBeenCalledWith(['f9']);
    });
  });

  describe('navigation — vision-guided', () => {
    it('detects gameplay screen and stops navigating', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: '{"screen": "gameplay", "description": "In-game with units visible"}',
        }],
      });

      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        connectExisting: true,
      });
      await adapter.connect();

      // Should have called vision API once (detected gameplay immediately)
      expect(mockAnthropicCreate).toHaveBeenCalledOnce();
    });

    it('clicks through menus based on vision guidance', async () => {
      let callCount = 0;
      mockAnthropicCreate.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: [{
              type: 'text',
              text: '{"screen": "main_menu", "clickTarget": {"x": 400, "y": 300}, "waitMs": 1000, "description": "Click Single Player"}',
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: '{"screen": "gameplay", "description": "In-game"}',
          }],
        };
      });

      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        connectExisting: true,
      });
      await adapter.connect();

      // First call: menu detected, click (400, 300)
      // Second call: gameplay detected, done
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
      // The fbClick uses detected framebuffer size (800x600)
      expect(mockController.mouseClick).toHaveBeenCalledWith(
        400, 300, undefined, { width: 800, height: 600 },
      );
    });

    it('handles key press navigation actions', async () => {
      let callCount = 0;
      mockAnthropicCreate.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: [{
              type: 'text',
              text: '{"screen": "video", "keyPress": ["esc"], "waitMs": 500, "description": "Skip intro video"}',
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: '{"screen": "gameplay", "description": "In-game"}',
          }],
        };
      });

      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        connectExisting: true,
      });
      await adapter.connect();

      expect(mockController.sendKey).toHaveBeenCalledWith(['esc']);
    });

    it('clamps out-of-bounds LLM click coordinates', async () => {
      let callCount = 0;
      mockAnthropicCreate.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: [{
              type: 'text',
              text: '{"screen": "main_menu", "clickTarget": {"x": -50, "y": 1200}, "waitMs": 500, "description": "OOB coords"}',
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: '{"screen": "gameplay", "description": "In-game"}',
          }],
        };
      });

      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        connectExisting: true,
      });
      await adapter.connect();

      // Coords should be clamped to [0, 799] x [0, 599]
      const clickCall = mockController.mouseClick.mock.calls[0];
      expect(clickCall[0]).toBe(0);   // clamped from -50
      expect(clickCall[1]).toBe(599); // clamped from 1200
    });

    it('falls back to game resolution when framebuffer detection fails', async () => {
      mockController.getFramebufferSize.mockRejectedValueOnce(new Error('no screendump'));
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"screen": "gameplay"}' }],
      });

      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        connectExisting: true,
      });
      await adapter.connect();

      // Should not throw, falls back to gameResolution (800x600)
      expect(mockController.getFramebufferSize).toHaveBeenCalled();
    });
  });

  describe('disconnect — connectExisting', () => {
    it('closes QMP socket without shutting down VM', async () => {
      adapter = new QemuOracleAdapter({
        housePrefix: 'AT',
        connectExisting: true,
        skipNavigation: true,
      });
      await adapter.connect();
      await adapter.disconnect();

      expect(mockController.disconnectQmp).toHaveBeenCalledOnce();
      expect(mockController.shutdown).not.toHaveBeenCalled();
    });
  });
});
