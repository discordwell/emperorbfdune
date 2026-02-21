/**
 * Main .tok bytecode interpreter.
 *
 * Implements the same lifecycle as MissionScriptRunner:
 *   - init() — Parse .tok binary, build string table, init variables
 *   - tick() — Evaluate all conditional blocks
 *   - serialize() / restore() — Save/load state
 *   - dispose() — Cleanup
 *
 * Can be assigned to ctx.missionScriptRunner (duck-typed).
 */

import type { TokProgram } from './TokTypes';
import type { GameContext } from '../../../core/GameContext';
import type { MissionScriptState } from '../MissionScriptTypes';
import { parseTokFile } from './TokParser';
import { TokEvaluator } from './TokEvaluator';
import { TokFunctionDispatch } from './TokFunctions';
import { buildStringTable } from './TokStringTable';
import { EventBus } from '../../../core/EventBus';
import { hasComponent, Owner } from '../../../core/ECS';

export class TokInterpreter {
  private program: TokProgram = [];
  private evaluator = new TokEvaluator();
  private functions = new TokFunctionDispatch();
  private initialized = false;
  private scriptId = '';
  private eventListeners: Array<{ event: string; callback: (data: any) => void }> = [];

  init(ctx: GameContext, tokBuffer: ArrayBuffer, scriptId: string): void {
    this.scriptId = scriptId;

    // Build string table from type registry
    const stringTable = buildStringTable(ctx.typeRegistry);
    this.functions.setStringTable(stringTable);

    // Parse the .tok binary
    const { program, varDecls, varSlotCount } = parseTokFile(tokBuffer);
    this.program = program;

    // Initialize variable slots
    this.evaluator.initVars(varDecls, varSlotCount);

    // Register event listeners for event tracking
    this.registerEventListeners(ctx);

    this.initialized = true;

    console.log(`[Tok] Loaded ${scriptId}: ${program.length} blocks, ${varSlotCount} var slots, ${stringTable.length} string table entries`);
  }

  tick(ctx: GameContext, currentTick: number): void {
    if (!this.initialized) return;

    // Evaluate all blocks (events accumulated since last tick are visible)
    this.evaluator.tick(this.program, ctx, this.functions, currentTick);

    // Clear event flags AFTER evaluation so events from the simulation
    // step (which runs before tick) are visible to the script
    this.evaluator.events.clear();
  }

  isActive(): boolean {
    return this.initialized;
  }

  getScriptId(): string | null {
    return this.scriptId || null;
  }

  /**
   * Serialize state for save/load.
   * Returns in MissionScriptState shape for compatibility with save system.
   */
  serialize(eidToIndex: Map<number, number>): MissionScriptState {
    const tokState = this.evaluator.serialize(eidToIndex);
    return {
      firedRuleIds: [],
      flags: {},
      groupEntities: {},
      disabledRules: [],
      repeatCounts: {},
      pendingDelayed: [],
      tokState,
    };
  }

  /**
   * Restore state from save data.
   */
  restore(state: MissionScriptState, indexToEid: Map<number, number>): void {
    if (state.tokState) {
      this.evaluator.restore(state.tokState, indexToEid);
    }
  }

  /** Get the relationship manager for combat system integration. */
  getSideManager() {
    return this.evaluator.sides;
  }

  dispose(): void {
    for (const { event, callback } of this.eventListeners) {
      EventBus.off(event as any, callback);
    }
    this.eventListeners = [];
    this.initialized = false;
    this.program = [];
    this.scriptId = '';
  }

  private registerEventListeners(ctx: GameContext): void {
    // Track unit deaths for EventObjectDestroyed
    const onDied = (data: { entityId: number; killerEntity: number }) => {
      this.evaluator.events.objectDestroyed(data.entityId);

      // Track side-attacks-side if killed by another entity
      if (data.killerEntity >= 0) {
        const w = ctx.game.getWorld();
        if (hasComponent(w, Owner, data.killerEntity) && hasComponent(w, Owner, data.entityId)) {
          const attackerSide = Owner.playerId[data.killerEntity];
          const victimSide = Owner.playerId[data.entityId];
          if (attackerSide !== victimSide) {
            this.evaluator.events.sideAttacksSide(attackerSide, victimSide);
          }
        }
      }
    };
    EventBus.on('unit:died', onDied);
    this.eventListeners.push({ event: 'unit:died', callback: onDied });

    // Track attacks for EventSideAttacksSide
    const onAttack = (data: { attackerEid: number; targetEid: number }) => {
      const w = ctx.game.getWorld();
      if (hasComponent(w, Owner, data.attackerEid) && hasComponent(w, Owner, data.targetEid)) {
        const attackerSide = Owner.playerId[data.attackerEid];
        const targetSide = Owner.playerId[data.targetEid];
        if (attackerSide !== targetSide) {
          this.evaluator.events.sideAttacksSide(attackerSide, targetSide);
          this.evaluator.events.objectAttacksSide(data.attackerEid, targetSide);
        }
      }
    };
    EventBus.on('unit:attacked', onAttack);
    this.eventListeners.push({ event: 'unit:attacked', callback: onAttack });

    // Track building construction for EventObjectConstructed
    const onBuilt = (data: { entityId: number; playerId: number; typeName?: string }) => {
      this.evaluator.events.objectConstructed(data.playerId, data.entityId);
      if (data.typeName) {
        this.evaluator.events.objectTypeConstructed(data.playerId, data.typeName);
      }
    };
    EventBus.on('building:completed' as any, onBuilt);
    this.eventListeners.push({ event: 'building:completed', callback: onBuilt });
  }
}
