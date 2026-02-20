import { describe, it, expect } from 'vitest';
import { parseArtIni } from '../../src/config/ArtIniParser';

describe('parseArtIni', () => {
  it('parses basic entries', () => {
    // Double backslashes in template = literal \\ in the INI text (Windows paths)
    const result = parseArtIni(`
[ATLightInf]
Icon=data\\\\icons\\\\at_lightinf.png
IconGrey=data\\\\icons\\\\at_lightinf_grey.png
Xaf=ATLightInf_idle
SideBarType=Infantry
`);
    expect(result.size).toBe(1);
    const entry = result.get('ATLightInf')!;
    expect(entry.icon).toBe('data/icons/at_lightinf.png');
    expect(entry.iconGrey).toBe('data/icons/at_lightinf_grey.png');
    expect(entry.xaf).toBe('ATLightInf_idle');
    expect(entry.sideBarType).toBe('Infantry');
  });

  it('strips quotes from values', () => {
    const result = parseArtIni(`
[TestUnit]
Icon="data\\\\icons\\\\test.png"
`);
    expect(result.get('TestUnit')!.icon).toBe('data/icons/test.png');
  });

  it('handles multiple sections', () => {
    const result = parseArtIni(`
[UnitA]
Icon=a.png
SideBarType=Vehicle

[UnitB]
Icon=b.png
SideBarType=Structure
`);
    expect(result.size).toBe(2);
    expect(result.get('UnitA')!.icon).toBe('a.png');
    expect(result.get('UnitB')!.sideBarType).toBe('Structure');
  });

  it('strips comments', () => {
    const result = parseArtIni(`
// Header comment
[TestUnit]
Icon=test.png // inline comment
SideBarType=Infantry
`);
    expect(result.get('TestUnit')!.icon).toBe('test.png');
  });

  it('handles empty input', () => {
    expect(parseArtIni('').size).toBe(0);
  });

  it('handles section with no entries', () => {
    const result = parseArtIni(`
[EmptySection]
[NextSection]
Icon=next.png
`);
    expect(result.size).toBe(2);
    const empty = result.get('EmptySection')!;
    expect(empty.icon).toBe('');
    expect(empty.sideBarType).toBe('');
  });

  it('converts double backslashes to forward slashes in paths', () => {
    const result = parseArtIni(`
[Test]
Icon=data\\\\textures\\\\units\\\\tank.png
IconGrey=data\\\\textures\\\\units\\\\tank_grey.png
`);
    expect(result.get('Test')!.icon).toBe('data/textures/units/tank.png');
    expect(result.get('Test')!.iconGrey).toBe('data/textures/units/tank_grey.png');
  });

  it('preserves single backslashes (non-Windows path)', () => {
    const result = parseArtIni(`
[Test]
Icon=data\\icons\\test.png
`);
    // Single backslashes are NOT converted (regex matches \\\\ only)
    expect(result.get('Test')!.icon).toBe('data\\icons\\test.png');
  });
});
