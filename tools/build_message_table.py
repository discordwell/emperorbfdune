#!/usr/bin/env python3
"""
Extract per-house MissionMessages from E_Output_Pickup.txt (UTF-16LE)
and build assets/data/mission-messages.json.

The file has sections: Briefing, [END], Debriefing, [END], MissionMessages, [END]
repeated for each house (AT, HK, OR). There are also per-mission MissionMessages
sections later in the file. Both are combined per-house.

Within each MissionMessages section, non-empty lines with a tab separator are
message entries. The Message(N) function in .tok scripts uses a 1-based index
into the house-specific entry list.
"""

import json
import os
import re
import sys
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent
STRINGS_FILE = ROOT / "extracted" / "STRINGS0001" / "E_Output_Pickup.txt"
OUTPUT_FILE = ROOT / "assets" / "data" / "mission-messages.json"
DECOMPILED_DIR = ROOT / "decompiled_missions"

HOUSE_PREFIXES = ("AT", "HK", "OR")


def clean_text(raw: str) -> str:
    """Strip surrounding quotes and braces from message text."""
    text = raw.strip()
    if text.startswith('"') and text.endswith('"'):
        text = text[1:-1].strip()
    if text.startswith('{') and text.endswith('}'):
        text = text[1:-1].strip()
    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def detect_house(key: str) -> str | None:
    """Determine which house a message key belongs to."""
    key_upper = key.upper()
    # Direct prefix match
    for prefix in HOUSE_PREFIXES:
        if key_upper.startswith(prefix):
            return prefix
    # Special prefixes: DAT -> AT, HHK -> HK
    if key_upper.startswith('DAT'):
        return 'AT'
    if key_upper.startswith('HHK'):
        return 'HK'
    return None


def parse_strings_file(path: Path) -> dict[str, list[tuple[str, str]]]:
    """
    Parse E_Output_Pickup.txt and return per-house MissionMessages entries.
    Returns { 'AT': [(key, text), ...], 'HK': [...], 'OR': [...] }
    """
    raw = path.read_bytes()
    # Strip BOM if present
    if raw[:2] == b'\xff\xfe':
        text = raw[2:].decode('utf-16-le')
    elif raw[:2] == b'\xfe\xff':
        text = raw[2:].decode('utf-16-be')
    else:
        text = raw.decode('utf-16')

    lines = text.splitlines()
    print(f"  File has {len(lines)} lines")

    # Find all MissionMessages sections
    in_mission_messages = False
    section_count = 0
    house_entries: dict[str, list[tuple[str, str]]] = {h: [] for h in HOUSE_PREFIXES}

    for i, line in enumerate(lines):
        stripped = line.strip()

        # Detect [END] marker
        if stripped.startswith('[END]'):
            if in_mission_messages:
                in_mission_messages = False
            continue

        # Detect MissionMessages header
        if stripped.startswith('MissionMessages'):
            in_mission_messages = True
            section_count += 1
            continue

        if not in_mission_messages:
            continue

        # Skip empty lines and comments
        if not stripped or stripped.startswith(';'):
            continue

        # Parse tab-separated key-value
        if '\t' not in stripped:
            continue

        parts = stripped.split('\t', 1)
        key = parts[0].strip()
        value = parts[1].strip() if len(parts) > 1 else ''

        if not key or not value:
            continue

        # Determine house from key
        house = detect_house(key)
        if not house:
            continue

        msg_text = clean_text(value)
        if msg_text:
            house_entries[house].append((key, msg_text))

    print(f"  Found {section_count} MissionMessages sections")
    return house_entries


def extract_message_ids(decompiled_dir: Path) -> dict[str, set[int]]:
    """
    Parse all decompiled .tok scripts to find Message(N) calls.
    Returns { 'AT': {5, 6, 7, ...}, 'HK': {...}, 'OR': {...} }
    """
    pattern = re.compile(r'Message\s*\((\d+)\)')
    house_ids: dict[str, set[int]] = defaultdict(set)

    for tok_file in sorted(decompiled_dir.glob("*.txt")):
        name = tok_file.stem.upper()
        house = None
        for prefix in HOUSE_PREFIXES:
            if name.startswith(prefix):
                house = prefix
                break
        # Also detect special missions
        if not house:
            if 'DAT' in name or 'ATEND' in name or 'ATJUMP' in name:
                house = 'AT'
            elif 'HHK' in name or 'HKEND' in name or 'HKJUMP' in name:
                house = 'HK'
            elif 'OREND' in name or 'ORJUMP' in name:
                house = 'OR'

        if not house:
            continue

        content = tok_file.read_text(errors='replace')
        for match in pattern.finditer(content):
            msg_id = int(match.group(1))
            house_ids[house].add(msg_id)

    return dict(house_ids)


def build_message_table():
    print(f"Parsing: {STRINGS_FILE}")
    house_entries = parse_strings_file(STRINGS_FILE)

    for house, entries in house_entries.items():
        print(f"  {house}: {len(entries)} message entries")

    # Build 1-based index lookup
    result: dict[str, dict[str, str]] = {}
    key_names: dict[str, dict[str, str]] = {}
    for house, entries in house_entries.items():
        msg_map = {}
        name_map = {}
        for idx, (key, text) in enumerate(entries, start=1):
            msg_map[str(idx)] = text
            name_map[str(idx)] = key
        result[house] = msg_map
        key_names[house] = name_map

    # Cross-validate against decompiled missions
    print(f"\nCross-validating against decompiled missions in: {DECOMPILED_DIR}")
    script_ids = extract_message_ids(DECOMPILED_DIR)

    all_ok = True
    for house in HOUSE_PREFIXES:
        used_ids = script_ids.get(house, set())
        available = len(house_entries.get(house, []))
        max_used = max(used_ids) if used_ids else 0
        coverage = sum(1 for i in used_ids if i <= available)

        print(f"  {house}: scripts use IDs {min(used_ids) if used_ids else 0}-{max_used} "
              f"({len(used_ids)} unique), table has {available} entries, "
              f"coverage: {coverage}/{len(used_ids)}")

        if max_used > available:
            print(f"  WARNING: {house} scripts reference ID {max_used} but only {available} entries exist!")
            all_ok = False

        # Show sample mappings for common IDs
        if used_ids and house_entries.get(house):
            samples = sorted(used_ids)[:5]
            for sample_id in samples:
                if sample_id <= len(house_entries[house]):
                    key, text = house_entries[house][sample_id - 1]
                    preview = text[:80] + "..." if len(text) > 80 else text
                    print(f"    Message({sample_id}) = [{key}] \"{preview}\"")

    # Write output
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\nWrote: {OUTPUT_FILE} ({os.path.getsize(OUTPUT_FILE)} bytes)")

    # Write debug key mapping
    debug_file = OUTPUT_FILE.parent / "mission-messages-keys.json"
    with open(debug_file, 'w', encoding='utf-8') as f:
        json.dump(key_names, f, ensure_ascii=False, indent=2)
    print(f"Wrote: {debug_file} (key names for debugging)")

    return all_ok


if __name__ == '__main__':
    ok = build_message_table()
    sys.exit(0 if ok else 1)
