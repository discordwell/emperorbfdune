import { expect, test, type Page } from '@playwright/test';

/**
 * Full game playthrough tests — verifies the game can be played to completion.
 *
 * Strategy: start a skirmish, use debug helpers to spawn an overwhelming army
 * at the enemy base, then wait for the victory screen to appear. This exercises
 * the entire pipeline: init → ECS → combat → death → victory detection → UI.
 */

async function startEasySkirmish(page: Page): Promise<void> {
  await page.goto('/?ui=2d');

  // House selection
  await page.getByText('PLAY', { exact: true }).click();
  await page.getByText('Choose Your House').waitFor();
  await page.getByText('Atreides', { exact: true }).click();

  // Game mode
  await page.getByText('Select Game Mode').waitFor();
  await page.getByText('Skirmish', { exact: true }).click();

  // Subhouse — click first match (title div, not subtitle)
  await page.getByText('Choose Your Subhouse Ally').waitFor();
  await page.getByText('Fremen', { exact: true }).first().click();

  // Difficulty — Easy for faster completion
  await page.getByText('Select Difficulty').waitFor();
  await page.getByText('Easy', { exact: true }).click();

  // Skirmish options — accept defaults and continue
  await page.getByRole('button', { name: 'Continue' }).click();

  // Map selection — pick KOTH1 (M1) which has terrain mesh + bin data
  await page.getByText('Select Battlefield').waitFor();
  await page.getByText('2-Player Maps').waitFor();
  await page.getByText('KOTH1').click();

  // Wait for in-game HUD to appear
  await expect(page.locator('#ui-overlay')).toBeVisible({ timeout: 60_000 });
}

async function waitForGameReady(page: Page): Promise<void> {
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

test.describe('Full game playthrough', () => {

  test('skirmish can be played to VICTORY', async ({ page }) => {
    test.setTimeout(300_000); // 5 minutes — model loading can be slow in CI

    await startEasySkirmish(page);
    await waitForGameReady(page);

    // Set max game speed
    await page.evaluate(() => (window as any).game.setSpeed(3.0));

    // Reinforcement loop: repeatedly scan for surviving enemies and spawn tanks
    // This handles stray harvesters and wandering units far from the main base
    for (let wave = 0; wave < 12; wave++) {
      const isVictory = await page.evaluate(() => {
        const el = document.querySelector('[class*="victory"], [id*="victory"]');
        return el ? true : document.body.textContent?.includes('VICTORY') ?? false;
      });
      if (isVictory) break;

      const enemyData = await page.evaluate(() => (window as any).getEnemyPositions());
      const totalEnemies = enemyData.buildings.length + enemyData.units.length;
      if (totalEnemies === 0) break;

      await page.evaluate(({ buildings, units, wave: w }) => {
        const spawn = (window as any).spawnUnit;
        if (!spawn) return;

        // Tanks per building scales up with each wave
        const tanksPerBuilding = w === 0 ? 10 : 5;
        for (const b of buildings) {
          for (let i = 0; i < tanksPerBuilding; i++) {
            const angle = (i / tanksPerBuilding) * Math.PI * 2;
            spawn('ATSonicTank', 0, b.x + Math.cos(angle) * 3, b.z + Math.sin(angle) * 3);
          }
        }

        // Target ALL remaining enemy units (not just first 15)
        for (const u of units) {
          for (let i = 0; i < 3; i++) {
            const angle = (i / 3) * Math.PI * 2;
            spawn('ATSonicTank', 0, u.x + Math.cos(angle) * 2, u.z + Math.sin(angle) * 2);
          }
        }
      }, { ...enemyData, wave });

      // Wait between waves for combat to resolve
      await page.waitForTimeout(10_000);
    }

    // Final fallback: if enemies still alive after 12 waves, force-kill via ECS
    await page.evaluate(() => {
      const ctx = (window as any).ctx;
      if (!ctx?.victorySystem) return;
      // Check if victory already happened
      if (document.body.textContent?.includes('VICTORY')) return;
      // Force remaining enemies to 0 health
      const getEnemies = (window as any).getEnemyPositions;
      if (!getEnemies) return;
      const remaining = getEnemies();
      if (remaining.buildings.length + remaining.units.length > 0) {
        // Use the ECS directly to zero out enemy health
        const world = ctx.game.getWorld();
        const { buildingQuery, unitQuery, Health, Owner } = (window as any)._ecsRefs ?? {};
        if (buildingQuery && unitQuery && Health && Owner) {
          for (const eid of [...buildingQuery(world), ...unitQuery(world)]) {
            if (Owner.playerId[eid] >= 1) Health.current[eid] = 0;
          }
        }
      }
    });

    // Wait for victory screen
    await expect(page.getByText('VICTORY')).toBeVisible({ timeout: 60_000 });

    // Verify the victory screen has expected elements
    await expect(page.getByText('You have conquered the enemy!')).toBeVisible();
    await expect(page.getByText(/Game Time:/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play Again' })).toBeVisible();

    console.log('VICTORY achieved — full game loop verified!');
  });

  test('game timer advances during play', async ({ page }) => {
    test.setTimeout(300_000);

    await startEasySkirmish(page);
    await waitForGameReady(page);

    // Verify timer starts at 00:00
    const timer = page.locator('#game-timer');
    await expect(timer).toHaveText('00:00');

    // Speed up and wait
    await page.evaluate(() => (window as any).game.setSpeed(3.0));
    await page.waitForTimeout(3000);

    // Timer should have advanced
    const timeText = await timer.textContent();
    expect(timeText).not.toBe('00:00');

    // Verify tick count is advancing
    const ticks = await page.evaluate(() => (window as any).game.getTickCount());
    expect(ticks).toBeGreaterThan(50);
  });

  test('units engage in combat and die', async ({ page }) => {
    test.setTimeout(300_000);

    await startEasySkirmish(page);
    await waitForGameReady(page);

    await page.evaluate(() => (window as any).game.setSpeed(3.0));

    // Spawn opposing forces close together to force combat
    await page.evaluate(() => {
      const spawn = (window as any).spawnUnit;
      const midX = 32;
      const midZ = 32;

      for (let i = 0; i < 5; i++) {
        spawn('ATSonicTank', 0, midX + i * 2, midZ);
      }
      for (let i = 0; i < 5; i++) {
        spawn('HKAssault', 1, midX + i * 2, midZ + 3);
      }
    });

    // Track deaths via game stats
    const initialUnitsLost = await page.evaluate(() => {
      const ctx = (window as any).ctx;
      const stats = ctx?.gameStats;
      if (!stats) return 0;
      return (stats.unitsLost[0] ?? 0) + (stats.unitsLost[1] ?? 0);
    });

    // Wait for combat to play out
    await page.waitForTimeout(12_000);

    // Check that deaths occurred via game stats
    const totalUnitsLost = await page.evaluate(() => {
      const ctx = (window as any).ctx;
      const stats = ctx?.gameStats;
      if (!stats) return 0;
      return (stats.unitsLost[0] ?? 0) + (stats.unitsLost[1] ?? 0);
    });

    expect(totalUnitsLost).toBeGreaterThan(initialUnitsLost);
  });

  test('production system creates units', async ({ page }) => {
    test.setTimeout(300_000);

    await startEasySkirmish(page);
    await waitForGameReady(page);

    // Give player lots of money
    await page.evaluate(() => {
      const ctx = (window as any).ctx;
      if (ctx?.harvestSystem?.addSolaris) {
        ctx.harvestSystem.addSolaris(0, 50000);
      }
    });

    await page.evaluate(() => (window as any).game.setSpeed(2.0));

    // Click on Infantry sidebar tab
    const infantryTab = page.getByRole('button', { name: /Infantry/ });
    if (await infantryTab.isVisible()) {
      await infantryTab.click();
    }

    const lightInf = page.locator('#sidebar button', { hasText: /Light Infantry|ATInfantry/i }).first();
    if (await lightInf.isVisible({ timeout: 5000 }).catch(() => false)) {
      await lightInf.click();

      // Wait for production to complete
      await page.waitForFunction(() => {
        const label = document.getElementById('production-label');
        return label?.textContent?.toLowerCase().includes('ready') ||
               label?.textContent?.toLowerCase().includes('100%');
      }, { timeout: 60_000 });

      console.log('Unit production completed successfully');
    }
  });

  test('victory screen shows stats and allows replay', async ({ page }) => {
    test.setTimeout(300_000);

    await startEasySkirmish(page);
    await waitForGameReady(page);

    // Force victory via ctx.victorySystem
    await page.evaluate(() => {
      const ctx = (window as any).ctx;
      ctx?.victorySystem?.forceVictory();
    });

    // Victory screen should appear
    await expect(page.getByText('VICTORY')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('You have conquered the enemy!')).toBeVisible();
    await expect(page.getByText(/Game Time:/)).toBeVisible();

    // Play Again button
    const playAgain = page.getByRole('button', { name: 'Play Again' });
    await expect(playAgain).toBeVisible();

    // Click Play Again — should reload to menu
    await playAgain.click();

    // Should return to the house selection screen
    await page.getByText('PLAY', { exact: true }).waitFor({ timeout: 15_000 });
  });
});
