import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FUNC_NAMES } from '../../../src/campaign/scripting/tok/TokTypes';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const DECOMPILED_DIR = path.join(ROOT, 'decompiled_missions');
const TOK_FUNCTIONS_FILE = path.join(ROOT, 'src/campaign/scripting/tok/TokFunctions.ts');

type DispatchStatus = 'implemented' | 'stubbed';

function getMissionUsageByFunction(): Map<string, number> {
  const counts = new Map<string, number>();
  const functionNames = Object.entries(FUNC_NAMES)
    .map(([, name]) => name)
    .filter((name) => !['int', 'obj', 'pos', 'if', 'else', 'endif'].includes(name));

  const files = fs.readdirSync(DECOMPILED_DIR).filter((f) => f.endsWith('.txt'));
  for (const file of files) {
    const text = fs.readFileSync(path.join(DECOMPILED_DIR, file), 'utf8');
    for (const name of functionNames) {
      if (text.includes(`${name} (`)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }

  return counts;
}

function getDispatchStatus(): Map<string, DispatchStatus> {
  const source = fs.readFileSync(TOK_FUNCTIONS_FILE, 'utf8');
  const status = new Map<string, DispatchStatus>();

  const caseGroupRegex = /((?:\s*case FUNC\.[A-Za-z0-9_]+:\s*)+)([\s\S]*?)(?=\n\s*case FUNC\.|\n\s*default:)/g;
  const stubMarker = /not implemented|no-op|for now|niche|not used in campaign|simplified|always single-player|not implemented|No missions use this/i;

  for (const match of source.matchAll(caseGroupRegex)) {
    const labels = [...match[1].matchAll(/case FUNC\.([A-Za-z0-9_]+):/g)].map((m) => m[1]);
    const body = match[2];

    const bodyStatus: DispatchStatus = stubMarker.test(body) ? 'stubbed' : 'implemented';
    for (const label of labels) {
      status.set(label, bodyStatus);
    }
  }

  return status;
}

describe('Tok function coverage', () => {
  it('reports implemented/stubbed/unused and guards frequent stubs', () => {
    const usage = getMissionUsageByFunction();
    const dispatch = getDispatchStatus();

    const rows = Object.entries(FUNC_NAMES)
      .map(([, name]) => name)
      .filter((name) => !['int', 'obj', 'pos', 'if', 'else', 'endif'].includes(name))
      .map((name) => {
        const uses = usage.get(name) ?? 0;
        const status = dispatch.get(name) ?? 'stubbed';
        return { name, uses, status };
      })
      .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));

    const implemented = rows.filter((r) => r.status === 'implemented').length;
    const stubbed = rows.filter((r) => r.status === 'stubbed').length;
    const unused = rows.filter((r) => r.uses === 0).length;

    // Print a concise machine-readable report in test logs.
    console.log('[TokCoverage]', JSON.stringify({ implemented, stubbed, unused }));
    console.log('[TokCoverageTop]', JSON.stringify(rows.slice(0, 25)));

    const frequentStubbed = rows.filter((r) => r.uses >= 10 && r.status === 'stubbed');
    expect(frequentStubbed).toEqual([]);
  });
});
