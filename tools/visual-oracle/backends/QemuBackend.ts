import type { OriginalGameController } from './OriginalGameController.js';
import { QemuController } from '../qemu/QemuController.js';
import type { InputStep } from '../qemu/input-sequences.js';

/**
 * Adapter that wraps the existing QemuController to implement
 * the OriginalGameController interface.
 */
export class QemuBackend implements OriginalGameController {
  private qemu = new QemuController();

  async boot(): Promise<void> {
    await this.qemu.boot();
  }

  async waitForDesktop(timeoutMs?: number): Promise<void> {
    await this.qemu.waitForDesktop(timeoutMs);
  }

  async executeInputSequence(steps: InputStep[]): Promise<void> {
    await this.qemu.executeInputSequence(steps);
  }

  async sendKey(keys: string[]): Promise<void> {
    await this.qemu.sendKey(keys);
  }

  async captureScreenshot(outputPath: string): Promise<Buffer> {
    return this.qemu.captureScreenshot(outputPath);
  }

  async captureMultiple(scenarioId: string, count: number, intervalMs: number): Promise<Buffer[]> {
    return this.qemu.captureMultiple(scenarioId, count, intervalMs);
  }

  async resetGuest(): Promise<void> {
    await this.qemu.resetGuest();
  }

  async shutdown(): Promise<void> {
    await this.qemu.shutdown();
  }
}
