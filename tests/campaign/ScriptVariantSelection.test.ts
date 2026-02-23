/**
 * Tests for mission script variant selection (M → D → Fail/Win chain).
 */
import { describe, it, expect } from 'vitest';
import { selectScriptVariant } from '../../src/campaign/MissionConfig';
import type { TerritoryAttempt } from '../../src/campaign/CampaignPhaseManager';

describe('selectScriptVariant', () => {
  it('returns M-variant for first attempt (no history)', () => {
    expect(selectScriptVariant('ATP1M1FR', undefined)).toBe('ATP1M1FR');
  });

  it('returns M-variant for zero-attempt history', () => {
    const history: TerritoryAttempt = { attempts: 0, lastOutcome: 'none' };
    expect(selectScriptVariant('ATP1M1FR', history)).toBe('ATP1M1FR');
  });

  it('returns D-variant for second attempt', () => {
    const history: TerritoryAttempt = { attempts: 1, lastOutcome: 'none' };
    expect(selectScriptVariant('ATP1M1FR', history)).toBe('ATP1D1FR');
  });

  it('returns D-variant with correct territory number', () => {
    const history: TerritoryAttempt = { attempts: 1, lastOutcome: 'none' };
    expect(selectScriptVariant('HKP2M14IX', history)).toBe('HKP2D14IX');
    expect(selectScriptVariant('ORP3M10TL', history)).toBe('ORP3D10TL');
  });

  it('returns Fail variant after losing D-variant', () => {
    const history: TerritoryAttempt = { attempts: 2, lastOutcome: 'defeat' };
    expect(selectScriptVariant('ATP1M1FR', history)).toBe('ATP1D1FRFail');
  });

  it('returns Win variant after winning D-variant', () => {
    const history: TerritoryAttempt = { attempts: 2, lastOutcome: 'victory' };
    expect(selectScriptVariant('ATP1M19GN', history)).toBe('ATP1D19GNWin');
  });

  it('returns D-variant for special missions (no M/D pattern)', () => {
    // Special missions don't have M→D variant pattern
    const history: TerritoryAttempt = { attempts: 1, lastOutcome: 'none' };
    expect(selectScriptVariant('Atreides Heighliner Mission', history)).toBe('Atreides Heighliner Mission');
    expect(selectScriptVariant('ATENDMission', history)).toBe('ATENDMission');
  });

  it('handles multi-digit phase and territory IDs', () => {
    const history: TerritoryAttempt = { attempts: 1, lastOutcome: 'none' };
    expect(selectScriptVariant('ATP2M16TL', history)).toBe('ATP2D16TL');
  });

  it('returns Fail for 3+ attempts after defeat', () => {
    const history: TerritoryAttempt = { attempts: 5, lastOutcome: 'defeat' };
    expect(selectScriptVariant('HKP1M1FR', history)).toBe('HKP1D1FRFail');
  });
});
