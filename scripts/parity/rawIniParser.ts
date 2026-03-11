/**
 * Raw INI Parser — Independent parser for rules.txt that does NOT reuse RulesParser.
 * This parser intentionally does NOT apply defaults, derive values, or normalize case.
 * It exists solely as a cross-check against RulesParser.
 */

export interface RawSection {
  name: string;
  /** Key-value entries (key=value lines). Last-wins for duplicate keys. */
  entries: Map<string, string>;
  /** Bare values (list entries without '=') */
  listValues: string[];
  /** Ordered key-value pairs preserving duplicates */
  orderedEntries: [string, string][];
}

export interface RawIniData {
  sections: Map<string, RawSection>;
}

/**
 * Parse a raw INI file into sections, merging repeated section names.
 * Does NOT apply any game-specific logic — purely structural parsing.
 */
export function parseRawIni(text: string): RawIniData {
  const sections = new Map<string, RawSection>();
  let current: RawSection | null = null;

  for (const rawLine of text.split('\n')) {
    // Strip comments (// style)
    const commentIdx = rawLine.indexOf('//');
    const line = (commentIdx >= 0 ? rawLine.substring(0, commentIdx) : rawLine).trim();
    if (!line) continue;

    // Section header
    if (line.startsWith('[') && line.includes(']')) {
      const name = line.substring(1, line.indexOf(']'));
      const existing = sections.get(name);
      if (existing) {
        // Merge into existing section (rules.txt has repeated [UnitTypes] etc.)
        current = existing;
      } else {
        current = {
          name,
          entries: new Map(),
          listValues: [],
          orderedEntries: [],
        };
        sections.set(name, current);
      }
      continue;
    }

    if (!current) continue;

    // Key=value
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      const key = line.substring(0, eqIdx).trim();
      const value = line.substring(eqIdx + 1).trim();
      current.entries.set(key, value); // last-wins for duplicates
      current.orderedEntries.push([key, value]);
    } else if (line.length > 0) {
      // Bare value (list entry)
      current.listValues.push(line);
    }
  }

  return { sections };
}

/** Get a numeric value from a raw section, returning undefined if not present */
export function rawNum(section: RawSection | undefined, key: string): number | undefined {
  if (!section) return undefined;
  const v = section.entries.get(key);
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

/** Get a string value from a raw section */
export function rawStr(section: RawSection | undefined, key: string): string | undefined {
  if (!section) return undefined;
  return section.entries.get(key);
}

/** Get a boolean value from a raw section */
export function rawBool(section: RawSection | undefined, key: string): boolean | undefined {
  if (!section) return undefined;
  const v = section.entries.get(key);
  if (v === undefined) return undefined;
  return v.toLowerCase() === 'true' || v === '1';
}

/** Get a comma-separated list from a raw section */
export function rawList(section: RawSection | undefined, key: string): string[] | undefined {
  if (!section) return undefined;
  const v = section.entries.get(key);
  if (v === undefined) return undefined;
  return v.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
