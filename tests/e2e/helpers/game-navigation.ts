/**
 * Shared E2E navigation helpers for starting game modes.
 * Single source of truth for menu navigation sequences.
 *
 * Used by: screenshots.spec.ts, llm-sanity.spec.ts, skirmish-flow.spec.ts,
 *          parity-smoke.spec.ts, campaign-flow.spec.ts, RemakeCapture.ts
 */

import { expect, type Page } from '@playwright/test';

export interface SkirmishOptions {
  house?: string;
  subhouse?: string;
  difficulty?: 'Easy' | 'Normal' | 'Hard';
  map?: string;
  /** If true, navigates to /?ui=2d first. Default: true */
  navigate?: boolean;
  /** If true, waits for game to be fully ready after loading. Default: false */
  waitForReady?: boolean;
}

export interface CampaignOptions {
  house?: string;
  difficulty?: 'Easy' | 'Normal' | 'Hard';
  /** If true, navigates to /?ui=2d first. Default: true */
  navigate?: boolean;
  /** If true, clears campaign localStorage before starting. Default: true */
  clearState?: boolean;
}

/**
 * Navigate through menus to start a skirmish game.
 * After this returns, the in-game HUD (#ui-overlay) is visible.
 */
export async function startSkirmish(page: Page, opts?: SkirmishOptions): Promise<void> {
  const {
    house = 'Atreides',
    subhouse = 'Fremen',
    difficulty = 'Easy',
    map = 'KOTH1',
    navigate = true,
    waitForReady = false,
  } = opts ?? {};

  if (navigate) {
    await page.goto('/?ui=2d');
  }

  // House selection
  await page.getByText('PLAY', { exact: true }).click();
  await page.getByText('Choose Your House').waitFor();
  await page.getByText(house, { exact: true }).click();

  // Game mode
  await page.getByText('Select Game Mode').waitFor();
  await page.getByText('Skirmish', { exact: true }).click();

  // Subhouse
  await page.getByText('Choose Your Subhouse Ally').waitFor();
  await page.getByText(subhouse, { exact: true }).first().click();

  // Difficulty
  await page.getByText('Select Difficulty').waitFor();
  await page.getByText(difficulty, { exact: true }).click();

  // Skirmish options
  await page.getByRole('button', { name: 'Continue' }).click();

  // Map selection
  await page.getByText('Select Battlefield').waitFor();
  await page.getByText('2-Player Maps').waitFor();
  await page.getByText(map).click();

  // Wait for in-game HUD
  await expect(page.locator('#ui-overlay')).toBeVisible({ timeout: 120_000 });

  if (waitForReady) {
    await waitForGameReady(page);
  }
}

/**
 * Navigate through menus to reach the campaign map.
 * After this returns, the campaign map is displayed.
 */
export async function startCampaign(page: Page, opts?: CampaignOptions): Promise<void> {
  const {
    house = 'Atreides',
    difficulty = 'Easy',
    navigate = true,
    clearState = true,
  } = opts ?? {};

  if (navigate) {
    await page.goto('/?ui=2d');
  }

  if (clearState) {
    await page.evaluate(() => {
      localStorage.removeItem('ebfd_campaign');
      localStorage.removeItem('ebfd_campaign_next');
      localStorage.removeItem('ebfd_save');
      localStorage.removeItem('ebfd_forced_mission');
    });
  }

  // House selection
  await page.getByText('PLAY', { exact: true }).click();
  await page.getByText('Choose Your House').waitFor();
  await page.getByText(house, { exact: true }).click();

  // Game mode — campaign skips subhouse selection
  await page.getByText('Select Game Mode').waitFor();
  await page.getByText('Campaign', { exact: true }).click();

  // Difficulty
  await page.getByText('Select Difficulty').waitFor();
  await page.getByText(difficulty, { exact: true }).click();

  // Wait for campaign map
  await page.waitForTimeout(3000);
}

/**
 * Wait for the game to be fully loaded and running.
 * Checks: loading screen gone + game tick count > 5.
 */
export async function waitForGameReady(page: Page): Promise<void> {
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
}

/**
 * Wait for the title screen to be ready (PLAY button visible).
 */
export async function waitForTitleScreen(page: Page): Promise<void> {
  await page.getByText('PLAY', { exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1000);
}
