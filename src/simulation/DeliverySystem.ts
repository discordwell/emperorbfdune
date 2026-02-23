/**
 * DeliverySystem - Manages animated Carryall delivery sequences for the
 * .tok script functions CarryAllDelivery, Delivery, StarportDelivery, and
 * BuildObject.
 *
 * Instead of instantly spawning units at the destination, the system:
 *  1. Creates a temporary Carryall entity at a map entrance point.
 *  2. Flies the Carryall to the delivery position (using the flying movement system).
 *  3. When the Carryall arrives, spawns the delivered unit(s) at the position.
 *  4. Flies the Carryall back to the entrance and despawns it.
 *
 * For StarportDelivery, units descend from above at the starport pad
 * (re-using the existing descendingUnits animation).
 *
 * For BuildObject, queues production via the ProductionSystem when possible,
 * falling back to instant spawn for scripted AI sides that lack production
 * buildings.
 */

import type { GameContext } from '../core/GameContext';
import {
  Position, Health, Owner, MoveTarget, Rotation, Speed, Velocity,
  Renderable, UnitType, ViewRange,
  addEntity, addComponent, removeEntity, hasComponent,
} from '../core/ECS';
import { distance2D, angleBetween } from '../utils/MathUtils';

// Delivery phase state machine
const enum Phase {
  FlyingIn = 0,    // Carryall flying towards delivery position
  Hovering = 1,    // Carryall hovering over delivery position (short pause)
  Dropping = 2,    // Spawning units + brief visual pause
  FlyingOut = 3,   // Carryall flying back to entrance
}

// Timing constants (in simulation ticks at 25 tps)
const HOVER_TICKS = 15;     // ~0.6s hover before drop
const DROP_TICKS = 10;      // ~0.4s drop animation time
const CARRYALL_SPEED = 0.6; // World units per tick (faster than normal units)
const ARRIVAL_THRESHOLD = 3.0;
const FLIGHT_ALTITUDE = 5.0;

export interface DeliveryRequest {
  /** Side (player ID) receiving the delivery */
  side: number;
  /** Type names to spawn */
  typeNames: string[];
  /** Destination position in world coordinates */
  destX: number;
  destZ: number;
  /** Entrance position in world coordinates (where the Carryall spawns/exits) */
  entranceX: number;
  entranceZ: number;
  /** Kind of delivery for choosing visuals and behaviour */
  kind: 'carryall' | 'starport';
  /** Callback when units are actually spawned (for script event tracking) */
  onSpawned?: (spawnedEids: number[]) => void;
}

interface ActiveDelivery {
  request: DeliveryRequest;
  carryallEid: number;
  phase: Phase;
  phaseTicks: number;
  spawnedEids: number[];
}

export class DeliverySystem {
  private deliveries: ActiveDelivery[] = [];
  // House prefix mapping: playerId -> house prefix for selecting the correct Carryall model
  private housePrefixes = new Map<number, string>();

  /** Set house prefix for a player (e.g., 'AT', 'HK', 'OR') for model selection. */
  setHousePrefix(playerId: number, prefix: string): void {
    this.housePrefixes.set(playerId, prefix);
  }

  /**
   * Queue a new delivery animation.
   * Returns immediately; the actual unit spawn happens when the Carryall arrives.
   */
  queueDelivery(ctx: GameContext, request: DeliveryRequest): void {
    const world = ctx.game.getWorld();

    // Create the temporary Carryall entity
    const eid = addEntity(world);
    addComponent(world, Position, eid);
    addComponent(world, Velocity, eid);
    addComponent(world, Rotation, eid);
    addComponent(world, Speed, eid);
    addComponent(world, MoveTarget, eid);
    addComponent(world, Health, eid);
    addComponent(world, Owner, eid);
    addComponent(world, UnitType, eid);
    addComponent(world, Renderable, eid);
    addComponent(world, ViewRange, eid);

    // Set initial position at entrance
    Position.x[eid] = request.entranceX;
    Position.y[eid] = FLIGHT_ALTITUDE;
    Position.z[eid] = request.entranceZ;

    // Face towards destination
    Rotation.y[eid] = angleBetween(
      request.entranceX, request.entranceZ,
      request.destX, request.destZ,
    );

    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
    Velocity.z[eid] = 0;
    Speed.max[eid] = CARRYALL_SPEED;
    Speed.turnRate[eid] = 0.15;
    Speed.acceleration[eid] = 0; // Carryalls: instant speed (delivery entities)
    Speed.current[eid] = CARRYALL_SPEED;

    Health.current[eid] = 9999;
    Health.max[eid] = 9999;
    Owner.playerId[eid] = request.side;

    // Use the generic Carryall unit type ID if available, else 0
    const carryallTypeId = ctx.typeRegistry.unitTypeIdMap.get('Carryall') ?? 0;
    UnitType.id[eid] = carryallTypeId;

    Renderable.modelId[eid] = carryallTypeId;
    Renderable.sceneIndex[eid] = -1;
    ViewRange.range[eid] = 0; // Temporary entity, no vision

    // Register as flying entity so MovementSystem handles it properly
    ctx.movement.registerFlyer(eid);

    // Set move target to the delivery destination
    MoveTarget.x[eid] = request.destX;
    MoveTarget.z[eid] = request.destZ;
    MoveTarget.active[eid] = 1;

    // Set the visual model: pick house-specific Carryall model
    const prefix = this.getCarryallPrefix(request.side);
    const xafName = `${prefix}_Carryall`;
    ctx.unitRenderer.setEntityModel(eid, xafName);

    this.deliveries.push({
      request,
      carryallEid: eid,
      phase: Phase.FlyingIn,
      phaseTicks: 0,
      spawnedEids: [],
    });
  }

  /**
   * Tick the delivery system. Call once per simulation tick.
   */
  update(ctx: GameContext): void {
    const world = ctx.game.getWorld();

    for (let i = this.deliveries.length - 1; i >= 0; i--) {
      const d = this.deliveries[i];

      // Guard: if the carryall entity was somehow killed, clean up
      if (!hasComponent(world, Position, d.carryallEid) ||
          Health.current[d.carryallEid] <= 0) {
        this.cleanupDelivery(ctx, d);
        this.deliveries.splice(i, 1);
        continue;
      }

      d.phaseTicks++;

      switch (d.phase) {
        case Phase.FlyingIn:
          this.tickFlyingIn(ctx, d);
          break;
        case Phase.Hovering:
          this.tickHovering(ctx, d);
          break;
        case Phase.Dropping:
          this.tickDropping(ctx, d);
          break;
        case Phase.FlyingOut:
          this.tickFlyingOut(ctx, d, i);
          break;
      }
    }
  }

  /** Get the number of active deliveries (for debugging/UI). */
  getActiveCount(): number {
    return this.deliveries.length;
  }

  /** Check if there are active deliveries for serialization awareness. */
  hasActiveDeliveries(): boolean {
    return this.deliveries.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Phase handlers
  // ---------------------------------------------------------------------------

  private tickFlyingIn(ctx: GameContext, d: ActiveDelivery): void {
    // MovementSystem handles the actual flying movement.
    // We just check if the Carryall has arrived at the destination.
    const cx = Position.x[d.carryallEid];
    const cz = Position.z[d.carryallEid];
    const dist = distance2D(cx, cz, d.request.destX, d.request.destZ);

    if (dist < ARRIVAL_THRESHOLD || MoveTarget.active[d.carryallEid] === 0) {
      // Arrived at delivery position - transition to hovering
      MoveTarget.active[d.carryallEid] = 0;
      Velocity.x[d.carryallEid] = 0;
      Velocity.z[d.carryallEid] = 0;

      // Snap to delivery position
      Position.x[d.carryallEid] = d.request.destX;
      Position.z[d.carryallEid] = d.request.destZ;
      Position.y[d.carryallEid] = FLIGHT_ALTITUDE;

      d.phase = Phase.Hovering;
      d.phaseTicks = 0;
    }
  }

  private tickHovering(_ctx: GameContext, d: ActiveDelivery): void {
    // Keep the Carryall stationary for a brief hover
    Velocity.x[d.carryallEid] = 0;
    Velocity.z[d.carryallEid] = 0;
    Position.y[d.carryallEid] = FLIGHT_ALTITUDE;

    if (d.phaseTicks >= HOVER_TICKS) {
      d.phase = Phase.Dropping;
      d.phaseTicks = 0;
    }
  }

  private tickDropping(ctx: GameContext, d: ActiveDelivery): void {
    // On the first tick of the drop phase, spawn the actual units
    if (d.phaseTicks === 1) {
      this.spawnDeliveredUnits(ctx, d);
    }

    // Keep hovering during the drop
    Velocity.x[d.carryallEid] = 0;
    Velocity.z[d.carryallEid] = 0;
    Position.y[d.carryallEid] = FLIGHT_ALTITUDE;

    if (d.phaseTicks >= DROP_TICKS) {
      // Start flying back to entrance
      MoveTarget.x[d.carryallEid] = d.request.entranceX;
      MoveTarget.z[d.carryallEid] = d.request.entranceZ;
      MoveTarget.active[d.carryallEid] = 1;

      d.phase = Phase.FlyingOut;
      d.phaseTicks = 0;
    }
  }

  private tickFlyingOut(ctx: GameContext, d: ActiveDelivery, index: number): void {
    const cx = Position.x[d.carryallEid];
    const cz = Position.z[d.carryallEid];
    const dist = distance2D(cx, cz, d.request.entranceX, d.request.entranceZ);

    if (dist < ARRIVAL_THRESHOLD || MoveTarget.active[d.carryallEid] === 0) {
      // Arrived back at entrance - despawn and clean up
      this.cleanupDelivery(ctx, d);
      this.deliveries.splice(index, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Unit spawning
  // ---------------------------------------------------------------------------

  private spawnDeliveredUnits(ctx: GameContext, d: ActiveDelivery): void {
    const world = ctx.game.getWorld();
    const req = d.request;
    const spawnedEids: number[] = [];

    for (let i = 0; i < req.typeNames.length; i++) {
      const typeName = req.typeNames[i];

      // Spread units around the drop point to prevent stacking
      const offset = this.getSpreadOffset(i, req.typeNames.length);
      const sx = req.destX + offset.x;
      const sz = req.destZ + offset.z;

      const isBuilding = ctx.typeRegistry.buildingTypeIdMap.has(typeName);
      let eid: number;

      if (isBuilding) {
        eid = ctx.spawnBuilding(world, typeName, req.side, sx, sz);
      } else {
        eid = ctx.spawnUnit(world, typeName, req.side, sx, sz);
      }

      if (eid >= 0) {
        spawnedEids.push(eid);

        if (req.kind === 'starport') {
          // Starport delivery: add descent animation (units drop from above)
          Position.y[eid] = 10;
          MoveTarget.active[eid] = 0;
          ctx.combatSystem.setSuppressed(eid, true);
          ctx.descendingUnits.set(eid, {
            startTick: ctx.game.getTickCount(),
            duration: 20,
          });
        } else {
          // Carryall delivery: brief descent from carryall altitude
          Position.y[eid] = FLIGHT_ALTITUDE - 1;
          ctx.descendingUnits.set(eid, {
            startTick: ctx.game.getTickCount(),
            duration: 12,
          });
        }

        // Small dust/landing effect
        ctx.effectsManager.spawnExplosion(sx, 0.5, sz, 'small');
      }
    }

    d.spawnedEids = spawnedEids;

    // Notify the callback (used by TokFunctions for script event tracking)
    if (req.onSpawned) {
      req.onSpawned(spawnedEids);
    }
  }

  /**
   * Calculate a spread offset for multiple units being dropped at once
   * to prevent them from stacking on top of each other.
   */
  private getSpreadOffset(index: number, total: number): { x: number; z: number } {
    if (total <= 1) return { x: 0, z: 0 };

    const radius = 2.5;
    const angle = (index / total) * Math.PI * 2;
    return {
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
    };
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  private cleanupDelivery(ctx: GameContext, d: ActiveDelivery): void {
    const world = ctx.game.getWorld();
    const eid = d.carryallEid;

    // Unregister from movement system
    ctx.movement.unregisterFlyer(eid);
    ctx.movement.unregisterEntity(eid);

    // Remove entity from ECS
    try {
      if (hasComponent(world, Position, eid)) {
        removeEntity(world, eid);
      }
    } catch {
      // Entity may already have been removed
    }
  }

  // ---------------------------------------------------------------------------
  // House prefix resolution
  // ---------------------------------------------------------------------------

  private getCarryallPrefix(side: number): string {
    const prefix = this.housePrefixes.get(side);
    if (prefix) return prefix;

    // Fallback: use generic Carryall model prefix
    // The generic Carryall uses 'G_Carryall' in the asset files
    return 'G';
  }
}
