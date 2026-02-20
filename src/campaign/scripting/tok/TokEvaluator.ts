/**
 * Evaluates .tok AST every game tick.
 *
 * The .tok VM is reactive: every tick, ALL top-level if/endif blocks
 * are re-evaluated. State is maintained in typed variable slots.
 * Side effects happen when conditions become true.
 */

import type {
  TokProgram, TokBlock, TokStatement, TokExpr,
  TokPos, TokSaveState,
} from './TokTypes';
import { VarType } from './TokTypes';
import type { TokFunctionDispatch } from './TokFunctions';
import type { GameContext } from '../../../core/GameContext';

// ---------------------------------------------------------------------------
// Side management
// ---------------------------------------------------------------------------

export class SideManager {
  nextSideId = 2; // 0=player, 1=enemy, 2+=script-created
  /** Relationship: key = "a:b", value = 'enemy' | 'friend' | 'neutral' */
  relationships = new Map<string, 'enemy' | 'friend' | 'neutral'>();

  createSide(): number {
    return this.nextSideId++;
  }

  setEnemy(a: number, b: number): void {
    this.relationships.set(`${a}:${b}`, 'enemy');
  }

  setFriend(a: number, b: number): void {
    this.relationships.set(`${a}:${b}`, 'friend');
  }

  setNeutral(a: number, b: number): void {
    this.relationships.set(`${a}:${b}`, 'neutral');
  }

  isEnemy(a: number, b: number): boolean {
    if (a === b) return false;
    const rel = this.relationships.get(`${a}:${b}`);
    if (rel !== undefined) return rel === 'enemy';
    // Default: player (0) is enemy to enemy (1) and vice versa
    if ((a === 0 && b === 1) || (a === 1 && b === 0)) return true;
    return false;
  }

  isFriend(a: number, b: number): boolean {
    if (a === b) return true;
    const rel = this.relationships.get(`${a}:${b}`);
    if (rel !== undefined) return rel === 'friend';
    return false;
  }

  serialize(): Array<{ a: number; b: number; rel: string }> {
    const out: Array<{ a: number; b: number; rel: string }> = [];
    for (const [key, rel] of this.relationships) {
      const [a, b] = key.split(':').map(Number);
      out.push({ a, b, rel });
    }
    return out;
  }

  restore(data: Array<{ a: number; b: number; rel: string }>, nextId: number): void {
    this.nextSideId = nextId;
    this.relationships.clear();
    for (const { a, b, rel } of data) {
      this.relationships.set(`${a}:${b}`, rel as 'enemy' | 'friend' | 'neutral');
    }
  }
}

// ---------------------------------------------------------------------------
// Event tracker
// ---------------------------------------------------------------------------

export class EventTracker {
  /** Tracks events that occurred: key is a compound key, value is the data. */
  private events = new Map<string, any>();

  /** Record that an object was destroyed. */
  objectDestroyed(eid: number): void {
    this.events.set(`obj_destroyed:${eid}`, true);
  }

  /** Record that side A attacked side B. */
  sideAttacksSide(a: number, b: number): void {
    this.events.set(`side_attacks:${a}:${b}`, true);
  }

  /** Record that an object was delivered. */
  objectDelivered(eid: number): void {
    this.events.set(`obj_delivered:${eid}`, true);
  }

  /** Record that a side constructed an object. */
  objectConstructed(side: number, eid: number): void {
    this.events.set(`obj_constructed:${side}:${eid}`, true);
  }

  /** Record that a type was constructed by a side. */
  objectTypeConstructed(side: number, typeName: string): void {
    this.events.set(`type_constructed:${side}:${typeName}`, true);
  }

  /** Record that an object attacks a side. */
  objectAttacksSide(eid: number, side: number): void {
    this.events.set(`obj_attacks_side:${eid}:${side}`, true);
  }

  /** Query: was object destroyed? */
  wasObjectDestroyed(eid: number): boolean {
    return this.events.has(`obj_destroyed:${eid}`);
  }

  /** Query: did side A attack side B? */
  didSideAttackSide(a: number, b: number): boolean {
    return this.events.has(`side_attacks:${a}:${b}`);
  }

  /** Query: was object delivered? */
  wasObjectDelivered(eid: number): boolean {
    return this.events.has(`obj_delivered:${eid}`);
  }

  /** Query: did side construct object? */
  wasObjectConstructed(side: number, eid: number): boolean {
    return this.events.has(`obj_constructed:${side}:${eid}`);
  }

  /** Query: did side construct type? */
  wasObjectTypeConstructed(side: number, typeName: string): boolean {
    return this.events.has(`type_constructed:${side}:${typeName}`);
  }

  /** Query: did object attack side? */
  didObjectAttackSide(eid: number, side: number): boolean {
    return this.events.has(`obj_attacks_side:${eid}:${side}`);
  }

  /** Clear all event flags (called at start of each tick). */
  clear(): void {
    this.events.clear();
  }

  serialize(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [k, v] of this.events) out[k] = v;
    return out;
  }

  restore(data: Record<string, boolean>): void {
    this.events.clear();
    for (const [k, v] of Object.entries(data)) this.events.set(k, v);
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export class TokEvaluator {
  intVars: number[] = [];
  objVars: number[] = [];
  posVars: TokPos[] = [];
  sides = new SideManager();
  events = new EventTracker();

  initVars(varDecls: Map<number, VarType>, slotCount: number): void {
    // Allocate enough slots for all declared variables
    let maxSlot = slotCount;
    for (const slot of varDecls.keys()) {
      if (slot >= maxSlot) maxSlot = slot + 1;
    }

    this.intVars = new Array(maxSlot).fill(0);
    this.objVars = new Array(maxSlot).fill(-1);
    this.posVars = new Array(maxSlot).fill(null).map(() => ({ x: 0, z: 0 }));
  }

  /** Execute one tick: evaluate all top-level blocks. */
  tick(program: TokProgram, ctx: GameContext, functions: TokFunctionDispatch, currentTick: number): void {
    // Note: events are NOT cleared here — they accumulate within a tick
    // and should be cleared by the interpreter before calling tick()

    for (const block of program) {
      this.evaluateBlock(block, ctx, functions, currentTick);
    }
  }

  private evaluateBlock(block: TokBlock, ctx: GameContext, functions: TokFunctionDispatch, currentTick: number): void {
    const condVal = this.evaluateExpr(block.condition, ctx, functions, currentTick);
    if (this.isTruthy(condVal)) {
      for (const stmt of block.body) {
        this.executeStatement(stmt, ctx, functions, currentTick);
      }
    } else if (block.elseBody.length > 0) {
      for (const stmt of block.elseBody) {
        this.executeStatement(stmt, ctx, functions, currentTick);
      }
    }
  }

  private executeStatement(stmt: TokStatement, ctx: GameContext, functions: TokFunctionDispatch, currentTick: number): void {
    switch (stmt.kind) {
      case 'block':
        this.evaluateBlock(stmt, ctx, functions, currentTick);
        break;

      case 'assign': {
        const val = this.evaluateExpr(stmt.value, ctx, functions, currentTick);
        this.setVar(stmt.varSlot, stmt.varType, val);
        break;
      }

      case 'call':
        functions.call(stmt.funcId, stmt.args, ctx, this, currentTick);
        break;
    }
  }

  evaluateExpr(expr: TokExpr, ctx: GameContext, functions: TokFunctionDispatch, currentTick: number): number | TokPos {
    switch (expr.kind) {
      case 'literal':
        return expr.value;

      case 'bool':
        return expr.value ? 1 : 0;

      case 'var':
        return this.getVar(expr.slot, expr.varType);

      case 'string':
        return expr.index;

      case 'callExpr':
        return functions.call(expr.funcId, expr.args, ctx, this, currentTick);

      case 'binary': {
        const left = this.evaluateExpr(expr.left, ctx, functions, currentTick);
        const right = this.evaluateExpr(expr.right, ctx, functions, currentTick);
        return this.evalBinaryOp(expr.op, left, right);
      }
    }
  }

  private evalBinaryOp(op: string, left: number | TokPos, right: number | TokPos): number {
    const l = typeof left === 'number' ? left : 0;
    const r = typeof right === 'number' ? right : 0;

    switch (op) {
      case '==': return l === r ? 1 : 0;
      case '!=': return l !== r ? 1 : 0;
      case '>=': return l >= r ? 1 : 0;
      case '<=': return l <= r ? 1 : 0;
      case '>':  return l > r ? 1 : 0;
      case '<':  return l < r ? 1 : 0;
      case '&&': return (l !== 0 && r !== 0) ? 1 : 0;
      case '||': return (l !== 0 || r !== 0) ? 1 : 0;
      case '+':  return l + r;
      case '-':  return l - r;
      default:   return 0;
    }
  }

  getVar(slot: number, type: VarType): number | TokPos {
    switch (type) {
      case VarType.Int: return this.intVars[slot] ?? 0;
      case VarType.Obj: return this.objVars[slot] ?? -1;
      case VarType.Pos: return this.posVars[slot] ?? { x: 0, z: 0 };
    }
  }

  setVar(slot: number, type: VarType, value: number | TokPos): void {
    // Ensure arrays are large enough
    while (slot >= this.intVars.length) {
      this.intVars.push(0);
      this.objVars.push(-1);
      this.posVars.push({ x: 0, z: 0 });
    }

    switch (type) {
      case VarType.Int:
        this.intVars[slot] = typeof value === 'number' ? value : 0;
        break;
      case VarType.Obj:
        this.objVars[slot] = typeof value === 'number' ? value : -1;
        break;
      case VarType.Pos:
        if (typeof value === 'object' && value !== null) {
          this.posVars[slot] = value;
        }
        break;
    }
  }

  private isTruthy(val: number | TokPos): boolean {
    if (typeof val === 'number') return val !== 0;
    // Position is always truthy (it's a valid value)
    return true;
  }

  /** Serialize state for save/load. */
  serialize(eidToIndex: Map<number, number>): TokSaveState {
    return {
      intVars: [...this.intVars],
      objVars: this.objVars.map(eid => eid >= 0 ? (eidToIndex.get(eid) ?? -1) : -1),
      posVars: this.posVars.map(p => ({ x: p.x, z: p.z })),
      nextSideId: this.sides.nextSideId,
      relationships: this.sides.serialize(),
      eventFlags: this.events.serialize(),
    };
  }

  /** Restore state from save data. */
  restore(state: TokSaveState, indexToEid: Map<number, number>): void {
    this.intVars = [...state.intVars];
    this.objVars = state.objVars.map(idx => idx >= 0 ? (indexToEid.get(idx) ?? -1) : -1);
    this.posVars = state.posVars.map(p => ({ x: p.x, z: p.z }));
    this.sides.restore(state.relationships, state.nextSideId);
    this.events.restore(state.eventFlags);
  }
}
