#!/usr/bin/env python3
"""
Analyze all decompiled .tok mission scripts to build a comprehensive mapping
of STR[N] indices, grouped by house context.

Scans all 228 missions in decompiled_missions/ and determines:
- Which STR[N] indices are used in which missions
- The function context (NewObject, SetThreatLevel, ObjectChange, etc.)
- The side context (GetPlayerSide, GetEnemySide, CreateSide, etc.)
- House associations based on filename prefixes/suffixes
"""

import os
import re
import sys
from collections import defaultdict
from pathlib import Path

MISSIONS_DIR = Path(__file__).parent.parent / "decompiled_missions"

# House prefix mappings from filenames
HOUSE_PREFIXES = {
    'AT': 'Atreides',
    'HK': 'Harkonnen',
    'OR': 'Ordos',
}

# Suffix mappings (subhouse/enemy)
SUFFIX_MAP = {
    'FR': 'Fremen',
    'SA': 'Sardaukar',
    'IX': 'Ix',
    'TL': 'Tleilaxu',
    'GU': 'Guild',
    'GN': 'Guild',  # GN appears to be Guild/Neutral
    'SM': 'Smugglers',
    'HK': 'Harkonnen',
    'AT': 'Atreides',
    'OR': 'Ordos',
}


def parse_filename(filename):
    """Extract player house, path number, mission type, and enemy/subhouse from filename."""
    name = filename.replace('.txt', '')
    
    # Normalize case for matching
    name_upper = name.upper()
    
    info = {
        'filename': filename,
        'player_house': None,
        'enemy_subhouse': None,
        'mission_type': None,  # 'start', 'end', 'main', 'dialog', 'tutorial', etc.
        'path': None,
        'is_fail': 'FAIL' in name_upper or 'WIN' in name_upper,
    }
    
    # Detect player house from prefix
    for prefix, house in HOUSE_PREFIXES.items():
        if name_upper.startswith(prefix):
            info['player_house'] = house
            break
    
    # Special missions
    if 'Start' in name:
        info['mission_type'] = 'start'
    elif 'END' in name_upper or 'End' in name:
        info['mission_type'] = 'end'
    elif 'Tutorial' in name:
        info['mission_type'] = 'tutorial'
    elif 'Jump' in name or 'jump' in name:
        info['mission_type'] = 'jump'
    elif 'Heighliner' in name:
        info['mission_type'] = 'heighliner'
        if 'Atreides' in name:
            info['player_house'] = 'Atreides'
        elif 'Harkonnen' in name or 'HHK' in name:
            info['player_house'] = 'Harkonnen'
        elif 'Ordos' in name:
            info['player_house'] = 'Ordos'
    elif 'homeworld' in name.lower() or 'Homeworld' in name:
        info['mission_type'] = 'homeworld'
        if 'Atreides' in name or '_AT' in name:
            if info['player_house'] is None:
                info['player_house'] = 'Atreides'
            else:
                info['enemy_subhouse'] = 'Atreides'
        if 'Harkonnen' in name or 'HK' in name.split('_')[-1] if '_' in name else False:
            if info['player_house'] is None:
                info['player_house'] = 'Harkonnen'
            else:
                info['enemy_subhouse'] = 'Harkonnen'
        if 'Ordos' in name or '_OR' in name:
            if info['player_house'] is None:
                info['player_house'] = 'Ordos'
            else:
                info['enemy_subhouse'] = 'Ordos'
    elif 'Civil War' in name:
        info['mission_type'] = 'civil_war'
        info['player_house'] = 'Harkonnen'
    elif 'Save The Duke' in name or 'DAT' in name:
        info['mission_type'] = 'special'
        info['player_house'] = 'Atreides'
    
    # Parse standard mission format: XXP#M#YY or XXP#D#YY
    match = re.match(r'([A-Za-z]{2})P(\d+)([MD])(\d+)([A-Za-z]*)', name, re.IGNORECASE)
    if match:
        prefix = match.group(1).upper()
        info['path'] = int(match.group(2))
        info['mission_type'] = 'main' if match.group(3).upper() == 'M' else 'dialog'
        suffix = match.group(5).upper()
        
        # Remove Fail/Win from suffix
        for tag in ['FAIL', 'WIN']:
            suffix = suffix.replace(tag, '')
        
        if suffix in SUFFIX_MAP:
            info['enemy_subhouse'] = SUFFIX_MAP[suffix]
    
    # Handle T36 missions
    if name.startswith('T36'):
        info['mission_type'] = 'homeworld'
        if 'Atreides' in name:
            info['player_house'] = 'Atreides'
        if '_OR' in name:
            info['enemy_subhouse'] = 'Ordos'
    
    # Handle named Harkonnen/Ordos homeworld missions
    if 'Harkonnen homeworld' in name:
        info['player_house'] = 'Harkonnen'
        info['mission_type'] = 'homeworld'
        if '_AT' in name:
            info['enemy_subhouse'] = 'Atreides'
        elif '_OR' in name:
            info['enemy_subhouse'] = 'Ordos'
    
    if 'Ordos homeworld' in name or 'Ordos Homeworld' in name:
        info['player_house'] = 'Ordos'
        info['mission_type'] = 'homeworld'
        if 'Atreides' in name or '_Atreides' in name:
            info['enemy_subhouse'] = 'Atreides'
    
    return info


def analyze_mission_file(filepath):
    """Parse a decompiled mission script and extract all STR[N] references with context."""
    with open(filepath, 'r') as f:
        content = f.read()
    
    lines = content.split('\n')
    
    str_refs = []  # List of dicts
    
    # Track side variable assignments
    side_vars = {}  # var_name -> side_type
    
    # First pass: find side assignments
    for line in lines:
        line_stripped = line.strip()
        
        m = re.match(r'(int_\d+)\s*=\s*GetPlayerSide\s*\(\)', line_stripped)
        if m:
            side_vars[m.group(1)] = 'PlayerSide'
        
        m = re.match(r'(int_\d+)\s*=\s*GetEnemySide\s*\(\)', line_stripped)
        if m:
            side_vars[m.group(1)] = 'EnemySide'
            
        m = re.match(r'(int_\d+)\s*=\s*GetSecondPlayerSide\s*\(\)', line_stripped)
        if m:
            side_vars[m.group(1)] = 'SecondPlayerSide'
        
        m = re.match(r'(int_\d+)\s*=\s*CreateSide\s*\(\)', line_stripped)
        if m:
            side_vars[m.group(1)] = 'CreatedSide'
    
    # Track SideFriendTo / SideEnemyTo relationships
    friend_relations = []
    enemy_relations = []
    
    for line in lines:
        line_stripped = line.strip()
        
        m = re.match(r'SideFriendTo\s*\((.+?),\s*(.+?)\)', line_stripped)
        if m:
            friend_relations.append((m.group(1).strip(), m.group(2).strip()))
        
        m = re.match(r'SideEnemyTo\s*\((.+?),\s*(.+?)\)', line_stripped)
        if m:
            enemy_relations.append((m.group(1).strip(), m.group(2).strip()))
    
    # Build side classification
    side_roles = {}
    
    for var, stype in side_vars.items():
        if stype == 'PlayerSide':
            side_roles[var] = 'player'
        elif stype == 'EnemySide':
            side_roles[var] = 'enemy'
        elif stype == 'SecondPlayerSide':
            side_roles[var] = 'second_player'
    
    # Classify created sides based on friend/enemy relations to player
    player_exprs = set([v for v, s in side_vars.items() if s == 'PlayerSide'] + ['GetPlayerSide ()'])
    enemy_exprs = set([v for v, s in side_vars.items() if s == 'EnemySide'] + ['GetEnemySide ()'])
    
    for var, stype in side_vars.items():
        if stype == 'CreatedSide':
            is_friend_to_player = False
            is_enemy_to_player = False
            is_friend_to_enemy = False
            is_enemy_to_enemy = False
            
            for a, b in friend_relations:
                if (a == var and b in player_exprs) or (b == var and a in player_exprs):
                    is_friend_to_player = True
                if (a == var and b in enemy_exprs) or (b == var and a in enemy_exprs):
                    is_friend_to_enemy = True
            
            for a, b in enemy_relations:
                if (a == var and b in player_exprs) or (b == var and a in player_exprs):
                    is_enemy_to_player = True
                if (a == var and b in enemy_exprs) or (b == var and a in enemy_exprs):
                    is_enemy_to_enemy = True
            
            if is_friend_to_player and is_enemy_to_player:
                side_roles[var] = 'mixed_created'
            elif is_friend_to_player:
                side_roles[var] = 'ally'
            elif is_enemy_to_player:
                if is_friend_to_enemy:
                    side_roles[var] = 'enemy_ally'
                else:
                    side_roles[var] = 'enemy'
            elif is_friend_to_enemy:
                side_roles[var] = 'enemy_ally'
            else:
                side_roles[var] = 'neutral_created'
    
    # Second pass: find all STR[N] references
    str_pattern = re.compile(r'STR\[(\d+)\]')
    
    for line_num, line in enumerate(lines, 1):
        matches = str_pattern.finditer(line)
        for m in matches:
            str_idx = int(m.group(1))
            line_stripped = line.strip()
            
            # Determine function context
            func_context = 'unknown'
            func_patterns = [
                (r'NewObject\s*\(', 'NewObject'),
                (r'NewObjectOffsetOrientation\s*\(', 'NewObjectOffsetOrientation'),
                (r'SetThreatLevel\s*\(', 'SetThreatLevel'),
                (r'ObjectChange\s*\(', 'ObjectChange'),
                (r'ObjectChangeSide\s*\(', 'ObjectChangeSide'),
                (r'SideObjectCount\s*\(', 'SideObjectCount'),
                (r'SetSideColor\s*\(', 'SetSideColor'),
                (r'CountObjects\s*\(', 'CountObjects'),
                (r'SideUnitTypeCount\s*\(', 'SideUnitTypeCount'),
                (r'SideBuildingTypeCount\s*\(', 'SideBuildingTypeCount'),
                (r'GetObjectType\s*\(', 'GetObjectType'),
                (r'IsObjectType\s*\(', 'IsObjectType'),
                (r'EventObjectBuilt\s*\(', 'EventObjectBuilt'),
                (r'EventObjectDestroyed\s*\(', 'EventObjectDestroyed'),
                (r'EnableBuildObject\s*\(', 'EnableBuildObject'),
                (r'DisableBuildObject\s*\(', 'DisableBuildObject'),
            ]
            
            for pat, fname in func_patterns:
                if re.search(pat, line_stripped):
                    func_context = fname
                    break
            
            # Determine side context from the first argument
            side_context = 'unknown'
            
            if func_context in ('NewObject', 'NewObjectOffsetOrientation'):
                call_match = re.search(r'(?:NewObject|NewObjectOffsetOrientation)\s*\((.+?),', line_stripped)
                if call_match:
                    first_arg = call_match.group(1).strip()
                    if 'GetPlayerSide' in first_arg:
                        side_context = 'player'
                    elif 'GetEnemySide' in first_arg:
                        side_context = 'enemy'
                    elif 'GetSecondPlayerSide' in first_arg:
                        side_context = 'second_player'
                    elif first_arg in side_roles:
                        side_context = side_roles[first_arg]
                    else:
                        side_context = f'var:{first_arg}'
            elif func_context == 'SetThreatLevel':
                side_context = 'threat'
            elif func_context in ('SideObjectCount', 'SideUnitTypeCount', 'SideBuildingTypeCount'):
                call_match = re.search(rf'{func_context}\s*\((.+?),', line_stripped)
                if call_match:
                    first_arg = call_match.group(1).strip()
                    if 'GetPlayerSide' in first_arg:
                        side_context = 'player_count'
                    elif 'GetEnemySide' in first_arg:
                        side_context = 'enemy_count'
                    elif first_arg in side_roles:
                        side_context = f'{side_roles[first_arg]}_count'
                    else:
                        side_context = f'count_var:{first_arg}'
            elif func_context in ('EnableBuildObject', 'DisableBuildObject'):
                side_context = 'build_control'
            elif func_context in ('ObjectChange', 'EventObjectBuilt', 'EventObjectDestroyed', 
                                  'IsObjectType', 'GetObjectType'):
                side_context = 'type_ref'
            elif func_context == 'CountObjects':
                # CountObjects may take a side as first arg
                call_match = re.search(r'CountObjects\s*\((.+?),', line_stripped)
                if call_match:
                    first_arg = call_match.group(1).strip()
                    if 'GetPlayerSide' in first_arg:
                        side_context = 'player_count'
                    elif 'GetEnemySide' in first_arg:
                        side_context = 'enemy_count'
                    elif first_arg in side_roles:
                        side_context = f'{side_roles[first_arg]}_count'
            
            str_refs.append({
                'index': str_idx,
                'function': func_context,
                'side_context': side_context,
                'line_num': line_num,
                'line': line_stripped,
            })
    
    return str_refs, side_vars, side_roles


def main():
    if not MISSIONS_DIR.exists():
        print(f"ERROR: Missions directory not found: {MISSIONS_DIR}")
        sys.exit(1)
    
    mission_files = sorted(MISSIONS_DIR.glob('*.txt'))
    print(f"Found {len(mission_files)} mission files in {MISSIONS_DIR}\n")
    
    # Master data structures
    str_summary = defaultdict(lambda: {
        'missions': set(),
        'player_houses': defaultdict(int),
        'enemy_subhouses': defaultdict(int),
        'functions': defaultdict(int),
        'side_contexts': defaultdict(int),
        'total_count': 0,
        'example_lines': [],
    })
    
    # House-specific tracking
    house_player_strs = defaultdict(lambda: defaultdict(int))
    house_enemy_strs = defaultdict(lambda: defaultdict(int))
    house_ally_strs = defaultdict(lambda: defaultdict(int))
    
    # enemy_subhouse -> str_index -> count (for enemy-side units in missions with known enemy)
    enemy_subhouse_str = defaultdict(lambda: defaultdict(int))
    # ally tracking by mission context
    ally_by_context = defaultdict(lambda: defaultdict(int))
    
    for filepath in mission_files:
        mission_info = parse_filename(filepath.name)
        str_refs, side_vars, side_roles = analyze_mission_file(filepath)
        
        for ref in str_refs:
            idx = ref['index']
            summary = str_summary[idx]
            summary['missions'].add(filepath.name)
            summary['total_count'] += 1
            summary['functions'][ref['function']] += 1
            summary['side_contexts'][ref['side_context']] += 1
            
            if mission_info['player_house']:
                summary['player_houses'][mission_info['player_house']] += 1
            if mission_info['enemy_subhouse']:
                summary['enemy_subhouses'][mission_info['enemy_subhouse']] += 1
            
            player_house = mission_info['player_house']
            enemy_sub = mission_info['enemy_subhouse']
            
            if player_house:
                if ref['side_context'] == 'player':
                    house_player_strs[player_house][idx] += 1
                elif ref['side_context'] in ('enemy', 'enemy_ally'):
                    house_enemy_strs[player_house][idx] += 1
                elif ref['side_context'] == 'ally':
                    house_ally_strs[player_house][idx] += 1
            
            # Track what STR indices appear as enemy when we know the enemy house
            if enemy_sub and ref['side_context'] in ('enemy', 'enemy_ally'):
                enemy_subhouse_str[enemy_sub][idx] += 1
            
            # Track ally units by context
            if ref['side_context'] == 'ally' and player_house and enemy_sub:
                key = f"{player_house} vs {enemy_sub}"
                ally_by_context[key][idx] += 1
            
            # Keep first 3 example lines per index
            if len(summary['example_lines']) < 3:
                example = f"  {filepath.name}:{ref['line_num']} [{ref['side_context']}] {ref['line']}"
                if example not in summary['example_lines']:
                    summary['example_lines'].append(example)
    
    # =========================================================================
    # OUTPUT
    # =========================================================================
    
    print("=" * 120)
    print("COMPREHENSIVE STR[N] INDEX ANALYSIS")
    print("=" * 120)
    
    # Show the Start mission comparison (key Rosetta Stone)
    print("\n" + "=" * 120)
    print("ROSETTA STONE: Start Mission Base Building Comparison")
    print("=" * 120)
    print("\nThese missions build the player's starting base, so STR indices used here")
    print("with GetPlayerSide are house-specific building/unit types.\n")
    
    start_missions = ['ATStart.txt', 'HKStart.txt', 'ORStart.txt']
    start_data = {}
    for sm in start_missions:
        filepath = MISSIONS_DIR / sm
        if filepath.exists():
            refs, _, _ = analyze_mission_file(filepath)
            player_refs = [r for r in refs if r['side_context'] == 'player']
            idx_funcs = defaultdict(lambda: defaultdict(int))
            for r in player_refs:
                idx_funcs[r['index']][r['function']] += 1
            
            idx_counts = defaultdict(int)
            for r in player_refs:
                idx_counts[r['index']] += 1
            start_data[sm[:2]] = idx_counts
            
            print(f"\n{sm} (Player = {sm[:2]}) - Player-side STR indices:")
            for idx in sorted(idx_funcs.keys()):
                funcs = dict(idx_funcs[idx])
                total = sum(funcs.values())
                func_str = ', '.join(f"{f}:{c}" for f, c in sorted(funcs.items()))
                print(f"  STR[{idx:3d}]: {total:3d}x  ({func_str})")
    
    # Cross-reference equivalent structures between houses
    print("\n\n" + "=" * 120)
    print("CROSS-HOUSE EQUIVALENCE ANALYSIS (from Start missions)")
    print("=" * 120)
    print("\nBuildings that appear in equivalent counts across Start missions")
    print("are likely the same building type for different houses.\n")
    
    # Find exact count matches
    print(f"{'Count':>5}  {'AT Index':>10}  {'HK Index':>10}  {'OR Index':>10}")
    print("-" * 50)
    
    equivalence_candidates = []
    at_data = start_data.get('AT', {})
    hk_data = start_data.get('HK', {})
    or_data = start_data.get('OR', {})
    
    for at_idx, at_count in sorted(at_data.items()):
        for hk_idx, hk_count in sorted(hk_data.items()):
            for or_idx, or_count in sorted(or_data.items()):
                if at_count == hk_count == or_count and at_count >= 2:
                    if at_idx != hk_idx and hk_idx != or_idx and at_idx != or_idx:
                        equivalence_candidates.append((at_count, at_idx, hk_idx, or_idx))
    
    seen = set()
    for count, at_idx, hk_idx, or_idx in sorted(equivalence_candidates, reverse=True):
        key = (at_idx, hk_idx, or_idx)
        if key not in seen:
            seen.add(key)
            print(f"{count:5d}  STR[{at_idx:3d}]    STR[{hk_idx:3d}]    STR[{or_idx:3d}]")
    
    # =========================================================================
    # Per-index detailed analysis
    # =========================================================================
    
    print("\n\n" + "=" * 120)
    print("DETAILED PER-INDEX ANALYSIS (indices 0-127)")
    print("=" * 120)
    
    target_indices = list(range(0, 31)) + list(range(33, 128))
    
    for idx in target_indices:
        if idx not in str_summary:
            continue
        
        s = str_summary[idx]
        
        # Determine likely house
        at_p = house_player_strs['Atreides'].get(idx, 0)
        hk_p = house_player_strs['Harkonnen'].get(idx, 0)
        or_p = house_player_strs['Ordos'].get(idx, 0)
        
        assoc_parts = []
        if at_p > 0 and hk_p == 0 and or_p == 0:
            assoc_parts.append('AT_player_exclusive')
        if hk_p > 0 and at_p == 0 and or_p == 0:
            assoc_parts.append('HK_player_exclusive')
        if or_p > 0 and at_p == 0 and hk_p == 0:
            assoc_parts.append('OR_player_exclusive')
        player_count = sum(1 for x in [at_p, hk_p, or_p] if x > 0)
        if player_count == 3:
            assoc_parts.append('GENERIC')
        elif player_count == 2:
            houses = []
            if at_p > 0: houses.append('AT')
            if hk_p > 0: houses.append('HK')
            if or_p > 0: houses.append('OR')
            assoc_parts.append(f'SHARED({"+".join(houses)})')
        
        # Check enemy-subhouse associations
        enemy_subs_for_idx = {}
        for sub, idx_map in enemy_subhouse_str.items():
            if idx in idx_map:
                enemy_subs_for_idx[sub] = idx_map[idx]
        if enemy_subs_for_idx:
            top = sorted(enemy_subs_for_idx.items(), key=lambda x: -x[1])
            assoc_parts.append(f'enemy_of({",".join(f"{s}:{c}" for s,c in top)})')
        
        print(f"\n{'─' * 100}")
        print(f"STR[{idx}]  |  Total uses: {s['total_count']}  |  Missions: {len(s['missions'])}  |  {', '.join(assoc_parts) if assoc_parts else 'unclassified'}")
        print(f"{'─' * 100}")
        
        if s['player_houses']:
            ph_str = ', '.join(f"{h}:{c}" for h, c in sorted(s['player_houses'].items(), key=lambda x: -x[1]))
            print(f"  Player houses:   {ph_str}")
        
        if s['enemy_subhouses']:
            eh_str = ', '.join(f"{h}:{c}" for h, c in sorted(s['enemy_subhouses'].items(), key=lambda x: -x[1]))
            print(f"  Enemy/subhouses: {eh_str}")
        
        if s['functions']:
            fn_str = ', '.join(f"{f}:{c}" for f, c in sorted(s['functions'].items(), key=lambda x: -x[1]))
            print(f"  Functions:       {fn_str}")
        
        if s['side_contexts']:
            sc_str = ', '.join(f"{ctx}:{c}" for ctx, c in sorted(s['side_contexts'].items(), key=lambda x: -x[1]))
            print(f"  Side contexts:   {sc_str}")
        
        at_e = house_enemy_strs['Atreides'].get(idx, 0)
        hk_e = house_enemy_strs['Harkonnen'].get(idx, 0)
        or_e = house_enemy_strs['Ordos'].get(idx, 0)
        at_a = house_ally_strs['Atreides'].get(idx, 0)
        hk_a = house_ally_strs['Harkonnen'].get(idx, 0)
        or_a = house_ally_strs['Ordos'].get(idx, 0)
        
        if any([at_p, hk_p, or_p, at_e, hk_e, or_e, at_a, hk_a, or_a]):
            print(f"  Side breakdown:  AT(player:{at_p} enemy:{at_e} ally:{at_a})  "
                  f"HK(player:{hk_p} enemy:{hk_e} ally:{hk_a})  "
                  f"OR(player:{or_p} enemy:{or_e} ally:{or_a})")
        
        if s['example_lines']:
            print(f"  Examples:")
            for ex in s['example_lines'][:3]:
                if len(ex) > 115:
                    ex = ex[:112] + "..."
                print(f"    {ex}")
        
        missions_list = sorted(s['missions'])
        if len(missions_list) <= 8:
            print(f"  Missions: {', '.join(missions_list)}")
        else:
            print(f"  Missions ({len(missions_list)}): {', '.join(missions_list[:6])} ...")
    
    # =========================================================================
    # ENEMY-SIDE ANALYSIS
    # =========================================================================
    
    print("\n\n" + "=" * 120)
    print("ENEMY-SIDE ANALYSIS: STR indices used for enemy forces by known enemy house")
    print("=" * 120)
    print("\nWhen the enemy house is known from the filename suffix, what STR indices")
    print("appear on the enemy side? This identifies house-specific unit types.\n")
    
    for house in ['Atreides', 'Harkonnen', 'Ordos', 'Fremen', 'Sardaukar', 'Ix', 'Tleilaxu', 'Guild', 'Smugglers']:
        if house in enemy_subhouse_str:
            indices = enemy_subhouse_str[house]
            print(f"\n  {house} (as enemy) - STR indices on enemy side:")
            for idx in sorted(indices.keys()):
                count = indices[idx]
                print(f"    STR[{idx:3d}]: {count:3d}x")
    
    # =========================================================================
    # ALLY-SIDE ANALYSIS
    # =========================================================================
    
    print("\n\n" + "=" * 120)
    print("ALLY-SIDE ANALYSIS: STR indices used for allied forces by mission context")
    print("=" * 120)
    
    for context in sorted(ally_by_context.keys()):
        indices = ally_by_context[context]
        if indices:
            print(f"\n  {context} - Allied unit STR indices:")
            for idx in sorted(indices.keys()):
                count = indices[idx]
                print(f"    STR[{idx:3d}]: {count:3d}x")
    
    # =========================================================================
    # SUMMARY TABLE
    # =========================================================================
    
    print("\n\n" + "=" * 120)
    print("SUMMARY: House Classification of STR[N] Indices")
    print("=" * 120)
    
    atreides_indices = []
    harkonnen_indices = []
    ordos_indices = []
    generic_indices = []
    uncertain_indices = []
    
    for idx in sorted(str_summary.keys()):
        at_p = house_player_strs['Atreides'].get(idx, 0)
        hk_p = house_player_strs['Harkonnen'].get(idx, 0)
        or_p = house_player_strs['Ordos'].get(idx, 0)
        
        if at_p > 0 and hk_p == 0 and or_p == 0:
            atreides_indices.append(idx)
        elif hk_p > 0 and at_p == 0 and or_p == 0:
            harkonnen_indices.append(idx)
        elif or_p > 0 and at_p == 0 and hk_p == 0:
            ordos_indices.append(idx)
        elif sum(1 for x in [at_p, hk_p, or_p] if x > 0) >= 2:
            generic_indices.append(idx)
        else:
            uncertain_indices.append(idx)
    
    print(f"\n  ATREIDES (player-exclusive): {sorted(atreides_indices)}")
    print(f"  HARKONNEN (player-exclusive): {sorted(harkonnen_indices)}")
    print(f"  ORDOS (player-exclusive): {sorted(ordos_indices)}")
    print(f"  GENERIC/SHARED (used by 2+ houses as player): {sorted(generic_indices)}")
    print(f"  UNCERTAIN (no player-side usage or enemy-only): {sorted(uncertain_indices)}")
    
    # Sub-classify uncertain by enemy-subhouse association
    print("\n  Uncertain indices broken down by enemy-subhouse association:")
    for idx in sorted(uncertain_indices):
        enemy_assoc = {}
        for sub, idx_map in enemy_subhouse_str.items():
            if idx in idx_map:
                enemy_assoc[sub] = idx_map[idx]
        if enemy_assoc:
            assoc_str = ', '.join(f"{s}:{c}" for s, c in sorted(enemy_assoc.items(), key=lambda x: -x[1]))
            print(f"    STR[{idx:3d}]: enemy in missions vs [{assoc_str}]")
        else:
            s = str_summary[idx]
            sc = dict(s['side_contexts'])
            sc_str = ', '.join(f"{k}:{v}" for k, v in sorted(sc.items(), key=lambda x: -x[1]))
            print(f"    STR[{idx:3d}]: side_contexts=[{sc_str}], missions={len(s['missions'])}")
    
    # =========================================================================
    # COMPACT COMPARISON TABLE
    # =========================================================================
    
    print("\n\n" + "=" * 120)
    print("COMPACT INDEX TABLE (all indices 0-127)")
    print("=" * 120)
    print(f"\n{'Idx':>4} {'Total':>5} {'#Miss':>5}  {'AT_p':>4} {'AT_e':>4} {'AT_a':>4}  "
          f"{'HK_p':>4} {'HK_e':>4} {'HK_a':>4}  {'OR_p':>4} {'OR_e':>4} {'OR_a':>4}  "
          f"{'Primary Func':24} {'Likely House'}")
    print("-" * 135)
    
    for idx in range(128):
        if idx not in str_summary:
            continue
        
        s = str_summary[idx]
        at_p = house_player_strs['Atreides'].get(idx, 0)
        hk_p = house_player_strs['Harkonnen'].get(idx, 0)
        or_p = house_player_strs['Ordos'].get(idx, 0)
        at_e = house_enemy_strs['Atreides'].get(idx, 0)
        hk_e = house_enemy_strs['Harkonnen'].get(idx, 0)
        or_e = house_enemy_strs['Ordos'].get(idx, 0)
        at_a = house_ally_strs['Atreides'].get(idx, 0)
        hk_a = house_ally_strs['Harkonnen'].get(idx, 0)
        or_a = house_ally_strs['Ordos'].get(idx, 0)
        
        if s['functions']:
            primary_func = max(s['functions'].items(), key=lambda x: x[1])[0]
        else:
            primary_func = '-'
        
        likely = ''
        if at_p > 0 and hk_p == 0 and or_p == 0:
            likely = 'ATREIDES'
        elif hk_p > 0 and at_p == 0 and or_p == 0:
            likely = 'HARKONNEN'
        elif or_p > 0 and at_p == 0 and hk_p == 0:
            likely = 'ORDOS'
        elif at_p > 0 and hk_p > 0 and or_p > 0:
            likely = 'GENERIC'
        elif at_p > 0 and hk_p > 0:
            likely = 'AT+HK'
        elif at_p > 0 and or_p > 0:
            likely = 'AT+OR'
        elif hk_p > 0 and or_p > 0:
            likely = 'HK+OR'
        elif at_e + hk_e + or_e > 0:
            # Check which enemy subhouse
            top_enemy_sub = None
            for sub, idx_map in enemy_subhouse_str.items():
                if idx in idx_map:
                    if top_enemy_sub is None or idx_map[idx] > enemy_subhouse_str[top_enemy_sub].get(idx, 0):
                        top_enemy_sub = sub
            if top_enemy_sub:
                likely = f'ENEMY({top_enemy_sub})'
            else:
                likely = 'ENEMY-only'
        elif at_a + hk_a + or_a > 0:
            likely = 'ALLY-only'
        else:
            likely = '?'
        
        print(f"{idx:4d} {s['total_count']:5d} {len(s['missions']):5d}  "
              f"{at_p:4d} {at_e:4d} {at_a:4d}  "
              f"{hk_p:4d} {hk_e:4d} {hk_a:4d}  "
              f"{or_p:4d} {or_e:4d} {or_a:4d}  "
              f"{primary_func:24} {likely}")
    
    print("\n\nLegend: AT_p=Atreides player-side, AT_e=Atreides enemy-side, AT_a=Atreides ally-side")
    print("        (same pattern for HK=Harkonnen, OR=Ordos)")
    print("\nDone. Analysis complete.")


if __name__ == '__main__':
    main()
