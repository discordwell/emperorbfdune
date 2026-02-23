#!/usr/bin/env python3
"""
Emperor: Battle for Dune — Map Directory Format Parser & Analyzer

The EBFD map format is UNDOCUMENTED and was reverse-engineered from raw binary
analysis of the original game data. Maps are not a single file but a directory
of 6 interrelated binary/text files. The format was colloquially referred to
as ".dme" but no file with that extension exists — the actual structure is a
multi-file directory format used by the Xanadu engine (Intelligent Games, D3D7).

=== DISCOVERED FORMAT STRUCTURE ===

Each map directory (e.g. "#T1 GM Harkonnen Jump Point S LOD2/") contains:

1. map.inf         — Text: map dimensions and zlib sentinel
2. test.CPT        — Binary: 8-byte header + 2048×2048 heightmap (uint8)
3. test.CPF        — Binary: 131072 bytes of nibble-packed passability (512×512)
4. texture.dat     — Binary: 2048×2048 terrain texture palette indices (uint8)
5. test.lit        — Text+binary: lighting configuration (ambient/sun/ground/sky)
6. test.xbf        — XBF 3D scene with FXData sections:
                       Section 0xA0000001: (W+1)*(H+1) float32 heightmap
                       Section 0xA0000002: 8 bytes — uint32 width, uint32 height
                       Section 0xA0000003: W*H bytes — texture palette indices (0-7)
                       Section 0xA0000004: W*H bytes — binary passability (0/255)
                       Section 0xA0000005: entity/spawn data (variable)
                       Section 0xA0000007: pre-placed units for campaign (variable)
                       Section 0xA0000009: 16 bytes — camera/region bounds (4× uint32)

Optional:
  !05%thumb.tga    — 128×128 TGA thumbnail (skirmish maps only)
  !05%thumb_default.tga — default thumbnail

=== SCALE RELATIONSHIPS ===

  Layer          Grid Size    Per Game Tile    Notes
  ─────────────  ──────────   ──────────────   ─────────────────
  CPT heightmap  2048×2048    8×8 fine px      Averaged to get tile height
  texture.dat    2048×2048    8×8 fine px      Center-sampled for tile texture
  CPF passably   512×512      2×2 nibbles      Mode of 2×2 block for tile passability
  XBF FXData     W×H tiles    1:1              Authoritative tile-resolution data
  map.inf dims   W×H tiles    —                Defines playable area within fixed grids

=== CPF NIBBLE ENCODING ===

  131072 bytes = 512 rows × 256 bytes/row
  Each byte: low nibble = even column, high nibble = odd column
  Nibble values 0-15 map to terrain passability:
    0:  Impassable boundary
    1:  Cliff edge
    2:  Open terrain (sand)
    3:  Open terrain variant
    4:  Light dunes
    5:  Rocky elevated
    6:  Main open sand (most common)
    7:  Infantry-only elevated rock
    8:  Dunes
    9:  Dunes variant
    10: Open sand
    11: Sand variant
    12: Spice field (low)
    13: Spice variant
    14: Rich spice
    15: Rich spice variant

=== CPT FORMAT ===

  Offset  Size    Field
  0       4       uint32 LE: grid width  (always 2048)
  4       4       uint32 LE: grid height (always 2048)
  8       2048²   uint8 per fine pixel — elevation value 0-255

=== test.lit FORMAT ===

  Text lines (CRLF), followed by binary zlib data:
    Line 1: 1-3 float values — intensity multiplier(s)
    Line 2: R G B (0-255) — ambient/shadow color
    Line 3: R G B (0-255) — sun/directional color
    Line 4: R G B (0-255) — ground fill color
    Line 5: R G B (0-255) — sky/hemisphere color (optional)

=== map.inf FORMAT ===

  Text lines (CRLF), followed by 4-byte binary + zlib stream:
    Line 1: integer — map width in game tiles
    Line 2: "HEIGHT <integer>" — map height in game tiles
    Bytes after text: 0x00 0x00 0x02 0x00 followed by zlib (0x78 0xDA/0x9C)

Usage:
    python3 parse_dme.py <map_directory>                     # Analyze single map
    python3 parse_dme.py <map_directory> --json              # Output JSON summary
    python3 parse_dme.py <map_directory> --bin out.bin       # Convert to .bin format
    python3 parse_dme.py <map_directory> --hex               # Hex dump of all headers
    python3 parse_dme.py --all <MAPS0001_dir>               # Analyze all maps
    python3 parse_dme.py --all <MAPS0001_dir> --convert-all # Convert all to .bin

Requires: numpy (for array operations)
Optional: xanlib (pip install xanlib) for XBF FXData parsing
Optional: Pillow (for thumbnail conversion)
"""

import argparse
import json
import os
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

# ── CPF Passability Terrain Types ────────────────────────────────────────────

CPF_TERRAIN_NAMES = {
    0:  "Impassable boundary",
    1:  "Cliff edge",
    2:  "Open terrain (sand)",
    3:  "Open terrain variant",
    4:  "Light dunes",
    5:  "Rocky elevated",
    6:  "Main open sand",
    7:  "Infantry-only rock",
    8:  "Dunes",
    9:  "Dunes variant",
    10: "Open sand",
    11: "Sand variant",
    12: "Spice field (low)",
    13: "Spice variant",
    14: "Rich spice",
    15: "Rich spice variant",
}

# Fixed grid sizes used by the Xanadu engine
CPT_GRID_SIZE = 2048      # Fine heightmap/texture grid (CPT + texture.dat)
CPF_GRID_SIZE = 512       # Passability nibble grid
CPF_BYTES_PER_ROW = 256   # 512 nibbles / 2 nibbles per byte
CPF_FILE_SIZE = 131072    # 512 * 256 bytes
TEXTURE_FILE_SIZE = CPT_GRID_SIZE * CPT_GRID_SIZE  # 4194304
CPT_HEADER_SIZE = 8       # 2× uint32 (width, height)
CPT_FILE_SIZE = CPT_HEADER_SIZE + TEXTURE_FILE_SIZE  # 4194312

# Downsampling ratios
FINE_PX_PER_TILE = 8      # CPT/texture.dat pixels per game tile
CPF_CELLS_PER_TILE = 2    # CPF nibbles per game tile


# ── map.inf Parser ───────────────────────────────────────────────────────────

def parse_map_inf(path: str) -> dict:
    """
    Parse map.inf for map dimensions.

    Format:
        Line 1: <width>\\r\\n
        Line 2: HEIGHT <height>\\r\\n
        Binary: 0x00 0x00 0x02 0x00 + zlib compressed data

    Returns dict with 'width', 'height', 'has_zlib', 'zlib_offset'.
    """
    with open(path, 'rb') as f:
        data = f.read()

    result = {'raw_size': len(data)}

    # Split text from binary at the first null byte
    null_pos = data.find(b'\x00')
    text_part = data[:null_pos] if null_pos >= 0 else data
    lines = text_part.split(b'\r\n')

    result['width'] = int(lines[0].strip())
    h_line = lines[1].strip().decode('ascii', errors='replace')
    result['height'] = int(h_line.split()[-1])

    # Check for zlib sentinel after text
    if null_pos >= 0 and null_pos + 4 <= len(data):
        sentinel = data[null_pos:null_pos + 4]
        result['binary_sentinel'] = sentinel.hex()
        # Look for zlib magic (0x78 followed by 0x9C, 0xDA, 0x01, etc.)
        zlib_pos = data.find(b'\x78\xda', null_pos)
        if zlib_pos < 0:
            zlib_pos = data.find(b'\x78\x9c', null_pos)
        result['has_zlib'] = zlib_pos >= 0
        if zlib_pos >= 0:
            result['zlib_offset'] = zlib_pos
            # Try to decompress to see what's inside
            try:
                decompressed = zlib.decompress(data[zlib_pos:])
                result['zlib_decompressed_size'] = len(decompressed)
            except zlib.error:
                result['zlib_decompressed_size'] = None
    else:
        result['has_zlib'] = False

    return result


# ── test.CPT Parser ──────────────────────────────────────────────────────────

def parse_cpt_header(path: str) -> dict:
    """
    Parse CPT file header.

    Format:
        Offset 0: uint32 LE — grid width (always 2048)
        Offset 4: uint32 LE — grid height (always 2048)
        Offset 8: width × height bytes — heightmap data (uint8 per fine pixel)

    Returns dict with header info and height statistics.
    """
    with open(path, 'rb') as f:
        header = f.read(CPT_HEADER_SIZE)
        # Read a sample of height data for statistics
        sample = f.read(min(100000, TEXTURE_FILE_SIZE))

    grid_w, grid_h = struct.unpack('<II', header)
    file_size = os.path.getsize(path)
    data_size = file_size - CPT_HEADER_SIZE

    result = {
        'file_size': file_size,
        'grid_width': grid_w,
        'grid_height': grid_h,
        'expected_data_size': grid_w * grid_h,
        'actual_data_size': data_size,
        'data_matches': data_size == grid_w * grid_h,
    }

    # Height statistics from sample
    heights = np.frombuffer(sample, dtype=np.uint8)
    result['height_min'] = int(heights.min())
    result['height_max'] = int(heights.max())
    result['height_mean'] = round(float(heights.mean()), 1)
    result['height_std'] = round(float(heights.std()), 1)

    return result


def read_cpt_full(path: str) -> np.ndarray:
    """Read full 2048×2048 heightmap from CPT file."""
    with open(path, 'rb') as f:
        f.read(CPT_HEADER_SIZE)
        raw = np.frombuffer(f.read(TEXTURE_FILE_SIZE), dtype=np.uint8)
    return raw.reshape(CPT_GRID_SIZE, CPT_GRID_SIZE)


def downsample_cpt(cpt: np.ndarray, w: int, h: int) -> np.ndarray:
    """
    Downsample 2048×2048 CPT heightmap to W×H tiles.
    Each tile covers an 8×8 block of fine pixels; the tile height is the
    block average (matching the original game's tile-level height).
    """
    out = np.zeros((h, w), dtype=np.uint8)
    for r in range(h):
        for c in range(w):
            r0 = r * FINE_PX_PER_TILE
            c0 = c * FINE_PX_PER_TILE
            r1 = min(r0 + FINE_PX_PER_TILE, CPT_GRID_SIZE)
            c1 = min(c0 + FINE_PX_PER_TILE, CPT_GRID_SIZE)
            out[r, c] = int(cpt[r0:r1, c0:c1].mean())
    return out


# ── test.CPF Parser ──────────────────────────────────────────────────────────

def parse_cpf_header(path: str) -> dict:
    """
    Analyze CPF passability file.

    Format: 131072 bytes = 512 rows × 256 bytes/row
    Each byte packs 2 passability nibbles (4-bit values 0-15):
        Low nibble  (bits 0-3) = even column value
        High nibble (bits 4-7) = odd column value

    This creates a 512×512 nibble grid where each nibble is a passability
    value. Game tiles are 2× the CPF cell size, so a 200×200 tile map uses
    the first 400×400 cells of the 512×512 grid.

    Returns dict with file info and passability statistics.
    """
    with open(path, 'rb') as f:
        data = f.read()

    file_size = len(data)
    result = {
        'file_size': file_size,
        'expected_size': CPF_FILE_SIZE,
        'size_matches': file_size == CPF_FILE_SIZE,
        'grid_size': f'{CPF_GRID_SIZE}×{CPF_GRID_SIZE} nibbles',
        'bytes_per_row': CPF_BYTES_PER_ROW,
    }

    # Unpack all nibbles for analysis
    nibble_counts = [0] * 16
    for byte_val in data:
        lo = byte_val & 0x0F
        hi = (byte_val >> 4) & 0x0F
        nibble_counts[lo] += 1
        nibble_counts[hi] += 1

    total_nibbles = CPF_GRID_SIZE * CPF_GRID_SIZE
    result['nibble_histogram'] = {}
    for val in range(16):
        count = nibble_counts[val]
        if count > 0:
            result['nibble_histogram'][val] = {
                'count': count,
                'percent': round(count / total_nibbles * 100, 1),
                'terrain': CPF_TERRAIN_NAMES[val],
            }

    return result


def read_cpf_full(path: str) -> np.ndarray:
    """Read and unpack CPF into 512×512 nibble grid."""
    with open(path, 'rb') as f:
        raw = np.frombuffer(f.read(CPF_FILE_SIZE), dtype=np.uint8)

    cpf = np.zeros((CPF_GRID_SIZE, CPF_GRID_SIZE), dtype=np.uint8)
    for row in range(CPF_GRID_SIZE):
        base = row * CPF_BYTES_PER_ROW
        for col in range(CPF_BYTES_PER_ROW):
            byte = raw[base + col]
            cpf[row, col * 2] = byte & 0x0F       # Low nibble → even column
            cpf[row, col * 2 + 1] = (byte >> 4) & 0x0F  # High nibble → odd column
    return cpf


def downsample_cpf(cpf: np.ndarray, w: int, h: int) -> np.ndarray:
    """
    Downsample 512×512 CPF nibble grid to W×H tiles.
    Each tile covers a 2×2 block of CPF cells; the tile passability is
    the mode (most common value) of the 2×2 block.
    """
    out = np.zeros((h, w), dtype=np.uint8)
    for r in range(h):
        for c in range(w):
            r0 = r * CPF_CELLS_PER_TILE
            c0 = c * CPF_CELLS_PER_TILE
            r1 = min(r0 + CPF_CELLS_PER_TILE, CPF_GRID_SIZE)
            c1 = min(c0 + CPF_CELLS_PER_TILE, CPF_GRID_SIZE)
            block = cpf[r0:r1, c0:c1].flatten()
            vals, counts = np.unique(block, return_counts=True)
            out[r, c] = vals[counts.argmax()]
    return out


# ── texture.dat Parser ───────────────────────────────────────────────────────

def parse_texture_header(path: str) -> dict:
    """
    Analyze texture.dat terrain texture index file.

    Format: 2048×2048 bytes, each byte is a texture palette index (0-255).
    The palette maps to the texture names stored in the test.xbf textureNameData.

    Returns dict with file info and texture usage statistics.
    """
    with open(path, 'rb') as f:
        data = np.frombuffer(f.read(TEXTURE_FILE_SIZE), dtype=np.uint8)

    file_size = len(data)
    unique_vals = np.unique(data)

    # Get top 10 most common texture indices
    vals, counts = np.unique(data, return_counts=True)
    sorted_idx = np.argsort(-counts)
    top10 = [(int(vals[i]), int(counts[i]), round(counts[i] / len(data) * 100, 1))
             for i in sorted_idx[:10]]

    return {
        'file_size': file_size,
        'expected_size': TEXTURE_FILE_SIZE,
        'size_matches': file_size == TEXTURE_FILE_SIZE,
        'grid_size': f'{CPT_GRID_SIZE}×{CPT_GRID_SIZE}',
        'unique_textures': len(unique_vals),
        'texture_range': f'{int(unique_vals.min())}-{int(unique_vals.max())}',
        'top_textures': [
            {'index': idx, 'count': cnt, 'percent': pct}
            for idx, cnt, pct in top10
        ],
    }


def read_texture_full(path: str) -> np.ndarray:
    """Read full 2048×2048 texture index grid."""
    with open(path, 'rb') as f:
        raw = np.frombuffer(f.read(TEXTURE_FILE_SIZE), dtype=np.uint8)
    return raw.reshape(CPT_GRID_SIZE, CPT_GRID_SIZE)


def downsample_texture(tex: np.ndarray, w: int, h: int) -> np.ndarray:
    """
    Downsample 2048×2048 texture grid to W×H tiles.
    Each tile samples the center pixel of its 8×8 block.
    """
    out = np.zeros((h, w), dtype=np.uint8)
    for r in range(h):
        for c in range(w):
            sr = min(r * FINE_PX_PER_TILE + FINE_PX_PER_TILE // 2,
                     CPT_GRID_SIZE - 1)
            sc = min(c * FINE_PX_PER_TILE + FINE_PX_PER_TILE // 2,
                     CPT_GRID_SIZE - 1)
            out[r, c] = tex[sr, sc]
    return out


# ── test.lit Parser ──────────────────────────────────────────────────────────

def parse_lit(path: str) -> dict:
    """
    Parse test.lit lighting configuration.

    Format (text lines CRLF, followed by optional binary data):
        Line 1: 1-3 float values — intensity multiplier(s)
        Line 2: R G B (0-255) — ambient/shadow color
        Line 3: R G B (0-255) — sun/directional light color
        Line 4: R G B (0-255) — ground fill color
        Line 5: R G B (0-255) — sky/hemisphere color (optional)
        After text: possible 4-byte sentinel + zlib data

    Returns dict with parsed lighting data.
    """
    with open(path, 'rb') as f:
        data = f.read()

    result = {'raw_size': len(data)}

    # Parse text lines, stopping at non-numeric data
    raw_lines = data.split(b'\r\n')
    lines = []
    for raw in raw_lines:
        try:
            text = raw.decode('ascii').strip()
        except UnicodeDecodeError:
            # Extract ASCII prefix from binary-contaminated line
            ascii_bytes = bytearray()
            for b in raw:
                if b < 0x80 and (b == 0x20 or b == 0x2E or 0x30 <= b <= 0x39):
                    ascii_bytes.append(b)
                elif len(ascii_bytes) > 0:
                    break
            text = ascii_bytes.decode('ascii').strip() if ascii_bytes else ''
            if not text:
                break
        if not text:
            break
        parts = text.split()
        try:
            [float(p) for p in parts]
        except ValueError:
            break
        lines.append(text)
        if len(lines) >= 5:
            break

    if len(lines) >= 1:
        result['intensity'] = [float(v) for v in lines[0].split()]

    def safe_int(s: str) -> int:
        """Parse an integer from a string that may have trailing non-digit chars."""
        import re
        m = re.match(r'^-?\d+', s.strip())
        return int(m.group(0)) if m else 0

    def parse_rgb_line(line: str) -> list[int]:
        """Parse R G B from a line, tolerating trailing binary contamination."""
        parts = line.split()[:3]
        return [safe_int(p) for p in parts]

    if len(lines) >= 2:
        result['ambient_color'] = parse_rgb_line(lines[1])

    if len(lines) >= 3:
        result['sun_color'] = parse_rgb_line(lines[2])

    if len(lines) >= 4:
        result['ground_color'] = parse_rgb_line(lines[3])

    if len(lines) >= 5:
        parts = lines[4].split()
        if len(parts) >= 3:
            result['sky_color'] = [safe_int(v) for v in parts[:3]]

    # Check for trailing binary data
    result['has_binary_tail'] = b'\x78\xda' in data or b'\x78\x9c' in data

    return result


# ── XBF FXData Parser ────────────────────────────────────────────────────────

def parse_xbf_sections(path: str) -> dict:
    """
    Parse test.xbf to extract FXData section summary.

    The XBF file contains a 3D scene (terrain mesh + objects). The FXData
    field of the root Scene object stores map metadata in tagged sections:

        Tag 0xA000NNNN: section ID = NNNN
        Each section: tag(4) + size(4) + data(size)

    Known sections:
        0x0000: Empty (0 bytes)
        0x0001: Heightmap — (W+1)×(H+1) float32 values
        0x0002: Dimensions — uint32 width, uint32 height
        0x0003: Texture map — W×H bytes (palette index 0-7)
        0x0004: Passability — W×H bytes (0=passable, 255=blocked)
        0x0005: Entities — spawn points, spice fields, entrances, scripts
        0x0007: Pre-placed units — campaign starting units
        0x0009: Camera/region bounds — 4× uint32 (16 bytes)

    Returns dict with section summaries.
    """
    result = {'available': False}

    try:
        from xanlib import load_xbf
    except ImportError:
        result['error'] = 'xanlib not installed (pip install xanlib)'
        return result

    try:
        scene = load_xbf(str(path))
    except Exception as e:
        result['error'] = f'Failed to load XBF: {e}'
        return result

    if not scene.FXData or len(scene.FXData) == 0:
        result['error'] = 'No FXData in XBF'
        return result

    result['available'] = True
    result['fxdata_size'] = len(scene.FXData)
    result['node_count'] = len(scene.nodes)

    # Parse sections
    fxdata = scene.FXData
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

    result['sections'] = {}
    section_names = {
        0: 'empty',
        1: 'heightmap',
        2: 'dimensions',
        3: 'texture_map',
        4: 'passability',
        5: 'entities',
        7: 'preplaced_units',
        9: 'camera_bounds',
    }

    width = height = 0
    if 2 in sections:
        width, height = struct.unpack_from('<II', sections[2], 0)

    for sid, sdata in sorted(sections.items()):
        sec_info = {
            'id': f'0xA000{sid:04X}',
            'size': len(sdata),
            'name': section_names.get(sid, 'unknown'),
        }

        if sid == 2:
            sec_info['width'] = width
            sec_info['height'] = height

        elif sid == 1 and width > 0:
            expected = (width + 1) * (height + 1) * 4
            sec_info['expected_size'] = expected
            sec_info['grid'] = f'({width+1})×({height+1}) float32'
            sec_info['matches'] = len(sdata) == expected
            # Height statistics
            if len(sdata) >= 4:
                num_floats = min(len(sdata) // 4, (width + 1) * (height + 1))
                heights = np.array(struct.unpack_from(f'<{num_floats}f', sdata, 0))
                sec_info['height_min'] = round(float(heights.min()), 2)
                sec_info['height_max'] = round(float(heights.max()), 2)
                sec_info['height_mean'] = round(float(heights.mean()), 2)

        elif sid == 3:
            sec_info['expected_size'] = width * height
            vals = np.frombuffer(sdata, dtype=np.uint8) if sdata else np.array([])
            sec_info['unique_values'] = len(np.unique(vals)) if len(vals) > 0 else 0
            sec_info['value_range'] = f'{int(vals.min())}-{int(vals.max())}' if len(vals) > 0 else 'N/A'

        elif sid == 4:
            sec_info['expected_size'] = width * height
            vals = np.frombuffer(sdata, dtype=np.uint8) if sdata else np.array([])
            if len(vals) > 0:
                unique = np.unique(vals)
                sec_info['unique_values'] = len(unique)
                sec_info['encoding'] = 'binary (0=passable, 255=blocked)' \
                    if set(unique).issubset({0, 255}) else f'values: {list(unique[:10])}'

        elif sid == 5:
            sec_info['description'] = 'Spawn points, spice fields, entrances, script triggers, AI waypoints'
            # Try to extract entity names
            import re
            strings = re.findall(b'[A-Za-z_][A-Za-z0-9_]{3,}', sdata)
            sec_info['entity_names'] = list(set(s.decode() for s in strings[:20]))

        elif sid == 7:
            import re
            strings = re.findall(b'[A-Za-z_][A-Za-z0-9_]{3,}', sdata)
            unit_names = list(set(s.decode() for s in strings))
            sec_info['unit_names'] = sorted(unit_names)[:20]

        elif sid == 9 and len(sdata) >= 16:
            vals = struct.unpack_from('<4I', sdata, 0)
            sec_info['values'] = list(vals)
            sec_info['interpretation'] = f'Bounds: ({vals[0]}, {vals[1]}) to ({vals[2]}, {vals[3]})'

        result['sections'][sid] = sec_info

    # Extract texture names from scene
    if scene.textureNameData:
        textures = []
        for part in scene.textureNameData.split(b'\x00'):
            name = part.decode('ascii', errors='replace').strip()
            if name and len(name) > 1:
                textures.append(name)
        result['texture_names'] = textures

    return result


# ── Hex Dump ─────────────────────────────────────────────────────────────────

def hex_dump(data: bytes, offset: int = 0, length: int = 256) -> str:
    """Format bytes as a hex dump with ASCII sidebar."""
    lines = []
    for i in range(0, min(length, len(data)), 16):
        chunk = data[i:i + 16]
        hex_part = ' '.join(f'{b:02x}' for b in chunk)
        ascii_part = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
        lines.append(f'  {offset + i:08x}  {hex_part:<48s}  {ascii_part}')
    return '\n'.join(lines)


# ── .bin Output ──────────────────────────────────────────────────────────────

def write_bin(output_path: str, w: int, h: int, ambient_r: float, ambient_g: float,
              height_map: np.ndarray, passability: np.ndarray, texture_idx: np.ndarray):
    """
    Write web-optimized binary map file (.bin format).

    Format:
        Header (12 bytes):
            uint16 LE: width
            uint16 LE: height
            float32 LE: ambientR
            float32 LE: ambientG
        Body (3 × W×H bytes):
            heightMap[W*H]   — elevation 0-255
            passability[W*H] — terrain type 0-15
            textureIdx[W*H]  — texture palette index 0-255
    """
    with open(output_path, 'wb') as f:
        f.write(struct.pack('<HH', w, h))
        f.write(struct.pack('<ff', ambient_r, ambient_g))
        f.write(height_map.tobytes())
        f.write(passability.tobytes())
        f.write(texture_idx.tobytes())


# ── Full Map Analysis ────────────────────────────────────────────────────────

def analyze_map(map_dir: str, show_hex: bool = False) -> dict:
    """
    Analyze a complete Emperor: BFD map directory.

    Parses all component files and returns a comprehensive summary.
    """
    result = {
        'directory': os.path.basename(map_dir),
        'files': {},
    }

    # List files
    if os.path.isdir(map_dir):
        result['file_list'] = sorted(os.listdir(map_dir))
    else:
        result['error'] = 'Not a directory'
        return result

    # map.inf
    inf_path = os.path.join(map_dir, 'map.inf')
    if os.path.exists(inf_path):
        inf_data = parse_map_inf(inf_path)
        result['files']['map.inf'] = inf_data
        result['width'] = inf_data['width']
        result['height'] = inf_data['height']
        result['tile_count'] = inf_data['width'] * inf_data['height']
        if show_hex:
            with open(inf_path, 'rb') as f:
                result['files']['map.inf']['hex_dump'] = hex_dump(f.read())
    else:
        result['files']['map.inf'] = {'error': 'File not found'}

    w = result.get('width', 0)
    h = result.get('height', 0)

    # test.CPT
    cpt_path = os.path.join(map_dir, 'test.CPT')
    if os.path.exists(cpt_path):
        cpt_info = parse_cpt_header(cpt_path)
        result['files']['test.CPT'] = cpt_info
        if show_hex:
            with open(cpt_path, 'rb') as f:
                result['files']['test.CPT']['hex_dump'] = hex_dump(f.read(256))
    else:
        result['files']['test.CPT'] = {'error': 'File not found'}

    # test.CPF
    cpf_path = os.path.join(map_dir, 'test.CPF')
    if os.path.exists(cpf_path):
        cpf_info = parse_cpf_header(cpf_path)
        result['files']['test.CPF'] = cpf_info

        # Show active area vs boundary
        if w > 0 and h > 0:
            cpf_info['active_area'] = f'{w * CPF_CELLS_PER_TILE}×{h * CPF_CELLS_PER_TILE} of {CPF_GRID_SIZE}×{CPF_GRID_SIZE}'

        if show_hex:
            with open(cpf_path, 'rb') as f:
                result['files']['test.CPF']['hex_dump'] = hex_dump(f.read(256))
    else:
        result['files']['test.CPF'] = {'error': 'File not found'}

    # texture.dat
    tex_path = os.path.join(map_dir, 'texture.dat')
    if os.path.exists(tex_path):
        tex_info = parse_texture_header(tex_path)
        result['files']['texture.dat'] = tex_info
        if show_hex:
            with open(tex_path, 'rb') as f:
                result['files']['texture.dat']['hex_dump'] = hex_dump(f.read(256))
    else:
        result['files']['texture.dat'] = {'error': 'File not found'}

    # test.lit
    lit_path = os.path.join(map_dir, 'test.lit')
    if os.path.exists(lit_path):
        lit_info = parse_lit(lit_path)
        result['files']['test.lit'] = lit_info
        if show_hex:
            with open(lit_path, 'rb') as f:
                result['files']['test.lit']['hex_dump'] = hex_dump(f.read())
    else:
        result['files']['test.lit'] = {'error': 'File not found'}

    # test.xbf
    xbf_path = os.path.join(map_dir, 'test.xbf')
    if os.path.exists(xbf_path):
        xbf_info = parse_xbf_sections(xbf_path)
        result['files']['test.xbf'] = xbf_info
    else:
        result['files']['test.xbf'] = {'error': 'File not found'}

    # Scale relationship summary
    if w > 0 and h > 0:
        result['scale_info'] = {
            'tile_dimensions': f'{w}×{h}',
            'cpt_fine_grid': f'{CPT_GRID_SIZE}×{CPT_GRID_SIZE}',
            'cpf_nibble_grid': f'{CPF_GRID_SIZE}×{CPF_GRID_SIZE}',
            'fine_px_per_tile': FINE_PX_PER_TILE,
            'cpf_cells_per_tile': CPF_CELLS_PER_TILE,
            'active_cpt_area': f'{w * FINE_PX_PER_TILE}×{h * FINE_PX_PER_TILE}',
            'active_cpf_area': f'{w * CPF_CELLS_PER_TILE}×{h * CPF_CELLS_PER_TILE}',
        }

    return result


def convert_map(map_dir: str, output_path: str) -> bool:
    """
    Convert a map directory to the .bin web format.

    Reads CPT, CPF, texture.dat, lit and map.inf, downsamples to tile
    resolution, and writes the compact binary format.

    Returns True on success.
    """
    inf_path = os.path.join(map_dir, 'map.inf')
    cpt_path = os.path.join(map_dir, 'test.CPT')
    cpf_path = os.path.join(map_dir, 'test.CPF')
    tex_path = os.path.join(map_dir, 'texture.dat')
    lit_path = os.path.join(map_dir, 'test.lit')

    required = [inf_path, cpt_path, cpf_path, tex_path]
    for p in required:
        if not os.path.exists(p):
            print(f'  ERROR: Missing {os.path.basename(p)}')
            return False

    # Parse dimensions
    inf_data = parse_map_inf(inf_path)
    w = inf_data['width']
    h = inf_data['height']

    # Parse lighting
    if os.path.exists(lit_path):
        lit_data = parse_lit(lit_path)
        intensity = lit_data.get('intensity', [0.5])
        ambient_r = intensity[0]
        ambient_g = intensity[-1]
    else:
        ambient_r = ambient_g = 0.5

    # Read and downsample
    print(f'  Reading CPT ({CPT_GRID_SIZE}² → {w}×{h})...')
    cpt = read_cpt_full(cpt_path)
    height_map = downsample_cpt(cpt, w, h)

    print(f'  Reading CPF ({CPF_GRID_SIZE}² → {w}×{h})...')
    cpf = read_cpf_full(cpf_path)
    passability = downsample_cpf(cpf, w, h)

    print(f'  Reading texture.dat ({CPT_GRID_SIZE}² → {w}×{h})...')
    tex = read_texture_full(tex_path)
    texture_idx = downsample_texture(tex, w, h)

    # Write output
    write_bin(output_path, w, h, ambient_r, ambient_g, height_map, passability, texture_idx)
    file_size = os.path.getsize(output_path)
    print(f'  Written: {output_path} ({file_size:,} bytes)')

    return True


# ── Pretty Print ─────────────────────────────────────────────────────────────

def print_analysis(analysis: dict):
    """Print a human-readable analysis summary."""
    print(f'{"=" * 72}')
    print(f'Emperor: BFD Map Analysis — {analysis["directory"]}')
    print(f'{"=" * 72}')

    if 'width' in analysis:
        w = analysis['width']
        h = analysis['height']
        tiles = analysis['tile_count']
        print(f'\nDimensions: {w} × {h} tiles ({tiles:,} total)')

    if 'scale_info' in analysis:
        si = analysis['scale_info']
        print(f'\nScale Relationships:')
        print(f'  Game tiles:       {si["tile_dimensions"]}')
        print(f'  CPT fine grid:    {si["cpt_fine_grid"]} ({si["fine_px_per_tile"]}px/tile)')
        print(f'  CPF nibble grid:  {si["cpf_nibble_grid"]} ({si["cpf_cells_per_tile"]} cells/tile)')
        print(f'  Active CPT area:  {si["active_cpt_area"]}')
        print(f'  Active CPF area:  {si["active_cpf_area"]}')

    print(f'\nFiles:')
    for fname, finfo in analysis.get('files', {}).items():
        if 'error' in finfo:
            print(f'\n  {fname}: {finfo["error"]}')
            continue

        print(f'\n  {fname}:')

        if fname == 'map.inf':
            print(f'    Width: {finfo["width"]} tiles')
            print(f'    Height: {finfo["height"]} tiles')
            print(f'    Has zlib data: {finfo.get("has_zlib", False)}')

        elif fname == 'test.CPT':
            print(f'    File size: {finfo["file_size"]:,} bytes')
            print(f'    Grid: {finfo["grid_width"]}×{finfo["grid_height"]}')
            print(f'    Height range: {finfo["height_min"]}-{finfo["height_max"]} '
                  f'(mean={finfo["height_mean"]}, std={finfo["height_std"]})')
            print(f'    Data integrity: {"OK" if finfo["data_matches"] else "MISMATCH"}')

        elif fname == 'test.CPF':
            print(f'    File size: {finfo["file_size"]:,} bytes')
            print(f'    Grid: {finfo["grid_size"]}')
            if 'active_area' in finfo:
                print(f'    Active area: {finfo["active_area"]}')
            print(f'    Passability distribution:')
            for nib, info in finfo.get('nibble_histogram', {}).items():
                bar = '#' * max(1, int(info['percent'] / 2))
                print(f'      {nib:2d} ({info["terrain"]:24s}): '
                      f'{info["count"]:7d} ({info["percent"]:5.1f}%) {bar}')

        elif fname == 'texture.dat':
            print(f'    File size: {finfo["file_size"]:,} bytes')
            print(f'    Grid: {finfo["grid_size"]}')
            print(f'    Unique textures: {finfo["unique_textures"]}')
            print(f'    Index range: {finfo["texture_range"]}')
            print(f'    Top textures:')
            for t in finfo['top_textures'][:5]:
                print(f'      Index {t["index"]:3d}: {t["count"]:7d} ({t["percent"]}%)')

        elif fname == 'test.lit':
            if 'intensity' in finfo:
                print(f'    Intensity: {finfo["intensity"]}')
            if 'ambient_color' in finfo:
                print(f'    Ambient color:  RGB({finfo["ambient_color"]})')
            if 'sun_color' in finfo:
                print(f'    Sun color:      RGB({finfo["sun_color"]})')
            if 'ground_color' in finfo:
                print(f'    Ground color:   RGB({finfo["ground_color"]})')
            if 'sky_color' in finfo:
                print(f'    Sky color:      RGB({finfo["sky_color"]})')

        elif fname == 'test.xbf':
            if not finfo.get('available', False):
                if 'error' in finfo:
                    print(f'    {finfo["error"]}')
                continue
            print(f'    FXData size: {finfo["fxdata_size"]:,} bytes')
            print(f'    Nodes: {finfo["node_count"]}')
            if 'texture_names' in finfo:
                print(f'    Textures: {", ".join(finfo["texture_names"][:8])}')
            print(f'    Sections:')
            for sid, sec in finfo.get('sections', {}).items():
                print(f'      {sec["id"]} ({sec["name"]}): {sec["size"]:,} bytes')
                if 'width' in sec:
                    print(f'        Dimensions: {sec["width"]}×{sec["height"]}')
                if 'grid' in sec:
                    print(f'        Grid: {sec["grid"]}')
                if 'height_min' in sec:
                    print(f'        Height range: {sec["height_min"]} to {sec["height_max"]} '
                          f'(mean={sec["height_mean"]})')
                if 'encoding' in sec:
                    print(f'        Encoding: {sec["encoding"]}')
                if 'unit_names' in sec and sec['unit_names']:
                    print(f'        Units: {", ".join(sec["unit_names"][:10])}')
                if 'entity_names' in sec:
                    names = sec['entity_names'][:10]
                    print(f'        Entities: {", ".join(names)}')
                if 'interpretation' in sec:
                    print(f'        {sec["interpretation"]}')

        # Hex dump
        if 'hex_dump' in finfo:
            print(f'    Hex dump:')
            print(finfo['hex_dump'])


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Emperor: Battle for Dune map directory format parser',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s "extracted/MAPS0001/#T1 GM Harkonnen Jump Point S LOD2"
  %(prog)s "extracted/MAPS0001/#T1 GM Harkonnen Jump Point S LOD2" --hex
  %(prog)s "extracted/MAPS0001/#T1 GM Harkonnen Jump Point S LOD2" --json
  %(prog)s "extracted/MAPS0001/#T1 GM Harkonnen Jump Point S LOD2" --bin T1.bin
  %(prog)s --all extracted/MAPS0001/
  %(prog)s --all extracted/MAPS0001/ --convert-all --output-dir assets/maps/
        """,
    )
    parser.add_argument('path', help='Map directory or MAPS0001 root (with --all)')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    parser.add_argument('--hex', action='store_true', help='Include hex dumps of headers')
    parser.add_argument('--bin', metavar='FILE', help='Convert to .bin format')
    parser.add_argument('--all', action='store_true', help='Analyze all maps in directory')
    parser.add_argument('--convert-all', action='store_true',
                        help='Convert all maps to .bin (with --all)')
    parser.add_argument('--output-dir', default='.', help='Output directory for --convert-all')

    args = parser.parse_args()

    if args.all:
        # Process all map directories
        maps_dir = args.path
        if not os.path.isdir(maps_dir):
            print(f'ERROR: {maps_dir} is not a directory')
            sys.exit(1)

        dirs = sorted([
            d for d in os.listdir(maps_dir)
            if os.path.isdir(os.path.join(maps_dir, d)) and d.startswith('#')
        ])

        if not dirs:
            print(f'No map directories found in {maps_dir}')
            sys.exit(1)

        print(f'Found {len(dirs)} map directories\n')

        results = []
        for dirname in dirs:
            map_dir = os.path.join(maps_dir, dirname)

            if args.convert_all:
                # Extract map ID from dirname
                import re
                match = re.match(r'^#([A-Z]\d+)', dirname)
                if not match:
                    print(f'  SKIP {dirname}: cannot parse ID')
                    continue
                map_id = match.group(1)
                output_path = os.path.join(args.output_dir, f'{map_id}.bin')
                print(f'Converting {dirname} → {map_id}.bin')
                convert_map(map_dir, output_path)
            else:
                analysis = analyze_map(map_dir, show_hex=args.hex)
                results.append(analysis)

                if args.json:
                    pass  # Collect all, print at end
                else:
                    # Print compact summary line
                    w = analysis.get('width', '?')
                    h = analysis.get('height', '?')
                    tiles = analysis.get('tile_count', 0)
                    xbf = analysis.get('files', {}).get('test.xbf', {})
                    sections = len(xbf.get('sections', {})) if xbf.get('available') else 0
                    print(f'  {dirname:55s}  {w:>3}×{h:<3}  '
                          f'{tiles:>5} tiles  {sections} XBF sections')

        if args.json and not args.convert_all:
            # Clean up hex dumps for JSON (they'd be huge)
            for r in results:
                for finfo in r.get('files', {}).values():
                    if 'hex_dump' in finfo:
                        del finfo['hex_dump']
            print(json.dumps(results, indent=2))

        if not args.json and not args.convert_all:
            print(f'\n{len(dirs)} maps analyzed')

    else:
        # Single map
        map_dir = args.path

        if args.bin:
            print(f'Converting {map_dir} → {args.bin}')
            success = convert_map(map_dir, args.bin)
            if not success:
                sys.exit(1)
        else:
            analysis = analyze_map(map_dir, show_hex=args.hex)

            if args.json:
                # Remove hex dumps for clean JSON
                for finfo in analysis.get('files', {}).values():
                    if 'hex_dump' in finfo:
                        del finfo['hex_dump']
                print(json.dumps(analysis, indent=2))
            else:
                print_analysis(analysis)


if __name__ == '__main__':
    main()
