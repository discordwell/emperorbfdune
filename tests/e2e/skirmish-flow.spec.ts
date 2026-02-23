import { expect, test } from '@playwright/test';

async function startSkirmish(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?ui=2d');

  await page.getByText('PLAY', { exact: true }).click();
  await page.getByText('Choose Your House').waitFor();
  await page.getByText('Atreides', { exact: true }).click();

  await page.getByText('Select Game Mode').waitFor();
  await page.getByText('Skirmish', { exact: true }).click();

  await page.getByText('Choose Your Subhouse Ally').waitFor();
  await page.getByText('Fremen', { exact: true }).first().click();

  await page.getByText('Select Difficulty').waitFor();
  await page.getByText('Normal', { exact: true }).click();

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Select Battlefield').waitFor();
  await page.getByText('2-Player Maps').waitFor();
  await page.getByText('KOTH1').click();

  await expect(page.locator('#ui-overlay')).toBeVisible({ timeout: 120_000 });

  // Wait for game loop to actually tick
  await page.waitForFunction(() => {
    const loading = document.getElementById('loading-screen');
    if (loading && loading.style.opacity !== '0' && loading.style.display !== 'none') return false;
    return (window as any).game?.getTickCount() > 5;
  }, { timeout: 60_000 });
}

test('starts a skirmish and reaches the in-game HUD', async ({ page }) => {
  await startSkirmish(page);

  const timer = page.locator('#game-timer');
  await expect(timer).toHaveText('00:00');

  // Speed up so timer advances quickly
  await page.evaluate(() => (window as any).game.setSpeed(3.0));
  await page.waitForTimeout(3000);
  await expect(timer).not.toHaveText('00:00');
});

test('pause menu can save to slot 1', async ({ page }) => {
  await startSkirmish(page);

  await page.waitForTimeout(800);
  await page.locator('#game-canvas').click({ position: { x: 80, y: 80 } });
  await page.keyboard.press('Escape');
  await page.getByText('PAUSED').waitFor();

  await page.getByRole('button', { name: 'Save / Load' }).click();
  await page.getByRole('button', { name: 'Save' }).first().click();

  const saved = await page.evaluate(() => localStorage.getItem('ebfd_save'));
  expect(saved).toBeTruthy();
});

test('sidebar shows building and unit tabs', async ({ page }) => {
  await startSkirmish(page);

  // Verify sidebar tabs exist
  await expect(page.getByRole('button', { name: /Buildings/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Units/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Infantry/ })).toBeVisible();

  // Buildings tab should show Windtrap
  const windTrap = page.locator('#sidebar button', { hasText: /Windtrap/i }).first();
  await expect(windTrap).toBeVisible();

  // Switch to Infantry tab
  await page.getByRole('button', { name: /Infantry/ }).click();
  const infantryBtn = page.locator('#sidebar button', { hasText: /Infantry|Trooper/i }).first();
  await expect(infantryBtn).toBeVisible({ timeout: 10_000 });

  // Switch to Units tab
  await page.getByRole('button', { name: /Units/ }).click();
  // Should show vehicle-type units (may be locked)
  const sidebar = page.locator('#sidebar');
  await expect(sidebar).toBeVisible();
});
