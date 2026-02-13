export interface ArtEntry {
  icon: string;
  iconGrey: string;
  xaf: string;
  sideBarType: string;
}

export function parseArtIni(text: string): Map<string, ArtEntry> {
  const entries = new Map<string, ArtEntry>();
  let currentName = '';
  let current: ArtEntry | null = null;

  for (const rawLine of text.split('\n')) {
    const commentIdx = rawLine.indexOf('//');
    const line = (commentIdx >= 0 ? rawLine.substring(0, commentIdx) : rawLine).trim();
    if (!line) continue;

    // Section header
    if (line.startsWith('[') && line.includes(']')) {
      if (current && currentName) {
        entries.set(currentName, current);
      }
      currentName = line.substring(1, line.indexOf(']'));
      current = { icon: '', iconGrey: '', xaf: '', sideBarType: '' };
      continue;
    }

    if (!current) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;

    const key = line.substring(0, eqIdx).trim();
    let value = line.substring(eqIdx + 1).trim();
    // Strip quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1);
    }

    switch (key) {
      case 'Icon': current.icon = value.replace(/\\\\/g, '/'); break;
      case 'IconGrey': current.iconGrey = value.replace(/\\\\/g, '/'); break;
      case 'Xaf': current.xaf = value; break;
      case 'SideBarType': current.sideBarType = value; break;
    }
  }

  if (current && currentName) {
    entries.set(currentName, current);
  }

  return entries;
}
