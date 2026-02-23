/**
 * Rules.txt Oracle — loads the REAL game rules as a test oracle.
 * All parity tests import this to verify systems respect Rules.txt data.
 */
import fs from 'fs';
import path from 'path';
import { parseRules, type GameRules } from '../../src/config/RulesParser';

const RULES_PATH = path.resolve(__dirname, '../../extracted/MODEL0001/rules.txt');

let _rules: GameRules | null = null;

/** Load and cache the real Rules.txt */
export function getRealRules(): GameRules {
  if (!_rules) {
    const text = fs.readFileSync(RULES_PATH, 'utf-8');
    _rules = parseRules(text);
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
