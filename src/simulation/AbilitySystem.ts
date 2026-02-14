import type { GameRules } from '../config/RulesParser';
import type { CombatSystem } from './CombatSystem';
import type { SandwormSystem } from './SandwormSystem';
import type { ProductionSystem } from './ProductionSystem';
import type { UnitRenderer } from '../rendering/UnitRenderer';
import type { EffectsManager } from '../rendering/EffectsManager';
import type { SceneManager } from '../rendering/SceneManager';
import type { AudioManager } from '../audio/AudioManager';
import type { CommandManager } from '../input/CommandManager';
import type { SelectionManager } from '../input/SelectionManager';
import type { SelectionPanel } from '../ui/SelectionPanel';
import { EventBus } from '../core/EventBus';
import {
  Position, Health, Combat, Owner, UnitType, AttackTarget, MoveTarget,
  BuildingType,
  unitQuery, buildingQuery, hasComponent,
  type World,
} from '../core/ECS';

/** Callback signatures for functions that remain in index.ts */
export type SpawnUnitFn = (world: World, typeName: string, owner: number, x: number, z: number) => number;
export type SpawnBuildingFn = (world: World, typeName: string, owner: number, x: number, z: number) => number;

export interface AbilitySystemDeps {
  rules: GameRules;
  combatSystem: CombatSystem;
  sandwormSystem: SandwormSystem;
  productionSystem: ProductionSystem;
  unitRenderer: UnitRenderer;
  effectsManager: EffectsManager;
  scene: SceneManager;
  audioManager: AudioManager;
  commandManager: CommandManager;
  selectionManager: SelectionManager;
  selectionPanel: SelectionPanel;
  unitTypeNames: string[];
  buildingTypeNames: string[];
  unitTypeIdMap: Map<string, number>;
  spawnUnit: SpawnUnitFn;
  spawnBuilding: SpawnBuildingFn;
  getWorld: () => World;
  getTickCount: () => number;
  housePrefix: string;
  enemyPrefix: string;
}

export class AbilitySystem {
  private deps: AbilitySystemDeps;

  // --- Deviator conversion tracking ---
  private deviatedUnits = new Map<number, { originalOwner: number; revertTick: number }>();

  // --- Leech parasitization: leechEid -> targetVehicleEid ---
  private leechTargets = new Map<number, number>();

  // --- Projector holograms: hologramEid -> ticksRemaining ---
  private projectorHolograms = new Map<number, number>();

  // --- Kobra deployed units (immobilized, doubled range) ---
  private kobraDeployed = new Set<number>();
  private kobraBaseRange = new Map<number, number>(); // eid -> original combat range

  // --- NIAB Tank teleport cooldowns: eid -> ticksRemaining ---
  private niabCooldowns = new Map<number, number>();

  // --- Infiltrator reveal persistence: eid -> tick when reveal expires ---
  private infiltratorRevealed = new Map<number, number>();

  // --- Stealth timing: per-entity idle/fire cooldown tracking ---
  private stealthTimers = new Map<number, { idleTicks: number; fireCooldown: number; active: boolean }>();
  // Track previous positions for movement detection
  private stealthPrevPositions = new Map<number, { x: number; z: number }>();

  // --- APC Transport system ---
  private transportPassengers = new Map<number, number[]>();

  constructor(deps: AbilitySystemDeps) {
    this.deps = deps;
    this.setupEventHandlers();
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  /** Called when a unit dies — clean up all ability tracking for that entity. */
  handleUnitDeath(entityId: number): void {
    const { combatSystem, sandwormSystem } = this.deps;

    // Kill passengers if this was a transport
    this.killPassengers(entityId);

    // If this entity was a passenger, remove from its transport
    for (const [tid, passengers] of this.transportPassengers) {
      const idx = passengers.indexOf(entityId);
      if (idx >= 0) { passengers.splice(idx, 1); break; }
    }

    // Clean up special ability tracking
    this.leechTargets.delete(entityId);
    this.projectorHolograms.delete(entityId);
    this.infiltratorRevealed.delete(entityId);
    this.stealthTimers.delete(entityId);
    this.stealthPrevPositions.delete(entityId);

    // Kobra: restore base range on death (for ECS entity recycling safety)
    if (this.kobraDeployed.has(entityId)) {
      this.kobraDeployed.delete(entityId);
      this.kobraBaseRange.delete(entityId);
    }

    // NIAB: clear suppression on death
    if (this.niabCooldowns.has(entityId)) {
      this.niabCooldowns.delete(entityId);
      combatSystem.setSuppressed(entityId, false);
    }

    // Dismount worm if rider dies
    sandwormSystem.dismountWorm(entityId);

    // If this entity was being leeched, detach the leech(es)
    const leechesToDetach: number[] = [];
    for (const [leechEid, targetEid] of this.leechTargets) {
      if (targetEid === entityId) leechesToDetach.push(leechEid);
    }
    for (const leechEid of leechesToDetach) {
      this.leechTargets.delete(leechEid);
      combatSystem.setSuppressed(leechEid, false);
      Position.y[leechEid] = 0.1;
    }
  }

  /** Called every game tick from game:tick handler. */
  update(world: World, tickCount: number): void {
    this.updateDeviatorRevert(world, tickCount);
    this.updateStealth(world, tickCount);
    this.updateInfantryCrushing(world, tickCount);
    this.updateEngineerCapture(world, tickCount);
    this.updateSaboteur(world, tickCount);
    this.updateInfiltrator(world, tickCount);
    this.updateLeech(world, tickCount);
    this.updateProjectorDecay(world, tickCount);
    this.updateKobra(world, tickCount);
    this.updateNiabCooldowns(world, tickCount);
    this.updatePassiveRepair(world, tickCount);
    this.updateRepairVehicles(world, tickCount);
    this.updateFactionBonuses(world, tickCount);
  }

  /**
   * Handle key commands for abilities. Returns true if the key was handled.
   * Called from the keydown handler in index.ts.
   */
  handleKeyCommand(key: string, selectedEntities: number[], world: World): boolean {
    switch (key) {
      case 'x': return this.handleSelfDestruct(selectedEntities, world);
      case 'd': return this.handleDeploy(selectedEntities, world);
      case 't': return this.handleTeleportOrProjector(selectedEntities, world);
      case 'l': return this.handleLoadTransport(selectedEntities, world);
      case 'u': return this.handleUnloadTransport(selectedEntities, world);
      case 'w': return this.handleWormMount(selectedEntities, world);
      default: return false;
    }
  }

  /**
   * Handle combat-triggered abilities (deviator, contaminator).
   * Called from combat:fire event handler in index.ts.
   */
  handleCombatHit(attackerEntity: number, targetEntity: number): void {
    this.handleDeviatorHit(attackerEntity, targetEntity);
    this.handleContaminatorHit(attackerEntity, targetEntity);
  }

  /** Get count of passengers in a transport (for UI). */
  getTransportPassengerCount(transportEid: number): number {
    return this.transportPassengers.get(transportEid)?.length ?? 0;
  }

  /** Get the deviatedUnits map (needed for index.ts event handler wiring). */
  getDeviatedUnits(): Map<number, { originalOwner: number; revertTick: number }> {
    return this.deviatedUnits;
  }

  /** Get the leechTargets map (needed for save/load if desired). */
  getLeechTargets(): Map<number, number> {
    return this.leechTargets;
  }

  /** Get the transportPassengers map (needed for save/load). */
  getTransportPassengers(): Map<number, number[]> {
    return this.transportPassengers;
  }

  /** Set transport passengers (used when restoring from save). */
  setTransportPassengers(eid: number, passengers: number[]): void {
    this.transportPassengers.set(eid, passengers);
  }

  // =========================================================================
  // EVENT HANDLER SETUP
  // =========================================================================

  private setupEventHandlers(): void {
    // Stealth: when a stealthed unit fires, break stealth and set fire cooldown
    EventBus.on('combat:fire', ({ attackerEntity }) => {
      if (attackerEntity === undefined) return;
      const timer = this.stealthTimers.get(attackerEntity);
      if (timer) {
        const typeName = this.deps.unitTypeNames[UnitType.id[attackerEntity]];
        const def = typeName ? this.deps.rules.units.get(typeName) : null;
        if (def?.stealth) {
          const delayAfterFiring = def.stealthDelayAfterFiring || 125; // default 5 seconds
          timer.fireCooldown = delayAfterFiring;
          timer.idleTicks = 0;
          if (timer.active) {
            timer.active = false;
            this.deps.combatSystem.setStealthed(attackerEntity, false);
            // Instantly visible when firing
            const obj = this.deps.unitRenderer.getEntityObject(attackerEntity);
            if (obj) {
              obj.traverse(child => {
                const mat = (child as any).material;
                if (mat) { mat.transparent = false; mat.opacity = 1.0; }
              });
            }
          }
        }
      }
    });

    // NIAB Tank teleport: handle target selection
    EventBus.on('teleport:target', ({ x, z }) => {
      const { selectionManager, effectsManager, audioManager, selectionPanel, combatSystem } = this.deps;
      const selected = selectionManager.getSelectedEntities();
      const w = this.deps.getWorld();
      for (const eid of selected) {
        if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
        const typeName = this.deps.unitTypeNames[UnitType.id[eid]];
        const def = typeName ? this.deps.rules.units.get(typeName) : null;
        if (!def?.niabTank) continue;
        if (this.niabCooldowns.has(eid)) continue;

        // Teleport!
        effectsManager.spawnExplosion(Position.x[eid], 0, Position.z[eid], 'small');
        Position.x[eid] = x;
        Position.z[eid] = z;
        Position.y[eid] = 0.1;
        MoveTarget.active[eid] = 0;
        effectsManager.spawnExplosion(x, 0, z, 'small');
        audioManager.playSfx('explosion');
        // Cooldown (suppress combat during sleep time)
        const sleepTime = def.teleportSleepTime || 93;
        this.niabCooldowns.set(eid, sleepTime);
        combatSystem.setSuppressed(eid, true);
        selectionPanel.addMessage('NIAB teleported!', '#88aaff');
        break; // Only teleport first selected NIAB
      }
    });
  }

  // =========================================================================
  // TICK UPDATES
  // =========================================================================

  /** Revert deviated units when timer expires */
  private updateDeviatorRevert(_world: World, tickCount: number): void {
    if (tickCount % 25 !== 0 || this.deviatedUnits.size === 0) return;
    for (const [eid, info] of this.deviatedUnits) {
      if (tickCount >= info.revertTick || Health.current[eid] <= 0) {
        if (Health.current[eid] > 0) {
          Owner.playerId[eid] = info.originalOwner;
        }
        this.deviatedUnits.delete(eid);
      }
    }
  }

  /** Stealth timing: units gradually stealth when idle, break stealth on move/fire */
  private updateStealth(world: World, tickCount: number): void {
    // Run every tick for smooth transitions (but skip expensive work when possible)
    const { combatSystem, unitRenderer, unitTypeNames, rules } = this.deps;
    const units = unitQuery(world);

    // Clean up expired infiltrator reveals (every 25 ticks)
    if (tickCount % 25 === 0) {
      for (const [revEid, expireTick] of this.infiltratorRevealed) {
        if (tickCount >= expireTick || Health.current[revEid] <= 0) {
          this.infiltratorRevealed.delete(revEid);
        }
      }
    }

    // Check buildings with unstealthRange (every 25 ticks) — collect positions with owner
    let unstealthZones: { x: number; z: number; r2: number; owner: number }[] | null = null;
    if (tickCount % 25 === 0) {
      unstealthZones = [];
      const allBuildings = buildingQuery(world);
      for (const bid of allBuildings) {
        if (Health.current[bid] <= 0) continue;
        const bTypeId = BuildingType.id[bid];
        const bName = this.deps.buildingTypeNames[bTypeId];
        const bDef = bName ? rules.buildings.get(bName) : null;
        if (bDef && bDef.unstealthRange > 0) {
          unstealthZones.push({
            x: Position.x[bid],
            z: Position.z[bid],
            r2: bDef.unstealthRange * bDef.unstealthRange,
            owner: Owner.playerId[bid],
          });
        }
      }
    }

    // Stealth fade transition rate: ~10 ticks to fully fade
    const FADE_RATE = 0.07; // per tick, 0.7 opacity change over 10 ticks

    for (const eid of units) {
      if (Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? rules.units.get(typeName) : null;
      if (!def?.stealth) continue;

      // Initialize timer if needed
      if (!this.stealthTimers.has(eid)) {
        this.stealthTimers.set(eid, { idleTicks: 0, fireCooldown: 0, active: false });
        this.stealthPrevPositions.set(eid, { x: Position.x[eid], z: Position.z[eid] });
      }
      const timer = this.stealthTimers.get(eid)!;

      // Detect movement: compare current position to previous
      const prev = this.stealthPrevPositions.get(eid)!;
      const cx = Position.x[eid], cz = Position.z[eid];
      const moved = (cx - prev.x) * (cx - prev.x) + (cz - prev.z) * (cz - prev.z) > 0.01;
      prev.x = cx;
      prev.z = cz;

      // Infiltrator reveal overrides stealth
      const isRevealed = this.infiltratorRevealed.has(eid);

      // Check if near an enemy unstealth building (use cached zones with owner)
      let inUnstealthZone = false;
      if (unstealthZones) {
        const unitOwner = Owner.playerId[eid];
        for (const zone of unstealthZones) {
          if (zone.owner === unitOwner) continue; // Only enemy buildings unstealth
          const dx = cx - zone.x;
          const dz = cz - zone.z;
          if (dx * dx + dz * dz < zone.r2) {
            inUnstealthZone = true;
            break;
          }
        }
      }

      // Decrement fire cooldown
      if (timer.fireCooldown > 0) {
        timer.fireCooldown--;
      }

      // Determine stealth delay (with defaults)
      const stealthDelay = def.stealthDelay || 75; // default 3 seconds at 25 tps

      // Update idle tracking
      if (moved || isRevealed || inUnstealthZone) {
        // Reset idle counter when moving, revealed, or in unstealth zone
        timer.idleTicks = 0;
        if (timer.active) {
          timer.active = false;
          combatSystem.setStealthed(eid, false);
        }
      } else if (timer.fireCooldown <= 0) {
        // Not moving, not revealed, fire cooldown expired — count idle ticks
        timer.idleTicks++;
        if (timer.idleTicks >= stealthDelay && !timer.active) {
          // Activate stealth (visual transition handled below)
          timer.active = true;
          combatSystem.setStealthed(eid, true);
        }
      } else {
        // Fire cooldown still active — remain visible, reset idle
        timer.idleTicks = 0;
        if (timer.active) {
          timer.active = false;
          combatSystem.setStealthed(eid, false);
        }
      }

      // Visual opacity transition
      const obj = unitRenderer.getEntityObject(eid);
      if (obj) {
        // Determine target opacity
        let targetAlpha: number;
        if (timer.active) {
          // Stealthed: player's own units at 0.4, enemy units invisible
          targetAlpha = Owner.playerId[eid] === 0 ? 0.4 : 0.0;
        } else {
          targetAlpha = 1.0;
        }

        // Get current opacity from the first mesh material
        let currentAlpha = 1.0;
        obj.traverse(child => {
          const mat = (child as any).material;
          if (mat && currentAlpha === 1.0 && mat.opacity !== undefined) {
            currentAlpha = mat.opacity;
          }
        });

        // Smoothly transition toward target
        let newAlpha: number;
        if (timer.active) {
          // Gradual fade when becoming stealthed
          newAlpha = Math.max(targetAlpha, currentAlpha - FADE_RATE);
        } else {
          // Instant reveal when breaking stealth
          newAlpha = targetAlpha;
        }

        // Apply opacity
        if (Math.abs(newAlpha - currentAlpha) > 0.001) {
          const isTransparent = newAlpha < 0.99;
          obj.traverse(child => {
            const mat = (child as any).material;
            if (mat) {
              mat.transparent = isTransparent;
              mat.opacity = newAlpha;
            }
          });
        }
      }
    }
  }

  /** Infantry crushing: vehicles crush infantry they overlap */
  private updateInfantryCrushing(world: World, tickCount: number): void {
    if (tickCount % 10 !== 0) return;
    const { unitTypeNames, rules } = this.deps;
    const allUnits = unitQuery(world);
    // Pre-filter: collect moving crushers and crushable infantry separately
    const crushers: number[] = [];
    const crushable: number[] = [];
    for (const eid of allUnits) {
      if (Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? rules.units.get(typeName) : null;
      if (!def) continue;
      if (def.crushes && MoveTarget.active[eid] === 1) crushers.push(eid);
      if (def.crushable) crushable.push(eid);
    }
    // Only do O(crushers * crushable) check, typically much smaller than O(n^2)
    for (const eid of crushers) {
      const px = Position.x[eid], pz = Position.z[eid];
      const owner = Owner.playerId[eid];
      for (const other of crushable) {
        if (Health.current[other] <= 0) continue;
        if (Owner.playerId[other] === owner) continue;
        const dx = px - Position.x[other];
        const dz = pz - Position.z[other];
        if (dx * dx + dz * dz < 2.0) {
          Health.current[other] = 0;
          EventBus.emit('unit:died', { entityId: other, killerEntity: eid });
        }
      }
    }
  }

  /** Engineer building capture: engineers capture enemy buildings on contact */
  private updateEngineerCapture(world: World, tickCount: number): void {
    if (tickCount % 10 !== 5) return;
    const { unitTypeNames, rules, selectionPanel, productionSystem } = this.deps;
    const allUnits = unitQuery(world);
    const allBuildings = buildingQuery(world);
    for (const eid of allUnits) {
      if (Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? rules.units.get(typeName) : null;
      if (!def || !def.engineer) continue;
      if (MoveTarget.active[eid] !== 1) continue; // Only capture while moving (toward target)

      const engOwner = Owner.playerId[eid];

      for (const bid of allBuildings) {
        if (Health.current[bid] <= 0) continue;
        if (Owner.playerId[bid] === engOwner) continue; // Skip friendly buildings
        const bTypeId = BuildingType.id[bid];
        const bName = this.deps.buildingTypeNames[bTypeId];
        const bDef = bName ? rules.buildings.get(bName) : null;
        if (bDef && !bDef.canBeEngineered) continue; // Building can't be captured

        const dx = Position.x[eid] - Position.x[bid];
        const dz = Position.z[eid] - Position.z[bid];
        if (dx * dx + dz * dz < 6.0) { // Within ~2.4 units
          // Capture: transfer ownership
          const prevOwner = Owner.playerId[bid];
          Owner.playerId[bid] = engOwner;
          productionSystem.removePlayerBuilding(prevOwner, bName ?? '');
          productionSystem.addPlayerBuilding(engOwner, bName ?? '');

          // Engineer is consumed
          Health.current[eid] = 0;
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });

          if (engOwner === 0) {
            selectionPanel.addMessage(`Captured ${(bName ?? '').replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '')}!`, '#44ff44');
          } else if (prevOwner === 0) {
            selectionPanel.addMessage('Building captured by enemy!', '#ff4444');
          }
          break; // Engineer consumed, stop checking
        }
      }
    }
  }

  /** Saboteur auto-suicide: saboteurs destroy enemy buildings on contact */
  private updateSaboteur(world: World, tickCount: number): void {
    if (tickCount % 10 !== 5) return;
    const { unitTypeNames, rules, effectsManager, audioManager, scene, selectionPanel } = this.deps;
    const sabUnits = unitQuery(world);
    const sabBlds = buildingQuery(world);
    for (const eid of sabUnits) {
      if (Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? rules.units.get(typeName) : null;
      if (!def?.saboteur) continue;

      const sabOwner = Owner.playerId[eid];
      for (const bid of sabBlds) {
        if (Health.current[bid] <= 0) continue;
        if (Owner.playerId[bid] === sabOwner) continue;
        const dx = Position.x[eid] - Position.x[bid];
        const dz = Position.z[eid] - Position.z[bid];
        if (dx * dx + dz * dz < 9.0) { // Within 3 units
          // Massive damage to the building (usually kills it)
          const dmg = Math.max(Health.max[bid] * 0.8, 2000);
          Health.current[bid] = Math.max(0, Health.current[bid] - dmg);
          // Explosion effects
          effectsManager.spawnExplosion(Position.x[bid], 0, Position.z[bid], 'large');
          audioManager.playSfx('explosion');
          scene.shake(0.5);
          if (Health.current[bid] <= 0) {
            EventBus.emit('unit:died', { entityId: bid, killerEntity: eid });
          }
          // Saboteur is consumed
          Health.current[eid] = 0;
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
          if (sabOwner === 0) selectionPanel.addMessage('Saboteur detonated!', '#ff8800');
          else if (Owner.playerId[bid] === 0) selectionPanel.addMessage('Saboteur attack on base!', '#ff4444');
          break;
        }
      }
    }
  }

  /** Infiltrator: reveals stealthed enemies within blast radius, then suicide-attacks building */
  private updateInfiltrator(world: World, tickCount: number): void {
    if (tickCount % 10 !== 5) return;
    const { unitTypeNames, rules, combatSystem, effectsManager, audioManager, scene, selectionPanel } = this.deps;
    const infUnits = unitQuery(world);
    const infBlds = buildingQuery(world);
    for (const eid of infUnits) {
      if (Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? rules.units.get(typeName) : null;
      if (!def?.infiltrator) continue;
      const infOwner = Owner.playerId[eid];

      // Passive: reveal stealthed enemies within 10 tiles (persistent for 200 ticks)
      for (const other of infUnits) {
        if (Health.current[other] <= 0 || Owner.playerId[other] === infOwner) continue;
        const dx = Position.x[eid] - Position.x[other];
        const dz = Position.z[eid] - Position.z[other];
        if (dx * dx + dz * dz < 100) { // ~10 unit radius
          combatSystem.setStealthed(other, false);
          this.infiltratorRevealed.set(other, tickCount + 200);
        }
      }

      // Active: suicide on enemy building contact (like saboteur but full HP damage + destealths area)
      if (MoveTarget.active[eid] !== 1) continue;
      for (const bid of infBlds) {
        if (Health.current[bid] <= 0) continue;
        if (Owner.playerId[bid] === infOwner) continue;
        const dx = Position.x[eid] - Position.x[bid];
        const dz = Position.z[eid] - Position.z[bid];
        if (dx * dx + dz * dz < 9.0) {
          // Full HP damage to building
          const dmg = Health.max[bid];
          Health.current[bid] = Math.max(0, Health.current[bid] - dmg);
          effectsManager.spawnExplosion(Position.x[bid], 0, Position.z[bid], 'large');
          audioManager.playSfx('explosion');
          scene.shake(0.5);
          if (Health.current[bid] <= 0) {
            EventBus.emit('unit:died', { entityId: bid, killerEntity: eid });
          }
          // Destealth all enemies in radius
          for (const other of infUnits) {
            if (Owner.playerId[other] === infOwner || Health.current[other] <= 0) continue;
            const ox = Position.x[other] - Position.x[eid];
            const oz = Position.z[other] - Position.z[eid];
            if (ox * ox + oz * oz < 100) {
              combatSystem.setStealthed(other, false);
            }
          }
          Health.current[eid] = 0;
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
          if (infOwner === 0) selectionPanel.addMessage('Infiltrator deployed!', '#88aaff');
          else if (Owner.playerId[bid] === 0) selectionPanel.addMessage('Infiltrator attack on base!', '#ff4444');
          break;
        }
      }
    }
  }

  /** Leech: parasitizes enemy vehicles, drains HP over time, spawns new Leech when vehicle dies */
  private updateLeech(world: World, tickCount: number): void {
    if (tickCount % 15 !== 0) return;
    const { unitTypeNames, rules, combatSystem, selectionPanel, spawnUnit } = this.deps;
    const leechUnits = unitQuery(world);
    for (const eid of leechUnits) {
      if (Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? rules.units.get(typeName) : null;
      if (!def?.leech) continue;

      const leechOwner = Owner.playerId[eid];

      // Check if actively parasitizing (stored in leechTargets map)
      const parasiteTarget = this.leechTargets.get(eid);
      if (parasiteTarget !== undefined) {
        // Drain target vehicle
        if (Health.current[parasiteTarget] <= 0 || Position.x[parasiteTarget] < -900) {
          // Target died or gone - spawn a new Leech at target's position
          const tx = Position.x[parasiteTarget];
          const tz = Position.z[parasiteTarget];
          if (tx > -900) {
            spawnUnit(this.deps.getWorld(), typeName, leechOwner, tx + 2, tz + 2);
            if (leechOwner === 0) selectionPanel.addMessage('Leech replicated!', '#88ff44');
          }
          this.leechTargets.delete(eid);
          // Leech detaches and becomes active again
          Position.y[eid] = 0.1;
          continue;
        }
        // Drain 2% of target's max HP per tick
        const drainDmg = Health.max[parasiteTarget] * 0.02;
        Health.current[parasiteTarget] = Math.max(0, Health.current[parasiteTarget] - drainDmg);
        // Follow target position
        Position.x[eid] = Position.x[parasiteTarget];
        Position.z[eid] = Position.z[parasiteTarget];
        Position.y[eid] = 1.5; // Sit on top of vehicle
        if (Health.current[parasiteTarget] <= 0) {
          EventBus.emit('unit:died', { entityId: parasiteTarget, killerEntity: eid });
          // Spawn new Leech
          spawnUnit(this.deps.getWorld(), typeName, leechOwner,
            Position.x[parasiteTarget] + 2, Position.z[parasiteTarget] + 2);
          this.leechTargets.delete(eid);
          Position.y[eid] = 0.1;
          if (leechOwner === 0) selectionPanel.addMessage('Leech replicated!', '#88ff44');
          else if (Owner.playerId[parasiteTarget] === 0) selectionPanel.addMessage('Vehicle destroyed by Leech!', '#ff4444');
        }
        continue;
      }

      // Not parasitizing: look for nearby enemy vehicles to latch onto
      if (MoveTarget.active[eid] !== 1) continue; // Only while moving toward target
      for (const other of leechUnits) {
        if (other === eid || Health.current[other] <= 0) continue;
        if (Owner.playerId[other] === leechOwner) continue;
        // Must be a vehicle (not infantry, not flying)
        const otherTypeId = UnitType.id[other];
        const otherTypeName = unitTypeNames[otherTypeId];
        const otherDef = otherTypeName ? rules.units.get(otherTypeName) : null;
        if (!otherDef || otherDef.infantry || otherDef.canFly) continue;
        if (otherDef.cantBeLeeched || otherDef.leech) continue;
        const dx = Position.x[eid] - Position.x[other];
        const dz = Position.z[eid] - Position.z[other];
        if (dx * dx + dz * dz < 6.0) {
          // Latch on!
          this.leechTargets.set(eid, other);
          MoveTarget.active[eid] = 0;
          combatSystem.setSuppressed(eid, true);
          if (leechOwner === 0) selectionPanel.addMessage('Leech attached!', '#88ff44');
          else if (Owner.playerId[other] === 0) selectionPanel.addMessage('Leech on your vehicle!', '#ff4444');
          break;
        }
      }
    }
  }

  /** Projector: holograms decay over time */
  private updateProjectorDecay(world: World, tickCount: number): void {
    if (tickCount % 25 !== 12) return;
    const { unitRenderer } = this.deps;
    // Decay existing holograms
    for (const [hEid, ticksLeft] of this.projectorHolograms) {
      if (Health.current[hEid] <= 0) { this.projectorHolograms.delete(hEid); continue; }
      const remaining = ticksLeft - 25;
      if (remaining <= 0) {
        // Hologram expires
        Health.current[hEid] = 0;
        EventBus.emit('unit:died', { entityId: hEid, killerEntity: -1 });
        this.projectorHolograms.delete(hEid);
      } else {
        this.projectorHolograms.set(hEid, remaining);
        // Holograms flicker at low life
        if (remaining < 500) {
          const obj = unitRenderer.getEntityObject(hEid);
          if (obj) {
            const alpha = 0.3 + 0.4 * Math.sin(tickCount * 0.2);
            obj.traverse(child => {
              const mat = (child as any).material;
              if (mat) { mat.transparent = true; mat.opacity = alpha; }
            });
          }
        }
      }
    }
  }

  /** Kobra deployed state: immobilized but doubled range */
  private updateKobra(_world: World, tickCount: number): void {
    if (tickCount % 25 !== 0) return;
    for (const eid of this.kobraDeployed) {
      if (Health.current[eid] <= 0) { this.kobraDeployed.delete(eid); continue; }
      // Prevent movement while deployed
      MoveTarget.active[eid] = 0;
    }
  }

  /** NIAB Tank teleport cooldowns */
  private updateNiabCooldowns(_world: World, tickCount: number): void {
    if (tickCount % 25 !== 0 || this.niabCooldowns.size === 0) return;
    const { combatSystem } = this.deps;
    for (const [eid, ticks] of this.niabCooldowns) {
      if (Health.current[eid] <= 0) { this.niabCooldowns.delete(eid); continue; }
      const remaining = ticks - 25;
      if (remaining <= 0) {
        this.niabCooldowns.delete(eid);
        combatSystem.setSuppressed(eid, false);
      } else {
        this.niabCooldowns.set(eid, remaining);
      }
    }
  }

  /** Passive repair: idle units near friendly buildings heal slowly every 2 seconds */
  private updatePassiveRepair(world: World, tickCount: number): void {
    if (tickCount % 50 !== 0) return;
    const allUnits = unitQuery(world);
    const allBuildings = buildingQuery(world);
    for (const eid of allUnits) {
      if (Health.current[eid] <= 0) continue;
      if (Health.current[eid] >= Health.max[eid]) continue;
      // Only heal when idle (not moving, not attacking)
      if (MoveTarget.active[eid] === 1) continue;
      if (hasComponent(world, AttackTarget, eid) && AttackTarget.active[eid] === 1) continue;

      const owner = Owner.playerId[eid];
      const ux = Position.x[eid];
      const uz = Position.z[eid];

      // Check if near a friendly building (within 15 units)
      let nearBase = false;
      for (const bid of allBuildings) {
        if (Owner.playerId[bid] !== owner) continue;
        if (Health.current[bid] <= 0) continue;
        const dx = Position.x[bid] - ux;
        const dz = Position.z[bid] - uz;
        if (dx * dx + dz * dz < 225) { nearBase = true; break; }
      }
      if (nearBase) {
        Health.current[eid] = Math.min(Health.max[eid], Health.current[eid] + Health.max[eid] * 0.02);
      }
    }
  }

  /** Repair vehicles: units with repair flag heal nearby friendly units and buildings */
  private updateRepairVehicles(world: World, tickCount: number): void {
    if (tickCount % 25 !== 0) return;
    const { unitTypeNames, rules } = this.deps;
    const allUnits = unitQuery(world);
    for (const eid of allUnits) {
      if (Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const repDef = typeName ? rules.units.get(typeName) : null;
      if (!repDef?.repair) continue;

      const owner = Owner.playerId[eid];
      const rx = Position.x[eid];
      const rz = Position.z[eid];

      // Heal all friendly units within 8 units, 3% max HP per tick
      for (const other of allUnits) {
        if (other === eid) continue;
        if (Owner.playerId[other] !== owner) continue;
        if (Health.current[other] <= 0) continue;
        if (Health.current[other] >= Health.max[other]) continue;
        const dx = Position.x[other] - rx;
        const dz = Position.z[other] - rz;
        if (dx * dx + dz * dz < 64) { // 8 unit radius
          Health.current[other] = Math.min(Health.max[other],
            Health.current[other] + Health.max[other] * 0.03);
        }
      }

      // Also heal nearby buildings
      const nearBlds = buildingQuery(world);
      for (const bid of nearBlds) {
        if (Owner.playerId[bid] !== owner) continue;
        if (Health.current[bid] <= 0 || Health.current[bid] >= Health.max[bid]) continue;
        const dx = Position.x[bid] - rx;
        const dz = Position.z[bid] - rz;
        if (dx * dx + dz * dz < 64) {
          Health.current[bid] = Math.min(Health.max[bid],
            Health.current[bid] + Health.max[bid] * 0.02);
        }
      }
    }
  }

  /** Faction-specific bonuses (every 2 seconds) */
  private updateFactionBonuses(world: World, tickCount: number): void {
    if (tickCount % 50 !== 25) return;
    const allUnits = unitQuery(world);

    for (let pid = 0; pid <= 1; pid++) {
      const prefix = pid === 0 ? this.deps.housePrefix : this.deps.enemyPrefix;

      // ORDOS: self-regeneration (units slowly heal 1% HP per 2 seconds)
      if (prefix === 'OR') {
        for (const eid of allUnits) {
          if (Owner.playerId[eid] !== pid) continue;
          if (Health.current[eid] <= 0 || Health.current[eid] >= Health.max[eid]) continue;
          Health.current[eid] = Math.min(Health.max[eid],
            Health.current[eid] + Health.max[eid] * 0.01);
        }
      }

      // HARKONNEN: no damage degradation — implemented via combat system bonus
      // (In the real game, all units deal less damage as they lose HP. Harkonnen are exempt.
      //  Our implementation: Harkonnen get +10% damage at all times to represent this advantage.)
      // This is handled in the damage calculation below.
    }
  }

  // =========================================================================
  // KEY COMMAND HANDLERS
  // =========================================================================

  /** Self-destruct for Devastator units (X key) */
  private handleSelfDestruct(selected: number[], world: World): boolean {
    const { unitTypeNames, rules, effectsManager, audioManager, scene, selectionPanel } = this.deps;
    let handled = false;
    for (const eid of selected) {
      if (Owner.playerId[eid] !== 0) continue;
      if (Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? rules.units.get(typeName) : null;
      if (!def?.selfDestruct) continue;
      // Massive explosion
      const ex = Position.x[eid], ez = Position.z[eid];
      effectsManager.spawnExplosion(ex, 0, ez, 'large');
      effectsManager.spawnExplosion(ex + 2, 0, ez + 2, 'large');
      effectsManager.spawnExplosion(ex - 2, 0, ez - 2, 'large');
      audioManager.playSfx('explosion');
      selectionPanel.addMessage('SELF-DESTRUCT!', '#ff4444');
      scene.shake(0.8);
      // Damage all nearby units (friend and foe) in 12 unit radius
      const allUnits = unitQuery(world);
      const allBuildings = buildingQuery(world);
      const targets = [...allUnits, ...allBuildings];
      for (const tid of targets) {
        if (tid === eid) continue;
        if (Health.current[tid] <= 0) continue;
        const dx = Position.x[tid] - ex;
        const dz = Position.z[tid] - ez;
        const dist2 = dx * dx + dz * dz;
        if (dist2 < 144) { // 12 unit radius
          const dmg = Math.floor(1000 * (1 - Math.sqrt(dist2) / 12));
          Health.current[tid] = Math.max(0, Health.current[tid] - dmg);
          if (Health.current[tid] <= 0) {
            EventBus.emit('unit:died', { entityId: tid, killerEntity: eid });
          }
        }
      }
      // Kill the Devastator
      Health.current[eid] = 0;
      EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
      handled = true;
    }
    return handled;
  }

  /** MCV deploy or Kobra deploy/undeploy (D key) */
  private handleDeploy(selected: number[], world: World): boolean {
    const { unitTypeNames, rules, selectionPanel, audioManager, housePrefix } = this.deps;
    let handled = false;
    for (const eid of selected) {
      if (Owner.playerId[eid] !== 0) continue;
      if (Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? rules.units.get(typeName) : null;

      // MCV deployment
      if (typeName === 'MCV') {
        const conYardName = `${housePrefix}ConYard`;
        const bDef = rules.buildings.get(conYardName);
        if (!bDef) continue;
        const dx = Position.x[eid], dz = Position.z[eid];
        Health.current[eid] = 0;
        EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
        this.deps.spawnBuilding(world, conYardName, 0, dx, dz);
        selectionPanel.addMessage('MCV deployed!', '#44ff44');
        audioManager.playSfx('build');
        handled = true;
        break;
      }

      // Kobra deploy/undeploy toggle
      if (def?.kobra) {
        if (this.kobraDeployed.has(eid)) {
          // Undeploy: restore original range
          this.kobraDeployed.delete(eid);
          if (hasComponent(world, Combat, eid)) {
            const base = this.kobraBaseRange.get(eid) ?? Combat.attackRange[eid];
            Combat.attackRange[eid] = base;
          }
          this.kobraBaseRange.delete(eid);
          selectionPanel.addMessage('Kobra undeployed', '#aaa');
          audioManager.playSfx('build');
        } else {
          // Deploy: immobilize, double range (store base)
          if (hasComponent(world, Combat, eid)) {
            this.kobraBaseRange.set(eid, Combat.attackRange[eid]);
            Combat.attackRange[eid] = Combat.attackRange[eid] * 2;
          }
          this.kobraDeployed.add(eid);
          MoveTarget.active[eid] = 0;
          selectionPanel.addMessage('Kobra deployed - range doubled!', '#44ff44');
          audioManager.playSfx('build');
        }
        handled = true;
      }
    }
    return handled;
  }

  /** NIAB Tank teleport or Projector create hologram (T key) */
  private handleTeleportOrProjector(selected: number[], world: World): boolean {
    const { unitTypeNames, rules, selectionPanel, audioManager, commandManager, unitRenderer, spawnUnit } = this.deps;
    for (const eid of selected) {
      if (Owner.playerId[eid] !== 0) continue;
      if (Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? rules.units.get(typeName) : null;

      // NIAB Tank teleport: enter targeting mode
      if (def?.niabTank) {
        if (this.niabCooldowns.has(eid)) {
          selectionPanel.addMessage('Teleport on cooldown', '#ff8800');
          break;
        }
        // Enter teleport targeting mode
        commandManager.enterCommandMode('teleport', 'Click to teleport');
        break;
      }

      // Projector: create holographic copy of nearest friendly unit
      if (def?.projector) {
        // Find nearest friendly non-projector unit to copy
        const allUnits = unitQuery(world);
        let bestOther = -1;
        let bestDist = Infinity;
        for (const other of allUnits) {
          if (other === eid || Owner.playerId[other] !== 0) continue;
          if (Health.current[other] <= 0) continue;
          const otherTypeName = unitTypeNames[UnitType.id[other]];
          const otherDef = otherTypeName ? rules.units.get(otherTypeName) : null;
          if (otherDef?.projector) continue; // Can't copy another projector
          const dx = Position.x[other] - Position.x[eid];
          const dz = Position.z[other] - Position.z[eid];
          const dist = dx * dx + dz * dz;
          if (dist < 225 && dist < bestDist) { // Within 15 units
            bestDist = dist;
            bestOther = other;
          }
        }
        if (bestOther >= 0) {
          // Create holographic copy
          const copyTypeName = unitTypeNames[UnitType.id[bestOther]];
          if (copyTypeName) {
            const hx = Position.x[eid] + (Math.random() - 0.5) * 4;
            const hz = Position.z[eid] + (Math.random() - 0.5) * 4;
            const holoEid = spawnUnit(world, copyTypeName, 0, hx, hz);
            if (holoEid >= 0) {
              // Hologram: 1 HP, no damage, lasts 6000 ticks (~4 minutes)
              Health.max[holoEid] = 1;
              Health.current[holoEid] = 1;
              if (hasComponent(world, Combat, holoEid)) {
                (Combat as any).damage[holoEid] = 0; // Holograms can't deal damage
              }
              this.projectorHolograms.set(holoEid, 6000);
              // Make hologram slightly transparent
              const obj = unitRenderer.getEntityObject(holoEid);
              if (obj) {
                obj.traverse(child => {
                  const mat = (child as any).material;
                  if (mat) { mat.transparent = true; mat.opacity = 0.7; }
                });
              }
              selectionPanel.addMessage('Hologram created!', '#88aaff');
              audioManager.playSfx('select');
            }
          }
        } else {
          selectionPanel.addMessage('No unit nearby to copy', '#888');
        }
        break;
      }
    }
    return false; // T key doesn't prevent further handling in the original
  }

  /** Load infantry into selected APC (L key) */
  private handleLoadTransport(selected: number[], world: World): boolean {
    const { unitTypeNames, rules, selectionPanel, audioManager } = this.deps;
    let apcEid = -1;
    // Find the first selected APC
    for (const eid of selected) {
      if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
      const typeName = unitTypeNames[UnitType.id[eid]];
      const def = typeName ? rules.units.get(typeName) : null;
      if (def?.apc) { apcEid = eid; break; }
    }
    if (apcEid >= 0) {
      const ax = Position.x[apcEid], az = Position.z[apcEid];
      const allUnits = unitQuery(world);
      let loaded = 0;
      for (const eid of allUnits) {
        if (eid === apcEid) continue;
        if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
        if (Position.x[eid] < -900) continue; // Already loaded
        const dx = Position.x[eid] - ax;
        const dz = Position.z[eid] - az;
        if (dx * dx + dz * dz > 36) continue; // Within 6 units
        if (this.loadIntoTransport(apcEid, eid)) loaded++;
      }
      if (loaded > 0) {
        selectionPanel.addMessage(`Loaded ${loaded} infantry`, '#44ff44');
        audioManager.playSfx('select');
      } else {
        selectionPanel.addMessage('No infantry nearby to load', '#888');
      }
      return true;
    }
    return false;
  }

  /** Unload infantry from selected APC (U key) */
  private handleUnloadTransport(selected: number[], _world: World): boolean {
    const { selectionPanel, audioManager } = this.deps;
    let handled = false;
    for (const eid of selected) {
      if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
      const count = this.unloadTransport(eid);
      if (count > 0) {
        selectionPanel.addMessage(`Unloaded ${count} infantry`, '#44ff44');
        audioManager.playSfx('select');
        handled = true;
      }
    }
    return handled;
  }

  /** Mount/dismount sandworm for Fremen worm riders (W key) */
  private handleWormMount(selected: number[], _world: World): boolean {
    const { unitTypeNames, rules, sandwormSystem, selectionPanel, audioManager } = this.deps;
    let handled = false;
    for (const eid of selected) {
      if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
      const typeId = UnitType.id[eid];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? rules.units.get(typeName) : null;
      if (!def?.wormRider) continue;

      // Check if already mounted — dismount
      const riderWorm = sandwormSystem.getRiderWorm(eid);
      if (riderWorm) {
        sandwormSystem.dismountWorm(eid);
        selectionPanel.addMessage('Dismounted worm', '#aaa');
        audioManager.playSfx('select');
        handled = true;
        continue;
      }

      // Try to mount a nearby worm
      const mounted = sandwormSystem.mountWorm(
        eid, Position.x[eid], Position.z[eid], Owner.playerId[eid]
      );
      if (mounted) {
        selectionPanel.addMessage('Worm mounted!', '#f0c040');
        audioManager.playSfx('move');
        handled = true;
      } else {
        selectionPanel.addMessage('No worm nearby to mount', '#888');
      }
    }
    return handled;
  }

  // =========================================================================
  // COMBAT HIT HANDLERS
  // =========================================================================

  /** Deviator conversion: if attacker is a deviator, convert target temporarily */
  private handleDeviatorHit(attackerEntity: number, targetEntity: number): void {
    const { unitTypeNames, rules, selectionPanel } = this.deps;
    const atTypeId = UnitType.id[attackerEntity];
    const atName = unitTypeNames[atTypeId];
    const atDef = atName ? rules.units.get(atName) : null;
    if (atDef?.deviator && Health.current[targetEntity] > 0) {
      const tgtDef = unitTypeNames[UnitType.id[targetEntity]] ? rules.units.get(unitTypeNames[UnitType.id[targetEntity]]) : null;
      if (tgtDef?.canBeDeviated !== false) {
        const attackerOwner = Owner.playerId[attackerEntity];
        const originalOwner = Owner.playerId[targetEntity];
        if (originalOwner !== attackerOwner) {
          // Store original owner for revert
          if (!this.deviatedUnits.has(targetEntity)) {
            this.deviatedUnits.set(targetEntity, { originalOwner, revertTick: this.deps.getTickCount() + 400 });
          }
          Owner.playerId[targetEntity] = attackerOwner;
          if (attackerOwner === 0) selectionPanel.addMessage('Unit deviated!', '#cc44ff');
          else if (originalOwner === 0) selectionPanel.addMessage('Unit mind-controlled!', '#ff4444');
        }
      }
    }
  }

  /** Contaminator replication: Contaminator kills infantry and spawns a new Contaminator */
  private handleContaminatorHit(attackerEntity: number, targetEntity: number): void {
    const { unitTypeNames, rules, selectionPanel, spawnUnit } = this.deps;
    const atName2 = unitTypeNames[UnitType.id[attackerEntity]];
    if (atName2?.includes('Contaminator')) {
      const tgtTypeId = UnitType.id[targetEntity];
      const tgtName = unitTypeNames[tgtTypeId];
      const tgtDef = tgtName ? rules.units.get(tgtName) : null;
      if (tgtDef?.infantry && Health.current[targetEntity] > 0) {
        const attackerOwner = Owner.playerId[attackerEntity];
        const tgtOwner = Owner.playerId[targetEntity];
        if (tgtOwner !== attackerOwner) {
          // Kill the target
          Health.current[targetEntity] = 0;
          EventBus.emit('unit:died', { entityId: targetEntity, killerEntity: attackerEntity });
          // Spawn a new Contaminator at the target's position
          const cx = Position.x[targetEntity];
          const cz = Position.z[targetEntity];
          spawnUnit(this.deps.getWorld(), atName2, attackerOwner, cx, cz);
          if (attackerOwner === 0) selectionPanel.addMessage('Infantry contaminated!', '#88ff44');
          else if (tgtOwner === 0) selectionPanel.addMessage('Unit contaminated by enemy!', '#ff4444');
        }
      }
    }
  }

  // =========================================================================
  // TRANSPORT HELPERS
  // =========================================================================

  loadIntoTransport(transportEid: number, infantryEid: number): boolean {
    const { unitTypeNames, rules } = this.deps;
    const typeName = unitTypeNames[UnitType.id[transportEid]];
    const def = typeName ? rules.units.get(typeName) : null;
    if (!def?.apc) return false;
    const passengers = this.transportPassengers.get(transportEid) ?? [];
    if (passengers.length >= def.passengerCapacity) return false;
    // Only infantry can board
    const infTypeName = unitTypeNames[UnitType.id[infantryEid]];
    const infDef = infTypeName ? rules.units.get(infTypeName) : null;
    if (!infDef?.infantry) return false;
    // Must be same owner
    if (Owner.playerId[infantryEid] !== Owner.playerId[transportEid]) return false;

    passengers.push(infantryEid);
    this.transportPassengers.set(transportEid, passengers);
    // Hide the passenger: move off-map, stop movement
    Position.x[infantryEid] = -999;
    Position.z[infantryEid] = -999;
    Position.y[infantryEid] = -999;
    MoveTarget.active[infantryEid] = 0;
    AttackTarget.active[infantryEid] = 0;
    return true;
  }

  unloadTransport(transportEid: number): number {
    const passengers = this.transportPassengers.get(transportEid);
    if (!passengers || passengers.length === 0) return 0;
    const tx = Position.x[transportEid];
    const tz = Position.z[transportEid];
    let unloaded = 0;
    for (let i = 0; i < passengers.length; i++) {
      const pEid = passengers[i];
      if (Health.current[pEid] <= 0) continue;
      // Place in a circle around the transport
      const angle = (i / passengers.length) * Math.PI * 2;
      Position.x[pEid] = tx + Math.cos(angle) * 3;
      Position.z[pEid] = tz + Math.sin(angle) * 3;
      Position.y[pEid] = 0.1;
      MoveTarget.active[pEid] = 0;
      unloaded++;
    }
    this.transportPassengers.delete(transportEid);
    return unloaded;
  }

  killPassengers(transportEid: number): void {
    const passengers = this.transportPassengers.get(transportEid);
    if (!passengers) return;
    for (const pEid of passengers) {
      if (Health.current[pEid] <= 0) continue;
      Health.current[pEid] = 0;
      EventBus.emit('unit:died', { entityId: pEid, killerEntity: -1 });
    }
    this.transportPassengers.delete(transportEid);
  }
}
