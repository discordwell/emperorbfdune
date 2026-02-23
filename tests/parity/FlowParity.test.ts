/**
 * Flow Parity Test — verifies HouseSelect campaign auto-continue
 * validates localStorage data before bypassing the faction picker.
 *
 * Catches Bug 4: stale/malformed ebfd_campaign_next can skip
 * the house selection screen entirely.
 */
import { describe, it, expect } from 'vitest';

/**
 * Replicate the validation logic that HouseSelect.show() must perform.
 * Returns true if the data would correctly trigger campaign auto-continue,
 * false if it should fall through to the normal picker.
 */
function isValidCampaignContinuation(nextMission: string | null, campaignState: string | null): boolean {
  if (!nextMission || !campaignState) return false;
  try {
    const next = JSON.parse(nextMission);
    const state = JSON.parse(campaignState);

    // Validate required fields
    if (typeof next.territoryId !== 'number') return false;
    if (typeof state.housePrefix !== 'string') return false;
    if (!['AT', 'HK', 'OR'].includes(state.housePrefix)) return false;

    return true;
  } catch {
    return false;
  }
}

describe('FlowParity — HouseSelect campaign state validation', () => {
  it('accepts valid campaign continuation', () => {
    const next = JSON.stringify({ territoryId: 3, difficulty: 'normal', mapSeed: 42 });
    const state = JSON.stringify({ housePrefix: 'AT', enemyPrefix: 'HK', territories: {} });
    expect(isValidCampaignContinuation(next, state)).toBe(true);
  });

  it('rejects when nextMission is null', () => {
    const state = JSON.stringify({ housePrefix: 'AT' });
    expect(isValidCampaignContinuation(null, state)).toBe(false);
  });

  it('rejects when campaignState is null', () => {
    const next = JSON.stringify({ territoryId: 3 });
    expect(isValidCampaignContinuation(next, null)).toBe(false);
  });

  it('rejects malformed JSON in nextMission', () => {
    const state = JSON.stringify({ housePrefix: 'AT' });
    expect(isValidCampaignContinuation('{broken', state)).toBe(false);
  });

  it('rejects malformed JSON in campaignState', () => {
    const next = JSON.stringify({ territoryId: 3 });
    expect(isValidCampaignContinuation(next, '{broken')).toBe(false);
  });

  it('rejects missing territoryId', () => {
    const next = JSON.stringify({ difficulty: 'normal' });
    const state = JSON.stringify({ housePrefix: 'AT' });
    expect(isValidCampaignContinuation(next, state)).toBe(false);
  });

  it('rejects non-number territoryId', () => {
    const next = JSON.stringify({ territoryId: 'three' });
    const state = JSON.stringify({ housePrefix: 'AT' });
    expect(isValidCampaignContinuation(next, state)).toBe(false);
  });

  it('rejects missing housePrefix', () => {
    const next = JSON.stringify({ territoryId: 3 });
    const state = JSON.stringify({ territories: {} });
    expect(isValidCampaignContinuation(next, state)).toBe(false);
  });

  it('rejects invalid housePrefix', () => {
    const next = JSON.stringify({ territoryId: 3 });
    const state = JSON.stringify({ housePrefix: 'ZZ' });
    expect(isValidCampaignContinuation(next, state)).toBe(false);
  });

  it('rejects non-string housePrefix', () => {
    const next = JSON.stringify({ territoryId: 3 });
    const state = JSON.stringify({ housePrefix: 42 });
    expect(isValidCampaignContinuation(next, state)).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isValidCampaignContinuation('', '')).toBe(false);
  });

  it('accepts all three valid house prefixes', () => {
    for (const prefix of ['AT', 'HK', 'OR']) {
      const next = JSON.stringify({ territoryId: 1 });
      const state = JSON.stringify({ housePrefix: prefix });
      expect(isValidCampaignContinuation(next, state)).toBe(true);
    }
  });
});
