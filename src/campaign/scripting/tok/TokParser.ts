/**
 * Parses .tok binary bytecode into an AST.
 *
 * Ports the Theory B decoding from decompile_tok.py to TypeScript.
 * Instead of producing text, builds typed AST nodes for runtime evaluation.
 *
 * Binary format:
 *   [4 bytes: data_size (LE u32)]
 *   [4 bytes: null_count (LE u32)]
 *   [payload: null-separated segments]
 *
 * Each segment is decoded into a token stream, then the stream of all
 * segments is parsed into an AST via recursive descent.
 */

import {
  type TokProgram, type TokBlock, type TokStatement,
  type TokExpr, type TokFuncCall, type TokAssignment,
  type VarDecl,
  VarType, KEYWORD_THRESHOLD, FUNC_NAMES, KW,
} from './TokTypes';

// ---------------------------------------------------------------------------
// Token types produced by the decoder
// ---------------------------------------------------------------------------

const enum TokKind {
  Func,     // function ID to be called
  Keyword,  // keyword/operator token ID (>= 162)
  Var,      // variable reference (slot number)
  Str,      // string table index
  Int,      // integer literal
  Ascii,    // standalone ASCII character (digit, paren, comma, semicolon)
}

interface Token {
  kind: TokKind;
  value: number;   // func ID, keyword ID, var slot, string index, int value, or char code
}

// ---------------------------------------------------------------------------
// Phase 1: Split binary into segments and decode tokens
// ---------------------------------------------------------------------------

function splitSegments(data: Uint8Array): Uint8Array[] {
  const segments: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) {
      segments.push(data.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < data.length) {
    segments.push(data.subarray(start));
  }
  return segments;
}

function decodeSegment(seg: Uint8Array): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < seg.length) {
    const b = seg[i];

    if (b < 0x80) {
      // Standalone ASCII literal
      tokens.push({ kind: TokKind.Ascii, value: b });
      i++;
      continue;
    }

    // All bytes >= 0x80 start a 2-byte pair
    if (i + 1 >= seg.length) {
      // Orphan prefix at end = statement terminator (semicolon)
      tokens.push({ kind: TokKind.Ascii, value: 0x3B }); // ';'
      i++;
      continue;
    }

    const second = seg[i + 1];

    if (b === 0x80) {
      // Function/keyword prefix
      if (second < 0x80) {
        tokens.push({ kind: TokKind.Ascii, value: second });
      } else {
        // Check if next 2 bytes are 0x80 0x28 (function call via 80-prefix)
        const posAfter = i + 2;
        const isCall = posAfter + 1 < seg.length
          && seg[posAfter] === 0x80
          && seg[posAfter + 1] === 0x28;
        if (isCall) {
          tokens.push({ kind: TokKind.Func, value: second - 0x80 });
        } else {
          const tokId = second; // raw: keyword/operator
          if (tokId >= KEYWORD_THRESHOLD) {
            tokens.push({ kind: TokKind.Keyword, value: tokId });
          } else {
            tokens.push({ kind: TokKind.Func, value: tokId });
          }
        }
      }
    } else if (b === 0x81) {
      // Variable prefix
      if (second < 0x80) {
        tokens.push({ kind: TokKind.Ascii, value: second });
      } else if (second === 0x81 && i + 2 < seg.length && seg[i + 2] >= 0x81) {
        // Bug 2 fix: standalone accumulator marker — skip
        i++;
        continue;
      } else {
        tokens.push({ kind: TokKind.Var, value: second - 0x80 });
      }
    } else if (b === 0x82) {
      // String reference prefix
      if (second < 0x80) {
        tokens.push({ kind: TokKind.Ascii, value: second });
      } else {
        tokens.push({ kind: TokKind.Str, value: second - 0x80 });
      }
    } else {
      // Extended token prefix (P >= 0x83)
      if (second === 0x80) {
        const nextPos = i + 2;
        if (nextPos < seg.length && seg[nextPos] === 0x28) {
          // Function call: token = P - 0x80
          tokens.push({ kind: TokKind.Func, value: b - 0x80 });
        } else {
          // Variable reference or keyword
          const rawTok = b;
          if (rawTok >= KEYWORD_THRESHOLD && FUNC_NAMES[rawTok] !== undefined) {
            tokens.push({ kind: TokKind.Keyword, value: rawTok });
          } else {
            tokens.push({ kind: TokKind.Var, value: b - 0x80 });
          }
        }
      } else if (second < 0x80) {
        tokens.push({ kind: TokKind.Ascii, value: second });
      } else {
        // S > 0x80: keyword, high function call, or integer literal
        const rawTok = b;
        if (rawTok >= KEYWORD_THRESHOLD && FUNC_NAMES[rawTok] !== undefined) {
          tokens.push({ kind: TokKind.Keyword, value: rawTok });
        } else if (second === 0x81 && i + 2 < seg.length && seg[i + 2] === 0x28) {
          // Bug 1 fix: high function call (IDs 131-161)
          tokens.push({ kind: TokKind.Func, value: rawTok });
        } else {
          // Integer literal
          tokens.push({ kind: TokKind.Int, value: second - 0x80 });
        }
      }
    }

    i += 2;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Phase 2: Combine multi-digit integers from token stream
// ---------------------------------------------------------------------------

function combineDigits(tokens: Token[]): Token[] {
  const out: Token[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Check if this starts a digit sequence
    if (isDigitAscii(t) || (isMinusAscii(t) && i + 1 < tokens.length && isDigitAscii(tokens[i + 1]))) {
      let numStr = '';
      if (isMinusAscii(t)) {
        numStr = '-';
        i++;
      }
      while (i < tokens.length && isDigitAscii(tokens[i])) {
        numStr += String.fromCharCode(tokens[i].value);
        i++;
      }
      i--; // back up since outer loop will increment
      out.push({ kind: TokKind.Int, value: parseInt(numStr, 10) });
    } else {
      out.push(t);
    }
  }

  return out;
}

function isDigitAscii(t: Token): boolean {
  return t.kind === TokKind.Ascii && t.value >= 0x30 && t.value <= 0x39;
}

function isMinusAscii(t: Token): boolean {
  return t.kind === TokKind.Ascii && t.value === 0x2D; // '-'
}

// ---------------------------------------------------------------------------
// Phase 3: Parse token stream into AST
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[] = [];
  private pos = 0;
  private varDecls = new Map<number, VarType>();

  parse(allSegmentTokens: Token[][]): TokProgram {
    // Flatten all segment tokens, inserting semicolons between segments
    const flat: Token[] = [];
    for (let si = 0; si < allSegmentTokens.length; si++) {
      const seg = allSegmentTokens[si];
      if (seg.length === 0) continue;
      for (const t of seg) flat.push(t);
      flat.push({ kind: TokKind.Ascii, value: 0x3B }); // semicolon separator
    }

    this.tokens = flat;
    this.pos = 0;

    // Parse variable declarations first
    this.parseVarDeclarations();

    // Parse top-level blocks
    const blocks: TokBlock[] = [];
    while (this.pos < this.tokens.length) {
      this.skipSemicolons();
      if (this.pos >= this.tokens.length) break;

      const block = this.parseBlock();
      if (block) blocks.push(block);
    }

    return blocks;
  }

  getVarDecls(): Map<number, VarType> {
    return this.varDecls;
  }

  private parseVarDeclarations(): void {
    // Scan for variable declarations: int(vN), obj(vN), pos(vN)
    // These appear as: Keyword(int/obj/pos), Ascii('('), Var(slot), Ascii(')')
    while (this.pos < this.tokens.length) {
      const saved = this.pos;
      this.skipSemicolons();
      if (this.pos >= this.tokens.length) break;

      const t = this.tokens[this.pos];
      if (t.kind === TokKind.Keyword && (t.value === KW.int || t.value === KW.obj || t.value === KW.pos)) {
        const varType = t.value === KW.int ? VarType.Int
          : t.value === KW.obj ? VarType.Obj
          : VarType.Pos;
        this.pos++;
        if (this.matchAscii(0x28)) { // '('
          if (this.pos < this.tokens.length && this.tokens[this.pos].kind === TokKind.Var) {
            const slot = this.tokens[this.pos].value;
            this.varDecls.set(slot, varType);
            this.pos++;
          }
          this.matchAscii(0x29); // ')'
        }
      } else {
        // Not a var declaration — rewind and stop
        this.pos = saved;
        break;
      }
    }
  }

  private parseBlock(): TokBlock | null {
    // Expect: if keyword
    if (!this.isKeyword(KW.if)) return this.skipToNextBlock();

    this.pos++; // consume 'if'

    // Parse condition (wrapped in parens at top level)
    const condition = this.parseExpression();

    this.skipSemicolons();

    // Parse body statements until else or endif
    const body: TokStatement[] = [];
    const elseBody: TokStatement[] = [];

    while (this.pos < this.tokens.length) {
      this.skipSemicolons();
      if (this.pos >= this.tokens.length) break;

      if (this.isKeyword(KW.endif)) {
        this.pos++; // consume endif
        break;
      }
      if (this.isKeyword(KW.else)) {
        this.pos++; // consume else
        this.skipSemicolons();
        // Parse else body
        while (this.pos < this.tokens.length) {
          this.skipSemicolons();
          if (this.pos >= this.tokens.length) break;
          if (this.isKeyword(KW.endif)) {
            this.pos++;
            break;
          }
          const stmt = this.parseStatement();
          if (stmt) elseBody.push(stmt);
        }
        break;
      }

      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
    }

    return { kind: 'block', condition, body, elseBody };
  }

  private parseStatement(): TokStatement | null {
    this.skipSemicolons();
    if (this.pos >= this.tokens.length) return null;

    const t = this.tokens[this.pos];

    // Nested if block
    if (t.kind === TokKind.Keyword && t.value === KW.if) {
      return this.parseBlock();
    }

    // Variable assignment: var = expr
    if (t.kind === TokKind.Var) {
      const slot = t.value;
      const nextIdx = this.pos + 1;
      if (nextIdx < this.tokens.length
        && this.tokens[nextIdx].kind === TokKind.Keyword
        && this.tokens[nextIdx].value === KW.assign) {
        this.pos += 2; // consume var and =
        // Skip accumulator variable (slot 0) if present
        this.skipAccumulator();
        const value = this.parseExpression();
        return {
          kind: 'assign',
          varSlot: slot,
          varType: this.varDecls.get(slot) ?? VarType.Int,
          value,
        } satisfies TokAssignment;
      }
    }

    // Function call as statement
    if (t.kind === TokKind.Func) {
      return this.parseFuncCallStatement();
    }

    // Unknown token — skip it
    this.pos++;
    return null;
  }

  private parseFuncCallStatement(): TokFuncCall {
    const funcId = this.tokens[this.pos].value;
    this.pos++; // consume function token

    const args = this.parseFuncArgs();

    return { kind: 'call', funcId, args };
  }

  private parseFuncArgs(): TokExpr[] {
    const args: TokExpr[] = [];

    if (!this.matchAscii(0x28)) return args; // '('

    while (this.pos < this.tokens.length) {
      if (this.isAscii(0x29)) { // ')'
        this.pos++;
        break;
      }
      if (this.isAscii(0x2C)) { // ','
        this.pos++;
        continue;
      }
      // Skip accumulator references (slot 0) before arguments
      this.skipAccumulator();
      args.push(this.parseExpression());
    }

    return args;
  }

  private parseExpression(): TokExpr {
    // Handle outer parens
    if (this.isAscii(0x28)) { // '('
      this.pos++;
      const inner = this.parseExpression();
      this.matchAscii(0x29); // ')'

      // Check for binary operator after closing paren
      return this.maybeBinaryRight(inner);
    }

    let left = this.parsePrimary();
    return this.maybeBinaryRight(left);
  }

  private maybeBinaryRight(left: TokExpr): TokExpr {
    // Check for binary operator
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      if (t.kind !== TokKind.Keyword) break;

      const op = this.keywordToOp(t.value);
      if (!op) break;

      this.pos++; // consume operator

      // Skip accumulator references
      this.skipAccumulator();

      // Right side might be wrapped in parens
      let right: TokExpr;
      if (this.isAscii(0x28)) {
        this.pos++;
        right = this.parseExpression();
        this.matchAscii(0x29);
      } else {
        right = this.parsePrimary();
      }

      left = { kind: 'binary', op, left, right };
    }

    return left;
  }

  private parsePrimary(): TokExpr {
    if (this.pos >= this.tokens.length) {
      return { kind: 'literal', value: 0 };
    }

    const t = this.tokens[this.pos];

    // Integer literal
    if (t.kind === TokKind.Int) {
      this.pos++;
      return { kind: 'literal', value: t.value };
    }

    // Variable reference
    if (t.kind === TokKind.Var) {
      this.pos++;
      return {
        kind: 'var',
        slot: t.value,
        varType: this.varDecls.get(t.value) ?? VarType.Int,
      };
    }

    // String reference
    if (t.kind === TokKind.Str) {
      this.pos++;
      return { kind: 'string', index: t.value };
    }

    // Boolean literal
    if (t.kind === TokKind.Keyword && t.value === KW.TRUE) {
      this.pos++;
      return { kind: 'bool', value: true };
    }
    if (t.kind === TokKind.Keyword && t.value === KW.FALSE) {
      this.pos++;
      return { kind: 'bool', value: false };
    }

    // Function call as expression
    if (t.kind === TokKind.Func) {
      const funcId = t.value;
      this.pos++;
      const args = this.parseFuncArgs();
      return { kind: 'callExpr', funcId, args };
    }

    // Neg() function via Keyword for the '-' unary case
    if (t.kind === TokKind.Keyword && t.value === KW.minus) {
      this.pos++;
      const operand = this.parsePrimary();
      // Represent as 0 - operand
      return { kind: 'binary', op: '-', left: { kind: 'literal', value: 0 }, right: operand };
    }

    // Parenthesized sub-expression
    if (t.kind === TokKind.Ascii && t.value === 0x28) {
      this.pos++;
      const inner = this.parseExpression();
      this.matchAscii(0x29);
      return inner;
    }

    // Unknown — skip and return 0
    this.pos++;
    return { kind: 'literal', value: 0 };
  }

  private skipAccumulator(): void {
    // The compiler emits slot-0 variable references as accumulator artifacts.
    // If next token is var slot 0 and followed by something meaningful, skip it.
    if (this.pos < this.tokens.length
      && this.tokens[this.pos].kind === TokKind.Var
      && this.tokens[this.pos].value === 0
      && this.pos + 1 < this.tokens.length) {
      const next = this.tokens[this.pos + 1];
      // Skip if followed by a function, variable, string, keyword (TRUE/FALSE), or int
      if (next.kind === TokKind.Func
        || next.kind === TokKind.Var
        || next.kind === TokKind.Str
        || next.kind === TokKind.Int
        || (next.kind === TokKind.Keyword && (next.value === KW.TRUE || next.value === KW.FALSE))) {
        this.pos++; // skip accumulator
      }
    }
  }

  private keywordToOp(kw: number): '==' | '!=' | '>=' | '<=' | '>' | '<' | '&&' | '||' | '+' | '-' | null {
    switch (kw) {
      case KW.eq: return '==';
      case KW.neq: return '!=';
      case KW.gte: return '>=';
      case KW.lte: return '<=';
      case KW.gt: return '>';
      case KW.lt: return '<';
      case KW.and: return '&&';
      case KW.or: return '||';
      case KW.plus: return '+';
      case KW.minus: return '-';
      default: return null;
    }
  }

  private isKeyword(kw: number): boolean {
    return this.pos < this.tokens.length
      && this.tokens[this.pos].kind === TokKind.Keyword
      && this.tokens[this.pos].value === kw;
  }

  private isAscii(ch: number): boolean {
    return this.pos < this.tokens.length
      && this.tokens[this.pos].kind === TokKind.Ascii
      && this.tokens[this.pos].value === ch;
  }

  private matchAscii(ch: number): boolean {
    if (this.isAscii(ch)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private skipSemicolons(): void {
    while (this.pos < this.tokens.length
      && this.tokens[this.pos].kind === TokKind.Ascii
      && this.tokens[this.pos].value === 0x3B) {
      this.pos++;
    }
  }

  private skipToNextBlock(): null {
    // Skip tokens until we find an 'if' keyword or end
    while (this.pos < this.tokens.length) {
      if (this.isKeyword(KW.if)) return null;
      this.pos++;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseResult {
  program: TokProgram;
  varDecls: Map<number, VarType>;
  varSlotCount: number;
}

export function parseTokFile(buffer: ArrayBuffer): ParseResult {
  const data = new Uint8Array(buffer);

  if (data.length < 8) {
    return { program: [], varDecls: new Map(), varSlotCount: 0 };
  }

  // Read header
  const view = new DataView(buffer);
  const _dataSize = view.getUint32(0, true);
  const _nullCount = view.getUint32(4, true);

  // Split payload into segments
  const payload = data.subarray(8);
  const segments = splitSegments(payload);

  // Count leading empty segments (= variable slot count)
  let emptyCount = 0;
  for (const s of segments) {
    if (s.length === 0) emptyCount++;
    else break;
  }

  // Decode each non-empty segment into tokens, then combine multi-digit integers
  const allSegmentTokens: Token[][] = [];
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const raw = decodeSegment(seg);
    const combined = combineDigits(raw);
    allSegmentTokens.push(combined);
  }

  // Parse into AST
  const parser = new Parser();
  const program = parser.parse(allSegmentTokens);

  return {
    program,
    varDecls: parser.getVarDecls(),
    varSlotCount: emptyCount,
  };
}
