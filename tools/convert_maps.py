#!/usr/bin/env python3
"""
Convert all 82 Emperor: BFD map directories to web-optimized binary format.

Input:  extracted/MAPS0001/{map_dir}/
Output: assets/maps/{mapId}.bin, assets/maps/{mapId}.thumb.png, assets/maps/manifest.json

Binary format (.bin):
  Header (12 bytes):
    uint16 LE: width (tiles)
    uint16 LE: height (tiles)
    float32 LE: ambientR (0.0-1.0, from test.lit)
    float32 LE: ambientG (0.0-1.0, from test.lit)
  Body (3 × W×H bytes):
    [W*H bytes] heightMap  — CPT elevation 0-255, averaged from 8×8 blocks
    [W*H bytes] passability — CPF terrain type 0-15, mode of 2×2 cells
    [W*H bytes] textureIdx — texture.dat index 0-255, center of 8×8 block

Scale relationships:
  CPT / texture.dat: 2048×2048, 8 cells per game tile
  CPF: 512×512 nibbles, 2 cells per game tile
  map.inf W×H: game tile dimensions
"""

import json
import os
import re
import struct
import sys
import numpy as np

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

MAPS_DIR = os.path.join(os.path.dirname(__file__), '..', 'extracted', 'MAPS0001')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'assets', 'maps')

# Map name prefix → type classification
MAP_TYPES = {
    'T': 'territory',
    'M': 'skirmish',
    'H': 'heighliner',
    'D': 'defense',
    'V': 'defense',
    'A': 'attack',
    'C': 'civilwar',
    'E': 'final',
    'U': 'tutorial',
    'X': 'tutorial',
}

# Player count extraction from directory name
PLAYER_RE = re.compile(r'(\d+)[\s-]*(?:\d+)?p', re.IGNORECASE)


def parse_map_id(dirname: str) -> tuple[str, str]:
    """Extract map ID and display name from directory name.

    '#T5 JF The Cauldron S LOD2' → ('T5', 'The Cauldron')
    '#M29 GM Fishes Plain S 8' → ('M29', 'Fishes Plain')
    '#D2 Ordos Homeworld Defense LOD2' → ('D2', 'Ordos Homeworld Defense')
    """
    # Strip leading # and trailing LOD markers
    name = dirname.lstrip('#').strip()

    # Extract the ID (letter + digits)
    match = re.match(r'^([A-Z]\d+)', name)
    if not match:
        return '', name

    map_id = match.group(1)
    rest = name[match.end():].strip()

    # Remove designer initials (2 uppercase letters at start)
    rest = re.sub(r'^[A-Z]{2}\s+', '', rest)

    # Remove trailing markers: S, LOD2, player counts
    rest = re.sub(r'\s+LOD\d*$', '', rest, flags=re.IGNORECASE)
    rest = re.sub(r'\s+S$', '', rest)
    rest = re.sub(r'\s+S\s+', ' ', rest)
    rest = re.sub(r'\s+\d+-?\d*p?$', '', rest, flags=re.IGNORECASE)
    rest = rest.strip()

    if not rest:
        rest = map_id

    return map_id, rest


def parse_player_count(dirname: str) -> int:
    """Extract max player count from directory name."""
    match = PLAYER_RE.search(dirname)
    if match:
        return int(match.group(1))
    # Special cases
    if dirname.startswith('#M'):
        # Skirmish maps without explicit player count — check for number at end
        m = re.search(r'\s(\d)$', dirname.rstrip())
        if m:
            return int(m.group(1))
        return 2  # Default skirmish
    return 2  # Default


def parse_map_inf(path: str) -> tuple[int, int]:
    """Parse map.inf for width and height."""
    with open(path, 'rb') as f:
        data = f.read()
    lines = data.split(b'\r\n')
    w = int(lines[0])
    h = int(lines[1].split()[-1])
    return w, h


def parse_lit(path: str) -> tuple[float, float]:
    """Parse test.lit for ambient lighting values.

    Format: first line has 1-2 float values (ambient intensity).
    Returns (ambientR, ambientG) as floats 0.0-1.0.
    """
    try:
        with open(path, 'rb') as f:
            data = f.read()
        # Find the text portion (before any binary data)
        text = data.split(b'\r\n')[0].decode('ascii', errors='ignore').strip()
        parts = text.split()

        if len(parts) >= 2:
            return float(parts[0]), float(parts[1])
        elif len(parts) == 1:
            v = float(parts[0])
            return v, v
        return 0.5, 0.5
    except Exception:
        return 0.5, 0.5


def read_cpt(path: str, w: int, h: int) -> np.ndarray:
    """Read CPT heightmap and downsample to W×H by averaging 8×8 blocks."""
    with open(path, 'rb') as f:
        f.read(8)  # skip header
        raw = np.frombuffer(f.read(2048 * 2048), dtype=np.uint8)
    cpt = raw.reshape(2048, 2048)

    # Downsample: average each 8×8 block
    out = np.zeros((h, w), dtype=np.uint8)
    for r in range(h):
        for c in range(w):
            r0 = r * 8
            c0 = c * 8
            r1 = min(r0 + 8, 2048)
            c1 = min(c0 + 8, 2048)
            block = cpt[r0:r1, c0:c1]
            out[r, c] = int(block.mean())
    return out


def read_cpf(path: str, w: int, h: int) -> np.ndarray:
    """Read CPF passability nibbles and downsample to W×H."""
    with open(path, 'rb') as f:
        raw = np.frombuffer(f.read(131072), dtype=np.uint8)

    # Unpack nibbles into 512×512 grid
    cpf = np.zeros((512, 512), dtype=np.uint8)
    for row in range(512):
        base = row * 256
        for col in range(256):
            byte = raw[base + col]
            cpf[row, col * 2] = byte & 0x0F
            cpf[row, col * 2 + 1] = (byte >> 4) & 0x0F

    # Downsample to W×H: take mode of 2×2 block (most common value)
    out = np.zeros((h, w), dtype=np.uint8)
    for r in range(h):
        for c in range(w):
            r0 = r * 2
            c0 = c * 2
            r1 = min(r0 + 2, 512)
            c1 = min(c0 + 2, 512)
            block = cpf[r0:r1, c0:c1].flatten()
            # Use mode (most common value in 2×2)
            vals, counts = np.unique(block, return_counts=True)
            out[r, c] = vals[counts.argmax()]
    return out


def read_texture(path: str, w: int, h: int) -> np.ndarray:
    """Read texture.dat and downsample to W×H."""
    with open(path, 'rb') as f:
        raw = np.frombuffer(f.read(2048 * 2048), dtype=np.uint8)
    tex = raw.reshape(2048, 2048)

    # Downsample: center sample of 8×8 block
    out = np.zeros((h, w), dtype=np.uint8)
    for r in range(h):
        for c in range(w):
            sr = min(r * 8 + 4, 2047)
            sc = min(c * 8 + 4, 2047)
            out[r, c] = tex[sr, sc]
    return out


def convert_thumbnail(map_dir: str, output_path: str) -> bool:
    """Convert TGA thumbnail to PNG. Returns True if successful."""
    if not HAS_PIL:
        return False

    # Look for thumbnail file
    for f in os.listdir(map_dir):
        if f.lower().endswith('.tga') and 'thumb' in f.lower():
            try:
                img = Image.open(os.path.join(map_dir, f)).convert('RGB')
                img.save(output_path)
                return True
            except Exception:
                pass
    return False


def write_bin(output_path: str, w: int, h: int, ambient_r: float, ambient_g: float,
              height_map: np.ndarray, passability: np.ndarray, texture_idx: np.ndarray):
    """Write web-optimized binary map file."""
    with open(output_path, 'wb') as f:
        # Header: 12 bytes
        f.write(struct.pack('<HH', w, h))
        f.write(struct.pack('<ff', ambient_r, ambient_g))
        # Body: 3 × W×H bytes
        f.write(height_map.tobytes())
        f.write(passability.tobytes())
        f.write(texture_idx.tobytes())


def convert_map(map_dir: str, dirname: str, output_dir: str) -> dict | None:
    """Convert a single map. Returns manifest entry or None."""
    inf_path = os.path.join(map_dir, 'map.inf')
    cpt_path = os.path.join(map_dir, 'test.CPT')
    cpf_path = os.path.join(map_dir, 'test.CPF')
    tex_path = os.path.join(map_dir, 'texture.dat')
    lit_path = os.path.join(map_dir, 'test.lit')

    required = [inf_path, cpt_path, cpf_path, tex_path]
    if not all(os.path.exists(p) for p in required):
        print(f'  SKIP {dirname}: missing required files')
        return None

    map_id, name = parse_map_id(dirname)
    if not map_id:
        print(f'  SKIP {dirname}: cannot parse ID')
        return None

    w, h = parse_map_inf(inf_path)
    ambient_r, ambient_g = parse_lit(lit_path) if os.path.exists(lit_path) else (0.5, 0.5)
    players = parse_player_count(dirname)

    # Determine map type
    type_char = map_id[0]
    map_type = MAP_TYPES.get(type_char, 'unknown')

    print(f'  {map_id:5s} {w:3d}×{h:<3d} {map_type:10s} {players}p  "{name}"')

    # Read and downsample data
    height_map = read_cpt(cpt_path, w, h)
    passability = read_cpf(cpf_path, w, h)
    texture_idx = read_texture(tex_path, w, h)

    # Write binary
    bin_path = os.path.join(output_dir, f'{map_id}.bin')
    write_bin(bin_path, w, h, ambient_r, ambient_g, height_map, passability, texture_idx)

    # Convert thumbnail
    thumb_path = os.path.join(output_dir, f'{map_id}.thumb.png')
    has_thumb = convert_thumbnail(map_dir, thumb_path)

    # Calculate file size
    bin_size = os.path.getsize(bin_path)

    return {
        'name': name,
        'w': w,
        'h': h,
        'players': players,
        'type': map_type,
        'binSize': bin_size,
        'hasThumb': has_thumb,
    }


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if not os.path.isdir(MAPS_DIR):
        print(f'ERROR: Maps directory not found: {MAPS_DIR}')
        sys.exit(1)

    # Collect all map directories
    dirs = sorted([
        d for d in os.listdir(MAPS_DIR)
        if os.path.isdir(os.path.join(MAPS_DIR, d)) and d.startswith('#')
    ])

    print(f'Found {len(dirs)} map directories')
    print()

    manifest = {}
    stats = {'total': 0, 'converted': 0, 'skipped': 0, 'total_bytes': 0}

    for dirname in dirs:
        map_dir = os.path.join(MAPS_DIR, dirname)
        entry = convert_map(map_dir, dirname, OUTPUT_DIR)

        stats['total'] += 1
        if entry:
            map_id, _ = parse_map_id(dirname)
            manifest[map_id] = entry
            stats['converted'] += 1
            stats['total_bytes'] += entry['binSize']
        else:
            stats['skipped'] += 1

    # Write manifest
    manifest_path = os.path.join(OUTPUT_DIR, 'manifest.json')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2, sort_keys=True)

    print(f'\n=== Summary ===')
    print(f'Total maps: {stats["total"]}')
    print(f'Converted:  {stats["converted"]}')
    print(f'Skipped:    {stats["skipped"]}')
    print(f'Total size: {stats["total_bytes"] / 1024:.0f} KB ({stats["total_bytes"] / 1024 / 1024:.1f} MB)')
    print(f'Output dir: {OUTPUT_DIR}')
    print(f'Manifest:   {manifest_path}')

    # Print map type counts
    type_counts: dict[str, int] = {}
    for entry in manifest.values():
        t = entry['type']
        type_counts[t] = type_counts.get(t, 0) + 1
    print(f'\nBy type:')
    for t, c in sorted(type_counts.items()):
        print(f'  {t}: {c}')


if __name__ == '__main__':
    main()
