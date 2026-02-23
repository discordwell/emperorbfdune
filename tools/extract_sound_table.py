#!/usr/bin/env python3
"""
Extract the sound ID table from Emperor: Battle for Dune's AUDIO.BAG file.

The AUDIO.BAG file uses the "GABA" format (IMA ADPCM audio archive).
Each entry has a 0-based index that serves as the sound ID used by the
PlaySound() scripting function in .tok mission scripts.

Usage:
    python3 extract_sound_table.py [bag_path] [--json] [--ts]

    bag_path:  Path to AUDIO.BAG (default: gamedata/data/Sfx/AUDIO.BAG)
    --json:    Output as JSON to stdout
    --ts:      Output as TypeScript map to stdout (for SoundIdTable.ts)

If no flags are given, prints a human-readable table.
"""

import struct
import sys
import os
import re
import json
from pathlib import Path


def parse_audio_bag(bag_path: str) -> list[dict]:
    """Parse AUDIO.BAG and return list of entries with id, name, metadata."""
    entries = []
    with open(bag_path, 'rb') as f:
        magic = f.read(4)
        if magic != b'GABA':
            raise ValueError(f"Bad magic: {magic!r} (expected GABA)")

        version, entry_count, header_size = struct.unpack('<III', f.read(12))

        for i in range(entry_count):
            entry_data = f.read(header_size)
            if len(entry_data) < header_size:
                break

            name = entry_data[:32].split(b'\x00')[0].decode('ascii', errors='replace')
            offset, size, sample_rate, format_code = struct.unpack_from('<IIII', entry_data, 32)
            block_align = struct.unpack_from('<I', entry_data, 48)[0]

            entries.append({
                'id': i,
                'name': name,
                'offset': offset,
                'size': size,
                'sampleRate': sample_rate,
                'format': format_code,
                'blockAlign': block_align,
            })

    return entries


def classify_entry(name: str) -> str:
    """Classify a BAG entry into a category."""
    # Voice lines: NN-U{A,M,S,X}NN
    if re.match(r'^\d{2}-U[AMSX]', name):
        return 'voice'
    # Faction acknowledgements
    if re.match(r'^(ATR|HAR|ORD|FRE|GUI|SAR|IX)', name, re.I):
        return 'factionVoice'
    # Dust scout (unit-specific sounds)
    if name.lower().startswith('dustscout'):
        return 'unitSound'
    return 'sfx'


def map_to_sfx_category(name: str) -> str | None:
    """Map a BAG entry name to an existing SfxManifest category, or None."""
    lower = name.lower()

    # Explosions
    if 'bigxplosion' in lower:
        return 'deathBuilding'
    if 'explosion_large' in lower:
        return 'deathVehicle'
    if 'explosion_vehicle' in lower:
        return 'deathVehicle'
    if 'explosion_medium' in lower:
        return 'explosion'
    if 'explosion_small' in lower:
        return 'explosion'
    if 'explosionordos' in lower:
        return 'explosion'

    # Death sounds
    if 'normal_dying' in lower or 'burn_dying' in lower or 'choke_dying' in lower:
        return 'deathInfantry'
    if 'female_death' in lower:
        return 'deathInfantry'
    if 'crush_guy' in lower:
        return 'deathInfantry'
    if lower.startswith('kilguild') or 'contaminator_die' in lower:
        return 'deathInfantry'

    # Weapons
    if 'light_infantry' in lower or 'mgun' in lower or 'sardukar_mgun' in lower:
        return 'shot'
    if 'adp_gun' in lower:
        return 'shot'
    if 'rocket' in lower or 'missile_tank_1' in lower or 'bazooka' in lower:
        return 'shotRocket'
    if 'laser' in lower and 'attack' in lower:
        return 'shotLaser'
    if 'flame' in lower and ('infantry' in lower or 'turret' in lower or 'attack' in lower):
        return 'shotFlame'
    if 'chemflamer' in lower or 'chemturret' in lower:
        return 'shotFlame'
    if 'mortar' in lower and 'attack' in lower:
        return 'shotMortar'
    if 'sniper' in lower:
        return 'shotSniper'
    if 'buzzsaw' in lower and 'gun' in lower:
        return 'shotBuzzsaw'
    if 'inkvine_shot' in lower:
        return 'shotInkvine'
    if 'sonic_tank_boom' in lower:
        return 'shotSonic'
    if 'cannon' in lower:
        return 'shotCannon'
    if 'popupturretattack' in lower:
        return 'shotPopupTurret'
    if 'palace_arc' in lower:
        return 'shotPalace'
    if 'weirding' in lower:
        return 'weirdingWeapon'
    if 'kindjalgun' in lower:
        return 'shot'
    if 'niab_tank_fire' in lower:
        return 'shot'

    # Building / construction
    if 'constructionelement' in lower or 'constructionsparks' in lower or 'constructspark' in lower:
        return 'build'
    if 'building_thud' in lower or 'wall_thud' in lower or 'fremen_tent' in lower:
        return 'place'
    if 'mcvdeploy' in lower:
        return 'place'

    # Worm
    if 'worm_roar' in lower or 'worm_rumble' in lower:
        return 'worm'
    if 'worm_sign' in lower:
        return 'worm'

    # Power / UI
    if lower == 'powrdn1':
        return 'powerlow'
    if lower == 'powrup1':
        return 'powerlow'
    if lower == 'radaronline':
        return 'underattack'
    if lower == 'button1' or 'sci_fi_click' in lower or 'nav_button' in lower:
        return 'select'
    if 'credit_up' in lower:
        return 'harvest'
    if 'credit_down' in lower:
        return 'sell'
    if 'harvester_deposit' in lower:
        return 'harvest'

    # Death hand
    if 'death_hand' in lower:
        return 'superweaponLaunch'

    # Stealth
    if lower.startswith('stealth'):
        return 'stealth'

    # Repair
    if 'repair_vehicle' in lower:
        return 'repairSparks'

    # Thumper
    if 'thumper_deploy' in lower:
        return 'thumperDeploy'
    if 'thumper_single' in lower:
        return 'thumperRhythm'

    # Turret
    if 'popupturretrise' in lower:
        return 'popupTurretRise'
    if 'popupturretdrop' in lower:
        return 'popupTurretDrop'

    # Leech
    if 'tx_leech_attack' in lower and 'confirm' not in lower:
        return 'leechAttack'
    if 'tx_flesh_born' in lower:
        return 'fleshBorn'

    # Sonic deploy
    if 'sonic_tank_deploy' in lower:
        return 'sonicDeploy'

    # Wind
    if 'wind_loop' in lower:
        return 'windLoop'

    # Veteran
    if 'veteran_upgrade' in lower:
        return 'veterancyUp'

    return None


def main():
    # Default path
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    default_bag = project_root / 'gamedata' / 'data' / 'Sfx' / 'AUDIO.BAG'

    bag_path = default_bag
    output_json = False
    output_ts = False

    for arg in sys.argv[1:]:
        if arg == '--json':
            output_json = True
        elif arg == '--ts':
            output_ts = True
        elif not arg.startswith('-'):
            bag_path = Path(arg)

    if not bag_path.exists():
        print(f"ERROR: {bag_path} not found", file=sys.stderr)
        sys.exit(1)

    entries = parse_audio_bag(str(bag_path))

    if output_json:
        print(json.dumps(entries, indent=2))
        return

    if output_ts:
        # Generate TypeScript sound ID table
        print("// AUTO-GENERATED by tools/extract_sound_table.py")
        print("// Source: gamedata/data/Sfx/AUDIO.BAG (945 entries)")
        print("//")
        print("// Maps AUDIO.BAG index (used by PlaySound) to { name, sfxCategory }.")
        print("// sfxCategory matches keys in SfxManifest.ts for playback routing.")
        print("")
        print("export interface SoundIdEntry {")
        print("  /** Original filename in AUDIO.BAG (without extension). */")
        print("  name: string;")
        print("  /** SfxManifest category to route playback to, or null for unmapped. */")
        print("  sfxCategory: string | null;")
        print("  /** Entry type: 'sfx' | 'voice' | 'factionVoice' | 'unitSound'. */")
        print("  type: string;")
        print("}")
        print("")
        print("export const SOUND_ID_TABLE: Record<number, SoundIdEntry> = {")
        for e in entries:
            name = e['name']
            entry_type = classify_entry(name)
            category = map_to_sfx_category(name)
            cat_str = f"'{category}'" if category else 'null'
            print(f"  {e['id']}: {{ name: '{name}', sfxCategory: {cat_str}, type: '{entry_type}' }},")
        print("};")
        print("")
        print(f"export const SOUND_ID_COUNT = {len(entries)};")
        return

    # Human-readable table
    print(f"AUDIO.BAG Sound Table ({len(entries)} entries)")
    print(f"{'ID':>4}  {'Name':<40}  {'Type':<12}  {'SfxCategory':<20}  {'Rate':>6}  {'Size':>8}")
    print("-" * 100)
    for e in entries:
        name = e['name']
        entry_type = classify_entry(name)
        category = map_to_sfx_category(name) or '-'
        print(f"{e['id']:4d}  {name:<40}  {entry_type:<12}  {category:<20}  {e['sampleRate']:>6}  {e['size']:>8}")


if __name__ == '__main__':
    main()
