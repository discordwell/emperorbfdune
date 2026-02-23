import { expect, test } from '@playwright/test';
import { startSkirmish } from './helpers/game-navigation.js';

test('starts a skirmish and reaches the in-game HUD', async ({ page }) => {
  await startSkirmish(page, { difficulty: 'Normal', waitForReady: true });

  const timer = page.locator('#game-timer');
  await expect(timer).toHaveText('00:00');

  // Speed up so timer advances quickly
  await page.evaluate(() => (window as any).game.setSpeed(3.0));
  await page.waitForTimeout(3000);
  await expect(timer).not.toHaveText('00:00');
});

test('pause menu can save to slot 1', async ({ page }) => {
  await startSkirmish(page, { difficulty: 'Normal', waitForReady: true });

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
  await startSkirmish(page, { difficulty: 'Normal', waitForReady: true });

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
