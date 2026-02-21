#!/usr/bin/env python3
"""
Emperor: Battle for Dune .tok mission script decompiler.

Decodes compiled Lexan tokenized bytecode (.tok) into human-readable script.

Encoding rules discovered from GAME.EXE analysis:
  ALL bytes >= 0x80 form 2-byte pairs (prefix, second). Bytes < 0x80 are standalone ASCII.

  Pair (P, S) decoding:
  - P == 0x80 (function/keyword prefix):
    - S < 0x80: ASCII literal
    - S >= 0x80 + next 2 bytes are 0x80 0x28: function call, token = S - 0x80
    - S >= 0x80 + otherwise: keyword/operator, token = S (raw)
  - P == 0x81 (variable prefix):
    - S < 0x80: ASCII literal
    - S >= 0x80: variable reference, slot = S - 0x80
  - P == 0x82 (string prefix):
    - S < 0x80: ASCII literal
    - S >= 0x80: string table reference, index = S - 0x80
  - P >= 0x83 (extended token prefix):
    - S == 0x80 + next byte 0x28: function call (IDs 3-127), token = P - 0x80
    - S == 0x80 + no 0x28: variable reference or keyword (raw P)
    - S == 0x81 + next byte 0x28: high function call (IDs 131-161), token = P (raw)
    - S < 0x80 (S != 0x80): ASCII literal
    - S > 0x80: keyword if raw P >= 162, else integer literal (value = S - 0x80)

  Special case for P == 0x81 (variable prefix):
    - When S == 0x81 and byte at i+2 >= 0x83: standalone accumulator marker (skip).
      The compiler emits a lone 0x81 before variable references after operators.

  Standalone bytes (< 0x80): ASCII characters and digit literals.
  Null (0x00): segment separator.
"""

import struct
import sys
import os
import re

# Complete function table extracted from GAME.EXE at offset 0x1FE0B0
FUNC_TABLE = {
    0: 'ModelTick', 1: 'Random', 2: 'Multiplayer',
    3: 'GetUnusedBasePoint', 4: 'GetSideBasePoint', 5: 'GetScriptPoint',
    6: 'GetEntrancePoint', 7: 'GetExitPoint', 8: 'GetNeutralEntrancePoint',
    9: 'GetEntrancePointByIndex', 10: 'GetEntranceNearToPos',
    11: 'GetEntranceFarFromPos', 12: 'GetSidePosition', 13: 'GetObjectPosition',
    14: 'GetPlayerSide', 15: 'GetSecondPlayerSide', 16: 'GetEnemySide',
    17: 'GetObjectSide', 18: 'CreateSide', 19: 'GetSideCash', 20: 'GetSideSpice',
    21: 'NewObject', 22: 'ObjectValid', 23: 'ObjectDestroyed',
    24: 'ObjectNearToSide', 25: 'ObjectNearToSideBase', 26: 'ObjectNearToObject',
    27: 'ObjectVisibleToSide', 28: 'ObjectTypeVisibleToSide',
    29: 'ObjectGetHealth', 30: 'ObjectMaxHealth', 31: 'SideVisibleToSide',
    32: 'SideNearToSide', 33: 'SideNearToSideBase', 34: 'SideNearToPoint',
    35: 'SideUnitCount', 36: 'SideBuildingCount', 37: 'SideObjectCount',
    38: 'SideAIDone', 39: 'EventObjectDelivered', 40: 'EventObjectConstructed',
    41: 'EventObjectTypeConstructed', 42: 'EventSideAttacksSide',
    43: 'EventObjectAttacksSide', 44: 'EventObjectDestroyed',
    45: 'Message', 46: 'GiftingMessage', 47: 'TimerMessage',
    48: 'TimerMessageRemove', 49: 'CarryAllDelivery', 50: 'Delivery',
    51: 'StarportDelivery', 52: 'BuildObject', 53: 'ObjectChangeSide',
    54: 'ObjectSetHealth', 55: 'ObjectInfect', 56: 'ObjectDetonate',
    57: 'ObjectChange', 58: 'ObjectToolTip', 59: 'SideFriendTo',
    60: 'SideEnemyTo', 61: 'SideNeutralTo', 62: 'AddSideCash',
    63: 'SideAIControl', 64: 'SideAIAggressive', 65: 'SideAIAggressiveTowards',
    66: 'SideAIBehaviourAggressive', 67: 'SideAIBehaviourRetreat',
    68: 'SideAIBehaviourNormal', 69: 'SideAIEncounterIgnore',
    70: 'SideAIEncounterAttack', 71: 'SideAIMove', 72: 'SideAIStop',
    73: 'SideAIAttackObject', 74: 'SideAIGuardObject', 75: 'SideAIExitMap',
    76: 'SideAIEnterBuilding', 77: 'SideAIBehaviourDefensive',
    78: 'SideAIHeadlessChicken', 79: 'SideAIShuffle',
    80: 'SideAttractsWorms', 81: 'SideRepelsWorms', 82: 'ForceWormStrike',
    83: 'MissionOutcome', 84: 'EndGameWin', 85: 'EndGameLose',
    86: 'NewCrateUnit', 87: 'NewCrateBomb', 88: 'NewCrateStealth',
    89: 'NewCrateCash', 90: 'NewCrateShroud', 91: 'SideChangeSide',
    92: 'SetReinforcements', 93: 'SideNuke', 94: 'SideNukeAll',
    95: 'RadarEnabled', 96: 'RadarAlert', 97: 'RemoveShroud',
    98: 'ReplaceShroud', 99: 'RemoveMapShroud',
    100: 'CameraLookAtPoint', 101: 'CameraPanToPoint',
    102: 'CameraScrollToPoint', 103: 'CameraZoomTo', 104: 'CameraViewFrom',
    105: 'CameraStartRotate', 106: 'CameraStopRotate',
    107: 'CameraTrackObject', 108: 'CameraStopTrack',
    109: 'CameraIsPanning', 110: 'CameraIsScrolling', 111: 'CameraIsSpinning',
    112: 'CameraStore', 113: 'CameraRestore',
    114: 'PIPCameraLookAtPoint', 115: 'PIPCameraPanToPoint',
    116: 'PIPCameraScrollToPoint', 117: 'PIPCameraZoomTo',
    118: 'PIPCameraViewFrom', 119: 'PIPCameraStartRotate',
    120: 'PIPCameraStopRotate', 121: 'PIPCameraTrackObject',
    122: 'PIPCameraStopTrack', 123: 'PIPCameraIsPanning',
    124: 'PIPCameraIsScrolling', 125: 'PIPCameraIsSpinning',
    126: 'PIPCameraStore', 127: 'PIPCameraRestore',
    128: 'PIPRelease', 129: 'FreezeGame', 130: 'UnFreezeGame',
    131: 'DisableUI', 132: 'EnableUI', 133: 'ObjectDeploy',
    134: 'ObjectUndeploy', 135: 'ObjectSell', 136: 'ObjectRemove',
    137: 'NewObjectInAPC', 138: 'ObjectIsCarried',
    139: 'NewObjectOffsetOrientation', 140: 'GetNeutralSide',
    141: 'GetNeutralExitPoint', 142: 'PlaySound', 143: 'Neg',
    144: 'SetValue', 145: 'GetIsolatedEntrance', 146: 'GetHideOut',
    147: 'GetConvoyWayPointFunction', 148: 'GetValley',
    149: 'GetIsolatedInfantryRock', 150: 'SetSideColor',
    151: 'GetSideColor', 152: 'SetSideCash', 153: 'AirStrike',
    154: 'AirStrikeDone', 155: 'SetThreatLevel', 156: 'SetVeterancy',
    157: 'FireSpecialWeapon', 158: 'SetTilePos', 159: 'CentreCursor',
    160: 'BreakPoint', 161: 'NormalConditionLose',
    162: 'int', 163: 'obj', 164: 'pos',
    165: 'if', 166: 'else', 167: 'endif',
    168: '==', 169: '!=', 170: '>=', 171: '<=', 172: '>', 173: '<',
    174: '&&', 175: '||', 176: 'FALSE', 177: 'TRUE',
    178: '+', 179: '-', 180: '=',
}

# Keyword/operator tokens start at 162
KEYWORD_THRESHOLD = 162

# .tok string table: STR[N] -> type name mapping (128 entries)
# Buildings: HK(111-124), AT(125-127,0-10), OR(11-23), subhouse(24-32)
# Units: 33-110 in rules.txt [UnitTypes] order
# Note: The game uses runtime type substitution - the same STR[N] resolves
# to different house variants based on the spawning side.
STRING_TABLE = [
    'ATRefinery',       # 0
    'ATFactory',        # 1
    'ATFactoryFrigate', # 2
    'ATOutpost',        # 3
    'ATPillbox',        # 4
    'ATRocketTurret',   # 5
    'ATHanger',         # 6
    'ATHelipad',        # 7
    'ATStarport',       # 8
    'ATPalace',         # 9
    'ATConYard',        # 10
    'ORSmWindtrap',     # 11
    'ORBarracks',       # 12
    'ORWall',           # 13
    'ORRefinery',       # 14
    'ORFactory',        # 15
    'ORFactoryFrigate', # 16
    'OROutpost',        # 17
    'ORGasTurret',      # 18
    'ORPopUpTurret',    # 19
    'ORHanger',         # 20
    'ORStarport',       # 21
    'ORPalace',         # 22
    'ORConYard',        # 23
    'TLFleshVat',       # 24
    'GUPalace',         # 25
    'IXResCentre',      # 26
    'IMBarracks',       # 27
    'FRCamp',           # 28
    'HKRefineryDock',   # 29
    'ATRefineryDock',   # 30
    'ORRefineryDock',   # 31
    'BeaconFlare',      # 32
    'HKScout',          # 33
    'HKLightInf',       # 34
    'HKTrooper',        # 35
    'HKEngineer',       # 36
    'HKFlamer',         # 37
    'ATScout',          # 38
    'ATInfantry',       # 39
    'ATSniper',         # 40
    'ATEngineer',       # 41
    'ATKindjal',        # 42
    'ORScout',          # 43
    'ORChemical',       # 44
    'ORAATrooper',      # 45
    'OREngineer',       # 46
    'ORMortar',         # 47
    'ORSaboteur',       # 48
    'IMGeneral',        # 49
    'ATGeneral',        # 50
    'HKGeneral',        # 51
    'ORGeneral',        # 52
    'IXScientist',      # 53
    'TLScientist',      # 54
    'IXSlave',          # 55
    'CubScout',         # 56
    'ATMilitia',        # 57
    'HKBuzzsaw',        # 58
    'HKAssault',        # 59
    'HKFlame',          # 60
    'HKInkVine',        # 61
    'HKMissile',        # 62
    'HKDevastator',     # 63
    'ATTrike',          # 64
    'ATMongoose',       # 65
    'ATAPC',            # 66
    'ATRepairUnit',     # 67
    'ATMinotaurus',     # 68
    'ATSonicTank',      # 69
    'ORDustScout',      # 70
    'ORLaserTank',      # 71
    'ORAPC',            # 72
    'ORKobra',          # 73
    'ORDeviator',       # 74
    'HKGunship',        # 75
    'HKADVCarryall',    # 76
    'HKDeathHand',      # 77
    'HKADP',            # 78
    'ATOrni',           # 79
    'ATADVCarryall',    # 80
    'ATHawkWeapon',     # 81
    'ATADP',            # 82
    'OREITS',           # 83
    'ORADVCarryall',    # 84
    'ORBeamWeapon',     # 85
    'ORADP',            # 86
    'Harvester',        # 87
    'MCV',              # 88
    'Carryall',         # 89
    'IXInfiltrator',    # 90
    'IXProjector',      # 91
    'TLContaminator',   # 92
    'TLLeech',          # 93
    'IMSardaukar',      # 94
    'IMADVSardaukar',   # 95
    'IMDropShip',       # 96
    'FRFremen',         # 97
    'FRADVFremen',      # 98
    'StoryFRFremen',    # 99
    'StoryFRADVFremen', # 100
    'WormRider',        # 101
    'GUMaker',          # 102
    'GUNIABTank',       # 103
    'INYak',            # 104
    'INYakHauder',      # 105
    'INYakRider',       # 106
    'INSandCrawler',    # 107
    'INBuggy',          # 108
    'INMedicalVehicle', # 109
    'INFemaleCiv',      # 110
    'HKSmWindtrap',     # 111
    'HKBarracks',       # 112
    'HKWall',           # 113
    'HKRefinery',       # 114
    'HKFactory',        # 115
    'HKFactoryFrigate', # 116
    'HKOutpost',        # 117
    'HKFlameTurret',    # 118
    'HKGunTurret',      # 119
    'HKHanger',         # 120
    'HKHelipad',        # 121
    'HKStarport',       # 122
    'HKPalace',         # 123
    'HKConYard',        # 124
    'ATSmWindtrap',     # 125
    'ATBarracks',       # 126
    'ATWall',           # 127
]


def decode_segment(seg, var_names=None):
    """Decode a single bytecode segment into tokens.

    All bytes >= 0x80 form 2-byte pairs. Bytes < 0x80 are standalone ASCII.
    """
    tokens = []
    i = 0
    while i < len(seg):
        b = seg[i]

        if b < 0x80:
            # Standalone ASCII literal
            if 32 <= b <= 126:
                tokens.append(chr(b))
            else:
                tokens.append(f'<0x{b:02x}>')
            i += 1
            continue

        # All bytes >= 0x80 start a 2-byte pair
        if i + 1 >= len(seg):
            # Orphan prefix at end of segment — treat as statement terminator
            tokens.append(';')
            i += 1
            continue

        second = seg[i + 1]

        if b == 0x80:
            # Function/keyword prefix
            if second < 0x80:
                tokens.append(chr(second))
            else:
                # Check if next 2 bytes are 0x80 0x28 (function call via 80-prefix)
                pos_after = i + 2
                is_call = (pos_after + 1 < len(seg)
                           and seg[pos_after] == 0x80
                           and seg[pos_after + 1] == 0x28)
                if is_call:
                    tok_id = second - 0x80  # Shifted: function call
                else:
                    tok_id = second  # Raw: keyword/operator
                name = FUNC_TABLE.get(tok_id, f'UNK_{tok_id}')
                tokens.append(name)

        elif b == 0x81:
            # Variable prefix
            if second < 0x80:
                tokens.append(chr(second))
            elif second == 0x81 and i + 2 < len(seg) and seg[i + 2] >= 0x81:
                # Bug 2 fix: standalone accumulator marker before variable reference.
                # After operators (==, =, +, etc.), the compiler emits a lone 0x81
                # accumulator byte before the 0x81+slot variable reference pair.
                # Skip this byte and let the next iteration decode the real pair.
                i += 1
                continue
            else:
                slot = second - 0x80
                vname = var_names.get(slot, f'v{slot}') if var_names else f'v{slot}'
                tokens.append(vname)

        elif b == 0x82:
            # String reference prefix
            if second < 0x80:
                tokens.append(chr(second))
            else:
                idx = second - 0x80
                tokens.append(f'STR[{idx}]')

        else:
            # Extended token prefix (P >= 0x83)
            if second == 0x80:
                # S == 0x80: function call OR variable reference
                # Check if next byte is 0x28 (open paren) for function call
                next_pos = i + 2
                if next_pos < len(seg) and seg[next_pos] == 0x28:
                    # Function call: token = P - 0x80
                    tok_id = b - 0x80
                    name = FUNC_TABLE.get(tok_id, f'UNK_{tok_id}')
                    tokens.append(name)
                else:
                    # No open paren: variable reference or keyword
                    raw_tok = b
                    if raw_tok >= KEYWORD_THRESHOLD and raw_tok in FUNC_TABLE:
                        tokens.append(FUNC_TABLE[raw_tok])
                    else:
                        slot = b - 0x80
                        vname = var_names.get(slot, f'v{slot}') if var_names else f'v{slot}'
                        tokens.append(vname)
            elif second < 0x80:
                # ASCII literal in typed context
                tokens.append(chr(second))
            else:
                # S > 0x80: keyword, high function call, or integer literal
                raw_tok = b  # Raw token from prefix byte
                if raw_tok >= KEYWORD_THRESHOLD and raw_tok in FUNC_TABLE:
                    # Keyword/operator (if, else, ==, TRUE, FALSE, etc.)
                    tokens.append(FUNC_TABLE[raw_tok])
                elif second == 0x81 and i + 2 < len(seg) and seg[i + 2] == 0x28:
                    # Bug 1 fix: high function call (IDs 131-161).
                    # These can't use P-0x80 shifted encoding (would overflow byte).
                    # Instead: P = raw function ID, S = 0x81 marker, followed by '('.
                    name = FUNC_TABLE.get(raw_tok, f'UNK_{raw_tok}')
                    tokens.append(name)
                else:
                    # Integer literal: value from second byte
                    val = second - 0x80
                    tokens.append(str(val))

        i += 2

    return tokens


def format_tokens(tokens):
    """Pretty-print token list into readable code."""
    result = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        # Combine adjacent digits into numbers
        if t.isdigit() or (t == '-' and i + 1 < len(tokens) and tokens[i + 1].isdigit()):
            num = t
            i += 1
            while i < len(tokens) and tokens[i].isdigit():
                num += tokens[i]
                i += 1
            result.append(num)
            continue
        result.append(t)
        i += 1

    # Join with context-aware spacing
    out = ''
    for j, t in enumerate(result):
        if j == 0:
            out = t
            continue
        prev = result[j - 1]
        # No space before ), ,, ;
        if t in (')', ',', ';'):
            out += t
        # No space after (
        elif prev == '(':
            out += t
        # Space around comparison/assignment/logic operators
        elif t in ('==', '!=', '>=', '<=', '>', '<', '&&', '||', '=', '+', '-'):
            out += ' ' + t
        elif prev in ('==', '!=', '>=', '<=', '>', '<', '&&', '||', '=', '+', '-'):
            out += ' ' + t
        else:
            out += ' ' + t

    return out


def decompile_tok(filepath, string_table=None):
    """Decompile a .tok file to readable script."""
    with open(filepath, 'rb') as f:
        data = f.read()

    if len(data) < 8:
        return f"// File too small: {len(data)} bytes"

    data_size = struct.unpack_from('<I', data, 0)[0]
    null_count = struct.unpack_from('<I', data, 4)[0]

    payload = data[8:]
    segments = payload.split(b'\x00')

    # Count empty variable slots
    empty_count = 0
    for s in segments:
        if len(s) == 0:
            empty_count += 1
        else:
            break

    lines = []
    lines.append(f'// File: {os.path.basename(filepath)}')
    lines.append(f'// Size: {len(data)} bytes, segments: {len(segments)}, vars: {empty_count}')
    lines.append('')

    # Track variable declarations
    var_types = {}  # slot -> type name
    var_names = {}  # slot -> display name
    indent = 0

    for idx, seg in enumerate(segments):
        if len(seg) == 0:
            continue

        tokens = decode_segment(seg, var_names)
        formatted = format_tokens(tokens)

        # Detect variable declarations: type(vN)
        if len(tokens) >= 4 and tokens[0] in ('int', 'obj', 'pos') and tokens[1] == '(':
            vtype = tokens[0]
            for t in tokens[2:]:
                if t.startswith('v') and t[1:].isdigit():
                    slot = int(t[1:])
                    var_types[slot] = vtype
                    var_names[slot] = f'{vtype}_{slot}'
                    break

        # Handle indentation for if/else/endif
        if tokens and tokens[0] == 'endif':
            indent = max(0, indent - 1)
        elif tokens and tokens[0] == 'else':
            indent = max(0, indent - 1)

        prefix = '  ' * indent

        # Clean up the accumulator artifact (slot 0: v0/pos_0/int_0/obj_0)
        # The compiler stores intermediate results in slot 0 (the accumulator register).
        # We strip these artifacts only for slot 0 variables.
        cleaned = formatted
        acc = r'(?:v0|pos_0|int_0|obj_0)'
        # Remove accumulator between = and a function/keyword name
        cleaned = re.sub(r'= ' + acc + r' ([A-Z])', r'= \1', cleaned)
        cleaned = re.sub(r'= ' + acc + r' (ModelTick|Random|Multiplayer)', r'= \1', cleaned)
        # Remove accumulator before TRUE/FALSE (in both = and == contexts)
        cleaned = re.sub(r'= ' + acc + r' (TRUE|FALSE)', r'= \1', cleaned)
        cleaned = re.sub(r'== ' + acc + r' (TRUE|FALSE)', r'== \1', cleaned)
        # Remove accumulator before integer after ==: "== pos_0 0" → "== 0"
        cleaned = re.sub(r'== ' + acc + r' (\d)', r'== \1', cleaned)
        # Remove accumulator after comparison ops: "== pos_0 int_5" → "== int_5"
        cleaned = re.sub(r'(==|!=|>=|<=|>|<) ' + acc + r' ', r'\1 ', cleaned)

        # Replace string indices with actual strings if table provided
        if string_table:
            def replace_str(m):
                idx_val = int(m.group(1))
                if idx_val < len(string_table):
                    return f'"{string_table[idx_val]}"'
                return m.group(0)
            cleaned = re.sub(r'STR\[(\d+)\]', replace_str, cleaned)

        lines.append(f'{prefix}{cleaned}')

        if tokens and tokens[0] == 'if':
            indent += 1
        elif tokens and tokens[0] == 'else':
            indent += 1

    return '\n'.join(lines)


def main():
    if len(sys.argv) < 2:
        print("Usage: python decompile_tok.py <file.tok> [--all] [--dir DIR]")
        print("  --all: decompile all .tok files in the missions directory")
        print("  --dir DIR: output directory for decompiled files")
        sys.exit(1)

    if sys.argv[1] == '--all':
        tok_dir = 'extracted/MISSIONS0001'
        out_dir = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == '--dir' else 'decompiled_missions'
        os.makedirs(out_dir, exist_ok=True)

        count = 0
        errors = 0
        for fname in sorted(os.listdir(tok_dir)):
            if fname.endswith('.tok') and fname != 'header.tok':
                path = os.path.join(tok_dir, fname)
                try:
                    result = decompile_tok(path, string_table=STRING_TABLE)
                    out_path = os.path.join(out_dir, fname.replace('.tok', '.txt'))
                    with open(out_path, 'w') as f:
                        f.write(result)
                    print(f"  {fname} -> {out_path}")
                    count += 1
                except Exception as e:
                    print(f"  {fname}: ERROR: {e}")
                    errors += 1
        print(f"\nDone: {count} files decompiled, {errors} errors")
    else:
        filepath = sys.argv[1]
        result = decompile_tok(filepath, string_table=STRING_TABLE)
        print(result)


if __name__ == '__main__':
    main()
