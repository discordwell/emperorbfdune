import { describe, expect, it } from 'vitest';

import { compareOracleValues } from './oracles/comparator';

describe('Tok oracle comparator', () => {
  it('finds first mismatch path', () => {
    const expected = { a: 1, b: { c: [10, 20] } };
    const actual = { a: 1, b: { c: [10, 99] } };
    const diffs = compareOracleValues(expected, actual, { maxDiffs: 1 });
    expect(diffs).toEqual([{ path: '$.b.c[1]', expected: 20, actual: 99 }]);
  });

  it('supports numeric tolerance by path', () => {
    const expected = { pos: { x: 10, z: 20 } };
    const actual = { pos: { x: 10.001, z: 20 } };
    const diffs = compareOracleValues(expected, actual, {
      maxDiffs: 1,
      tolerances: [{ pathPattern: /^\$\.pos\.x$/, epsilon: 0.01 }],
    });
    expect(diffs).toEqual([]);
  });
});
