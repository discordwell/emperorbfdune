import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Owner, Health, MoveTarget, UnitType,
  addComponent, addEntity, unitQuery,
} from '../core/ECS';
import * as ECS from '../core/ECS';
import type { GameRules } from '../config/RulesParser';
import type { CombatSystem } from '../simulation/CombatSystem';
import { randomFloat } from '../utils/MathUtils';

// Simple AI: spawns waves of units and sends them to attack
export class AIPlayer implements GameSystem {
  private rules: GameRules;
  private combatSystem: CombatSystem;
  private playerId: number;
  private spawnX: number;
  private spawnZ: number;
  private targetX: number;
  private targetZ: number;
  private tickCounter = 0;
  private waveInterval = 750; // Ticks between waves (~30 seconds)
  private waveSize = 3;
  private spawnCallback: ((eid: number, typeName: string, owner: number, x: number, z: number) => void) | null = null;

  // Unit types the AI can build
  private unitPool: string[] = [];

  constructor(rules: GameRules, combatSystem: CombatSystem, playerId: number, spawnX: number, spawnZ: number, targetX: number, targetZ: number) {
    this.rules = rules;
    this.combatSystem = combatSystem;
    this.playerId = playerId;
    this.spawnX = spawnX;
    this.spawnZ = spawnZ;
    this.targetX = targetX;
    this.targetZ = targetZ;

    // Build unit pool from available Harkonnen units
    for (const [name, def] of rules.units) {
      if (name.startsWith('HK') && def.cost > 0 && def.cost <= 1200 && !def.canFly) {
        this.unitPool.push(name);
      }
    }
    if (this.unitPool.length === 0) {
      this.unitPool = ['HKLightInf', 'HKBuzzsaw', 'HKAssault'];
    }
  }

  setSpawnCallback(cb: (eid: number, typeName: string, owner: number, x: number, z: number) => void): void {
    this.spawnCallback = cb;
  }

  setUnitPool(prefix: string): void {
    this.unitPool = [];
    for (const [name, def] of this.rules.units) {
      if (name.startsWith(prefix) && def.cost > 0 && def.cost <= 1200 && !def.canFly) {
        this.unitPool.push(name);
      }
    }
    if (this.unitPool.length === 0) {
      this.unitPool = [`${prefix}LightInf`, `${prefix}Trooper`];
    }
  }

  init(_world: World): void {}

  update(world: World, _dt: number): void {
    this.tickCounter++;

    if (this.tickCounter % this.waveInterval === 0) {
      this.spawnWave(world);
      // Increase difficulty over time
      if (this.waveSize < 10) this.waveSize++;
      if (this.waveInterval > 375) this.waveInterval -= 25;
    }

    // Send idle AI units to attack
    if (this.tickCounter % 50 === 0) {
      this.sendIdleUnitsToAttack(world);
    }
  }

  private spawnWave(world: World): void {
    for (let i = 0; i < this.waveSize; i++) {
      const typeName = this.unitPool[Math.floor(Math.random() * this.unitPool.length)];
      const x = this.spawnX + randomFloat(-10, 10);
      const z = this.spawnZ + randomFloat(-10, 10);

      if (this.spawnCallback) {
        const eid = addEntity(world);
        this.spawnCallback(eid, typeName, this.playerId, x, z);
      }
    }
  }

  private sendIdleUnitsToAttack(world: World): void {
    const units = unitQuery(world);
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (MoveTarget.active[eid] === 1) continue;
      if (Health.current[eid] <= 0) continue;

      // Send to attack player base area with some randomness
      MoveTarget.x[eid] = this.targetX + randomFloat(-20, 20);
      MoveTarget.z[eid] = this.targetZ + randomFloat(-20, 20);
      MoveTarget.active[eid] = 1;
    }
  }
}
