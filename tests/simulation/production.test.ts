import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProductionSystem } from '../../src/simulation/ProductionSystem';
import { parseRules, type GameRules } from '../../src/config/RulesParser';
import { EventBus } from '../../src/core/EventBus';

// Minimal HarvestSystem mock that satisfies ProductionSystem's needs
class MockHarvestSystem {
  private solaris = new Map<number, number>();

  getSolaris(playerId: number): number {
    return this.solaris.get(playerId) ?? 0;
  }

  addSolaris(playerId: number, amount: number): void {
    this.solaris.set(playerId, (this.solaris.get(playerId) ?? 0) + amount);
  }

  spendSolaris(playerId: number, amount: number): boolean {
    const current = this.solaris.get(playerId) ?? 0;
    if (current < amount) return false;
    this.solaris.set(playerId, current - amount);
    return true;
  }
}

const RULES_TEXT = `
[General]
EasyBuildCost=50
NormalBuildCost=100
HardBuildCost=125
EasyBuildTime=75
NormalBuildTime=100
HardBuildTime=125

[HouseTypes]
Atreides

[TerrainTypes]
Sand
Rock

[ArmourTypes]
None
Building

[UnitTypes]
ATLightInf
ATCombatTank
ATHarvester

[BuildingTypes]
ATConYard
ATBarracks
ATFactory
ATRefinery

[TurretTypes]
[BulletTypes]
[WarheadTypes]

[ATLightInf]
House=Atreides
Cost=50
BuildTime=100
Health=80
Infantry=true
TechLevel=1
PrimaryBuilding=ATBarracks

[ATCombatTank]
House=Atreides
Cost=500
BuildTime=400
Health=600
TechLevel=3
PrimaryBuilding=ATFactory
Starportable=true

[ATHarvester]
House=Atreides
Cost=1000
BuildTime=500
Health=800
TechLevel=2
PrimaryBuilding=ATFactory

[ATConYard]
House=Atreides
Cost=5000
BuildTime=1000
Health=3000
TechLevel=1

[ATBarracks]
House=Atreides
Cost=300
BuildTime=200
Health=1500
TechLevel=1
PrimaryBuilding=ATConYard
UpgradeCost=500
UpgradeTechLevel=3

[ATFactory]
House=Atreides
Cost=600
BuildTime=300
Health=2000
TechLevel=2
PrimaryBuilding=ATConYard
SecondaryBuilding=ATBarracks

[ATRefinery]
House=Atreides
Cost=1500
BuildTime=400
Health=2000
TechLevel=1
PrimaryBuilding=ATConYard
Refinery=true
GetUnitWhenBuilt=ATHarvester
`;

describe('ProductionSystem', () => {
  let rules: GameRules;
  let harvest: MockHarvestSystem;
  let production: ProductionSystem;

  beforeEach(() => {
    EventBus.clear();
    rules = parseRules(RULES_TEXT);
    harvest = new MockHarvestSystem();
    production = new ProductionSystem(rules, harvest as any);

    // Give player 0 some starting money and basic buildings
    harvest.addSolaris(0, 10000);
    production.addPlayerBuilding(0, 'ATConYard');
    production.addPlayerBuilding(0, 'ATBarracks');
  });

  describe('canBuild', () => {
    it('allows building when prerequisites are met', () => {
      expect(production.canBuild(0, 'ATLightInf', false)).toBe(true);
    });

    it('blocks when missing primary building', () => {
      expect(production.canBuild(0, 'ATCombatTank', false)).toBe(false);
    });

    it('blocks when missing secondary building', () => {
      // ATFactory requires ATConYard (primary) + ATBarracks (secondary) + tech 2
      // Give player factory first to reach tech 2, then test secondary prereq
      production.addPlayerBuilding(0, 'ATFactory');
      expect(production.canBuild(0, 'ATFactory', true)).toBe(true);

      // Remove barracks - now factory should be blocked (missing secondary)
      production.removePlayerBuilding(0, 'ATBarracks');
      expect(production.canBuild(0, 'ATFactory', true)).toBe(false);
    });

    it('blocks when insufficient funds', () => {
      harvest.spendSolaris(0, 10000); // drain all money
      expect(production.canBuild(0, 'ATLightInf', false)).toBe(false);
    });

    it('blocks at population cap', () => {
      production.setUnitCountCallback(() => 50);
      production.setMaxUnits(50);
      expect(production.canBuild(0, 'ATLightInf', false)).toBe(false);
    });

    it('allows buildings at pop cap', () => {
      production.setUnitCountCallback(() => 50);
      production.setMaxUnits(50);
      expect(production.canBuild(0, 'ATBarracks', true)).toBe(true);
    });
  });

  describe('getBuildBlockReason', () => {
    it('returns null when buildable', () => {
      expect(production.getBuildBlockReason(0, 'ATLightInf', false)).toBeNull();
    });

    it('returns cost reason when insufficient funds', () => {
      harvest.spendSolaris(0, 10000);
      const reason = production.getBuildBlockReason(0, 'ATLightInf', false);
      expect(reason?.reason).toBe('cost');
    });

    it('returns prereq reason when missing building', () => {
      const reason = production.getBuildBlockReason(0, 'ATCombatTank', false);
      expect(reason?.reason).toBe('prereq');
    });

    it('returns cap reason at population limit', () => {
      production.setUnitCountCallback(() => 50);
      production.setMaxUnits(50);
      const reason = production.getBuildBlockReason(0, 'ATLightInf', false);
      expect(reason?.reason).toBe('cap');
    });
  });

  describe('startProduction', () => {
    it('starts production and deducts cost', () => {
      expect(production.startProduction(0, 'ATLightInf', false)).toBe(true);
      expect(harvest.getSolaris(0)).toBe(9950); // 10000 - 50
    });

    it('fails when cannot build', () => {
      harvest.spendSolaris(0, 10000);
      expect(production.startProduction(0, 'ATLightInf', false)).toBe(false);
    });

    it('enforces queue limit of 5', () => {
      for (let i = 0; i < 5; i++) {
        expect(production.startProduction(0, 'ATLightInf', false)).toBe(true);
      }
      expect(production.startProduction(0, 'ATLightInf', false)).toBe(false);
    });

    it('emits production:started event', () => {
      const handler = vi.fn();
      EventBus.on('production:started', handler);
      production.startProduction(0, 'ATLightInf', false);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ unitType: 'ATLightInf', owner: 0, isBuilding: false })
      );
    });
  });

  describe('update and completion', () => {
    it('completes production after enough ticks', () => {
      const handler = vi.fn();
      EventBus.on('production:complete', handler);

      production.startProduction(0, 'ATLightInf', false);
      // Infantry build time is 100 ticks
      for (let i = 0; i < 100; i++) {
        production.update();
      }
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ unitType: 'ATLightInf', owner: 0, isBuilding: false })
      );
    });

    it('building queue processes separately from unit queues', () => {
      const handler = vi.fn();
      EventBus.on('production:complete', handler);

      production.startProduction(0, 'ATBarracks', true);
      production.startProduction(0, 'ATLightInf', false);

      // Both should progress simultaneously
      for (let i = 0; i < 100; i++) {
        production.update();
      }
      // Infantry should complete at tick 100
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ unitType: 'ATLightInf', isBuilding: false })
      );
    });
  });

  describe('difficulty multipliers', () => {
    it('easy difficulty halves unit cost', () => {
      production.setDifficulty(0, 'easy');
      const cost = production.getAdjustedCost(0, 'ATLightInf', false);
      expect(cost).toBe(25); // 50 * 0.5
    });

    it('hard difficulty increases cost by 25%', () => {
      production.setDifficulty(0, 'hard');
      const cost = production.getAdjustedCost(0, 'ATLightInf', false);
      expect(cost).toBe(63); // 50 * 1.25 = 62.5, rounded
    });

    it('AI gets inverse difficulty', () => {
      production.setDifficulty(1, 'easy', true);
      const cost = production.getAdjustedCost(1, 'ATLightInf', false);
      expect(cost).toBe(63); // AI on easy game pays 125% = 62.5 rounded
    });

    it('normal difficulty is 100%', () => {
      production.setDifficulty(0, 'normal');
      const cost = production.getAdjustedCost(0, 'ATLightInf', false);
      expect(cost).toBe(50);
    });
  });

  describe('tech level', () => {
    it('starts at tech 1 with ConYard', () => {
      expect(production.getPlayerTechLevel(0)).toBe(1);
    });

    it('increases tech with higher-level buildings', () => {
      production.addPlayerBuilding(0, 'ATFactory'); // tech 2
      expect(production.getPlayerTechLevel(0)).toBe(2);
    });

    it('returns 0 with no buildings', () => {
      expect(production.getPlayerTechLevel(1)).toBe(0);
    });
  });

  describe('upgrades', () => {
    it('can upgrade building with upgrade cost', () => {
      expect(production.canUpgrade(0, 'ATBarracks')).toBe(true);
    });

    it('cannot upgrade non-upgradable building', () => {
      expect(production.canUpgrade(0, 'ATConYard')).toBe(false);
    });

    it('cannot upgrade building player does not own', () => {
      expect(production.canUpgrade(1, 'ATBarracks')).toBe(false);
    });

    it('startUpgrade deducts cost and creates queue item', () => {
      expect(production.startUpgrade(0, 'ATBarracks')).toBe(true);
      expect(harvest.getSolaris(0)).toBe(9500); // 10000 - 500
    });

    it('upgrade completes and sets upgraded flag', () => {
      production.startUpgrade(0, 'ATBarracks');
      expect(production.isUpgraded(0, 'ATBarracks')).toBe(false);

      // Tick until complete (buildTime * 0.5 = 200 * 0.5 = 100)
      for (let i = 0; i < 100; i++) {
        production.update();
      }
      expect(production.isUpgraded(0, 'ATBarracks')).toBe(true);
    });

    it('cannot upgrade already upgraded building', () => {
      production.startUpgrade(0, 'ATBarracks');
      for (let i = 0; i < 100; i++) production.update();
      expect(production.canUpgrade(0, 'ATBarracks')).toBe(false);
    });
  });

  describe('factory speed bonus', () => {
    it('pauses production when no production building exists', () => {
      const handler = vi.fn();
      EventBus.on('production:complete', handler);

      production.startProduction(0, 'ATLightInf', false);

      // Remove all barracks (infantry production building)
      production.removePlayerBuilding(0, 'ATBarracks');

      // Tick 200 times - should not complete because factory speed = 0
      for (let i = 0; i < 200; i++) {
        production.update();
      }
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('cancelQueueItem', () => {
    it('refunds full cost for queued (not in-progress) items', () => {
      production.startProduction(0, 'ATLightInf', false);
      production.startProduction(0, 'ATLightInf', false);
      expect(harvest.getSolaris(0)).toBe(9900); // 10000 - 100

      // Cancel second item (index 1) - full refund
      production.cancelQueueItem(0, false, 1, 'infantry');
      expect(harvest.getSolaris(0)).toBe(9950);
    });

    it('partial refund for in-progress item', () => {
      production.startProduction(0, 'ATLightInf', false);
      expect(harvest.getSolaris(0)).toBe(9950);

      // Progress 50% (50 of 100 ticks)
      for (let i = 0; i < 50; i++) production.update();

      production.cancelQueueItem(0, false, 0, 'infantry');
      // Refund = floor(50 * (1 - 50/100)) = floor(25) = 25
      expect(harvest.getSolaris(0)).toBe(9975);
    });

    it('returns false for invalid index', () => {
      expect(production.cancelQueueItem(0, false, 0, 'infantry')).toBe(false);
    });
  });

  describe('repeat mode', () => {
    it('toggles repeat on and off', () => {
      expect(production.toggleRepeat(0, 'ATLightInf')).toBe(true);
      expect(production.isOnRepeat(0, 'ATLightInf')).toBe(true);
      expect(production.toggleRepeat(0, 'ATLightInf')).toBe(false);
      expect(production.isOnRepeat(0, 'ATLightInf')).toBe(false);
    });
  });

  describe('building tracking', () => {
    it('tracks building counts', () => {
      expect(production.ownsBuilding(0, 'ATConYard')).toBe(true);
      expect(production.ownsBuilding(0, 'ATFactory')).toBe(false);
    });

    it('handles multiple buildings of same type', () => {
      production.addPlayerBuilding(0, 'ATBarracks');
      expect(production.ownsBuilding(0, 'ATBarracks')).toBe(true);
      production.removePlayerBuilding(0, 'ATBarracks');
      expect(production.ownsBuilding(0, 'ATBarracks')).toBe(true); // still one left
      production.removePlayerBuilding(0, 'ATBarracks');
      expect(production.ownsBuilding(0, 'ATBarracks')).toBe(false);
    });

    it('ownsAnyBuildingSuffix works', () => {
      expect(production.ownsAnyBuildingSuffix(0, 'ConYard')).toBe(true);
      expect(production.ownsAnyBuildingSuffix(0, 'Factory')).toBe(false);
    });
  });

  describe('save/load', () => {
    it('round-trips production state', () => {
      production.setDifficulty(0, 'hard');
      production.startProduction(0, 'ATLightInf', false);
      production.toggleRepeat(0, 'ATLightInf');
      for (let i = 0; i < 30; i++) production.update();

      const state = production.getState();
      const json = JSON.stringify(state);
      const restored = JSON.parse(json);

      // Create new production system and restore
      const production2 = new ProductionSystem(rules, harvest as any);
      production2.restoreState(restored);

      // Should have queue progress
      const progress = production2.getQueueProgress(0, false, 'infantry');
      expect(progress).not.toBeNull();
      expect(progress!.typeName).toBe('ATLightInf');
      expect(progress!.progress).toBeGreaterThan(0);

      // Repeat mode should be restored
      expect(production2.isOnRepeat(0, 'ATLightInf')).toBe(true);
    });
  });
});
