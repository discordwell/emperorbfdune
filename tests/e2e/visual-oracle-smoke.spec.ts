import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Smoke test for the Visual Oracle tool.
 * Runs in remake-only mode (no QEMU needed) and verifies:
 * 1. Remake screenshots are captured
 * 2. HTML report is generated with expected structure
 * 3. LLM judge returns valid scores (if API key available)
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPORT_DIR = path.join(ROOT, 'artifacts', 'visual-oracle');
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

test.describe('Visual Oracle smoke test', () => {
  test.setTimeout(300_000); // 5 minutes — includes Playwright capture + LLM call

  test('remake-only capture and report generation', async () => {
    // Clean up previous reports to isolate this run
    const existingReports = fs.existsSync(REPORT_DIR)
      ? fs.readdirSync(REPORT_DIR).filter(f => f.startsWith('report-') && f.endsWith('.html'))
      : [];
    const beforeTimestamp = Date.now();

    // Run the visual oracle CLI in remake-only mode with title-screen scenario
    // Use the Playwright webServer's base URL
    const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
    const captureOnlyFlag = HAS_API_KEY ? '' : '--capture-only';

    const cmd = [
      'npx tsx tools/visual-oracle/cli.ts',
      '--skip-original',
      '--scenario title-screen',
      `--base-url ${baseUrl}`,
      captureOnlyFlag,
    ].filter(Boolean).join(' ');

    console.log(`Running: ${cmd}`);
    execSync(cmd, {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 240_000,
      env: { ...process.env, NODE_ENV: 'test' },
    });

    // Verify remake screenshots were captured
    const captureDir = path.join(REPORT_DIR, 'captures', 'title-screen', 'remake');
    expect(fs.existsSync(captureDir)).toBe(true);

    const screenshots = fs.readdirSync(captureDir).filter(f => f.endsWith('.png'));
    expect(screenshots.length).toBeGreaterThan(0);
    console.log(`Captured ${screenshots.length} remake screenshots`);

    // Verify each screenshot is a valid PNG (starts with PNG magic bytes)
    for (const file of screenshots) {
      const buf = fs.readFileSync(path.join(captureDir, file));
      expect(buf.length).toBeGreaterThan(1000); // At least 1KB
      // PNG magic: 89 50 4E 47
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
      expect(buf[2]).toBe(0x4e);
      expect(buf[3]).toBe(0x47);
    }

    // Verify HTML report was generated
    const newReports = fs.readdirSync(REPORT_DIR)
      .filter(f => f.startsWith('report-') && f.endsWith('.html'))
      .filter(f => {
        const ts = parseInt(f.replace('report-', '').replace('.html', ''));
        return ts >= beforeTimestamp;
      });

    expect(newReports.length).toBeGreaterThan(0);
    const reportPath = path.join(REPORT_DIR, newReports[0]);
    const reportHtml = fs.readFileSync(reportPath, 'utf-8');

    // Verify report structure
    expect(reportHtml).toContain('Visual Oracle Report');
    expect(reportHtml).toContain('Title Screen');
    expect(reportHtml).toContain('data:image/png;base64,');

    console.log(`Report generated: ${reportPath}`);

    // If API key is available, verify judge scores are present
    if (HAS_API_KEY) {
      expect(reportHtml).toContain('/10');
      // Check that the report contains aspect scores
      expect(reportHtml).toContain('aspect-bar');
      console.log('LLM judge scores present in report');
    }
  });
});
