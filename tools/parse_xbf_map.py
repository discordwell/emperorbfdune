#!/usr/bin/env python3
"""
Parse Emperor: Battle for Dune map data from test.xbf files.

The map data is stored in the FXData field of the XBF Scene object.
It contains heightmap, texture mapping, passability, spawn points,
spice fields, entrances, script triggers, AI waypoints, and terrain zones.

Usage:
    python parse_xbf_map.py <path_to_test.xbf> [--json]
    python parse_xbf_map.py --all <maps_directory> [--json]

Requires: xanlib (pip install xanlib)
"""

import struct
import json
import sys
import os
from pathlib import Path

try:
    from xanlib import load_xbf
except ImportError:
    print("Error: xanlib not installed. Run: pip install xanlib")
    sys.exit(1)


def read_name20(buf, offset):
    """Read a 20-byte null-padded name field."""
    raw = buf[offset:offset + 20]
    return raw.split(b'\x00')[0].decode('ascii', errors='replace')


def parse_fxdata_sections(fxdata):
    """
    Parse FXData into tagged sections.

    Returns dict mapping section_id -> bytes.
    Section tags are 0xA0000000 | id.
    """
    sections = {}
    pos = 0
    while pos + 8 <= len(fxdata):
        tag = struct.unpack_from('<I', fxdata, pos)[0]
        size = struct.unpack_from('<I', fxdata, pos + 4)[0]
        if (tag & 0xFFFF0000) != 0xA0000000:
            break
        section_id = tag & 0xFFFF
        sections[section_id] = fxdata[pos + 8: pos + 8 + size]
        pos += 8 + size
    return sections


def parse_dimensions(section_data):
    """Parse section 0xA0000002: map dimensions."""
    w, h = struct.unpack_from('<II', section_data, 0)
    return {'width': w, 'height': h}


def parse_heightmap(section_data, width, height):
    """Parse section 0xA0000001: heightmap as (W+1)*(H+1) float32 array."""
    expected = (width + 1) * (height + 1)
    num_floats = len(section_data) // 4
    heights = []
    for i in range(min(num_floats, expected)):
        heights.append(round(struct.unpack_from('<f', section_data, i * 4)[0], 4))
    return heights


def parse_texture_map(section_data):
    """Parse section 0xA0000003: texture index per tile."""
    return list(section_data)


def parse_passability_map(section_data):
    """Parse section 0xA0000004: passability flags per tile."""
    return list(section_data)


def parse_section5(sec5):
    """
    Parse section 0xA0000005: entity/spawn data.

    Structure:
    - num_entries(u32) = 8 main entries
    - Each entry: name(20) + sub_count(u32) + sub_entries[]
    - Each sub_entry: name(20) + point_count(u32) + points[]
    - Each point: marker(i32) + x(f64) + z(f64) = 20 bytes

    After main entries: AI zone groups
    - Groups: count(u32) + items[] (repeat until end)
    - Zone items (Cliff/Valley): name(20) + num_polys(u32) + polygons[]
    - Each polygon: num_verts(u32) + vertices[]
    - Each vertex: x(f64) + z(f64) = 16 bytes
    """
    result = {'entries': [], 'ai_groups': []}
    pos = 0

    # Main entries
    num_entries = struct.unpack_from('<I', sec5, pos)[0]
    pos += 4

    for _ in range(num_entries):
        name = read_name20(sec5, pos)
        pos += 20
        sub_count = struct.unpack_from('<I', sec5, pos)[0]
        pos += 4

        entry = {'name': name, 'sub_entries': []}
        for _ in range(sub_count):
            sname = read_name20(sec5, pos)
            pos += 20
            pt_count = struct.unpack_from('<I', sec5, pos)[0]
            pos += 4

            points = []
            for _ in range(pt_count):
                marker = struct.unpack_from('<i', sec5, pos)[0]
                x = struct.unpack_from('<d', sec5, pos + 4)[0]
                z = struct.unpack_from('<d', sec5, pos + 12)[0]
                points.append({
                    'marker': marker,
                    'x': round(x, 2),
                    'z': round(z, 2)
                })
                pos += 20

            entry['sub_entries'].append({'name': sname, 'points': points})
        result['entries'].append(entry)

    # AI zone groups
    while pos < len(sec5) - 4:
        count = struct.unpack_from('<I', sec5, pos)[0]
        if count > 100:
            break
        pos += 4

        group = []
        for _ in range(count):
            if pos + 20 > len(sec5):
                break
            name = read_name20(sec5, pos)
            pos += 20
            item = {'name': name}

            # Detect polygon data by heuristic
            if pos + 12 <= len(sec5):
                np = struct.unpack_from('<I', sec5, pos)[0]
                if 0 < np < 50 and pos + 8 <= len(sec5):
                    nv = struct.unpack_from('<I', sec5, pos + 4)[0]
                    if 3 <= nv <= 20 and pos + 16 <= len(sec5):
                        px = struct.unpack_from('<d', sec5, pos + 8)[0]
                        if 0 < abs(px) < 50000:
                            pos += 4
                            polys = []
                            for _ in range(np):
                                if pos + 4 > len(sec5):
                                    break
                                nv2 = struct.unpack_from('<I', sec5, pos)[0]
                                pos += 4
                                verts = []
                                for _ in range(nv2):
                                    if pos + 16 > len(sec5):
                                        break
                                    vx = struct.unpack_from('<d', sec5, pos)[0]
                                    vz = struct.unpack_from('<d', sec5, pos + 8)[0]
                                    verts.append([round(vx, 2), round(vz, 2)])
                                    pos += 16
                                polys.append(verts)
                            item['polygons'] = polys

            group.append(item)
        result['ai_groups'].append(group)

    result['_consumed'] = pos
    result['_total'] = len(sec5)
    return result


def parse_map(xbf_path):
    """
    Parse a complete map from a test.xbf file.

    Returns a dict with all map data.
    """
    scene = load_xbf(str(xbf_path))

    if not scene.FXData or len(scene.FXData) == 0:
        raise ValueError(f"No FXData in {xbf_path}")

    sections = parse_fxdata_sections(scene.FXData)
    result = {
        'path': str(xbf_path),
        'nodes': len(scene.nodes),
        'fxdata_size': len(scene.FXData),
    }

    # Map dimensions
    if 2 in sections:
        result['dimensions'] = parse_dimensions(sections[2])
    else:
        result['dimensions'] = {'width': 0, 'height': 0}

    w = result['dimensions']['width']
    h = result['dimensions']['height']

    # Heightmap
    if 1 in sections:
        result['heightmap'] = {
            'size': len(sections[1]),
            'num_values': len(sections[1]) // 4,
            'expected': (w + 1) * (h + 1),
        }
        # Don't include full heightmap in default output (too large)

    # Texture map
    if 3 in sections:
        result['texture_map_size'] = len(sections[3])

    # Passability map
    if 4 in sections:
        result['passability_map_size'] = len(sections[4])

    # Texture names
    if scene.textureNameData:
        textures = []
        for part in scene.textureNameData.split(b'\x00'):
            name = part.decode('ascii', errors='replace').strip()
            if name and len(name) > 1:
                textures.append(name)
        result['textures'] = textures

    # Entity data (section 5)
    if 5 in sections:
        entity_data = parse_section5(sections[5])
        result['entities'] = entity_data

        # Extract key data for convenience
        for entry in entity_data['entries']:
            if entry['name'] == 'Base':
                spawns = []
                for sub in entry['sub_entries']:
                    for pt in sub['points']:
                        spawns.append({
                            'type': sub['name'],
                            'x': pt['x'],
                            'z': pt['z'],
                            'marker': pt['marker']
                        })
                result['spawn_points'] = spawns

            elif entry['name'] == 'Resource':
                for sub in entry['sub_entries']:
                    if sub['name'] == 'Spice':
                        result['spice_fields'] = sub['points']

            elif entry['name'] == 'Entrance':
                for sub in entry['sub_entries']:
                    if sub['name'] == 'Connected_Entrance':
                        result['entrances'] = sub['points']

            elif entry['name'] in ('Mission', 'MoreScripts', 'MoreScripts3', 'MoreScripts4'):
                if 'script_points' not in result:
                    result['script_points'] = {}
                for sub in entry['sub_entries']:
                    if sub['points']:
                        result['script_points'][sub['name']] = sub['points'][0]

            elif entry['name'] == 'AI_Assembly':
                for sub in entry['sub_entries']:
                    if sub['name'] == 'tactic' and sub['points']:
                        result['ai_waypoints'] = sub['points']

        # Extract terrain zones
        zones = []
        for group in entity_data['ai_groups']:
            for item in group:
                if 'polygons' in item:
                    zones.append({
                        'name': item['name'],
                        'polygons': item['polygons']
                    })
        if zones:
            result['terrain_zones'] = zones

    return result


def print_map_summary(data):
    """Print a human-readable summary of map data."""
    print(f"Map: {data['path']}")
    print(f"  Dimensions: {data['dimensions']['width']} x {data['dimensions']['height']} tiles")
    print(f"  Nodes: {data['nodes']}")
    print(f"  FXData: {data['fxdata_size']} bytes")

    if 'textures' in data:
        print(f"  Textures: {', '.join(data['textures'][:5])}{'...' if len(data['textures']) > 5 else ''}")

    if 'spawn_points' in data and data['spawn_points']:
        print(f"\n  Spawn Points ({len(data['spawn_points'])}):")
        for sp in data['spawn_points']:
            print(f"    {sp['type']}: ({sp['x']}, {sp['z']})")

    if 'spice_fields' in data and data['spice_fields']:
        print(f"\n  Spice Fields ({len(data['spice_fields'])}):")
        for sf in data['spice_fields'][:5]:
            print(f"    ({sf['x']}, {sf['z']})")
        if len(data['spice_fields']) > 5:
            print(f"    ... +{len(data['spice_fields']) - 5} more")

    if 'entrances' in data and data['entrances']:
        print(f"\n  Entrances ({len(data['entrances'])}):")
        for e in data['entrances']:
            marker_str = f"id={e['marker']}" if e['marker'] != 99 else "generic"
            print(f"    ({e['x']}, {e['z']}) [{marker_str}]")

    if 'script_points' in data and data['script_points']:
        print(f"\n  Script Points ({len(data['script_points'])}):")
        for name, pt in sorted(data['script_points'].items()):
            print(f"    {name}: ({pt['x']}, {pt['z']})")

    if 'ai_waypoints' in data and data['ai_waypoints']:
        print(f"\n  AI Waypoints ({len(data['ai_waypoints'])})")

    if 'terrain_zones' in data:
        print(f"\n  Terrain Zones:")
        for zone in data['terrain_zones']:
            total_v = sum(len(p) for p in zone['polygons'])
            print(f"    {zone['name']}: {len(zone['polygons'])} polygons ({total_v} vertices)")


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Parse Emperor: Battle for Dune map XBF files')
    parser.add_argument('path', help='Path to test.xbf or maps directory (with --all)')
    parser.add_argument('--all', action='store_true', help='Parse all maps in directory')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    parser.add_argument('--heightmap', action='store_true', help='Include full heightmap in output')
    args = parser.parse_args()

    if args.all:
        maps_dir = Path(args.path)
        results = []
        for map_dir in sorted(maps_dir.iterdir()):
            xbf_path = map_dir / 'test.xbf'
            if xbf_path.exists():
                try:
                    data = parse_map(xbf_path)
                    if args.heightmap:
                        sections = parse_fxdata_sections(load_xbf(str(xbf_path)).FXData)
                        if 1 in sections:
                            data['heightmap']['values'] = parse_heightmap(
                                sections[1],
                                data['dimensions']['width'],
                                data['dimensions']['height']
                            )
                    results.append(data)
                    if not args.json:
                        print_map_summary(data)
                        print()
                except Exception as e:
                    if not args.json:
                        print(f"Error parsing {xbf_path}: {e}")
                    results.append({'path': str(xbf_path), 'error': str(e)})

        if args.json:
            # Remove internal fields
            for r in results:
                if 'entities' in r:
                    del r['entities']['_consumed']
                    del r['entities']['_total']
            print(json.dumps(results, indent=2))
    else:
        xbf_path = Path(args.path)
        data = parse_map(xbf_path)
        if args.heightmap:
            sections = parse_fxdata_sections(load_xbf(str(xbf_path)).FXData)
            if 1 in sections:
                data['heightmap']['values'] = parse_heightmap(
                    sections[1],
                    data['dimensions']['width'],
                    data['dimensions']['height']
                )

        if args.json:
            if 'entities' in data:
                del data['entities']['_consumed']
                del data['entities']['_total']
            print(json.dumps(data, indent=2))
        else:
            print_map_summary(data)


if __name__ == '__main__':
    main()
