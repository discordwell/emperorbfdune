import { expect, test, type Page } from '@playwright/test';
import { join } from 'path';

/**
 * Campaign E2E test — exercises the full campaign loop:
 * house selection → campaign map → territory attack → briefing → mission → victory
 *
 * Uses ?ui=2d to force 2D DOM-based campaign map for reliable element selection.
 */

const SCREENSHOTS_DIR = join(import.meta.dirname, '..', '..', 'screenshots');

async function screenshot(page: Page, name: string): Promise<void> {
  const path = join(SCREENSHOTS_DIR, `campaign-${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`Campaign screenshot: ${path}`);
}

test.describe('Campaign flow', () => {
  test.setTimeout(300_000);

  test('Atreides campaign: select territory, play mission, win', async ({ page }) => {
    // Use ?ui=2d to force 2D campaign map with clickable DOM territories
    await page.goto('/?ui=2d');
    await page.evaluate(() => {
      localStorage.removeItem('ebfd_campaign');
      localStorage.removeItem('ebfd_campaign_next');
      localStorage.removeItem('ebfd_save');
      localStorage.removeItem('ebfd_forced_mission');
    });

    // 1. House selection → Atreides
    await page.getByText('PLAY', { exact: true }).click();
    await page.getByText('Choose Your House').waitFor();
    await page.getByText('Atreides', { exact: true }).click();
    console.log('Step 1: Selected Atreides');

    // 2. Campaign mode (skips subhouse selection)
    await page.getByText('Select Game Mode').waitFor();
    await page.getByText('Campaign', { exact: true }).click();
    console.log('Step 2: Selected Campaign');

    // 3. Difficulty
    await page.getByText('Select Difficulty').waitFor();
    await page.getByText('Easy', { exact: true }).click();
    console.log('Step 3: Selected Easy difficulty');

    // 4. Campaign map — 2D fallback with "STRATEGIC BATTLE MAP"
    await page.getByText('STRATEGIC BATTLE MAP').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await screenshot(page, 'map-initial');
    console.log('Step 4: Campaign map displayed');

    // 5. Click an attackable territory (orange border, cursor:pointer)
    const attackableTerritory = page.locator('div[style*="cursor: pointer"], div[style*="cursor:pointer"]').first();
    await expect(attackableTerritory).toBeVisible({ timeout: 5000 });

    const territoryName = await attackableTerritory.locator('div').first().textContent();
    console.log(`Step 5: Clicking territory: ${territoryName}`);
    await attackableTerritory.click();

    // 6. After territory click, briefing may appear before game loads
    await page.waitForTimeout(2000);

    // Check if mission briefing appeared (has Accept/Launch button)
    const acceptBtn = page.getByRole('button', { name: /Accept|Launch|Start|Begin/i }).first();
    if (await acceptBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
      console.log('Step 6: Mission briefing visible, accepting...');
      await screenshot(page, 'briefing');
      await acceptBtn.click();
    } else {
      console.log('Step 6: No explicit briefing, mission loading directly...');
    }

    // 7. Wait for in-game HUD to appear
    await expect(page.locator('#ui-overlay')).toBeVisible({ timeout: 120_000 });

    // Wait for game to be fully ready
    await page.waitForFunction(() => {
      const loading = document.getElementById('loading-screen');
      if (loading && loading.style.opacity !== '0' && loading.style.display !== 'none') return false;
      return (window as any).game?.getTickCount() > 5;
    }, { timeout: 120_000 });
    console.log('Step 7: Game loaded and running');

    await page.waitForTimeout(2000);
    await screenshot(page, 'in-game');

    // 8. Check if .tok script loaded
    const tokLoaded = await page.evaluate(() => {
      const ctx = (window as any).ctx;
      return !!ctx?.missionScriptRunner;
    });
    console.log(`Step 8: Mission script loaded: ${tokLoaded}`);

    // 9. Force victory
    await page.evaluate(() => {
      const ctx = (window as any).ctx;
      ctx?.victorySystem?.forceVictory();
    });

    // 10. Victory screen
    await expect(page.getByText('VICTORY')).toBeVisible({ timeout: 30_000 });
    console.log('Step 9: Victory screen');
    await screenshot(page, 'victory');

    // 11. Verify campaign state updated
    const campaignSave = await page.evaluate(() => {
      const saved = localStorage.getItem('ebfd_campaign');
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      return {
        totalBattles: parsed.phaseState?.totalBattles,
        totalCaptures: parsed.phaseState?.totalCaptures,
        phase: parsed.phaseState?.currentPhase,
        territoryHistory: parsed.phaseState?.territoryHistory,
      };
    });
    console.log('Step 10: Campaign state:', JSON.stringify(campaignSave));

    if (campaignSave) {
      expect(campaignSave.totalBattles).toBeGreaterThanOrEqual(1);
    }
  });
});
