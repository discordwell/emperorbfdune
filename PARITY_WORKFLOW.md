# Parity Verification Workflow

A systematic, provable guarantee that our TypeScript engine faithfully implements the original Emperor: Battle for Dune rules.txt balance data and simulation formulas.

## 3-Layer Verification Strategy

### Layer 1: Source Truth Audit

**Command:** `npm run parity:source`

Loads `extracted/MODEL0001/rules.txt` via two independent parsers:
1. **Raw INI parser** (`scripts/parity/rawIniParser.ts`) — structural parse only, no defaults or derivations
2. **RulesParser** (`src/config/RulesParser.ts`) — the production parser with defaults, case normalization, and derived values

Compares every field across all categories and outputs reports to `test-results/parity/`:
- `source-parity-report.json` — machine-readable full comparison
- `source-parity-report.md` — human-readable summary

**Comparison statuses:**
| Status | Meaning |
|--------|---------|
| `match` | Raw INI value equals parsed value |
| `mismatch` | Values differ unexpectedly — **investigate** |
| `derived` | Parser computed a value not in INI (e.g., acceleration from speed) |
| `default_applied` | INI has no value; parser used a default |
| `intentional_divergence` | Known acceptable difference (documented) |

**CI gating:** `npm run parity:source:strict` exits 1 on any `mismatch`.

### Layer 2: Behavioral Tests

**Command:** `npm run parity:tests`

345 tests in `tests/parity/` organized by system:

| File | Codes | What it verifies |
|------|-------|-----------------|
| `GeneralConstantsParity.test.ts` | GN1-GN10 | Every [General] value → GameConstants |
| `CombatParity.test.ts` | CB1-CB12 | Full damage pipeline formulas |
| `WarheadTableParity.test.ts` | WH1-WH3 | Complete warhead × armor matrix |
| `VeterancyParity.test.ts` | VT1-VT4 | Vet levels, bonuses, flags |
| `ProductionPipelineParity.test.ts` | PR1-PR13 | Difficulty, factories, prerequisites, starport |
| `MovementParity.test.ts` | MV1-MV6 | Speed, acceleration, braking, stuck detection |
| `HarvestParity.test.ts` | HV1-HV6 | Spice economy, unload rates, cash fallback |
| `SpiceMoundParity.test.ts` | SM1-SM4 | Mound lifecycle, bloom damage |
| `StormWormParity.test.ts` | WM1-WM5 | Storm timing, kill chance, worm constants |
| `SuperweaponParity.test.ts` | SW1-SW4 | Charge durations, damage chains, prerequisites |
| `BuildingDetailsParity.test.ts` | BL1-BL6 | Power, upgrades, deploy tiles, footprints, groups |

Pre-existing tests (still running):
- `RulesParityUnit.test.ts` — Unit stat basics
- `RulesParityBuilding.test.ts` — Building stat basics
- `WeaponParity.test.ts` — Weapon chain integrity
- `SpawnParity.test.ts` — Spawn pool validation
- `ProductionParity.test.ts` — aiSpecial production blocking
- `SidebarParity.test.ts` — Sidebar filter validation
- `FlowParity.test.ts` — Campaign flow state validation

### Layer 3: Runtime Differential (Future)

QEMU visual oracle captures original game behavior for comparison with our simulation. Infrastructure exists in `tools/visual-oracle/` but isn't yet formalized into automated comparison.

## Promotion Path

1. **Burn mismatches**: Run `parity:source`, investigate every `mismatch` status
2. **Expand scenarios**: Add tests for edge cases discovered during burn-down
3. **Promote to CI gate**: Once zero mismatches, add `parity:source:strict` to CI pipeline
4. **Monitor drift**: Run parity tests on every PR to catch regressions

## Known Intentional Divergences

| Field | Raw Value | Parsed Value | Reason |
|-------|-----------|-------------|--------|
| `General.DeviateDuration` | 400 (first), 500 (last) | 500 | Duplicate key in rules.txt. Last-wins semantics matches original game behavior. |

## Running

```bash
# Full source truth report
npm run parity:source

# Strict mode (CI)
npm run parity:source:strict

# All behavioral parity tests
npm run parity:tests

# All tests including parity
npm test
```
