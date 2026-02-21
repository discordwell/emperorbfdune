#!/usr/bin/env python3
"""
Extract game string data from Emperor: Battle for Dune extracted files.

Produces:
  assets/data/display-names.json   - Unit/building internal name → display name
  assets/data/dialog-index.json    - UISPOKEN key → audio file number
  assets/data/phase-rules.json     - Campaign phase rules and tech level gates
"""

import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
STRINGS_DIR = os.path.join(PROJECT_ROOT, 'extracted', 'STRINGS0001')
CAMPAIGN_DIR = os.path.join(PROJECT_ROOT, 'extracted', 'CAMPAIGN0001')
OUTPUT_DIR = os.path.join(PROJECT_ROOT, 'assets', 'data')


def read_utf16le(path: str) -> str:
    """Read a UTF-16LE file (with or without BOM)."""
    with open(path, 'rb') as f:
        raw = f.read()
    if raw[:2] == b'\xff\xfe':
        return raw[2:].decode('utf-16-le', errors='replace')
    # Try UTF-16LE anyway
    try:
        return raw.decode('utf-16-le', errors='replace')
    except Exception:
        return raw.decode('utf-8', errors='replace')


def extract_display_names():
    """Parse 'Text strings.txt' → display-names.json.

    Format: key\\t{Display Name}
    Only extracts entries that look like unit/building names (faction-prefixed).
    """
    path = os.path.join(STRINGS_DIR, 'Text strings.txt')
    if not os.path.exists(path):
        print(f'WARNING: {path} not found, skipping display names')
        return

    text = read_utf16le(path)
    names = {}

    for line in text.split('\n'):
        line = line.strip().replace('\r', '')
        if not line or line.startswith(';') or line.startswith('['):
            continue
        if '\t' not in line:
            continue

        parts = line.split('\t', 1)
        key = parts[0].strip()
        value_raw = parts[1].strip() if len(parts) > 1 else ''

        # Extract value from {curly braces}
        match = re.match(r'\{(.+?)\}', value_raw)
        if not match or not key:
            continue

        display_name = match.group(1)
        names[key] = display_name

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, 'display-names.json')
    with open(out_path, 'w') as f:
        json.dump(names, f, indent=2, ensure_ascii=False)

    print(f'Wrote {len(names)} display names to {out_path}')


def extract_dialog_index():
    """Parse UISPOKEN.TXT → dialog-index.json.

    Entry order determines file number: fileNum = (index - 1) * 2 + 4
    where index is the 1-based entry number.
    """
    path = os.path.join(STRINGS_DIR, 'UISPOKEN.TXT')
    if not os.path.exists(path):
        print(f'WARNING: {path} not found, skipping dialog index')
        return

    text = read_utf16le(path)
    dialog_map = {}
    entry_index = 0  # 0-based, we'll convert to 1-based for formula

    in_section = False
    for line in text.split('\n'):
        line = line.strip().replace('\r', '')
        if not line or line.startswith(';'):
            continue
        if line.startswith('[END]'):
            break
        # Skip section headers
        if not line.startswith('[') and not line.startswith(';'):
            # Check if this is a data entry (has tab and curly braces)
            if '\t' in line:
                parts = line.split('\t', 1)
                key = parts[0].strip()
                if key and not key.startswith(';'):
                    entry_index += 1
                    file_num = (entry_index - 1) * 2 + 4
                    dialog_map[key] = file_num
            elif '{' not in line and not line.startswith('['):
                # Section name line (like "IngameMessages")
                in_section = True

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, 'dialog-index.json')
    with open(out_path, 'w') as f:
        json.dump(dialog_map, f, indent=2, ensure_ascii=False)

    print(f'Wrote {len(dialog_map)} dialog entries to {out_path}')


def extract_phase_rules():
    """Parse PhaseRules.txt → phase-rules.json.

    INI-style sections: [Phase N] and [Tech Level N]
    """
    path = os.path.join(CAMPAIGN_DIR, 'PhaseRules.txt')
    if not os.path.exists(path):
        print(f'WARNING: {path} not found, skipping phase rules')
        return

    with open(path, 'r') as f:
        text = f.read()

    phases = {}
    tech_levels = {}
    current_section = None
    current_data = {}

    for line in text.split('\n'):
        line = line.strip()
        # Strip comments
        comment_idx = line.find('//')
        if comment_idx >= 0:
            line = line[:comment_idx].strip()
        if not line:
            continue

        # Section header
        section_match = re.match(r'\[(.+?)\]', line)
        if section_match:
            # Save previous section
            if current_section is not None:
                _save_section(current_section, current_data, phases, tech_levels)
            current_section = section_match.group(1)
            current_data = {}
            continue

        # Key-value pair
        if ' ' in line:
            parts = line.split(None, 1)
            key = parts[0]
            value = parts[1] if len(parts) > 1 else ''
            current_data[key] = value

    # Save last section
    if current_section is not None:
        _save_section(current_section, current_data, phases, tech_levels)

    result = {
        'phases': phases,
        'techLevels': tech_levels,
    }

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, 'phase-rules.json')
    with open(out_path, 'w') as f:
        json.dump(result, f, indent=2)

    print(f'Wrote {len(phases)} phases + {len(tech_levels)} tech levels to {out_path}')


def _save_section(name: str, data: dict, phases: dict, tech_levels: dict):
    phase_match = re.match(r'Phase (\d+)', name)
    tech_match = re.match(r'Tech Level (\d+)', name)

    if phase_match:
        phase_id = phase_match.group(1)
        phase_entry = {}
        for k, v in data.items():
            try:
                phase_entry[k[0].lower() + k[1:]] = int(v)
            except ValueError:
                phase_entry[k[0].lower() + k[1:]] = v
        phases[phase_id] = phase_entry
    elif tech_match:
        level = tech_match.group(1)
        tech_entry = {}
        for k, v in data.items():
            try:
                tech_entry[k[0].lower() + k[1:]] = int(v)
            except ValueError:
                tech_entry[k[0].lower() + k[1:]] = v
        tech_levels[level] = tech_entry


if __name__ == '__main__':
    print('Extracting game string data...')
    extract_display_names()
    extract_dialog_index()
    extract_phase_rules()
    print('Done.')
