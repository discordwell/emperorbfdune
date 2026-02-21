import { FUNC_NAMES, VarType, type TokExpr, type TokProgram, type TokStatement } from '../../../src/campaign/scripting/tok/TokTypes';
import type { ParseResult } from '../../../src/campaign/scripting/tok/TokParser';

export interface TokTextHeader {
  fileName: string;
  fileSize: number;
  segmentCount: number;
  varSlotCount: number;
}

const OP_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '>=': 3,
  '<=': 3,
  '>': 3,
  '<': 3,
  '+': 4,
  '-': 4,
};

export function countTokSegments(buffer: ArrayBuffer): number {
  const data = new Uint8Array(buffer, 8);
  let separators = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) separators++;
  }
  return separators + 1;
}

export function astToText(result: ParseResult, header: TokTextHeader, stringTable: string[]): string {
  const lines: string[] = [];
  lines.push(`// File: ${header.fileName}`);
  lines.push(`// Size: ${header.fileSize} bytes, segments: ${header.segmentCount}, vars: ${header.varSlotCount}`);
  lines.push('');

  for (const [slot, type] of result.varDecls) {
    lines.push(`${varTypeName(type)} (v${slot})`);
  }

  emitProgram(lines, result.program, result.varDecls, stringTable, 0);
  return lines.join('\n');
}

export function normalizeTokText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function emitProgram(
  lines: string[],
  program: TokProgram,
  varDecls: Map<number, VarType>,
  stringTable: string[],
  depth: number,
): void {
  for (const block of program) {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}if (${formatExpr(block.condition, varDecls, stringTable, true)})`);

    for (const stmt of block.body) {
      emitStatement(lines, stmt, varDecls, stringTable, depth + 1);
    }

    if (block.elseBody.length > 0) {
      lines.push(`${indent}else;`);
      for (const stmt of block.elseBody) {
        emitStatement(lines, stmt, varDecls, stringTable, depth + 1);
      }
    }

    lines.push(`${indent}endif;`);
  }
}

function emitStatement(
  lines: string[],
  stmt: TokStatement,
  varDecls: Map<number, VarType>,
  stringTable: string[],
  depth: number,
): void {
  const indent = '  '.repeat(depth);

  if (stmt.kind === 'block') {
    emitProgram(lines, [stmt], varDecls, stringTable, depth);
    return;
  }

  if (stmt.kind === 'assign') {
    const left = varName(stmt.varSlot, stmt.varType);
    const right = formatExpr(stmt.value, varDecls, stringTable, false);
    lines.push(`${indent}${stripAccumulatorArtifacts(`${left} = ${right}`)}`);
    return;
  }

  lines.push(`${indent}${stripAccumulatorArtifacts(formatCall(stmt.funcId, stmt.args, varDecls, stringTable))}`);
}

function formatCall(funcId: number, args: TokExpr[], varDecls: Map<number, VarType>, stringTable: string[]): string {
  const name = FUNC_NAMES[funcId] ?? `Func_${funcId}`;
  const argText = args.map((arg) => formatExpr(arg, varDecls, stringTable, false)).join(', ');
  return `${name} (${argText})`;
}

function formatExpr(expr: TokExpr, varDecls: Map<number, VarType>, stringTable: string[], topLevel: boolean): string {
  switch (expr.kind) {
    case 'literal':
      return String(expr.value);

    case 'bool':
      return expr.value ? 'TRUE' : 'FALSE';

    case 'var':
      return varName(expr.slot, expr.varType ?? varDecls.get(expr.slot) ?? VarType.Int);

    case 'string': {
      const value = stringTable[expr.index];
      if (value === undefined) return `STR[${expr.index}]`;
      return `"${value}"`;
    }

    case 'callExpr':
      return formatCall(expr.funcId, expr.args, varDecls, stringTable);

    case 'binary': {
      const currentPrec = OP_PRECEDENCE[expr.op] ?? 0;

      let left = formatExpr(expr.left, varDecls, stringTable, false);
      if (expr.left.kind === 'binary') {
        const leftPrec = OP_PRECEDENCE[expr.left.op] ?? 0;
        const sameLogicalChain = (expr.op === '&&' || expr.op === '||') && expr.left.op === expr.op;
        if (!sameLogicalChain && (leftPrec < currentPrec || expr.op === '&&' || expr.op === '||')) {
          left = `(${left})`;
        }
      }

      let right = formatExpr(expr.right, varDecls, stringTable, false);
      if (expr.right.kind === 'binary') {
        const rightPrec = OP_PRECEDENCE[expr.right.op] ?? 0;
        const sameLogicalChain = (expr.op === '&&' || expr.op === '||') && expr.right.op === expr.op;
        if (!sameLogicalChain && (rightPrec < currentPrec || expr.op === '&&' || expr.op === '||')) {
          right = `(${right})`;
        }
      }

      const text = `${left} ${expr.op} ${right}`;
      return topLevel ? text : text;
    }
  }
}

function varName(slot: number, type: VarType): string {
  return `${varTypeName(type)}_${slot}`;
}

function varTypeName(type: VarType): string {
  switch (type) {
    case VarType.Int: return 'int';
    case VarType.Obj: return 'obj';
    case VarType.Pos: return 'pos';
    default: return 'int';
  }
}

function stripAccumulatorArtifacts(line: string): string {
  const acc = '(?:v0|pos_0|int_0|obj_0)';
  return line
    .replace(new RegExp(`= ${acc} ([A-Z])`, 'g'), '= $1')
    .replace(new RegExp(`= ${acc} (ModelTick|Random|Multiplayer)`, 'g'), '= $1')
    .replace(new RegExp(`= ${acc} (TRUE|FALSE)`, 'g'), '= $1')
    .replace(new RegExp(`== ${acc} (TRUE|FALSE)`, 'g'), '== $1')
    .replace(new RegExp(`== ${acc} (\\d)`, 'g'), '== $1')
    .replace(new RegExp(`(==|!=|>=|<=|>|<) ${acc} `, 'g'), '$1 ');
}
