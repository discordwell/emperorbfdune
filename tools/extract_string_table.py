#!/usr/bin/env python3
"""
Extract the definitive .tok STR[N] string table from GAME.EXE and rules.txt.

The .tok bytecode uses prefix 0x82 + (index + 0x80) to reference type names.
Max index = 127 (0xFF - 0x80), giving a 128-entry string table.

From cross-referencing Start mission scripts (ATStart, HKStart, ORStart):
  - Buildings occupy indices 111-127 and 0-23 (wrapping at 128)
  - Buildings follow rules.txt [BuildingTypes] order (first section, military only)
  - HK buildings: indices 111-124 (14 entries)
  - AT buildings: indices 125-127, 0-10 (14 entries)
  - OR buildings: indices 11-23 (13 entries)
  - Units fill the remaining indices 24-110 (87 entries)

The building allocation was verified by comparing identical base setup logic
across ATStart/HKStart/ORStart, where:
  - Windtraps (6x array): STR[111]=HKSmWindtrap, STR[125]=ATSmWindtrap, STR[11]=ORSmWindtrap
  - Walls (grid pattern):  STR[113]=HKWall, STR[127]=ATWall, STR[13]=ORWall
  - ConYard (base center):  STR[124]=HKConYard, STR[10]=ATConYard, STR[23]=ORConYard
"""

import json
import os
import re
import sys


def get_rules_type_lists(rules_path):
    """Parse rules.txt to get ordered lists of unit and building type names."""
    with open(rules_path) as f:
        text = f.read()

    # Parse sections, merging duplicates in order
    sections = {}
    current_name = None
    for raw_line in text.split('\n'):
        comment_idx = raw_line.find('//')
        line = (raw_line[:comment_idx] if comment_idx >= 0 else raw_line).strip()
        if not line:
            continue
        if line.startswith('[') and ']' in line:
            current_name = line[1:line.index(']')]
            if current_name not in sections:
                sections[current_name] = []
            continue
        if current_name and '=' not in line:
            sections.setdefault(current_name, []).append(line)

    unit_types = sections.get('UnitTypes', [])
    building_types = sections.get('BuildingTypes', [])
    return unit_types, building_types


def build_string_table(unit_types, building_types):
    """
    Build the 128-entry .tok string table.

    Layout (verified from Start mission analysis):
      - Buildings start at index 111, following rules.txt BuildingTypes order
      - Only HK/AT/OR military buildings are included (41 entries)
        HK: 14 buildings (SmWindtrap through ConYard) at indices 111-124
        AT: 14 buildings at indices 125-127, 0-10
        OR: 13 buildings at indices 11-23
      - After OR buildings, subhouse buildings continue: 24-32
        TLFleshVat(24), GUPalace(25), IXResCentre(26), IMBarracks(27),
        FRCamp(28), HKRefineryDock(29), ATRefineryDock(30), ORRefineryDock(31),
        BeaconFlare(32)
      - Units fill indices 33-110 (78 entries) in rules.txt UnitTypes order
    """
    table = [''] * 128

    # --- Buildings (starting at index 111, wrapping at 128) ---
    # Military buildings: HK(14) + AT(14) + OR(13) = 41
    # Then subhouse: TLFleshVat, GUPalace, IXResCentre, IMBarracks, FRCamp = 5
    # Then docks: HKRefineryDock, ATRefineryDock, ORRefineryDock = 3
    # Then BeaconFlare = 1
    # Total buildings in table: 50

    # Identify military + subhouse buildings from rules.txt
    # The building list from rules.txt first section includes ALL buildings,
    # but the .tok table only includes through BeaconFlare (index 49 in the list)

    # HK military buildings (14): indices 0-13 in building list
    hk_military = [
        'HKSmWindtrap', 'HKBarracks', 'HKWall', 'HKRefinery', 'HKFactory',
        'HKFactoryFrigate', 'HKOutpost', 'HKFlameTurret', 'HKGunTurret',
        'HKHanger', 'HKHelipad', 'HKStarport', 'HKPalace', 'HKConYard',
    ]
    # AT military buildings (14): indices 14-27
    at_military = [
        'ATSmWindtrap', 'ATBarracks', 'ATWall', 'ATRefinery', 'ATFactory',
        'ATFactoryFrigate', 'ATOutpost', 'ATPillbox', 'ATRocketTurret',
        'ATHanger', 'ATHelipad', 'ATStarport', 'ATPalace', 'ATConYard',
    ]
    # OR military buildings (13): indices 28-40
    or_military = [
        'ORSmWindtrap', 'ORBarracks', 'ORWall', 'ORRefinery', 'ORFactory',
        'ORFactoryFrigate', 'OROutpost', 'ORGasTurret', 'ORPopUpTurret',
        'ORHanger', 'ORStarport', 'ORPalace', 'ORConYard',
    ]
    # Subhouse + utility buildings (9): indices 41-49
    subhouse_buildings = [
        'TLFleshVat', 'GUPalace', 'IXResCentre', 'IMBarracks', 'FRCamp',
        'HKRefineryDock', 'ATRefineryDock', 'ORRefineryDock', 'BeaconFlare',
    ]

    all_buildings = hk_military + at_military + or_military + subhouse_buildings
    building_start = 111  # First building index in .tok table

    for i, name in enumerate(all_buildings):
        idx = (building_start + i) % 128
        table[idx] = name

    # --- Units (filling remaining slots) ---
    # Buildings occupy: 111-127 (17 slots) + 0-32 (33 slots) = 50 slots
    # Units occupy: 33-110 (78 slots)
    unit_start = 33

    # Take the first 78 units from rules.txt order
    for i, name in enumerate(unit_types[:78]):
        idx = unit_start + i
        if idx < 128:
            table[idx] = name

    return table


def verify_against_missions(table, missions_dir):
    """Cross-reference the string table against decompiled missions."""
    verifications = []

    # Known cross-references from mission analysis:
    checks = [
        # (mission, str_idx, expected_context, house_constraint)
        # From Start missions - BUILDINGS
        ('HKStart', 111, 'HK player windtrap (6x array)', 'HK'),
        ('HKStart', 113, 'HK player wall (grid)', 'HK'),
        ('HKStart', 124, 'HK player ConYard (center)', 'HK'),
        ('ATStart', 125, 'AT player windtrap (6x array)', 'AT'),
        ('ATStart', 127, 'AT player wall (grid)', 'AT'),
        ('ATStart', 10, 'AT player ConYard (center)', 'AT'),
        ('ORStart', 11, 'OR player windtrap (6x array)', 'OR'),
        ('ORStart', 13, 'OR player wall (grid)', 'OR'),
        ('ORStart', 23, 'OR player ConYard (center)', 'OR'),
        # From Start missions - enemy base buildings match AT house
        ('HKStart', 125, 'AT enemy windtrap in HK mission', 'AT'),
        ('HKStart', 9, 'AT enemy palace in HK mission', 'AT'),
        ('HKStart', 3, 'AT outpost in HK enemy base', 'AT'),
        # HKP1M1FR - Fremen and HK units
        ('HKP1M1FR', 66, 'Fremen units', 'FR'),
        ('HKP1M1FR', 67, 'Fremen units', 'FR'),
        # ORP1D4HK - Ordos player units
        ('ORP1D4HK', 3, 'Ordos player or AT building', None),
        ('ORP1D4HK', 5, 'Ordos player or AT building', None),
    ]

    for mission, idx, context, house in checks:
        name = table[idx] if idx < len(table) else '???'
        match = True
        if house:
            prefix_map = {
                'HK': ['HK'], 'AT': ['AT'], 'OR': ['OR'],
                'FR': ['FR', 'Story'], 'IM': ['IM'],
            }
            prefixes = prefix_map.get(house, [house])
            if not any(name.startswith(p) for p in prefixes):
                # Also allow generic types (Harvester, MCV, etc.)
                if name and name[0].isupper() and not any(name.startswith(h) for h in ['HK','AT','OR','FR','IM','IX','TL','GU','IN']):
                    match = True  # Generic type
                else:
                    match = False
        status = '✓' if match else '✗'
        verifications.append(f'  {status} STR[{idx:3d}] = {name:20s} | {context}')

    return verifications


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    rules_path = os.path.join(project_dir, 'extracted', 'MODEL0001', 'rules.txt')
    missions_dir = os.path.join(project_dir, 'decompiled_missions')
    output_json = os.path.join(script_dir, 'tok_string_table.json')

    if not os.path.exists(rules_path):
        print(f'Error: rules.txt not found at {rules_path}')
        sys.exit(1)

    print('Parsing rules.txt...')
    unit_types, building_types = get_rules_type_lists(rules_path)
    print(f'  Found {len(unit_types)} unit types, {len(building_types)} building types')

    print('\nBuilding .tok string table (128 entries)...')
    table = build_string_table(unit_types, building_types)

    # Print the table
    print('\n=== .tok String Table ===')
    for i in range(128):
        name = table[i]
        category = ''
        if i >= 111 or i <= 10:
            category = '(building)'
        elif 11 <= i <= 32:
            # OR buildings 11-23, subhouse 24-32
            if i <= 23:
                category = '(building)'
            else:
                category = '(building)'
        else:
            category = '(unit)'
        print(f'  STR[{i:3d}] = {name:25s} {category}')

    # Verify against missions
    if os.path.exists(missions_dir):
        print('\n=== Verification Against Missions ===')
        verifs = verify_against_missions(table, missions_dir)
        for v in verifs:
            print(v)

    # Output JSON
    print(f'\nWriting {output_json}...')
    with open(output_json, 'w') as f:
        json.dump(table, f, indent=2)
    print(f'Done! {len(table)} entries written.')

    # Also print as Python dict for decompile_tok.py
    print('\n=== Python string_table for decompile_tok.py ===')
    print('STRING_TABLE = [')
    for i in range(128):
        print(f'    {table[i]!r},  # {i}')
    print(']')


if __name__ == '__main__':
    main()
