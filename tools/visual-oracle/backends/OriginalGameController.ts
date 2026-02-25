import type { InputStep } from '../qemu/input-sequences.js';

/**
 * Shared interface for controlling the original Emperor: Battle for Dune game.
 * Implemented by both WineBackend (macOS native) and QemuBackend (Windows VM).
 */
export interface OriginalGameController {
  /** Launch the game environment (VM boot or Wine process start). */
  boot(): Promise<void>;

  /** Wait until the game has loaded to a usable state. */
  waitForDesktop(timeoutMs?: number): Promise<void>;

  /** Execute a sequence of keyboard inputs and waits. */
  executeInputSequence(steps: InputStep[]): Promise<void>;

  /** Send a single key combination (QEMU keycode names, e.g. ['ret'], ['1']). */
  sendKey(keys: string[]): Promise<void>;

  /** Capture a single screenshot, return PNG buffer. */
  captureScreenshot(outputPath: string): Promise<Buffer>;

  /** Capture multiple screenshots at an interval, return PNG buffers. */
  captureMultiple(scenarioId: string, count: number, intervalMs: number): Promise<Buffer[]>;

  /** Reset to a clean state between scenarios. */
  resetGuest(): Promise<void>;

  /** Shut down the game environment cleanly. */
  shutdown(): Promise<void>;
}
