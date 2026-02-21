import { describe, expect, it } from 'vitest';

import { parseTokFile } from '../../../src/campaign/scripting/tok/TokParser';
import { FUNC, VarType } from '../../../src/campaign/scripting/tok/TokTypes';

function kw(id: number): number[] {
  return [0x80, id];
}

function varRef(slot: number): number[] {
  return [0x81, 0x80 + slot];
}

function buildTokBuffer(segments: number[][]): ArrayBuffer {
  const payload: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    payload.push(...segments[i]);
    if (i < segments.length - 1) payload.push(0x00);
  }

  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, true);
  view.setUint32(4, segments.length - 1, true);
  out.set(payload, 8);
  return out.buffer;
}

describe('TokParser edge cases', () => {
  it('handles bug-2 accumulator marker sequence (81 81 83 ...)', () => {
    const segments = [
      [...kw(162), 0x28, ...varRef(1), 0x29], // int(v1)
      [...kw(162), 0x28, ...varRef(3), 0x29], // int(v3)
      [...kw(165), 0x28, ...kw(177), 0x29],   // if(TRUE)
      [
        ...varRef(1), ...kw(180),
        0x81, 0x81, // standalone accumulator marker to skip
        0x83, 0x80, // actual variable ref => v3
      ],
      [...kw(167)], // endif
    ];

    const parsed = parseTokFile(buildTokBuffer(segments));
    expect(parsed.program.length).toBe(1);

    const assign = parsed.program[0].body[0];
    expect(assign.kind).toBe('assign');
    if (assign.kind !== 'assign') return;

    expect(assign.varSlot).toBe(1);
    expect(assign.value.kind).toBe('var');
    if (assign.value.kind !== 'var') return;

    expect(assign.value.slot).toBe(3);
  });

  it('decodes high function calls (IDs 131-161) via 83 81 28 form', () => {
    const segments = [
      [...kw(165), 0x28, ...kw(177), 0x29], // if(TRUE)
      [0x83, 0x81, 0x28, 0x29],             // DisableUI()
      [...kw(167)],                         // endif
    ];

    const parsed = parseTokFile(buildTokBuffer(segments));
    expect(parsed.program.length).toBe(1);

    const stmt = parsed.program[0].body[0];
    expect(stmt.kind).toBe('call');
    if (stmt.kind !== 'call') return;

    expect(stmt.funcId).toBe(FUNC.DisableUI);
    expect(stmt.args).toHaveLength(0);
  });

  it('parses negative integers from ASCII minus + digits', () => {
    const segments = [
      [...kw(162), 0x28, ...varRef(1), 0x29], // int(v1)
      [...kw(165), 0x28, ...kw(177), 0x29],   // if(TRUE)
      [...varRef(1), ...kw(180), 0x2d, 0x36], // v1 = -6
      [...kw(167)],                           // endif
    ];

    const parsed = parseTokFile(buildTokBuffer(segments));
    const assign = parsed.program[0].body[0];
    expect(assign.kind).toBe('assign');
    if (assign.kind !== 'assign') return;

    expect(assign.varType).toBe(VarType.Int);
    expect(assign.value.kind).toBe('literal');
    if (assign.value.kind !== 'literal') return;

    expect(assign.value.value).toBe(-6);
  });

  it('supports empty if blocks (if (...) endif)', () => {
    const segments = [
      [...kw(165), 0x28, ...kw(177), 0x29], // if(TRUE)
      [...kw(167)],                         // endif
    ];

    const parsed = parseTokFile(buildTokBuffer(segments));
    expect(parsed.program.length).toBe(1);
    expect(parsed.program[0].body).toHaveLength(0);
    expect(parsed.program[0].elseBody).toHaveLength(0);
  });

  it('parses else blocks correctly', () => {
    const segments = [
      [...kw(162), 0x28, ...varRef(1), 0x29],         // int(v1)
      [...kw(165), 0x28, ...kw(177), 0x29],           // if(TRUE)
      [...varRef(1), ...kw(180), 0x31],               // v1 = 1
      [...kw(166)],                                   // else
      [...varRef(1), ...kw(180), 0x32],               // v1 = 2
      [...kw(167)],                                   // endif
    ];

    const parsed = parseTokFile(buildTokBuffer(segments));
    expect(parsed.program.length).toBe(1);

    const block = parsed.program[0];
    expect(block.body).toHaveLength(1);
    expect(block.elseBody).toHaveLength(1);

    const elseAssign = block.elseBody[0];
    expect(elseAssign.kind).toBe('assign');
    if (elseAssign.kind !== 'assign') return;

    expect(elseAssign.value.kind).toBe('literal');
    if (elseAssign.value.kind !== 'literal') return;

    expect(elseAssign.value.value).toBe(2);
  });
});
