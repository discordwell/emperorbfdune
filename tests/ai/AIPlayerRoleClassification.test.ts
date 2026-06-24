import { describe, it, expect, beforeEach } from 'vitest';

import { AIPlayer } from '../../src/ai/AIPlayer';
import { EventBus } from '../../src/core/EventBus';
import { createDefaultUnitDef } from '../../src/config/UnitDefs';
import {
  createDefaultTurretDef, createDefaultBulletDef, createDefaultWarheadDef,
} from '../../src/config/WeaponDefs';

/**
 * Regression test for multi-turret unit role misclassification.
 *
 * Several of the game's heaviest combat units (Devastator, Kobra, Flame Tank,
 * Kindjal, Buzzsaw, Mortar Infantry, ADV Sardaukar) store TurretAttach as a
 * comma-separated list, e.g. "HKDevastatorGun, HKDevastatorMissile". The AI's
 * classifyUnitRoles looked the whole string up in rules.turrets (which is keyed
 * by single turret names), got `undefined`, and tagged the unit a 'scout'. The AI
 * then never counted its best anti-vehicle units toward its composition goals and
 * never led counter-waves with them. The fix resolves the PRIMARY turret first.
 */

/** Build a minimal GameRules with one multi-turret unit and one single-turret control. */
function makeRules() {
  const units = new Map();
  const turrets = new Map();
  const bullets = new Map();
  const warheads = new Map();

  // A vehicle-killing warhead: best vs Medium/Heavy armour -> antiVeh role.
  const wh = createDefaultWarheadDef('VehWH');
  wh.vs = { None: 20, Light: 20, Medium: 100, Heavy: 100, Building: 20, CY: 20, Concrete: 20 };
  warheads.set('VehWH', wh);

  // Multi-turret heavy unit. TurretAttach lists two turrets; only the first is
  // a real key in rules.turrets — exactly as in the shipped rules.txt.
  const dev = createDefaultUnitDef('HKDevastator');
  dev.turretAttach = 'HKDevastatorGun, HKDevastatorMissile';
  dev.cost = 1500;
  dev.speed = 2;
  units.set('HKDevastator', dev);
  const devTurret = createDefaultTurretDef('HKDevastatorGun');
  devTurret.bullet = 'DevBullet';
  turrets.set('HKDevastatorGun', devTurret);
  const devBullet = createDefaultBulletDef('DevBullet');
  devBullet.warhead = 'VehWH';
  devBullet.damage = 200;
  bullets.set('DevBullet', devBullet);

  // Single-turret control: must classify the same way (unaffected by the bug).
  const tank = createDefaultUnitDef('HKMissileTank');
  tank.turretAttach = 'HKMissileTankGun';
  tank.cost = 800;
  tank.speed = 3;
  units.set('HKMissileTank', tank);
  const tankTurret = createDefaultTurretDef('HKMissileTankGun');
  tankTurret.bullet = 'TankBullet';
  turrets.set('HKMissileTankGun', tankTurret);
  const tankBullet = createDefaultBulletDef('TankBullet');
  tankBullet.warhead = 'VehWH';
  tankBullet.damage = 150;
  bullets.set('TankBullet', tankBullet);

  return { units, turrets, bullets, warheads } as any;
}

function makeAI() {
  const ai = new AIPlayer(makeRules(), {} as any, 1, 50, 50, 200, 200);
  (ai as any).unitPool = ['HKDevastator', 'HKMissileTank'];
  return ai;
}

describe('AIPlayer multi-turret role classification', () => {
  beforeEach(() => {
    EventBus.clear();
  });

  it('classifies a multi-turret unit by its primary turret, not as a scout', () => {
    const ai = makeAI();
    (ai as any).classifyUnitRoles();

    const roles = (ai as any).unitRoles as Map<string, string>;
    // The bug tagged the Devastator 'scout' because the comma-joined turret name
    // missed in rules.turrets. With the fix the turret->bullet->warhead chain
    // resolves and the vehicle-killing warhead yields 'antiVeh'.
    expect(roles.get('HKDevastator')).toBe('antiVeh');
    expect(roles.get('HKDevastator')).not.toBe('scout');
  });

  it('classifies single-turret units identically (control)', () => {
    const ai = makeAI();
    (ai as any).classifyUnitRoles();

    const roles = (ai as any).unitRoles as Map<string, string>;
    expect(roles.get('HKMissileTank')).toBe('antiVeh');
  });
});
