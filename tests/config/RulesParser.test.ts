import { describe, it, expect } from 'vitest';
import { parseRules } from '../../src/config/RulesParser';

const SAMPLE_RULES = `
[General]
SpiceValue=300
RepairRate=15
StealthDelay=50

[HouseTypes]
Atreides
Harkonnen
Ordos

[TerrainTypes]
Sand
Rock
Dunes

[ArmourTypes]
None
Light
Medium
Heavy
Building
Harvester

[UnitTypes]
ATLightInf
ATCombatTank

[BuildingTypes]
ATConYard
ATBarracks

[TurretTypes]
ATLightInfTurret
ATCombatTankTurret

[BulletTypes]
ATLightInfBullet
ATTankShell

[WarheadTypes]
SmallArms
HeavyShell

// Unit definitions
[ATLightInf]
House=Atreides
Cost=50
BuildTime=100
Health=80
Speed=3
TurnRate=0.2
Size=1
Armour=None
Score=2
TechLevel=1
ViewRange=6
PrimaryBuilding=ATBarracks
UnitGroup=Infantry
Infantry=true
Crushable=true
CanBeSuppressed=true
TurretAttach=ATLightInfTurret
VeterancyLevel=3
ExtraDamage=10
ExtraArmour=5
ExtraRange=1
VeterancyLevel=7
ExtraDamage=20
ExtraArmour=10
ExtraRange=2
Health=120

[ATCombatTank]
House=Atreides
Cost=500
BuildTime=400
Health=600
Speed=5
TurnRate=0.15
Size=2
Armour=Medium
Score=8
TechLevel=3
ViewRange=7
PrimaryBuilding=ATFactory
TurretAttach=ATCombatTankTurret
Crushes=true
Starportable=true
GetsHeightAdvantage=true
ShieldHealth=100
CanSelfRepairShield=true
HitSlowDownAmount=30
HitSlowDownDuration=25

[ATConYard]
House=Atreides
Group=Structure
Cost=5000
BuildTime=1000
Health=3000
Armour=CY
TechLevel=1
ViewRange=6
PowerGenerated=50
CanBeEngineered=true

[ATBarracks]
House=Atreides
Group=Structure
Cost=300
BuildTime=200
Health=1500
Armour=Building
TechLevel=1
ViewRange=5
PowerUsed=10
PrimaryBuilding=ATConYard
Refinery=false
UpgradeCost=500
UpgradeTechLevel=3

[ATLightInfTurret]
Bullet=ATLightInfBullet
ReloadCount=25
TurretMinYRotation=-180
TurretMaxYRotation=180

[ATCombatTankTurret]
Bullet=ATTankShell
ReloadCount=40
TurretMinYRotation=-180
TurretMaxYRotation=180

[ATLightInfBullet]
MaxRange=5
Damage=30
Speed=25
Warhead=SmallArms

[ATTankShell]
MaxRange=7
Damage=120
Speed=30
Warhead=HeavyShell
BlastRadius=32
ReduceDamageWithDistance=true
DamageFriendly=true
FriendlyDamageAmount=50

[SmallArms]
None=100
Light=80
Medium=60
Heavy=40
Building=30
Harvester=50

[HeavyShell]
None=150
Light=120
Medium=100
Heavy=80
Building=70
Harvester=90
`;

describe('parseRules', () => {
  const rules = parseRules(SAMPLE_RULES);

  describe('general section', () => {
    it('parses key-value pairs', () => {
      expect(rules.general['SpiceValue']).toBe('300');
      expect(rules.general['RepairRate']).toBe('15');
      expect(rules.general['StealthDelay']).toBe('50');
    });
  });

  describe('list sections', () => {
    it('parses house types', () => {
      expect(rules.houseTypes).toEqual(['Atreides', 'Harkonnen', 'Ordos']);
    });

    it('parses terrain types', () => {
      expect(rules.terrainTypes).toEqual(['Sand', 'Rock', 'Dunes']);
    });

    it('parses armour types', () => {
      expect(rules.armourTypes).toContain('None');
      expect(rules.armourTypes).toContain('Heavy');
      expect(rules.armourTypes).toContain('Building');
    });
  });

  describe('unit parsing', () => {
    it('parses all declared units', () => {
      expect(rules.units.size).toBe(2);
      expect(rules.units.has('ATLightInf')).toBe(true);
      expect(rules.units.has('ATCombatTank')).toBe(true);
    });

    it('parses basic unit properties', () => {
      const inf = rules.units.get('ATLightInf')!;
      expect(inf.house).toBe('Atreides');
      expect(inf.cost).toBe(50);
      expect(inf.buildTime).toBe(100);
      expect(inf.health).toBe(80);
      expect(inf.speed).toBe(3);
      expect(inf.turnRate).toBe(0.2);
      expect(inf.armour).toBe('None');
      expect(inf.score).toBe(2);
      expect(inf.techLevel).toBe(1);
      expect(inf.viewRange).toBe(6);
      expect(inf.primaryBuilding).toBe('ATBarracks');
    });

    it('parses boolean flags', () => {
      const inf = rules.units.get('ATLightInf')!;
      expect(inf.infantry).toBe(true);
      expect(inf.crushable).toBe(true);
      expect(inf.canBeSuppressed).toBe(true);

      const tank = rules.units.get('ATCombatTank')!;
      expect(tank.crushes).toBe(true);
      expect(tank.starportable).toBe(true);
      expect(tank.getsHeightAdvantage).toBe(true);
    });

    it('parses veterancy levels', () => {
      const inf = rules.units.get('ATLightInf')!;
      expect(inf.veterancy.length).toBe(2);
      expect(inf.veterancy[0]).toEqual({
        scoreThreshold: 3,
        extraDamage: 10,
        extraArmour: 5,
        extraRange: 1,
      });
      expect(inf.veterancy[1]).toMatchObject({
        scoreThreshold: 7,
        extraDamage: 20,
        extraArmour: 10,
        extraRange: 2,
        health: 120,
      });
    });

    it('parses shield and slowdown properties', () => {
      const tank = rules.units.get('ATCombatTank')!;
      expect(tank.shieldHealth).toBe(100);
      expect(tank.canSelfRepairShield).toBe(true);
      expect(tank.hitSlowDownAmount).toBe(30);
      expect(tank.hitSlowDownDuration).toBe(25);
    });

    it('links turret attachment', () => {
      const inf = rules.units.get('ATLightInf')!;
      expect(inf.turretAttach).toBe('ATLightInfTurret');
    });
  });

  describe('building parsing', () => {
    it('parses all declared buildings', () => {
      expect(rules.buildings.size).toBe(2);
    });

    it('parses building properties', () => {
      const cy = rules.buildings.get('ATConYard')!;
      expect(cy.house).toBe('Atreides');
      expect(cy.cost).toBe(5000);
      expect(cy.health).toBe(3000);
      expect(cy.armour).toBe('CY');
      expect(cy.powerGenerated).toBe(50);
      expect(cy.canBeEngineered).toBe(true);
    });

    it('parses upgrade properties', () => {
      const barracks = rules.buildings.get('ATBarracks')!;
      expect(barracks.upgradable).toBe(true);
      expect(barracks.upgradeCost).toBe(500);
      expect(barracks.upgradeTechLevel).toBe(3);
    });

    it('parses power usage', () => {
      const barracks = rules.buildings.get('ATBarracks')!;
      expect(barracks.powerUsed).toBe(10);
    });
  });

  describe('turret parsing', () => {
    it('parses turret definitions', () => {
      const turret = rules.turrets.get('ATLightInfTurret')!;
      expect(turret.bullet).toBe('ATLightInfBullet');
      expect(turret.reloadCount).toBe(25);
      expect(turret.minYRotation).toBe(-180);
      expect(turret.maxYRotation).toBe(180);
    });
  });

  describe('bullet parsing', () => {
    it('parses bullet properties', () => {
      const bullet = rules.bullets.get('ATLightInfBullet')!;
      expect(bullet.maxRange).toBe(5);
      expect(bullet.damage).toBe(30);
      expect(bullet.speed).toBe(25);
      expect(bullet.warhead).toBe('SmallArms');
    });

    it('parses AoE bullet', () => {
      const shell = rules.bullets.get('ATTankShell')!;
      expect(shell.blastRadius).toBe(32);
      expect(shell.reduceDamageWithDistance).toBe(true);
      expect(shell.damageFriendly).toBe(true);
      expect(shell.friendlyDamageAmount).toBe(50);
    });
  });

  describe('warhead parsing', () => {
    it('parses damage multipliers per armor type', () => {
      const wh = rules.warheads.get('SmallArms')!;
      expect(wh.vs['None']).toBe(100);
      expect(wh.vs['Light']).toBe(80);
      expect(wh.vs['Medium']).toBe(60);
      expect(wh.vs['Heavy']).toBe(40);
      expect(wh.vs['Building']).toBe(30);
    });

    it('parses heavy shell warhead', () => {
      const wh = rules.warheads.get('HeavyShell')!;
      expect(wh.vs['None']).toBe(150);
      expect(wh.vs['Medium']).toBe(100);
      expect(wh.vs['Heavy']).toBe(80);
    });
  });
});

describe('parseRules edge cases', () => {
  it('handles empty input', () => {
    const rules = parseRules('');
    expect(rules.units.size).toBe(0);
    expect(rules.buildings.size).toBe(0);
    expect(rules.houseTypes).toEqual([]);
  });

  it('strips comments', () => {
    const rules = parseRules(`
[General]
SpiceValue=200 // inline comment
// full line comment
RepairRate=12
`);
    expect(rules.general['SpiceValue']).toBe('200');
    expect(rules.general['RepairRate']).toBe('12');
  });

  it('merges duplicate sections', () => {
    const rules = parseRules(`
[UnitTypes]
UnitA
[UnitTypes]
UnitB
[UnitA]
Cost=100
[UnitB]
Cost=200
`);
    expect(rules.units.size).toBe(2);
    expect(rules.units.get('UnitA')!.cost).toBe(100);
    expect(rules.units.get('UnitB')!.cost).toBe(200);
  });
});
