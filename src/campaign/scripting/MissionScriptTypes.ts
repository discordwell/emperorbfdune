/**
 * Declarative mission scripting types.
 *
 * Missions are authored as JSON files with trigger-action rules.
 * The MissionScriptRunner evaluates triggers each tick and fires actions.
 */

// ── Entity Groups ─────────────────────────────────────────────────

/** A named group of entities tracked by the script. */
export interface EntityGroupDef {
  name: string;
  spawnAt?: { x: number; z: number };
  units?: Array<{ type: string; count: number; owner: number }>;
  buildings?: Array<{ type: string; owner: number }>;
  /** Match existing entities on the map instead of spawning new ones. */
  matchExisting?: {
    owner: number;
    unitType?: string;
    buildingType?: string;
    near?: { x: number; z: number; radius: number };
  };
}

// ── Triggers ──────────────────────────────────────────────────────

export type Trigger =
  | { type: 'timer'; tick: number }
  | { type: 'timerRepeat'; interval: number; start?: number; limit?: number }
  | { type: 'event'; event: string; filter?: Record<string, any> }
  | { type: 'groupDefeated'; group: string }
  | { type: 'groupReachedArea'; group: string; area: { x: number; z: number; radius: number } }
  | { type: 'buildingCount'; owner: number; typeName?: string; comparison: '<' | '<=' | '==' | '>=' | '>'; value: number }
  | { type: 'unitCount'; owner: number; typeName?: string; comparison: '<' | '<=' | '==' | '>=' | '>'; value: number }
  | { type: 'flag'; name: string; value?: boolean }
  | { type: 'and'; triggers: Trigger[] }
  | { type: 'or'; triggers: Trigger[] }
  | { type: 'not'; trigger: Trigger };

// ── Actions ───────────────────────────────────────────────────────

export type Action =
  | { type: 'spawnGroup'; group: string }
  | { type: 'showDialog'; key: string; event?: string }
  | { type: 'setObjective'; label: string }
  | { type: 'grantCredits'; owner: number; amount: number }
  | { type: 'revealArea'; x: number; z: number; radius: number }
  | { type: 'moveGroup'; group: string; target: { x: number; z: number } }
  | { type: 'attackMoveGroup'; group: string; target: { x: number; z: number } }
  | { type: 'setFlag'; name: string; value: boolean }
  | { type: 'victory' }
  | { type: 'defeat'; message?: string }
  | { type: 'setVictoryCondition'; condition: string; ticks?: number }
  | { type: 'playSound'; sound: string }
  | { type: 'cameraLook'; x: number; z: number }
  | { type: 'spawnCrate'; x: number; z: number; crateType: string }
  | { type: 'damageGroup'; group: string; amount: number }
  | { type: 'changeOwner'; group: string; newOwner: number }
  | { type: 'reinforcements'; group: string; edge: 'north' | 'south' | 'east' | 'west' }
  | { type: 'enableRule'; ruleId: string }
  | { type: 'disableRule'; ruleId: string }
  | { type: 'addMessage'; text: string; color?: string };

// ── Rules ─────────────────────────────────────────────────────────

/** A trigger-action rule. */
export interface ScriptRule {
  id: string;
  trigger: Trigger;
  actions: Action[];
  /** Fire only once (default: true). */
  once?: boolean;
  /** Ticks to wait after trigger before executing actions. */
  delay?: number;
  /** Whether the rule is active (default: true, can be toggled by other rules). */
  enabled?: boolean;
}

// ── Mission Script ────────────────────────────────────────────────

/** Top-level mission script document. */
export interface MissionScript {
  id: string;
  name: string;
  victoryCondition: string;
  victoryTicks?: number;
  objectiveLabel: string;
  startingCredits?: number;
  entityGroups: EntityGroupDef[];
  rules: ScriptRule[];
  flags?: Record<string, boolean>;
}

// ── Serialized State ──────────────────────────────────────────────

/**
 * Common interface for both JSON declarative runner and .tok bytecode interpreter.
 * GameContext uses this type for missionScriptRunner.
 */
export interface MissionScriptRunnerInterface {
  init(...args: any[]): void;
  tick(ctx: any, currentTick: number): void;
  isActive(): boolean;
  getScriptId(): string | null;
  serialize(eidToIndex: Map<number, number>): MissionScriptState;
  restore(state: MissionScriptState, indexToEid: Map<number, number>): void;
  dispose(): void;
}

/** Saved script runtime state for save/load. */
export interface MissionScriptState {
  firedRuleIds: string[];
  flags: Record<string, boolean>;
  groupEntities: Record<string, number[]>;
  disabledRules: string[];
  repeatCounts: Record<string, number>;
  pendingDelayed?: Array<{ ruleId: string; executeTick: number }>;
  /** Tok bytecode interpreter state (used when script is a .tok file). */
  tokState?: {
    intVars: number[];
    objVars: number[];
    posVars: Array<{ x: number; z: number }>;
    nextSideId: number;
    relationships: Array<{ a: number; b: number; rel: string }>;
    eventFlags: Record<string, boolean>;
  };
}
