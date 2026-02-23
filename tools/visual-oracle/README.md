# Visual Oracle

Compares screenshots from the **original** Emperor: Battle for Dune (running in QEMU) with the **web remake** (running in Playwright), using **Claude vision** as an LLM judge to assess visual similarity.

## Quick Start

```bash
# Remake-only mode (no QEMU needed, uses Claude's knowledge of the original)
npx tsx tools/visual-oracle/cli.ts --skip-original

# Run a specific scenario
npx tsx tools/visual-oracle/cli.ts --skip-original --scenario skirmish-base

# Capture screenshots only (no LLM judging)
npx tsx tools/visual-oracle/cli.ts --skip-original --capture-only

# Full comparison (requires QEMU VM setup)
npx tsx tools/visual-oracle/cli.ts
```

## Requirements

- **Node.js** + **tsx** (already in the project)
- **Playwright** (already in devDependencies)
- **@anthropic-ai/sdk** (already in devDependencies)
- **pngjs** (`npm install -D pngjs`) — for PPM→PNG conversion from QEMU screendumps
- **ANTHROPIC_API_KEY** environment variable — for LLM judging
- **QEMU** (`brew install qemu`) — only for original game capture
- **QEMU disk image** — see `tools/visual-oracle/vm/README.md`

## Architecture

```
tools/visual-oracle/
├── cli.ts                    # Main CLI orchestrator
├── scenarios/                # Scenario definitions (JSON)
│   ├── skirmish-base.json
│   ├── skirmish-combat.json
│   └── title-screen.json
├── qemu/
│   ├── QemuController.ts     # QEMU process + QMP client
│   ├── input-sequences.ts     # Reusable keyboard macros
│   └── qemu-config.ts        # VM configuration
├── remake/
│   └── RemakeCapture.ts       # Playwright-based screenshot capture
├── judge/
│   └── LlmJudge.ts           # Claude vision comparison
├── report/
│   └── HtmlReport.ts         # Self-contained HTML report generator
└── vm/
    ├── create-disk.sh         # Disk image bootstrap helper
    └── README.md              # Manual VM setup instructions
```

## Output

Reports are generated in `artifacts/visual-oracle/`:
- `report-{timestamp}.html` — self-contained HTML with side-by-side screenshots and scores
- `captures/{scenario-id}/original/` — original game screenshots
- `captures/{scenario-id}/remake/` — remake screenshots

## Scenarios

Each scenario JSON defines:
- **original**: key sequences to navigate the original game + capture timing
- **remake**: URL, setup function, and capture timing
- **judge**: aspects to evaluate and minimum passing score

## CLI Options

| Flag | Description |
|------|-------------|
| `--scenario <name>` | Run only the named scenario |
| `--skip-original` | Skip QEMU capture (use cached or empty) |
| `--skip-remake` | Skip Playwright capture (use cached or empty) |
| `--capture-only` | Only capture, don't run LLM judge |
| `--base-url <url>` | Remake server URL (default: http://localhost:8080) |

## npm Scripts

```bash
npm run visual-oracle              # Run all scenarios
npm run visual-oracle:remake-only  # Skip original, remake only
npm run visual-oracle:capture      # Capture only, no judging
```
