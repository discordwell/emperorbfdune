#!/usr/bin/env python3
"""Parse Emperor: BFD UTF-16LE string files into campaign-strings.json.

String files use UTF-16LE encoding with tab-delimited format:
  KeyName\t{Value text}\t; Comments
  KeyName\t"{Quoted value}"\t; Comments

Outputs flat JSON dict: {"KeyName": "Value text", ...}
Combines:
  - Text strings.txt (territory names, UI strings)
  - Atreides/Harkonnen/Ordos Mission Text Strings.txt (briefings)
"""

import json
import os
import re
import sys

STRINGS_DIR = os.path.join(os.path.dirname(__file__), '..', 'extracted', 'STRINGS0001')
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), '..', 'assets', 'data', 'campaign-strings.json')

FILES = [
    'Text strings.txt',
    'Atreides Mission Text Strings.txt',
    'Harkonnen mission text strings.txt',
    'Ordos mission text strings.txt',
]


def decode_utf16le_with_nulls(filepath: str) -> str:
    """Read a UTF-16LE file, handling BOM and null-padded characters."""
    with open(filepath, 'rb') as f:
        raw = f.read()

    # Strip BOM if present
    if raw[:2] == b'\xff\xfe':
        raw = raw[2:]

    # Decode as UTF-16LE
    text = raw.decode('utf-16-le', errors='replace')

    return text


def parse_string_file(filepath: str) -> dict[str, str]:
    """Parse a single string file into key-value pairs."""
    text = decode_utf16le_with_nulls(filepath)
    result: dict[str, str] = {}
    current_section = ''

    for line in text.split('\n'):
        line = line.strip()
        if not line:
            continue

        # Skip pure comments
        if line.startswith(';'):
            continue

        # Section headers (bare words without tabs)
        if '\t' not in line and not line.startswith('[') and not line.startswith('#'):
            current_section = line
            continue

        # [END] markers
        if line.startswith('[END]'):
            continue

        # Skip commented-out entries
        if line.startswith(';'):
            continue

        # Split on tab
        parts = line.split('\t')
        if len(parts) < 2:
            continue

        key = parts[0].strip()
        if not key or key.startswith(';'):
            continue

        # Find the value in {braces}
        rest = '\t'.join(parts[1:])
        # Extract value from {braces} or "{quoted braces}"
        value_match = re.search(r'"?\{([^}]*)\}"?', rest)
        if value_match:
            value = value_match.group(1).strip()
            result[key] = value

    return result


def main():
    all_strings: dict[str, str] = {}

    for filename in FILES:
        filepath = os.path.join(STRINGS_DIR, filename)
        if not os.path.exists(filepath):
            print(f'WARNING: {filepath} not found, skipping', file=sys.stderr)
            continue

        strings = parse_string_file(filepath)
        print(f'Parsed {filename}: {len(strings)} entries')
        all_strings.update(strings)

    # Write output
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(all_strings, f, indent=2, ensure_ascii=False)

    print(f'\nTotal: {len(all_strings)} entries -> {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
