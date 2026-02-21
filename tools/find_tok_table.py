#!/usr/bin/env python3
"""
Search GAME.EXE for the .tok string table (STR[N] mapping).

RESULT: The .tok string table is NOT a static pointer table in GAME.EXE.
It is built at runtime from rules.txt. The definitive mapping was determined
by cross-referencing Start missions (see extract_string_table.py):

  Buildings (wrapping at 128):
    STR[111..124] = HK military buildings (14 entries)
    STR[125..127, 0..10] = AT military buildings (14 entries)
    STR[11..23] = OR military buildings (13 entries)
    STR[24..32] = Subhouse + utility buildings (9 entries)
  Units:
    STR[33..110] = Units in rules.txt [UnitTypes] order (78 entries)

The bytecode encoding allows indices 0-127 (0x82 prefix, S-0x80).

This script was an intermediate research tool used to verify the mapping.
The authoritative table is in extract_string_table.py and tok_string_table.json.
"""

import struct
import os
import re
import glob
import collections

GAME_EXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gamedata', 'GAME.EXE')
RULES_TXT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'extracted', 'MODEL0001', 'rules.txt')
DECOMPILED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'decompiled_missions')


def parse_rules_type_names(rules_path):
    """Extract ordered type names from [UnitTypes] and [BuildingTypes] sections."""
    unit_types = []
    building_types = []
    current = None

    with open(rules_path) as f:
        for line in f:
            line = line.strip()
            if line == '[UnitTypes]':
                current = 'unit'
                continue
            elif line == '[BuildingTypes]':
                current = 'building'
                continue
            elif line.startswith('['):
                current = None
                continue
            if current:
                if '//' in line:
                    line = line[:line.index('//')]
                line = line.strip()
                if line:
                    if current == 'unit':
                        unit_types.append(line)
                    elif current == 'building':
                        building_types.append(line)

    return unit_types, building_types


def parse_pe_headers(data):
    """Parse PE headers for info display."""
    if data[:2] != b'MZ':
        raise ValueError("Not a valid PE file")
    pe_offset = struct.unpack_from('<I', data, 0x3C)[0]
    if data[pe_offset:pe_offset+4] != b'PE\x00\x00':
        raise ValueError("Not a valid PE file")

    coff_offset = pe_offset + 4
    num_sections = struct.unpack_from('<H', data, coff_offset + 2)[0]
    optional_header_size = struct.unpack_from('<H', data, coff_offset + 16)[0]
    opt_offset = coff_offset + 20
    image_base = struct.unpack_from('<I', data, opt_offset + 28)[0]

    sections_offset = opt_offset + optional_header_size
    sections = []
    for i in range(num_sections):
        sec_off = sections_offset + i * 40
        name = data[sec_off:sec_off+8].rstrip(b'\x00').decode('ascii', errors='replace')
        virtual_addr = struct.unpack_from('<I', data, sec_off + 12)[0]
        raw_size = struct.unpack_from('<I', data, sec_off + 16)[0]
        raw_offset = struct.unpack_from('<I', data, sec_off + 20)[0]
        sections.append({
            'name': name, 'virtual_addr': virtual_addr,
            'raw_size': raw_size, 'raw_offset': raw_offset,
        })
        print(f"  Section: {name:8s}  VA=0x{virtual_addr:08X}  RawOff=0x{raw_offset:08X}  Size=0x{raw_size:08X}")

    return image_base, sections


def file_offset_to_va(offset, sections, image_base):
    for sec in sections:
        if sec['raw_offset'] <= offset < sec['raw_offset'] + sec['raw_size']:
            return image_base + offset - sec['raw_offset'] + sec['virtual_addr']
    return None


def find_string_in_binary(data, name, image_base, sections):
    """Find all occurrences of a null-terminated string in binary."""
    needle = name.encode('ascii') + b'\x00'
    results = []
    start = 0
    while True:
        pos = data.find(needle, start)
        if pos == -1:
            break
        if pos == 0 or data[pos - 1] == 0:
            va = file_offset_to_va(pos, sections, image_base)
            results.append((pos, va))
        start = pos + 1
    return results


def gather_str_usage():
    """Analyze decompiled missions for STR[N] usage."""
    idx_data = collections.defaultdict(lambda: {'missions': set(), 'houses': set(), 'count': 0})

    for f in sorted(glob.glob(os.path.join(DECOMPILED_DIR, '*.txt'))):
        basename = os.path.basename(f)
        house = None
        if basename[:2] in ('AT', 'HK', 'OR', 'FR', 'IM'):
            house = basename[:2]

        with open(f) as fh:
            content = fh.read()
            for m in re.finditer(r'STR\[(\d+)\]', content):
                idx = int(m.group(1))
                idx_data[idx]['missions'].add(basename)
                idx_data[idx]['count'] += 1
                if house:
                    idx_data[idx]['houses'].add(house)

    return idx_data


def main():
    print("=" * 80)
    print("GAME.EXE .tok String Table (STR[N]) Finder & Mapper")
    print("=" * 80)
    print()

    # Load and parse GAME.EXE
    with open(GAME_EXE, 'rb') as f:
        data = f.read()
    print(f"Loaded GAME.EXE: {len(data):,} bytes")

    image_base, sections = parse_pe_headers(data)
    print(f"Image Base: 0x{image_base:08X}")
    print()

    # Parse rules.txt for ordered type names
    unit_types, building_types = parse_rules_type_names(RULES_TXT)
    combined = unit_types + building_types
    print(f"rules.txt: {len(unit_types)} unit types + {len(building_types)} building types = {len(combined)} total")
    print()

    # Verify strings exist in GAME.EXE binary
    print("Verifying type name strings in GAME.EXE...")
    found_count = 0
    not_found = []
    for i, name in enumerate(combined[:128]):
        locs = find_string_in_binary(data, name, image_base, sections)
        if locs:
            found_count += 1
        else:
            not_found.append((i, name))

    print(f"  {found_count}/128 type names found as null-terminated strings in binary")
    if not_found:
        print(f"  Not found ({len(not_found)}): {[f'STR[{i}]={n}' for i, n in not_found[:10]]}")
    print()

    # Gather STR[N] usage from decompiled scripts
    print("Analyzing STR[N] usage in decompiled mission scripts...")
    idx_data = gather_str_usage()
    used_count = len(idx_data)
    total_refs = sum(d['count'] for d in idx_data.values())
    print(f"  {used_count} unique STR indices used, {total_refs} total references")
    print()

    # =========================================================================
    # EVIDENCE: Verify the mapping using binary string locations
    # =========================================================================
    print("=" * 80)
    print("EVIDENCE: Verifying STR[N] -> rules.txt ordering")
    print("=" * 80)
    print()

    # The 30-entry pointer table at VA 0x5F02E0 contains unit name pointers.
    # It's an AI substitution table, not the STR table itself.
    # But we can verify: the strings in the pointer table at 0x1F02E0 match
    # the string pool at 0x1F0358+, which is where the unit type name strings
    # are laid out in rules.txt order.
    
    # Verify string pool ordering matches rules.txt ordering
    print("String pool verification (type names laid out in binary):")
    pool_start = 0x1F0358  # Start of unit name strings in .data section
    pool_entries = []
    off = pool_start
    while off < pool_start + 0x500 and off < len(data):
        if data[off] != 0:
            end = data.find(b'\x00', off)
            if end != -1 and end - off < 100:
                try:
                    s = data[off:end].decode('ascii')
                    if s.isprintable():
                        pool_entries.append((off, s))
                except:
                    pass
                off = end + 1
            else:
                off += 1
        else:
            off += 1

    print(f"  Found {len(pool_entries)} strings starting at 0x{pool_start:06X}:")
    for off, s in pool_entries[:15]:
        va = file_offset_to_va(off, sections, image_base)
        print(f"    0x{off:06X} (VA=0x{va:08X}): \"{s}\"")
    if len(pool_entries) > 15:
        print(f"    ... and {len(pool_entries) - 15} more")
    print()

    # =========================================================================
    # COMPLETE MAPPING TABLE
    # =========================================================================
    print("=" * 80)
    print("COMPLETE .tok STRING TABLE MAPPING (STR[N] -> Type Name)")
    print("=" * 80)
    print()
    print("The .tok bytecode string table maps STR[N] to the Nth entry in the")
    print("combined [UnitTypes] + [BuildingTypes] list from rules.txt.")
    print()
    print(f"{'Index':<7s} {'Hex':<7s} {'Type Name':<25s} {'Category':<10s} {'Used':<5s} {'Refs':<6s} {'Missions':<10s} Houses")
    print("-" * 95)

    for idx in range(128):
        name = combined[idx] if idx < len(combined) else '???'
        cat = 'Unit' if idx < len(unit_types) else 'Building'
        d = idx_data.get(idx, {'missions': set(), 'houses': set(), 'count': 0})
        used = 'YES' if idx in idx_data else ''
        refs = d['count']
        missions_ct = len(d['missions'])
        houses = ','.join(sorted(d['houses']))

        print(f"[{idx:4d}]  0x{idx:02X}   {name:<25s} {cat:<10s} {used:<5s} {refs:<6d} {missions_ct:<10d} {houses}")

    print()
    print("=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print()
    print(f"  STR[0..{len(unit_types)-1}]   = UnitTypes ({len(unit_types)} entries)")
    print(f"  STR[{len(unit_types)}..127] = BuildingTypes (first {128 - len(unit_types)} of {len(building_types)} entries)")
    print()
    print("  The .tok bytecode 0x82 prefix encodes string indices as:")
    print("    0x82 <S> where S >= 0x80 => index = S - 0x80 (range 0-127)")
    print()
    print("  This means only the first 128 types (100 units + 28 buildings) are")
    print("  directly addressable in .tok scripts. The remaining 124 building")
    print("  types are not used in mission scripts.")
    print()
    
    # Cross-reference: the 30-entry pointer table we found
    print("BONUS: AI Unit Substitution Table at VA 0x5F02E0 (file offset 0x1F02E0)")
    print("  This is NOT the STR table. It appears to be an AI combat unit")
    print("  preference/substitution table, grouped by house (AT/OR/HK, 10 each):")
    
    table_offset = 0x1F02E0
    for i in range(30):
        ptr = struct.unpack_from('<I', data, table_offset + i * 4)[0]
        # Find what string this points to
        rva = ptr - image_base
        for sec in sections:
            if sec['virtual_addr'] <= rva < sec['virtual_addr'] + sec['raw_size']:
                fo = rva - sec['virtual_addr'] + sec['raw_offset']
                end = data.find(b'\x00', fo)
                if end != -1:
                    s = data[fo:end].decode('ascii', errors='replace')
                    group = 'AT' if i < 10 else ('OR' if i < 20 else 'HK')
                    print(f"    [{i:2d}] ({group}) {s}")
                break
    print()


if __name__ == '__main__':
    main()
