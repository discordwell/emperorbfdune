/**
 * Tests for .tok script ID resolution via manifest.
 * Verifies case-insensitive lookup and URL encoding for filenames with spaces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveTokFilename, _resetManifest } from '../../src/campaign/scripting/MissionScriptLoader';

// Mock fetch to serve the manifest
const MANIFEST: Record<string, string> = {
  'atp1m1fr': 'ATP1M1FR',
  'atp3d8tlfail': 'ATP3D8TlFail',           // lowercase 'l' anomaly
  'atp3m10fr': 'ATp3M10FR',                  // lowercase 'p' anomaly
  'orp1d15sa': 'orp1d15sa',                   // fully lowercase anomaly
  'atreides heighliner mission': 'Atreides Heighliner Mission',  // spaces
  'hhk civil war attack mission': 'HHK Civil War Attack Mission',
  'ordos homeworld assault _atreides': 'Ordos homeworld assault _Atreides',
  'dat save the duke': 'DAT Save The Duke',
  'attutorial': 'ATTutorial',
  'hkstart': 'HKStart',
  'orstart': 'ORStart',
};

// Intercept global fetch for manifest requests
const origFetch = globalThis.fetch;
beforeEach(() => {
  _resetManifest();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('tok-manifest.json')) {
      return new Response(JSON.stringify(MANIFEST), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return origFetch(input);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('Script ID Resolution', () => {
  it('resolves exact-case IDs', async () => {
    expect(await resolveTokFilename('ATP1M1FR')).toBe('ATP1M1FR');
  });

  it('resolves case-insensitively', async () => {
    expect(await resolveTokFilename('atp1m1fr')).toBe('ATP1M1FR');
    expect(await resolveTokFilename('Atp1m1FR')).toBe('ATP1M1FR');
  });

  it('resolves case anomaly: ATp3M10FR', async () => {
    expect(await resolveTokFilename('ATP3M10FR')).toBe('ATp3M10FR');
    expect(await resolveTokFilename('atp3m10fr')).toBe('ATp3M10FR');
  });

  it('resolves case anomaly: ATP3D8TlFail', async () => {
    expect(await resolveTokFilename('ATP3D8TLFAIL')).toBe('ATP3D8TlFail');
  });

  it('resolves case anomaly: orp1d15sa (fully lowercase)', async () => {
    expect(await resolveTokFilename('ORP1D15SA')).toBe('orp1d15sa');
  });

  it('resolves filenames with spaces', async () => {
    expect(await resolveTokFilename('Atreides Heighliner Mission')).toBe('Atreides Heighliner Mission');
    expect(await resolveTokFilename('atreides heighliner mission')).toBe('Atreides Heighliner Mission');
  });

  it('resolves special missions with spaces', async () => {
    expect(await resolveTokFilename('HHK Civil War Attack Mission')).toBe('HHK Civil War Attack Mission');
    expect(await resolveTokFilename('DAT Save The Duke')).toBe('DAT Save The Duke');
    expect(await resolveTokFilename('Ordos homeworld assault _Atreides')).toBe('Ordos homeworld assault _Atreides');
  });

  it('resolves tutorial and start scripts', async () => {
    expect(await resolveTokFilename('ATTutorial')).toBe('ATTutorial');
    expect(await resolveTokFilename('HKStart')).toBe('HKStart');
    expect(await resolveTokFilename('ORStart')).toBe('ORStart');
    // Case insensitive
    expect(await resolveTokFilename('attutorial')).toBe('ATTutorial');
  });

  it('returns null for non-existent scripts', async () => {
    expect(await resolveTokFilename('NONEXISTENT')).toBeNull();
    expect(await resolveTokFilename('')).toBeNull();
  });
});
