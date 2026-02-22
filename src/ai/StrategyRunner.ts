// Executes parsed strategy scripts against the live game world
// Manages team formation, staging point resolution, and step-by-step advancement

import { simRng } from '../utils/DeterministicRNG';
import { distance2D } from '../utils/MathUtils';
import type { Strategy, ObjectSet, StrategyStaging, OriginalAIData } from './OriginalAIData';

// =========================================
// Types
// =========================================

interface TeamState {
  name: string;
  unitIds: number[];
  objectSetName: string;
}

interface ActiveStrategy {
  strategy: Strategy;
  teams: TeamState[];
  currentStep: number;
  stepStartTick: number;
  startTick: number;
}

// Unit position/health accessor interface (avoids importing ECS directly)
export interface StrategyWorldView {
  getUnitPosition(eid: number): { x: number; z: number } | null;
  getUnitHealth(eid: number): number; // 0 = dead
  isUnitAlive(eid: number): boolean;
  moveUnit(eid: number, x: number, z: number): void;
  setAttackMove(eids: number[]): void;
}

// =========================================
// House matching
// =========================================

const HOUSE_PREFIX_MAP: Record<string, string[]> = {
  'atreides': ['AT'],
  'harkonnen': ['HK'],
  'ordos': ['OR'],
  'all': ['AT', 'HK', 'OR', 'FR', 'IM', 'IX', 'TL', 'GU'],
};

function houseMatchesFaction(house: string, factionPrefix: string): boolean {
  if (house === 'all') return true;
  const prefixes = HOUSE_PREFIX_MAP[house];
  return prefixes ? prefixes.includes(factionPrefix) : false;
}

// =========================================
// StrategyRunner
// =========================================

export class StrategyRunner {
  private data: OriginalAIData;
  private factionPrefix: string;
  private activeStrategies: ActiveStrategy[] = [];
  private assignedUnits = new Set<number>();

  constructor(data: OriginalAIData, factionPrefix: string) {
    this.data = data;
    this.factionPrefix = factionPrefix;
  }

  /** Get entity IDs currently under strategy control */
  getAssignedUnits(): Set<number> {
    return this.assignedUnits;
  }

  /** Number of active (running) strategies */
  getActiveCount(): number {
    return this.activeStrategies.length;
  }

  /** Try to launch a new strategy matching the current state */
  tryLaunchStrategy(
    worldView: StrategyWorldView,
    techLevel: number,
    basePos: { x: number; z: number },
    targetPos: { x: number; z: number },
    availableUnits: Map<string, number[]>, // unitTypeName -> entity IDs
    currentTick: number,
    maxConcurrent: number,
  ): boolean {
    if (this.activeStrategies.length >= maxConcurrent) return false;

    // Clean up dead units from assigned set
    this.cleanupDeadUnits(worldView);

    // Filter strategies by tech level, faction, and non-reactive
    const eligible = this.data.strategies.filter(s => {
      const d = s.description;
      if (techLevel < d.minTech || techLevel > d.maxTech) return false;
      if (!houseMatchesFaction(d.house, this.factionPrefix)) return false;
      // Skip reactive strategies for proactive launching
      if (d.reactive) return false;
      return true;
    });

    if (eligible.length === 0) return false;

    // Weighted random selection by frequency
    const totalFreq = eligible.reduce((sum, s) => sum + s.description.frequency, 0);
    let roll = simRng.random() * totalFreq;
    let chosen: Strategy | null = null;
    for (const s of eligible) {
      roll -= s.description.frequency;
      if (roll <= 0) { chosen = s; break; }
    }
    if (!chosen) chosen = eligible[eligible.length - 1];

    // Try to assemble teams
    const teamStates = this.assembleTeams(chosen, availableUnits);
    if (!teamStates) return false; // Not enough units

    // Mark units as assigned
    for (const team of teamStates) {
      for (const eid of team.unitIds) {
        this.assignedUnits.add(eid);
      }
    }

    const active: ActiveStrategy = {
      strategy: chosen,
      teams: teamStates,
      currentStep: 0,
      stepStartTick: currentTick,
      startTick: currentTick,
    };

    this.activeStrategies.push(active);

    // Execute the first step immediately
    this.executeStep(active, worldView, basePos, targetPos);

    console.log(`[AI P${this.factionPrefix}] Launching strategy: ${chosen.description.name} (tech=${techLevel}, teams=${teamStates.length}, units=${teamStates.reduce((s, t) => s + t.unitIds.length, 0)})`);
    return true;
  }

  /** Advance all active strategies. Call every ~75 ticks. */
  tick(
    worldView: StrategyWorldView,
    currentTick: number,
    basePos: { x: number; z: number },
    targetPos: { x: number; z: number },
  ): void {
    this.cleanupDeadUnits(worldView);

    const completed: number[] = [];

    for (let i = 0; i < this.activeStrategies.length; i++) {
      const active = this.activeStrategies[i];
      const step = active.strategy.steps[active.currentStep];
      if (!step) { completed.push(i); continue; }

      // Check if current step is complete: all units near destination or timeout
      const stepElapsed = currentTick - active.stepStartTick;
      const allArrived = this.checkStepComplete(active, worldView, basePos, targetPos);

      if (allArrived || stepElapsed > 1500) {
        // Advance to next step
        active.currentStep++;
        active.stepStartTick = currentTick;

        if (active.currentStep >= active.strategy.steps.length) {
          completed.push(i);
        } else {
          this.executeStep(active, worldView, basePos, targetPos);
        }
      }
    }

    // Remove completed strategies (iterate in reverse)
    for (let i = completed.length - 1; i >= 0; i--) {
      const idx = completed[i];
      const active = this.activeStrategies[idx];
      // Release units
      for (const team of active.teams) {
        for (const eid of team.unitIds) {
          this.assignedUnits.delete(eid);
        }
      }
      this.activeStrategies.splice(idx, 1);
    }
  }

  // =========================================
  // Private methods
  // =========================================

  private cleanupDeadUnits(worldView: StrategyWorldView): void {
    for (const eid of this.assignedUnits) {
      if (!worldView.isUnitAlive(eid)) {
        this.assignedUnits.delete(eid);
      }
    }
    // Clean from active strategy teams too
    for (const active of this.activeStrategies) {
      for (const team of active.teams) {
        team.unitIds = team.unitIds.filter(eid => worldView.isUnitAlive(eid));
      }
    }
  }

  /** Try to fill teams from available units. Returns null if minimum not met. */
  private assembleTeams(
    strategy: Strategy,
    availableUnits: Map<string, number[]>,
  ): TeamState[] | null {
    const teamStates: TeamState[] = [];
    // Track which units we've already assigned in this assembly
    const used = new Set<number>();

    for (const teamDef of strategy.teams) {
      const objectSet = this.data.objectSets.get(teamDef.teamType.toLowerCase());
      if (!objectSet) continue;

      // Filter ObjectSet to units matching our faction
      const factionUnits = this.filterObjectSetToFaction(objectSet);

      // Gather available units matching the ObjectSet
      const candidates: number[] = [];
      for (const unitType of factionUnits) {
        const eids = availableUnits.get(unitType) ?? [];
        for (const eid of eids) {
          if (!used.has(eid) && !this.assignedUnits.has(eid)) {
            candidates.push(eid);
          }
        }
      }

      if (candidates.length < teamDef.minUnits) return null; // Can't fill minimum

      // Take up to maxUnits
      const count = Math.min(candidates.length, teamDef.maxUnits);
      const assigned = candidates.slice(0, count);
      for (const eid of assigned) used.add(eid);

      teamStates.push({
        name: teamDef.name,
        unitIds: assigned,
        objectSetName: teamDef.teamType,
      });
    }

    if (teamStates.length === 0) return null;
    return teamStates;
  }

  /** Filter an ObjectSet's objects to those matching the AI's faction prefix */
  private filterObjectSetToFaction(objectSet: ObjectSet): string[] {
    return objectSet.objects.filter(name => {
      // Generic names (no faction prefix) are available to all
      if (name === 'MCV') return true;
      // Check if the unit name starts with our faction prefix
      return name.startsWith(this.factionPrefix);
    });
  }

  /** Execute commands for the current step of an active strategy */
  private executeStep(
    active: ActiveStrategy,
    worldView: StrategyWorldView,
    basePos: { x: number; z: number },
    targetPos: { x: number; z: number },
  ): void {
    const step = active.strategy.steps[active.currentStep];
    if (!step) return;

    for (const send of step.sends) {
      // Resolve which units to send
      const unitsToSend = this.resolveWho(send.who, active.teams);

      // Resolve destination
      const dest = this.resolveDestination(
        send.destination, active.strategy, basePos, targetPos
      );

      // Move units with spread
      const attackMove = send.encounter === 'attack';
      const eids: number[] = [];
      for (const eid of unitsToSend) {
        if (!worldView.isUnitAlive(eid)) continue;
        const spread = (simRng.random() - 0.5) * 10;
        const spreadPerp = (simRng.random() - 0.5) * 10;
        worldView.moveUnit(eid, dest.x + spread, dest.z + spreadPerp);
        eids.push(eid);
      }

      if (attackMove && eids.length > 0) {
        worldView.setAttackMove(eids);
      }
    }
  }

  /** Resolve 'who' field to a list of entity IDs */
  private resolveWho(who: string, teams: TeamState[]): number[] {
    if (who.toLowerCase() === 'all') {
      return teams.flatMap(t => t.unitIds);
    }
    const team = teams.find(t => t.name === who);
    return team ? team.unitIds : [];
  }

  /** Resolve a destination name to world coordinates */
  private resolveDestination(
    destName: string,
    strategy: Strategy,
    basePos: { x: number; z: number },
    targetPos: { x: number; z: number },
  ): { x: number; z: number } {
    // 'homebase' → AI's base position
    if (destName.toLowerCase() === 'homebase') {
      return { x: basePos.x, z: basePos.z };
    }

    // Check if it's a staging point
    const staging = strategy.stagings.find(s => s.name === destName);
    if (staging) {
      return this.resolveStagingPoint(staging, basePos, targetPos);
    }

    // Check if it's a target
    const target = strategy.targets.find(t => t.name === destName);
    if (target) {
      // 'enemybase' or 'threat' both resolve to the target position
      return { x: targetPos.x, z: targetPos.z };
    }

    // Default: target position
    return { x: targetPos.x, z: targetPos.z };
  }

  /** Resolve a staging point to world coordinates */
  private resolveStagingPoint(
    staging: StrategyStaging,
    basePos: { x: number; z: number },
    targetPos: { x: number; z: number },
  ): { x: number; z: number } {
    // Direction from target to AI base
    const dx = basePos.x - targetPos.x;
    const dz = basePos.z - targetPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz) || 1;
    const dirX = dx / dist;
    const dirZ = dz / dist;

    // Perpendicular direction (for flanks)
    const perpX = -dirZ;
    const perpZ = dirX;

    // Distance offsets
    const distMap: Record<string, number> = { close: 15, medium: 25, far: 40 };
    const offset = distMap[staging.distance] ?? 25;

    let x = targetPos.x;
    let z = targetPos.z;

    switch (staging.stagingType) {
      case 'front':
        // Between target and AI base
        x = targetPos.x + dirX * offset;
        z = targetPos.z + dirZ * offset;
        break;
      case 'lflank':
        x = targetPos.x + dirX * offset * 0.5 + perpX * offset;
        z = targetPos.z + dirZ * offset * 0.5 + perpZ * offset;
        break;
      case 'rflank':
        x = targetPos.x + dirX * offset * 0.5 - perpX * offset;
        z = targetPos.z + dirZ * offset * 0.5 - perpZ * offset;
        break;
      case 'rear':
        // Away from AI base (behind target)
        x = targetPos.x - dirX * offset;
        z = targetPos.z - dirZ * offset;
        break;
    }

    return { x, z };
  }

  /** Check if all units in a step have roughly arrived at their destinations */
  private checkStepComplete(
    active: ActiveStrategy,
    worldView: StrategyWorldView,
    basePos: { x: number; z: number },
    targetPos: { x: number; z: number },
  ): boolean {
    const step = active.strategy.steps[active.currentStep];
    if (!step) return true;

    for (const send of step.sends) {
      const units = this.resolveWho(send.who, active.teams);
      const dest = this.resolveDestination(send.destination, active.strategy, basePos, targetPos);

      for (const eid of units) {
        const pos = worldView.getUnitPosition(eid);
        if (!pos) continue; // dead, skip
        const d = distance2D(pos.x, pos.z, dest.x, dest.z);
        if (d > 15) return false; // Still en route
      }
    }

    return true;
  }
}
