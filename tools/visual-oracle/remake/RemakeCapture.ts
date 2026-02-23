import { chromium, type Browser, type Page } from 'playwright';
import {
  startSkirmish,
  startCampaign,
  waitForGameReady,
  waitForTitleScreen,
} from '../../../tests/e2e/helpers/game-navigation.js';

export interface RemakeScenarioConfig {
  url: string;
  setup: string;
  waitForGame: boolean;
  captureDelay: number;
  captureCount: number;
  captureInterval: number;
}

/**
 * Captures screenshots from the web remake using Playwright.
 * Delegates navigation to the shared E2E helpers.
 */
export class RemakeCapture {
  private browser: Browser | null = null;
  private baseUrl: string;

  constructor(baseUrl = 'http://localhost:8080') {
    this.baseUrl = baseUrl;
  }

  async boot(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
      ],
    });
    console.log('[Remake] Browser launched');
  }

  async runScenario(config: RemakeScenarioConfig): Promise<Buffer[]> {
    if (!this.browser) throw new Error('Browser not launched — call boot() first');

    const page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });

    try {
      // Navigate to scenario URL
      const url = new URL(config.url, this.baseUrl).toString();
      console.log(`[Remake] Navigating to ${url}`);
      await page.goto(url, { timeout: 60_000 });

      // Run the appropriate setup function
      await this.runSetup(page, config.setup);

      // Wait for game to be ready if needed
      if (config.waitForGame) {
        await waitForGameReady(page);
      }

      // Wait the configured delay before capturing
      if (config.captureDelay > 0) {
        console.log(`[Remake] Waiting ${config.captureDelay}ms before capture...`);
        await page.waitForTimeout(config.captureDelay);
      }

      // Capture screenshots
      const buffers: Buffer[] = [];
      for (let i = 0; i < config.captureCount; i++) {
        console.log(`[Remake] Capturing screenshot ${i + 1}/${config.captureCount}`);
        const buf = await page.screenshot({ fullPage: false });
        buffers.push(buf);
        if (i < config.captureCount - 1) {
          await page.waitForTimeout(config.captureInterval);
        }
      }

      return buffers;
    } finally {
      await page.close();
    }
  }

  /**
   * Execute a named setup sequence to get the game into the right state.
   * Delegates to shared E2E navigation helpers.
   */
  private async runSetup(page: Page, setupName: string): Promise<void> {
    switch (setupName) {
      case 'titleScreen':
        await waitForTitleScreen(page);
        console.log('[Remake] Title screen ready');
        break;
      case 'startEasySkirmish':
        await startSkirmish(page, { navigate: false });
        console.log('[Remake] Easy skirmish started');
        break;
      case 'startCampaign':
        await startCampaign(page, { navigate: false });
        console.log('[Remake] Campaign map ready');
        break;
      default:
        throw new Error(`Unknown setup: ${setupName}`);
    }
  }

  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('[Remake] Browser closed');
    }
  }
}
