/**
 * Mission script runtime engine.
 *
 * Manages the lifecycle of a declarative mission script:
 * initialization, per-tick evaluation, event handling, and save/load.
 */

import type {
  MissionScript, ScriptRule, EntityGroupDef,
  MissionScriptState, Trigger,
} from './MissionScriptTypes';
import type { GameContext } from '../../core/GameContext';
import { EntityGroupTracker } from './EntityGroupTracker';
import { evaluateTrigger, type TriggerContext } from './TriggerEvaluator';
import { executeAction, type ActionContext } from './ActionExecutor';
import { EventBus } from '../../core/EventBus';

export class MissionScriptRunner {
  private script: MissionScript | null = null;
  private rules: ScriptRule[] = [];
  private groupDefs = new Map<string, EntityGroupDef>();
  private groups = new EntityGroupTracker();
  private flags = new Map<string, boolean>();
  private firedRules = new Set<string>();
  private disabledRules = new Set<string>();
  private repeatCounts = new Map<string, number>();
  private lastEventData = new Map<string, any>();
  private pendingDelayed: Array<{ ruleId: string; executeTick: number }> = [];
  private eventListeners: Array<{ event: string; callback: (data: any) => void }> = [];
  private initialized = false;

  /**
   * Initialize the runner with a script and game context.
   * @param skipGameSetup If true, only loads script structure (for save/load).
   */
  init(ctx: GameContext, script: MissionScript, skipGameSetup = false): void {
    this.script = script;
    this.rules = script.rules;
    this.initialized = true;

    // Index group definitions
    for (const gd of script.entityGroups) {
      this.groupDefs.set(gd.name, gd);
    }

    // Initialize flags
    if (script.flags) {
      for (const [key, value] of Object.entries(script.flags)) {
        this.flags.set(key, value);
      }
    }

    // Set initial disabled rules
    for (const rule of this.rules) {
      if (rule.enabled === false) {
        this.disabledRules.add(rule.id);
      }
    }

    // Register event listeners for event-based triggers
    this.registerEventListeners();

    if (skipGameSetup) return;

    // Set victory condition
    ctx.victorySystem.setVictoryCondition(script.victoryCondition as any);
    if (script.victoryTicks) {
      ctx.victorySystem.setSurvivalTicks(script.victoryTicks);
    }
    ctx.victorySystem.setObjectiveLabel(script.objectiveLabel);

    // Set starting credits
    if (script.startingCredits !== undefined) {
      const current = ctx.harvestSystem.getSolaris(0);
      ctx.harvestSystem.addSolaris(0, script.startingCredits - current);
    }

    // Match existing entity groups at startup
    for (const gd of script.entityGroups) {
      if (gd.matchExisting) {
        this.spawnOrMatchGroup(gd, ctx);
      }
    }
  }

  /** Process one game tick. */
  tick(ctx: GameContext, currentTick: number): void {
    if (!this.initialized || !this.script) return;

    const tctx: TriggerContext = {
      ctx,
      currentTick,
      groups: this.groups,
      flags: this.flags,
      firedRules: this.firedRules,
      repeatCounts: this.repeatCounts,
      lastEventData: this.lastEventData,
    };

    const actx = this.buildActionContext(ctx);

    // Evaluate rules
    for (const rule of this.rules) {
      // Skip disabled rules
      if (this.disabledRules.has(rule.id)) continue;

      // Skip one-shot rules that already fired
      const once = rule.once !== false; // default true
      if (once && this.firedRules.has(rule.id)) continue;

      // Check repeat limit for timerRepeat
      if (rule.trigger.type === 'timerRepeat' && rule.trigger.limit !== undefined) {
        const count = this.repeatCounts.get(rule.id) ?? 0;
        if (count >= rule.trigger.limit) continue;
      }

      // Evaluate trigger
      if (evaluateTrigger(rule.trigger, tctx)) {
        if (once) {
          this.firedRules.add(rule.id);
        }

        // Track repeat count for non-once rules
        if (!once) {
          const rc = this.repeatCounts.get(rule.id) ?? 0;
          this.repeatCounts.set(rule.id, rc + 1);
        }

        if (rule.delay && rule.delay > 0) {
          // Queue for delayed execution
          this.pendingDelayed.push({
            ruleId: rule.id,
            executeTick: currentTick + rule.delay,
          });
        } else {
          // Execute immediately
          for (const action of rule.actions) {
            executeAction(action, actx);
          }
        }
      }
    }

    // Process delayed actions
    for (let i = this.pendingDelayed.length - 1; i >= 0; i--) {
      const pending = this.pendingDelayed[i];
      if (currentTick >= pending.executeTick) {
        // Find the rule to get its actions
        const rule = this.rules.find(r => r.id === pending.ruleId);
        if (rule) {
          for (const action of rule.actions) {
            executeAction(action, actx);
          }
        }
        this.pendingDelayed.splice(i, 1);
      }
    }

    // Clear event data after processing (events are per-tick)
    this.lastEventData.clear();
  }

  /** Handle an EventBus event. */
  handleEvent(event: string, data: any): void {
    this.lastEventData.set(event, data);
  }

  /**
   * Serialize current state for save/load.
   * @param eidToIndex Maps entity IDs to save-array indices for correct remapping.
   */
  serialize(eidToIndex: Map<number, number>): MissionScriptState {
    // Convert group entity IDs to save-array indices
    const rawGroups = this.groups.serialize();
    const indexedGroups: Record<string, number[]> = {};
    for (const [name, eids] of Object.entries(rawGroups)) {
      indexedGroups[name] = eids
        .map(eid => eidToIndex.get(eid))
        .filter((idx): idx is number => idx !== undefined);
    }

    return {
      firedRuleIds: [...this.firedRules],
      flags: Object.fromEntries(this.flags),
      groupEntities: indexedGroups,
      disabledRules: [...this.disabledRules],
      repeatCounts: Object.fromEntries(this.repeatCounts),
      pendingDelayed: this.pendingDelayed.map(p => ({
        ruleId: p.ruleId,
        executeTick: p.executeTick,
      })),
    };
  }

  /** Restore state from save data. */
  restore(state: MissionScriptState, indexToEid: Map<number, number>): void {
    this.firedRules = new Set(state.firedRuleIds);
    this.flags = new Map(Object.entries(state.flags));
    this.disabledRules = new Set(state.disabledRules);
    this.repeatCounts = new Map(Object.entries(state.repeatCounts));

    // Remap save-array indices back to entity IDs
    const remappedGroups: Record<string, number[]> = {};
    for (const [name, indices] of Object.entries(state.groupEntities)) {
      remappedGroups[name] = indices
        .map(idx => indexToEid.get(idx))
        .filter((eid): eid is number => eid !== undefined);
    }
    this.groups.restore(remappedGroups);

    // Restore pending delayed actions
    if (state.pendingDelayed) {
      this.pendingDelayed = state.pendingDelayed.map(p => ({
        ruleId: p.ruleId,
        executeTick: p.executeTick,
      }));
    }
  }

  /** Whether a script is loaded and running. */
  isActive(): boolean {
    return this.initialized && this.script !== null;
  }

  /** Get the loaded script ID. */
  getScriptId(): string | null {
    return this.script?.id ?? null;
  }

  /** Get the group tracker (for integration/inspection). */
  getGroups(): EntityGroupTracker {
    return this.groups;
  }

  /** Clean up event listeners and all state. */
  dispose(): void {
    for (const { event, callback } of this.eventListeners) {
      EventBus.off(event as any, callback);
    }
    this.eventListeners = [];
    this.initialized = false;
    this.script = null;
    this.rules = [];
    this.groupDefs.clear();
    this.groups.clear();
    this.flags.clear();
    this.firedRules.clear();
    this.disabledRules.clear();
    this.repeatCounts.clear();
    this.lastEventData.clear();
    this.pendingDelayed = [];
  }

  private buildActionContext(ctx: GameContext): ActionContext {
    return {
      ctx,
      groups: this.groups,
      flags: this.flags,
      disabledRules: this.disabledRules,
      groupDefs: this.groupDefs,
    };
  }

  private registerEventListeners(): void {
    // Collect all event names used in triggers
    const eventNames = new Set<string>();
    for (const rule of this.rules) {
      this.collectEventNames(rule.trigger, eventNames);
    }

    // Register listeners
    for (const eventName of eventNames) {
      const callback = (data: any) => this.handleEvent(eventName, data);
      EventBus.on(eventName as any, callback);
      this.eventListeners.push({ event: eventName, callback });
    }
  }

  private collectEventNames(trigger: Trigger, out: Set<string>): void {
    switch (trigger.type) {
      case 'event':
        out.add(trigger.event);
        break;
      case 'and':
        for (const t of trigger.triggers) this.collectEventNames(t, out);
        break;
      case 'or':
        for (const t of trigger.triggers) this.collectEventNames(t, out);
        break;
      case 'not':
        this.collectEventNames(trigger.trigger, out);
        break;
    }
  }

  private spawnOrMatchGroup(def: EntityGroupDef, ctx: GameContext): void {
    const actx = this.buildActionContext(ctx);
    executeAction({ type: 'spawnGroup', group: def.name }, actx);
  }
}
