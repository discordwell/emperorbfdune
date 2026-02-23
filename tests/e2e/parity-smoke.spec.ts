import { expect, test, type Page } from '@playwright/test';

/**
 * Parity smoke tests — E2E verification that:
 * 1. No campaign-only (aiSpecial) units appear in skirmish
 * 2. Sidebar doesn't show campaign-only units
 * 3. Stale localStorage doesn't bypass faction picker
 */

const CAMPAIGN_ONLY_UNITS = [
  'ATGeneral', 'HKGeneral', 'ORGeneral',
  'ATEngineer', 'HKEngineer', 'OREngineer',
];

async function startAtreidesSkirm(page: Page): Promise<void> {
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
  await page.waitForFunction(() => {
    const loading = document.getElementById('loading-screen');
    if (loading && loading.style.opacity !== '0' && loading.style.display !== 'none') return false;
    return (window as any).game?.getTickCount() > 5;
  }, { timeout: 60_000 });
}

test('skirmish has no campaign-only units in game state', async ({ page }) => {
  test.setTimeout(180_000);
  await startAtreidesSkirm(page);

  const snapshot = await page.evaluate(() => (window as any).debug.gameStateSnapshot());
  const allUnitTypes = [
    ...snapshot.playerUnits.map((u: any) => u.type),
  ];

  for (const forbidden of CAMPAIGN_ONLY_UNITS) {
    expect(allUnitTypes).not.toContain(forbidden);
  }
});

test('sidebar Infantry tab has no campaign-only units', async ({ page }) => {
  test.setTimeout(180_000);
  await startAtreidesSkirm(page);

  // Click Infantry tab in sidebar
  const infantryTab = page.locator('[data-tab="infantry"], .sidebar-tab:has-text("Infantry")').first();
  if (await infantryTab.isVisible()) {
    await infantryTab.click();
    await page.waitForTimeout(500);
  }

  // Get all sidebar item text
  const sidebarText = await page.locator('#sidebar, .sidebar').textContent() ?? '';
  expect(sidebarText).not.toContain('General');
  expect(sidebarText).not.toContain('Engineer');
});

test('stale campaign localStorage does not bypass faction picker', async ({ page }) => {
  test.setTimeout(60_000);

  // Set stale/malformed campaign data before loading
  await page.goto('/?ui=2d');
  await page.evaluate(() => {
    localStorage.setItem('ebfd_campaign_next', JSON.stringify({ broken: true }));
    localStorage.setItem('ebfd_campaign', JSON.stringify({ housePrefix: 'ZZ' }));
  });

  // Reload — should show the normal title screen, not auto-continue
  await page.reload();
  await page.getByText('PLAY', { exact: true }).waitFor({ timeout: 30_000 });

  // Stale data should have been cleared
  const nextMission = await page.evaluate(() => localStorage.getItem('ebfd_campaign_next'));
  const campaignState = await page.evaluate(() => localStorage.getItem('ebfd_campaign'));
  expect(nextMission).toBeNull();
  expect(campaignState).toBeNull();
});
