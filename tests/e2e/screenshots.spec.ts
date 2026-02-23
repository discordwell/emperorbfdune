import { expect, test, type Page } from '@playwright/test';
import { join } from 'path';
import { startSkirmish, startCampaign, waitForGameReady } from './helpers/game-navigation.js';

/**
 * Automated screenshot suite — captures 10 key game moments to prove
 * the game looks like a real RTS with proper 3D models, terrain, and UI.
 *
 * Screenshots are saved to the /screenshots directory.
 */

const SCREENSHOTS_DIR = join(import.meta.dirname, '..', '..', 'screenshots');

async function screenshot(page: Page, name: string): Promise<void> {
  const path = join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`Screenshot saved: ${path}`);
}

test.describe('Screenshot suite', () => {
  test.setTimeout(300_000); // 5 minutes for the whole suite

  test('01 - Title screen', async ({ page }) => {
    await page.goto('/?ui=2d');
    // Wait for the title to render
    await page.getByText('PLAY', { exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1000); // Let particles/animations settle
    await screenshot(page, '01-title-screen');
  });

  test('02 - House selection', async ({ page }) => {
    await page.goto('/?ui=2d');
    await page.getByText('PLAY', { exact: true }).click();
    await page.getByText('Choose Your House').waitFor();
    await page.waitForTimeout(500);
    await screenshot(page, '02-house-selection');
  });

  test('03 - Campaign territory map', async ({ page }) => {
    await startCampaign(page);
    await screenshot(page, '03-campaign-map');
  });

  test('04 - Mission briefing', async ({ page }) => {
    await startCampaign(page);

    // Try clicking a territory with attack option
    const attackBtn = page.getByRole('button', { name: /Attack/i }).first();
    if (await attackBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await attackBtn.click();
    } else {
      // Click on the map canvas to select a territory
      const canvas = page.locator('#campaign-canvas, canvas').first();
      if (await canvas.isVisible()) {
        await canvas.click({ position: { x: 400, y: 300 } });
        await page.waitForTimeout(500);
      }
    }

    await page.waitForTimeout(1000);
    await screenshot(page, '04-mission-briefing');
  });

  test('05 - Fresh in-game view', async ({ page }) => {
    await startSkirmish(page);
    await waitForGameReady(page);
    await page.waitForTimeout(2000); // Let terrain and initial buildings render
    await screenshot(page, '05-fresh-game');
  });

  test('06 - Units and buildings', async ({ page }) => {
    await startSkirmish(page);
    await waitForGameReady(page);

    // Spawn units near the player base
    await page.evaluate(() => {
      const spawn = (window as any).spawnUnit;
      if (!spawn) return;
      // Spawn various unit types around center
      const types = ['ATSonicTank', 'ATSonicTank', 'ATMissile', 'ATMissile',
                     'ATInfantry', 'ATInfantry', 'ATInfantry', 'ATSonicTank',
                     'ATHarvester', 'ATSonicTank', 'ATMissile', 'ATInfantry'];
      const spawnBuild = (window as any).spawnBuilding;
      // Get player ConYard position
      const world = (window as any).ctx.game.getWorld();
      const buildings = (window as any)._ecsRefs.buildingQuery(world);
      const Owner = (window as any)._ecsRefs.Owner;
      const pos = (window as any).ctx.game.getWorld().__components?.position;
      let baseX = 32, baseZ = 32;
      for (const eid of buildings) {
        if (Owner.playerId[eid] === 0) {
          const px = (window as any).ctx.game.getWorld().__stores?.position_x?.[eid];
          if (px) { baseX = px; break; }
        }
      }
      for (let i = 0; i < types.length; i++) {
        const angle = (i / types.length) * Math.PI * 2;
        spawn(types[i], 0, baseX + Math.cos(angle) * 8 + 5, baseZ + Math.sin(angle) * 8 + 5);
      }
    });

    // Wait for models to load
    await page.waitForTimeout(5000);
    await screenshot(page, '06-units-and-buildings');
  });

  test('07 - Combat with effects', async ({ page }) => {
    await startSkirmish(page);
    await waitForGameReady(page);

    // Speed up for faster combat
    await page.evaluate(() => (window as any).game.setSpeed(2.0));

    // Spawn opposing forces near each other
    await page.evaluate(() => {
      const spawn = (window as any).spawnUnit;
      if (!spawn) return;
      const midX = 40, midZ = 40;
      for (let i = 0; i < 8; i++) {
        spawn('ATSonicTank', 0, midX + (i % 4) * 3, midZ + Math.floor(i / 4) * 3);
      }
      for (let i = 0; i < 8; i++) {
        spawn('HKAssault', 1, midX + (i % 4) * 3, midZ + 8 + Math.floor(i / 4) * 3);
      }
    });

    // Wait for combat
    await page.waitForTimeout(6000);
    await screenshot(page, '07-combat-effects');
  });

  test('08 - Base overview (zoomed out)', async ({ page }) => {
    await startSkirmish(page);
    await waitForGameReady(page);

    // Spawn extra buildings
    await page.evaluate(() => {
      const spawnBuild = (window as any).spawnBuilding;
      if (!spawnBuild) return;
      spawnBuild('ATWindtrap', 0, 28, 28);
      spawnBuild('ATWindtrap', 0, 24, 28);
      spawnBuild('ATRefinery', 0, 20, 28);
      spawnBuild('ATBarracks', 0, 28, 24);
    });

    // Zoom out with scroll
    await page.mouse.move(640, 360);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(200);
    }

    await page.waitForTimeout(2000);
    await screenshot(page, '08-base-overview');
  });

  test('09 - Sidebar and minimap detail', async ({ page }) => {
    await startSkirmish(page);
    await waitForGameReady(page);

    // Click Buildings tab to show sidebar content
    const buildingsTab = page.getByRole('button', { name: /Buildings/ });
    if (await buildingsTab.isVisible()) {
      await buildingsTab.click();
    }

    await page.waitForTimeout(1000);
    await screenshot(page, '09-sidebar-minimap');
  });

  test('10 - Victory screen', async ({ page }) => {
    await startSkirmish(page);
    await waitForGameReady(page);

    // Force victory
    await page.evaluate(() => {
      const ctx = (window as any).ctx;
      ctx?.victorySystem?.forceVictory();
    });

    // Wait for victory screen
    await expect(page.getByText('VICTORY')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await screenshot(page, '10-victory-screen');
  });
});
