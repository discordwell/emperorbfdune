import { chromium, type Browser, type Page } from 'playwright';

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
 * Reuses navigation patterns from the E2E test suite.
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
        await this.waitForGameReady(page);
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
   * These mirror the patterns from screenshots.spec.ts.
   */
  private async runSetup(page: Page, setupName: string): Promise<void> {
    switch (setupName) {
      case 'titleScreen':
        await this.setupTitleScreen(page);
        break;
      case 'startEasySkirmish':
        await this.setupEasySkirmish(page);
        break;
      case 'startCampaign':
        await this.setupCampaign(page);
        break;
      default:
        throw new Error(`Unknown setup: ${setupName}`);
    }
  }

  private async setupTitleScreen(page: Page): Promise<void> {
    // Just wait for the title to render
    await page.getByText('PLAY', { exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1000);
    console.log('[Remake] Title screen ready');
  }

  private async setupEasySkirmish(page: Page): Promise<void> {
    // House selection
    await page.getByText('PLAY', { exact: true }).click();
    await page.getByText('Choose Your House').waitFor();
    await page.getByText('Atreides', { exact: true }).click();

    // Game mode
    await page.getByText('Select Game Mode').waitFor();
    await page.getByText('Skirmish', { exact: true }).click();

    // Subhouse
    await page.getByText('Choose Your Subhouse Ally').waitFor();
    await page.getByText('Fremen', { exact: true }).first().click();

    // Difficulty
    await page.getByText('Select Difficulty').waitFor();
    await page.getByText('Easy', { exact: true }).click();

    // Skirmish options
    await page.getByRole('button', { name: 'Continue' }).click();

    // Map selection
    await page.getByText('Select Battlefield').waitFor();
    await page.getByText('2-Player Maps').waitFor();
    await page.getByText('KOTH1').click();

    // Wait for in-game HUD
    await page.locator('#ui-overlay').waitFor({ state: 'visible', timeout: 60_000 });
    console.log('[Remake] Easy skirmish started');
  }

  private async setupCampaign(page: Page): Promise<void> {
    // Clear campaign state for clean start
    await page.evaluate(() => {
      localStorage.removeItem('ebfd_campaign');
      localStorage.removeItem('ebfd_campaign_next');
    });

    // House selection
    await page.getByText('PLAY', { exact: true }).click();
    await page.getByText('Choose Your House').waitFor();
    await page.getByText('Atreides', { exact: true }).click();

    // Game mode
    await page.getByText('Select Game Mode').waitFor();
    await page.getByText('Campaign', { exact: true }).click();

    // Campaign skips subhouse selection — straight to difficulty
    await page.getByText('Select Difficulty').waitFor();
    await page.getByText('Easy', { exact: true }).click();

    // Wait for campaign map
    await page.waitForTimeout(3000);
    console.log('[Remake] Campaign map ready');
  }

  private async waitForGameReady(page: Page): Promise<void> {
    console.log('[Remake] Waiting for game to be ready...');

    // Wait for loading screen to disappear
    await page.waitForFunction(() => {
      const loading = document.getElementById('loading-screen');
      if (!loading) return true;
      return loading.style.opacity === '0' || loading.style.display === 'none';
    }, { timeout: 120_000 });

    // Wait for game loop to tick
    await page.waitForFunction(
      () => (window as any).game?.getTickCount() > 5,
      { timeout: 60_000 },
    );

    console.log('[Remake] Game ready');
  }

  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('[Remake] Browser closed');
    }
  }
}
