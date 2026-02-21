import type { OracleComparisonDiff } from './oracleTypes';

export interface ComparatorTolerance {
  pathPattern: RegExp;
  epsilon: number;
}

export interface ComparatorOptions {
  maxDiffs?: number;
  defaultEpsilon?: number;
  tolerances?: ComparatorTolerance[];
}

const DEFAULT_OPTIONS: Required<ComparatorOptions> = {
  maxDiffs: 1,
  defaultEpsilon: 0,
  tolerances: [],
};

export function compareOracleValues(
  expected: unknown,
  actual: unknown,
  options: ComparatorOptions = {},
): OracleComparisonDiff[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const diffs: OracleComparisonDiff[] = [];
  walk('$', expected, actual, opts, diffs);
  return diffs;
}

function walk(
  path: string,
  expected: unknown,
  actual: unknown,
  options: Required<ComparatorOptions>,
  out: OracleComparisonDiff[],
): void {
  if (out.length >= options.maxDiffs) return;

  if (typeof expected === 'number' && typeof actual === 'number') {
    const epsilon = epsilonForPath(path, options);
    if (Math.abs(expected - actual) > epsilon) {
      out.push({ path, expected, actual });
    }
    return;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      out.push({ path, expected, actual });
      return;
    }
    if (expected.length !== actual.length) {
      out.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
      return;
    }
    for (let i = 0; i < expected.length; i++) {
      walk(`${path}[${i}]`, expected[i], actual[i], options, out);
      if (out.length >= options.maxDiffs) return;
    }
    return;
  }

  if (isObject(expected) || isObject(actual)) {
    if (!isObject(expected) || !isObject(actual)) {
      out.push({ path, expected, actual });
      return;
    }

    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (expectedKeys.length !== actualKeys.length) {
      out.push({ path: `${path}.__keys`, expected: expectedKeys, actual: actualKeys });
      return;
    }
    for (let i = 0; i < expectedKeys.length; i++) {
      if (expectedKeys[i] !== actualKeys[i]) {
        out.push({ path: `${path}.__keys[${i}]`, expected: expectedKeys[i], actual: actualKeys[i] });
        return;
      }
    }

    for (const key of expectedKeys) {
      walk(`${path}.${key}`, (expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], options, out);
      if (out.length >= options.maxDiffs) return;
    }
    return;
  }

  if (expected !== actual) {
    out.push({ path, expected, actual });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function epsilonForPath(path: string, options: Required<ComparatorOptions>): number {
  for (const t of options.tolerances) {
    if (t.pathPattern.test(path)) return t.epsilon;
  }
  return options.defaultEpsilon;
}
