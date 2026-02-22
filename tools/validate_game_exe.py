#!/usr/bin/env python3
"""
Validate the .tok function table in GAME.EXE against our decompiler's FUNC_TABLE.

Reads the 181-entry function/keyword table at offset 0x1FE0B0 in GAME.EXE.
Each entry is a 92-byte struct:
  +0   : null-terminated name (up to ~36 bytes)
  +36  : func ID (uint32)
  +40  : (reserved)
  +44  : flags/category (uint32)
  +48  : argument count (uint32)
  +52+ : argument type slots (uint32 each)

Compares names against FUNC_TABLE from decompile_tok.py and reports matches,
mismatches, and argument count metadata.
"""

import struct
import sys
import os

# --- Configuration ---
GAME_EXE_PATH = os.path.join(os.path.dirname(__file__), '..', 'gamedata', 'GAME.EXE')
TABLE_OFFSET = 0x1FE0B0
ENTRY_SIZE = 92
NUM_ENTRIES = 181
KEYWORD_THRESHOLD = 162

# --- Reference function table (from decompile_tok.py) ---
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
    # Keywords (162+)
    162: 'int', 163: 'obj', 164: 'pos',
    165: 'if', 166: 'else', 167: 'endif',
    168: '==', 169: '!=', 170: '>=', 171: '<=', 172: '>', 173: '<',
    174: '&&', 175: '||', 176: 'FALSE', 177: 'TRUE',
    178: '+', 179: '-', 180: '=',
}

# Flag categories from +44 field
FLAG_CATEGORIES = {
    0: 'query',          # pure query, no side effects
    1: 'returns_pos',    # returns a position value
    2: 'returns_obj',    # returns an object reference
    8: 'action',         # side-effect / mutation
}


def read_entry(data: bytes, index: int) -> dict:
    """Parse a single 92-byte function table entry."""
    offset = index * ENTRY_SIZE
    raw = data[offset:offset + ENTRY_SIZE]

    # Name: null-terminated string at +0
    name_bytes = raw[0:36]
    null_pos = name_bytes.find(b'\x00')
    if null_pos >= 0:
        name = name_bytes[:null_pos].decode('ascii', errors='replace')
    else:
        name = name_bytes.decode('ascii', errors='replace')

    # Metadata fields
    func_id = struct.unpack_from('<I', raw, 36)[0]
    reserved = struct.unpack_from('<I', raw, 40)[0]
    flags = struct.unpack_from('<I', raw, 44)[0]
    arg_count = struct.unpack_from('<I', raw, 48)[0]

    # Argument types (remaining slots after +52, up to end of entry)
    arg_types = []
    for i in range(min(arg_count, 10)):  # max 10 args
        off = 52 + i * 4
        if off + 4 <= ENTRY_SIZE:
            arg_types.append(struct.unpack_from('<I', raw, off)[0])

    return {
        'index': index,
        'name': name,
        'func_id': func_id,
        'flags': flags,
        'arg_count': arg_count,
        'arg_types': arg_types,
    }


def main():
    if not os.path.exists(GAME_EXE_PATH):
        print(f"ERROR: GAME.EXE not found at {GAME_EXE_PATH}")
        sys.exit(1)

    with open(GAME_EXE_PATH, 'rb') as f:
        f.seek(TABLE_OFFSET)
        table_data = f.read(ENTRY_SIZE * NUM_ENTRIES)

    if len(table_data) < ENTRY_SIZE * NUM_ENTRIES:
        print(f"ERROR: Could not read full table (got {len(table_data)} bytes, expected {ENTRY_SIZE * NUM_ENTRIES})")
        sys.exit(1)

    entries = [read_entry(table_data, i) for i in range(NUM_ENTRIES)]

    # --- Compare names ---
    matches = 0
    mismatches = []
    for entry in entries:
        idx = entry['index']
        exe_name = entry['name']
        ref_name = FUNC_TABLE.get(idx, None)

        if ref_name is None:
            mismatches.append((idx, exe_name, '<missing from FUNC_TABLE>'))
        elif exe_name == ref_name:
            matches += 1
        else:
            mismatches.append((idx, exe_name, ref_name))

    # --- Output ---
    print("=" * 60)
    print("GAME.EXE Function Table Validation")
    print(f"  File:   {os.path.abspath(GAME_EXE_PATH)}")
    print(f"  Offset: 0x{TABLE_OFFSET:X}")
    print(f"  Entries: {NUM_ENTRIES} ({KEYWORD_THRESHOLD} functions + {NUM_ENTRIES - KEYWORD_THRESHOLD} keywords)")
    print("=" * 60)
    print()

    print(f"Name matches:    {matches}/{NUM_ENTRIES}")
    if mismatches:
        print(f"Name mismatches: {len(mismatches)}")
        for idx, exe_name, ref_name in mismatches:
            print(f"  [{idx:3d}] EXE: {exe_name!r:30s} vs REF: {ref_name!r}")
    else:
        print("Name mismatches: 0  (PERFECT MATCH)")
    print()

    # --- Argument count report ---
    print("--- Function Argument Counts (from EXE metadata) ---")
    print(f"{'ID':>4s}  {'Name':<30s}  {'Args':>4s}  {'Flags':>5s}  {'Category':<14s}  {'ArgTypes'}")
    print("-" * 90)
    for entry in entries:
        if entry['index'] >= KEYWORD_THRESHOLD:
            continue  # skip keywords
        cat = FLAG_CATEGORIES.get(entry['flags'], f'unknown({entry["flags"]})')
        arg_type_str = ', '.join(str(t) for t in entry['arg_types']) if entry['arg_types'] else '-'
        print(f"{entry['index']:4d}  {entry['name']:<30s}  {entry['arg_count']:4d}  {entry['flags']:5d}  {cat:<14s}  {arg_type_str}")

    print()
    print("--- Summary ---")
    funcs_only = [e for e in entries if e['index'] < KEYWORD_THRESHOLD]
    by_flags = {}
    for e in funcs_only:
        cat = FLAG_CATEGORIES.get(e['flags'], f'unknown({e["flags"]})')
        by_flags.setdefault(cat, []).append(e['name'])
    for cat, names in sorted(by_flags.items()):
        print(f"  {cat}: {len(names)} functions")

    # --- Final verdict ---
    print()
    if matches == NUM_ENTRIES:
        print("RESULT: PASS - 181/181 entries match (100% parity)")
    else:
        print(f"RESULT: FAIL - {matches}/{NUM_ENTRIES} entries match ({100*matches/NUM_ENTRIES:.1f}%)")

    sys.exit(0 if matches == NUM_ENTRIES else 1)


if __name__ == '__main__':
    main()
