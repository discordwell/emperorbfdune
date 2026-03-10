/**
 * Unit tests for QemuController mouse, click, and snapshot methods.
 * Mocks the QMP socket to verify correct protocol messages are sent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock net.createConnection and child_process.spawn before importing
const mockSocket = new EventEmitter() as EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
mockSocket.write = vi.fn();
mockSocket.destroy = vi.fn();

const mockProc = new EventEmitter() as EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
};
mockProc.kill = vi.fn();
mockProc.killed = false;

vi.mock('node:net', () => ({
  createConnection: vi.fn(() => {
    // Simulate async connect
    setTimeout(() => mockSocket.emit('connect'), 10);
    return mockSocket;
  }),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => mockProc),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.alloc(0)),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 500_000 })),
    mkdirSync: vi.fn(),
  },
}));

// Mock pngjs to avoid needing actual PNG encoding in tests
vi.mock('pngjs', () => ({
  PNG: class MockPNG {
    data: Buffer;
    constructor(opts: { width: number; height: number }) {
      this.data = Buffer.alloc(opts.width * opts.height * 4);
    }
    static sync = {
      write: () => Buffer.from('fake-png'),
    };
  },
}));

import { QemuController } from '../QemuController.js';

/**
 * Helper: send a QMP greeting then auto-respond to qmp_capabilities.
 * After calling this, the QemuController is in a ready state.
 */
function simulateQmpReady() {
  // Send greeting
  mockSocket.emit('data', '{"QMP": {"version": {"qemu": {"micro": 0, "minor": 2, "major": 9}}}}\n');

  // Auto-respond to qmp_capabilities command
  mockSocket.write.mockImplementationOnce(() => {
    setTimeout(() => {
      mockSocket.emit('data', '{"return": {}}\n');
    }, 5);
  });
}

/**
 * Helper: auto-respond to the next N QMP commands with success.
 */
function autoRespondSuccess(n = 1) {
  for (let i = 0; i < n; i++) {
    const currentImpl = mockSocket.write.getMockImplementation();
    mockSocket.write.mockImplementationOnce((data: string) => {
      currentImpl?.(data);
      setTimeout(() => {
        mockSocket.emit('data', '{"return": {}}\n');
      }, 5);
    });
  }
}

describe('QemuController', () => {
  let controller: QemuController;
  let sentCommands: Record<string, unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new QemuController();
    sentCommands = [];

    // Capture all commands sent via write
    mockSocket.write.mockImplementation((data: string) => {
      try {
        sentCommands.push(JSON.parse(data));
      } catch { /* ignore non-JSON */ }
      // Auto-respond with success
      setTimeout(() => {
        mockSocket.emit('data', '{"return": {}}\n');
      }, 5);
    });
  });

  afterEach(async () => {
    // Reset socket state
    mockSocket.removeAllListeners('data');
    mockSocket.removeAllListeners('connect');
  });

  async function initController(): Promise<void> {
    const bootPromise = controller.boot();
    // Wait for connect event to fire
    await new Promise((r) => setTimeout(r, 20));
    simulateQmpReady();
    await bootPromise;
    // Clear the qmp_capabilities command from our captured list
    sentCommands = [];
  }

  describe('mouseMove', () => {
    it('sends input-send-event with absolute axis coordinates', async () => {
      await initController();

      await controller.mouseMove(512, 384);

      // Find the input-send-event command
      const moveCmd = sentCommands.find((c) => c.execute === 'input-send-event');
      expect(moveCmd).toBeDefined();
      expect(moveCmd!.arguments).toEqual({
        events: [
          { type: 'abs', data: { axis: 'x', value: Math.round((512 / 800) * 32767) } },
          { type: 'abs', data: { axis: 'y', value: Math.round((384 / 600) * 32767) } },
        ],
      });
    });

    it('maps corner coordinates correctly', async () => {
      await initController();

      await controller.mouseMove(0, 0);
      const cmd = sentCommands.find((c) => c.execute === 'input-send-event');
      const events = (cmd!.arguments as any).events;
      expect(events[0].data.value).toBe(0);
      expect(events[1].data.value).toBe(0);
    });

    it('maps max coordinates to 32767', async () => {
      await initController();

      await controller.mouseMove(800, 600);
      const cmd = sentCommands.find((c) => c.execute === 'input-send-event');
      const events = (cmd!.arguments as any).events;
      expect(events[0].data.value).toBe(32767);
      expect(events[1].data.value).toBe(32767);
    });
  });

  describe('mouseClick', () => {
    it('sends tablet move then HMP mouse_button press and release', async () => {
      await initController();

      await controller.mouseClick(100, 200);

      // Should send: input-send-event (move), then two human-monitor-commands (press + release)
      const moveCmd = sentCommands.find((c) => c.execute === 'input-send-event');
      expect(moveCmd).toBeDefined();
      const moveEvents = (moveCmd!.arguments as any).events;
      expect(moveEvents).toHaveLength(2);
      expect(moveEvents[0]).toEqual({ type: 'abs', data: { axis: 'x', value: Math.round((100 / 800) * 32767) } });
      expect(moveEvents[1]).toEqual({ type: 'abs', data: { axis: 'y', value: Math.round((200 / 600) * 32767) } });

      const hmpCmds = sentCommands.filter((c) => c.execute === 'human-monitor-command');
      expect(hmpCmds.length).toBe(2);
      expect(hmpCmds[0].arguments).toEqual({ 'command-line': 'mouse_button 1' });
      expect(hmpCmds[1].arguments).toEqual({ 'command-line': 'mouse_button 0' });
    });

    it('supports right-click with correct bitmask', async () => {
      await initController();

      await controller.mouseClick(400, 300, 'right');

      const hmpCmds = sentCommands.filter((c) => c.execute === 'human-monitor-command');
      expect(hmpCmds[0].arguments).toEqual({ 'command-line': 'mouse_button 4' });
      expect(hmpCmds[1].arguments).toEqual({ 'command-line': 'mouse_button 0' });
    });

    it('supports middle-click with correct bitmask', async () => {
      await initController();

      await controller.mouseClick(400, 300, 'middle');

      const hmpCmds = sentCommands.filter((c) => c.execute === 'human-monitor-command');
      expect(hmpCmds[0].arguments).toEqual({ 'command-line': 'mouse_button 2' });
    });
  });

  describe('loadSnapshot', () => {
    it('sends human-monitor-command with loadvm', async () => {
      await initController();

      await controller.loadSnapshot('game-ready');

      const executes = sentCommands.map((c) => c.execute);
      expect(executes).toEqual(['human-monitor-command']);

      const loadCmd = sentCommands.find((c) => c.execute === 'human-monitor-command');
      expect(loadCmd!.arguments).toEqual({ 'command-line': 'loadvm game-ready' });
    });
  });

  describe('executeInputSequence with click', () => {
    it('handles click action type', async () => {
      await initController();

      await controller.executeInputSequence([
        { action: 'click', x: 512, y: 400, comment: 'click Single Player' },
      ]);

      // mouseClick sends: 1 input-send-event (move) + 2 human-monitor-commands (press + release)
      const inputCmds = sentCommands.filter((c) => c.execute === 'input-send-event');
      expect(inputCmds.length).toBe(1);
      const hmpCmds = sentCommands.filter((c) => c.execute === 'human-monitor-command');
      expect(hmpCmds.length).toBe(2);
    });

    it('handles mixed key, wait, and click steps', async () => {
      await initController();

      await controller.executeInputSequence([
        { action: 'key', keys: ['ret'], comment: 'dismiss splash' },
        { action: 'wait', ms: 100 },
        { action: 'click', x: 512, y: 385, comment: 'click Single Player' },
      ]);

      const keyCmd = sentCommands.find((c) => c.execute === 'send-key');
      expect(keyCmd).toBeDefined();

      // Click produces 1 move + 2 HMP commands
      const inputCmds = sentCommands.filter((c) => c.execute === 'input-send-event');
      expect(inputCmds.length).toBe(1);
      const hmpCmds = sentCommands.filter((c) => c.execute === 'human-monitor-command');
      expect(hmpCmds.length).toBe(2);
    });
  });

  describe('mouseClick with explicit framebuffer size', () => {
    it('uses provided fbSize instead of QEMU_CONFIG.resolution', async () => {
      await initController();

      // Click at (400, 300) with 800x600 framebuffer
      await controller.mouseClick(400, 300, 'left', { width: 800, height: 600 });

      const moveCmd = sentCommands.find((c) => c.execute === 'input-send-event');
      const moveEvents = (moveCmd!.arguments as any).events;
      // 400/800 * 32767 = 16383 (center of screen)
      expect(moveEvents[0]).toEqual({ type: 'abs', data: { axis: 'x', value: Math.round((400 / 800) * 32767) } });
      expect(moveEvents[1]).toEqual({ type: 'abs', data: { axis: 'y', value: Math.round((300 / 600) * 32767) } });
    });

    it('maps sidebar coordinates correctly at 800x600', async () => {
      await initController();

      // Buildings tab button at game coords (625, 72)
      await controller.mouseClick(625, 72, 'left', { width: 800, height: 600 });

      const moveCmd = sentCommands.find((c) => c.execute === 'input-send-event');
      const moveEvents = (moveCmd!.arguments as any).events;
      // 625/800 * 32767 = 25599
      expect(moveEvents[0].data.value).toBe(Math.round((625 / 800) * 32767));
      // 72/600 * 32767 = 3932
      expect(moveEvents[1].data.value).toBe(Math.round((72 / 600) * 32767));
    });
  });

  describe('mouseMove with explicit framebuffer size', () => {
    it('uses provided fbSize', async () => {
      await initController();

      await controller.mouseMove(200, 150, { width: 800, height: 600 });

      const cmd = sentCommands.find((c) => c.execute === 'input-send-event');
      const events = (cmd!.arguments as any).events;
      expect(events[0].data.value).toBe(Math.round((200 / 800) * 32767));
      expect(events[1].data.value).toBe(Math.round((150 / 600) * 32767));
    });
  });

  describe('connectToExisting', () => {
    it('connects to QMP socket without booting', async () => {
      const connectPromise = controller.connectToExisting();
      await new Promise((r) => setTimeout(r, 20));
      simulateQmpReady();
      await connectPromise;

      // Should be able to send commands now
      await controller.sendKey(['ret']);
      const keyCmd = sentCommands.find((c) => c.execute === 'send-key');
      expect(keyCmd).toBeDefined();
    });
  });

  describe('sendKey', () => {
    it('sends qcode key events', async () => {
      await initController();

      await controller.sendKey(['ret']);

      const keyCmd = sentCommands.find((c) => c.execute === 'send-key');
      expect(keyCmd).toBeDefined();
      expect(keyCmd!.arguments).toEqual({
        keys: [{ type: 'qcode', data: 'ret' }],
      });
    });
  });
});
