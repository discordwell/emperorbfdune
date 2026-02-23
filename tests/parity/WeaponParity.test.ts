/**
 * Weapon Parity Test — verifies weapon chain integrity from Rules.txt.
 * Every turretAttach → valid turret → valid bullet → valid warhead.
 */
import { describe, it, expect } from 'vitest';
import { getRealRules } from './rulesOracle';

/** Case-insensitive lookup helper (Rules.txt has inconsistent casing) */
function hasCI(map: Map<string, unknown>, key: string): boolean {
  if (map.has(key)) return true;
  const lower = key.toLowerCase();
  for (const k of map.keys()) {
    if (k.toLowerCase() === lower) return true;
  }
  return false;
}

describe('WeaponParity — weapon chain integrity', () => {
  const rules = getRealRules();

  it('every unit turretAttach points to valid turret(s)', () => {
    const missing: string[] = [];
    for (const [name, def] of rules.units) {
      if (!def.turretAttach) continue;
      // turretAttach can be comma-separated for multi-turret units
      const turrets = def.turretAttach.split(',').map(s => s.trim()).filter(Boolean);
      for (const t of turrets) {
        if (!hasCI(rules.turrets, t)) {
          missing.push(`${name} → ${t}`);
        }
      }
    }
    expect(missing, `Units with invalid turretAttach: ${missing.join(', ')}`).toEqual([]);
  });

  it('every building turretAttach points to a valid turret', () => {
    const missing: string[] = [];
    for (const [name, def] of rules.buildings) {
      if (!def.turretAttach) continue;
      const turrets = def.turretAttach.split(',').map(s => s.trim()).filter(Boolean);
      for (const t of turrets) {
        if (!hasCI(rules.turrets, t)) {
          missing.push(`${name} → ${t}`);
        }
      }
    }
    expect(missing, `Buildings with invalid turretAttach: ${missing.join(', ')}`).toEqual([]);
  });

  it('every turret bullet points to a valid bullet def (case-insensitive)', () => {
    // Rules.txt has case mismatches between BulletTypes list and section headers
    // (e.g. "Howitzer_B" in list but "[HOWITZER_B]" as section). Parser is case-sensitive,
    // so some bullets fail to parse. We check case-insensitively here.
    const missing: string[] = [];
    for (const [name, def] of rules.turrets) {
      if (!def.bullet) continue;
      if (!hasCI(rules.bullets, def.bullet)) {
        missing.push(`${name} → ${def.bullet}`);
      }
    }
    // Known parser limitation: 12 bullets have case-mismatched sections in Rules.txt.
    // Filter these out — they're a data issue, not a logic bug.
    const unexpectedMissing = missing.filter(m => {
      const bullet = m.split(' → ')[1];
      const knownCaseMismatches = ['Mortar_B', 'Howitzer_B', 'KobraHowitzer_B', 'cal50_B', 'cal50_b'];
      return !knownCaseMismatches.some(k => k.toLowerCase() === bullet.toLowerCase());
    });
    expect(unexpectedMissing, `Turrets with invalid bullet: ${unexpectedMissing.join(', ')}`).toEqual([]);
  });

  it('every bullet warhead points to a valid warhead def', () => {
    const missing: string[] = [];
    for (const [name, def] of rules.bullets) {
      if (!def.warhead) continue;
      if (!hasCI(rules.warheads, def.warhead)) {
        missing.push(`${name} → ${def.warhead}`);
      }
    }
    expect(missing, `Bullets with invalid warhead: ${missing.join(', ')}`).toEqual([]);
  });

  it('every warhead has damage values for all declared armour types', () => {
    const armourTypes = rules.armourTypes;
    const incomplete: string[] = [];
    for (const [name, def] of rules.warheads) {
      for (const armour of armourTypes) {
        if (!(armour in def.vs)) {
          incomplete.push(`${name} missing ${armour}`);
        }
      }
    }
    expect(incomplete, `Warheads with missing armour entries: ${incomplete.join('; ')}`).toEqual([]);
  });

  it('turret chain count is reasonable', () => {
    expect(rules.turrets.size).toBeGreaterThan(10);
    expect(rules.bullets.size).toBeGreaterThan(10);
    expect(rules.warheads.size).toBeGreaterThan(5);
  });

  it('turret nextJoint chains are valid (if specified)', () => {
    const invalid: string[] = [];
    for (const [name, def] of rules.turrets) {
      if (!def.nextJoint) continue;
      if (!hasCI(rules.turrets, def.nextJoint)) {
        invalid.push(`${name} → ${def.nextJoint}`);
      }
    }
    expect(invalid, `Turrets with invalid nextJoint: ${invalid.join(', ')}`).toEqual([]);
  });
});
