/**
 * Rules.txt Oracle — loads the REAL game rules as a test oracle.
 * All parity tests import this to verify systems respect Rules.txt data.
 */
import fs from 'fs';
import path from 'path';
import { describe } from 'vitest';
import { parseRules, type GameRules } from '../../src/config/RulesParser';

/** Canonical location of the extracted rules.txt — the single source of truth for all parity reads. */
export const RULES_PATH = path.resolve(__dirname, '../../extracted/MODEL0001/rules.txt');

/**
 * Whether the extracted game data is present. The `extracted/` directory holds
 * proprietary game files and is gitignored, so it only exists on machines where
 * the game assets have been extracted — never in CI or fresh clones.
 *
 * Suites that need the real rules.txt must be declared with `describeWithRules`
 * (below) so they skip cleanly on checkouts without game data. On machines where
 * the data is supposed to exist, set REAL_RULES_REQUIRE=1 to turn the silent
 * skip into a hard failure (mirrors TOK_REFERENCE_REQUIRE).
 */
export const REAL_RULES_AVAILABLE = fs.existsSync(RULES_PATH);

if (!REAL_RULES_AVAILABLE && process.env.REAL_RULES_REQUIRE === '1') {
  throw new Error(
    `REAL_RULES_REQUIRE is set but rules.txt was not found at ${RULES_PATH} — ` +
    'extract the game data or unset REAL_RULES_REQUIRE.'
  );
}

/**
 * Declare a suite that depends on the real rules.txt. Skips (and registers no
 * tests) when the game data is absent. Always use this instead of a bare
 * `describe` + availability check: vitest executes describe bodies at collection
 * time even when skipped, so a suite that calls getRealRules() in its body
 * would crash a clean checkout unless the factory itself is suppressed.
 */
export function describeWithRules(name: string, factory: () => void): void {
  describe.skipIf(!REAL_RULES_AVAILABLE)(name, REAL_RULES_AVAILABLE ? factory : () => {});
}

/** Raw rules.txt text, for suites that cross-check via the independent raw INI parser. */
export function loadRawRulesText(): string {
  return fs.readFileSync(RULES_PATH, 'utf-8');
}

let _rules: GameRules | null = null;

/** Load and cache the real Rules.txt */
export function getRealRules(): GameRules {
  if (!_rules) {
    _rules = parseRules(loadRawRulesText());
  }
  return _rules;
}

/** All unit names with AiSpecial=true */
export function getAiSpecialUnits(rules: GameRules): Set<string> {
  const set = new Set<string>();
  for (const [name, def] of rules.units) {
    if (def.aiSpecial) set.add(name);
  }
  return set;
}


/** All faction prefixes used in the game */
export const MAIN_FACTIONS = ['AT', 'HK', 'OR'] as const;
export const ALL_FACTIONS = ['AT', 'HK', 'OR', 'FR', 'IM', 'IX', 'TL', 'GU'] as const;
