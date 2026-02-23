#!/usr/bin/env npx tsx
/**
 * Visual Oracle CLI — captures screenshots from the original game (via QEMU)
 * and the web remake (via Playwright), then uses Claude vision as an LLM judge
 * to assess visual similarity.
 *
 * Usage:
 *   npx tsx tools/visual-oracle/cli.ts                    # Run all scenarios
 *   npx tsx tools/visual-oracle/cli.ts --scenario title-screen
 *   npx tsx tools/visual-oracle/cli.ts --skip-original     # Remake only
 *   npx tsx tools/visual-oracle/cli.ts --skip-remake        # Original only
 *   npx tsx tools/visual-oracle/cli.ts --capture-only       # No LLM judging
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QemuController } from './qemu/QemuController.js';
import { QEMU_CONFIG } from './qemu/qemu-config.js';
import { RemakeCapture } from './remake/RemakeCapture.js';
import { LlmJudge } from './judge/LlmJudge.js';
import { generateHtmlReport, type ScenarioReport } from './report/HtmlReport.js';
import type { InputStep } from './qemu/input-sequences.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const CAPTURES_DIR = path.join(ROOT, 'artifacts', 'visual-oracle', 'captures');
const REPORT_DIR = path.join(ROOT, 'artifacts', 'visual-oracle');

// --- Scenario definition types ---

interface ScenarioDef {
  id: string;
  name: string;
  description: string;
  original: {
    setupKeys: InputStep[];
    captureDelay: number;
    captureCount: number;
    captureInterval: number;
  };
  remake: {
    url: string;
    setup: string;
    waitForGame: boolean;
    captureDelay: number;
    captureCount: number;
    captureInterval: number;
  };
  judge: {
    aspects: string[];
    minimumScore: number;
  };
}

// --- CLI argument parsing ---

function parseArgs(): {
  scenario: string | null;
  skipOriginal: boolean;
  skipRemake: boolean;
  captureOnly: boolean;
  baseUrl: string;
} {
  const args = process.argv.slice(2);
  let scenario: string | null = null;
  let skipOriginal = false;
  let skipRemake = false;
  let captureOnly = false;
  let baseUrl = 'http://localhost:8080';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--scenario':
        scenario = args[++i];
        break;
      case '--skip-original':
        skipOriginal = true;
        break;
      case '--skip-remake':
        skipRemake = true;
        break;
      case '--capture-only':
        captureOnly = true;
        break;
      case '--base-url':
        baseUrl = args[++i];
        break;
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  return { scenario, skipOriginal, skipRemake, captureOnly, baseUrl };
}

function printHelp(): void {
  console.log(`
Visual Oracle — Original vs Remake Screenshot Comparison

Usage:
  npx tsx tools/visual-oracle/cli.ts [options]

Options:
  --scenario <name>     Run only the named scenario (filename without .json)
  --skip-original       Skip QEMU original game capture (use cached or empty)
  --skip-remake         Skip Playwright remake capture (use cached or empty)
  --capture-only        Only capture screenshots, don't run LLM judge
  --base-url <url>      Remake server URL (default: http://localhost:8080)
  --help                Show this help message

Examples:
  npx tsx tools/visual-oracle/cli.ts --skip-original --scenario skirmish-base
  npx tsx tools/visual-oracle/cli.ts --capture-only
  npx tsx tools/visual-oracle/cli.ts --skip-original
`);
}

// --- Load scenarios ---

function loadScenarios(filter: string | null): ScenarioDef[] {
  const files = fs.readdirSync(SCENARIOS_DIR).filter(f => f.endsWith('.json'));
  const scenarios: ScenarioDef[] = [];

  for (const file of files) {
    if (filter && file !== `${filter}.json`) continue;
    const content = fs.readFileSync(path.join(SCENARIOS_DIR, file), 'utf-8');
    scenarios.push(JSON.parse(content));
  }

  if (scenarios.length === 0) {
    console.error(`No scenarios found${filter ? ` matching "${filter}"` : ''}`);
    process.exit(1);
  }

  console.log(`Loaded ${scenarios.length} scenario(s): ${scenarios.map(s => s.id).join(', ')}`);
  return scenarios;
}

// --- Load cached screenshots ---

function loadCachedScreenshots(scenarioId: string, source: 'original' | 'remake'): Buffer[] {
  const dir = path.join(CAPTURES_DIR, scenarioId, source);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.png'))
    .sort();

  return files.map(f => fs.readFileSync(path.join(dir, f)));
}

function saveScreenshots(scenarioId: string, source: 'original' | 'remake', buffers: Buffer[]): void {
  const dir = path.join(CAPTURES_DIR, scenarioId, source);
  fs.mkdirSync(dir, { recursive: true });

  for (let i = 0; i < buffers.length; i++) {
    const outPath = path.join(dir, `capture-${String(i).padStart(2, '0')}.png`);
    fs.writeFileSync(outPath, buffers[i]);
  }
  console.log(`Saved ${buffers.length} screenshots to ${dir}`);
}

// --- Main orchestration ---

async function main(): Promise<void> {
  const opts = parseArgs();
  const scenarios = loadScenarios(opts.scenario);

  let qemu: QemuController | null = null;
  let remake: RemakeCapture | null = null;
  const reports: ScenarioReport[] = [];

  try {
    // Boot QEMU if needed
    if (!opts.skipOriginal) {
      if (!fs.existsSync(QEMU_CONFIG.diskImage)) {
        console.warn(
          `[WARN] QEMU disk image not found: ${QEMU_CONFIG.diskImage}\n` +
          '       Skipping original game capture. Use --skip-original to suppress this warning.\n' +
          '       See tools/visual-oracle/vm/README.md for setup instructions.'
        );
        opts.skipOriginal = true;
      } else {
        qemu = new QemuController();
        await qemu.boot();
        await qemu.waitForDesktop();
      }
    }

    // Boot Playwright if needed
    if (!opts.skipRemake) {
      remake = new RemakeCapture(opts.baseUrl);
      await remake.boot();
    }

    // Process each scenario
    let isFirstQemuScenario = true;
    for (const scenario of scenarios) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Scenario: ${scenario.name}`);
      console.log(`${'='.repeat(60)}\n`);

      let originalScreenshots: Buffer[];
      let remakeScreenshots: Buffer[];

      // Capture original
      if (!opts.skipOriginal && qemu) {
        // Reset guest between scenarios so each starts from a clean boot
        if (!isFirstQemuScenario) {
          await qemu.resetGuest();
        }
        isFirstQemuScenario = false;

        console.log('[Original] Navigating to scenario state...');
        await qemu.executeInputSequence(scenario.original.setupKeys);

        if (scenario.original.captureDelay > 0) {
          console.log(`[Original] Waiting ${scenario.original.captureDelay}ms before capture...`);
          await sleep(scenario.original.captureDelay);
        }

        originalScreenshots = await qemu.captureMultiple(
          scenario.id,
          scenario.original.captureCount,
          scenario.original.captureInterval,
        );
      } else {
        originalScreenshots = loadCachedScreenshots(scenario.id, 'original');
        if (originalScreenshots.length > 0) {
          console.log(`[Original] Loaded ${originalScreenshots.length} cached screenshots`);
        } else {
          console.log('[Original] No screenshots (skipped/no cache)');
        }
      }

      // Capture remake
      if (!opts.skipRemake && remake) {
        remakeScreenshots = await remake.runScenario(scenario.remake);
        saveScreenshots(scenario.id, 'remake', remakeScreenshots);
      } else {
        remakeScreenshots = loadCachedScreenshots(scenario.id, 'remake');
        if (remakeScreenshots.length > 0) {
          console.log(`[Remake] Loaded ${remakeScreenshots.length} cached screenshots`);
        } else {
          console.log('[Remake] No screenshots (skipped/no cache)');
        }
      }

      // Save original screenshots if captured fresh
      if (!opts.skipOriginal && originalScreenshots.length > 0) {
        saveScreenshots(scenario.id, 'original', originalScreenshots);
      }

      // Build report entry
      reports.push({
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        originalScreenshots,
        remakeScreenshots,
        judgeResult: null,
        minimumScore: scenario.judge.minimumScore,
      });
    }

    // Shutdown capture systems
    if (qemu) await qemu.shutdown();
    if (remake) await remake.shutdown();
    qemu = null;
    remake = null;

    // Run LLM judge
    if (!opts.captureOnly) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.warn('[WARN] ANTHROPIC_API_KEY not set — skipping LLM judge');
      } else {
        const judge = new LlmJudge(apiKey);

        for (const report of reports) {
          if (report.remakeScreenshots.length === 0) {
            console.log(`[Judge] Skipping ${report.id} — no remake screenshots`);
            continue;
          }

          console.log(`\n[Judge] Evaluating ${report.name}...`);

          if (report.originalScreenshots.length > 0) {
            report.judgeResult = await judge.compare(
              report.originalScreenshots,
              report.remakeScreenshots,
              report.name,
              report.description,
              { aspects: scenarios.find(s => s.id === report.id)!.judge.aspects, minimumScore: report.minimumScore },
            );
          } else {
            // No original screenshots — judge remake only
            report.judgeResult = await judge.judgeRemakeOnly(
              report.remakeScreenshots,
              report.name,
              report.description,
              { aspects: scenarios.find(s => s.id === report.id)!.judge.aspects, minimumScore: report.minimumScore },
            );
          }
        }
      }
    }

    // Generate HTML report
    console.log('\n[Report] Generating HTML report...');
    const html = generateHtmlReport(reports);
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `report-${Date.now()}.html`);
    fs.writeFileSync(reportPath, html);
    console.log(`[Report] Written to ${reportPath}`);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    for (const report of reports) {
      const score = report.judgeResult?.overallScore ?? 'N/A';
      const pass = report.judgeResult
        ? report.judgeResult.overallScore >= report.minimumScore ? 'PASS' : 'FAIL'
        : 'SKIP';
      console.log(`  ${pass}  ${report.name}  (score: ${score}/10, min: ${report.minimumScore})`);
    }
    console.log('='.repeat(60));

    // Exit with failure if any scenario failed
    const hasFailure = reports.some(r =>
      r.judgeResult && r.judgeResult.overallScore < r.minimumScore
    );
    if (hasFailure) {
      process.exit(1);
    }

  } catch (error) {
    console.error('[ERROR]', error);
    // Clean up
    if (qemu) await qemu.shutdown().catch(() => {});
    if (remake) await remake.shutdown().catch(() => {});
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main();
