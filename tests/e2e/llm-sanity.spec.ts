import { expect, test, type Page } from '@playwright/test';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * LLM-powered visual and game state sanity checks.
 * Sends screenshots and game state to Claude to verify the game looks correct.
 *
 * Requires ANTHROPIC_API_KEY environment variable — skips if not set.
 */

const SCREENSHOTS_DIR = join(import.meta.dirname, '..', '..', 'screenshots');
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

async function startEasySkirmish(page: Page): Promise<void> {
  await page.goto('/?ui=2d');
  await page.getByText('PLAY', { exact: true }).click();
  await page.getByText('Choose Your House').waitFor();
  await page.getByText('Atreides', { exact: true }).click();
  await page.getByText('Select Game Mode').waitFor();
  await page.getByText('Skirmish', { exact: true }).click();
  await page.getByText('Choose Your Subhouse Ally').waitFor();
  await page.getByText('Fremen', { exact: true }).first().click();
  await page.getByText('Select Difficulty').waitFor();
  await page.getByText('Easy', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Select Battlefield').waitFor();
  await page.getByText('2-Player Maps').waitFor();
  await page.getByText('KOTH1').click();
  await expect(page.locator('#ui-overlay')).toBeVisible({ timeout: 60_000 });
}

async function waitForGameReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const loading = document.getElementById('loading-screen');
    if (!loading) return true;
    return loading.style.opacity === '0' || loading.style.display === 'none';
  }, { timeout: 120_000 });
  await page.waitForFunction(
    () => (window as any).game?.getTickCount() > 5,
    { timeout: 60_000 },
  );
}

test.describe('LLM sanity checks', () => {
  test.setTimeout(300_000);

  test('vision check - screenshots look like an RTS game', async ({ page }) => {
    test.skip(!HAS_API_KEY, 'ANTHROPIC_API_KEY not set');

    await startEasySkirmish(page);
    await waitForGameReady(page);
    await page.evaluate(() => (window as any).game.setSpeed(2.0));

    // Spawn units and buildings to make the scene interesting
    await page.evaluate(() => {
      const spawn = (window as any).spawnUnit;
      if (!spawn) return;
      for (let i = 0; i < 6; i++) {
        spawn('ATSonicTank', 0, 35 + i * 2, 35);
      }
      for (let i = 0; i < 4; i++) {
        spawn('HKAssault', 1, 35 + i * 2, 42);
      }
    });

    // Take screenshots during gameplay
    const screenshots: Buffer[] = [];
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(3000);
      const buf = await page.screenshot();
      screenshots.push(buf);
    }

    // Send to Claude for evaluation
    const client = new Anthropic();
    const imageBlocks = screenshots.map((buf) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: buf.toString('base64'),
      },
    }));

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          {
            type: 'text',
            text: `These are 5 screenshots from a real-time strategy game (Emperor: Battle for Dune web remake).
Rate each screenshot on a scale of 1-10 for how much it looks like a functional RTS game.
Consider: terrain rendering, unit visibility, HUD elements, minimap, sidebar.
Reply with JSON: { "ratings": [n,n,n,n,n], "average": n, "anomalies": ["description"...] }
If no anomalies, return empty array. Be generous — this is a web remake of a 2001 game.`,
          },
        ],
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    console.log('LLM Vision Response:', text);

    // Parse the response - extract JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    expect(jsonMatch).toBeTruthy();

    const result = JSON.parse(jsonMatch![0]);
    expect(result.average).toBeGreaterThanOrEqual(5);
    console.log(`LLM visual rating: ${result.average}/10, anomalies: ${result.anomalies?.length ?? 0}`);
  });

  test('game state sanity check', async ({ page }) => {
    test.skip(!HAS_API_KEY, 'ANTHROPIC_API_KEY not set');

    await startEasySkirmish(page);
    await waitForGameReady(page);
    await page.evaluate(() => (window as any).game.setSpeed(2.0));

    // Let the game run for a bit
    await page.waitForTimeout(15_000);

    // Get game state snapshot
    const snapshot = await page.evaluate(() => (window as any).debug?.gameStateSnapshot());
    expect(snapshot).toBeTruthy();

    console.log('Game state snapshot:', JSON.stringify(snapshot));

    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `This is a game state snapshot from an RTS game (Emperor: Battle for Dune web remake) at tick ${snapshot.tick}:

Units per player: ${JSON.stringify(snapshot.playerUnits)}
Buildings per player: ${JSON.stringify(snapshot.playerBuildings)}
Credits per player: ${JSON.stringify(snapshot.credits)}

The game has been running for about 15 seconds at 2x speed (so ~30 seconds of game time).
Player 0 is human, Player 1+ are AI.

Are these values reasonable for an early-game RTS state?
Reply with JSON: { "pass": true/false, "reason": "explanation" }
Pass if values are plausible. Fail only for clearly broken states (e.g., 0 buildings for all players, negative values, absurd numbers like 10000 units).`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    console.log('LLM State Response:', text);

    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    expect(jsonMatch).toBeTruthy();

    const result = JSON.parse(jsonMatch![0]);
    expect(result.pass).toBe(true);
    console.log(`LLM state check: ${result.pass ? 'PASS' : 'FAIL'} — ${result.reason}`);
  });

  test('pre-captured screenshots check', async () => {
    test.skip(!HAS_API_KEY, 'ANTHROPIC_API_KEY not set');

    // Check if screenshots directory has files from the screenshot suite
    const screenshotFiles = ['05-fresh-game.png', '06-units-and-buildings.png', '07-combat-effects.png'];
    const available: { name: string; data: string }[] = [];

    for (const file of screenshotFiles) {
      try {
        const buf = readFileSync(join(SCREENSHOTS_DIR, file));
        available.push({ name: file, data: buf.toString('base64') });
      } catch {
        // File not yet generated
      }
    }

    test.skip(available.length === 0, 'No pre-captured screenshots available');

    const client = new Anthropic();
    const imageBlocks = available.map(s => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: s.data,
      },
    }));

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          {
            type: 'text',
            text: `These are screenshots from a web-based RTS game remake (Emperor: Battle for Dune).
Files: ${available.map(s => s.name).join(', ')}

For each screenshot, rate 1-10 for visual quality as an RTS game.
Reply with JSON: { "ratings": {"filename": score, ...}, "average": n, "anomalies": ["description"...] }`,
          },
        ],
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    console.log('LLM Pre-captured Response:', text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    expect(jsonMatch).toBeTruthy();

    const result = JSON.parse(jsonMatch![0]);
    expect(result.average).toBeGreaterThanOrEqual(4);
  });
});
