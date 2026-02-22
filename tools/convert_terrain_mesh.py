#!/usr/bin/env python3
"""
Convert Emperor: Battle for Dune terrain XBF meshes to optimized .glb + .terrain.heights files.

Each map's test.xbf contains 625 terrain patches with ~50K triangles and 18-26 textures.
This converter merges all patches by texture into a single glTF mesh with one primitive
per texture, applies coordinate transforms, and embeds texture images into a binary .glb.

Usage:
    python3 tools/convert_terrain_mesh.py --map T5          # Single map
    python3 tools/convert_terrain_mesh.py --all             # All 82 maps
    python3 tools/convert_terrain_mesh.py --list            # List available maps

Requires: xanlib (pip install xanlib), Pillow
"""

import json
import struct
import sys
import os
from pathlib import Path
from PIL import Image
import io

try:
    from xanlib import load_xbf
except ImportError:
    print("Error: xanlib not installed. Run: pip install xanlib")
    sys.exit(1)


# Coordinate transform: XBF uses 32 units per tile, web uses TILE_SIZE=2
SCALE = 2.0 / 32.0  # 0.0625

MAPS_DIR = Path("extracted/MAPS0001")
TEXTURES_DIR = Path("assets/textures")
OUTPUT_DIR = Path("assets/maps/terrain")


def parse_map_id(dirname: str) -> str | None:
    """Extract map ID (e.g. 'T5', 'M29') from directory name like '#T5 JF The Cauldron S LOD2'."""
    if not dirname.startswith('#'):
        return None
    parts = dirname[1:].split()
    if not parts:
        return None
    return parts[0]


def find_map_dir(map_id: str) -> Path | None:
    """Find the map directory for a given map ID."""
    for d in MAPS_DIR.iterdir():
        if d.is_dir() and parse_map_id(d.name) == map_id:
            return d
    return None


def list_maps() -> list[tuple[str, str]]:
    """List all available maps with their IDs and names."""
    maps = []
    for d in sorted(MAPS_DIR.iterdir()):
        if d.is_dir():
            mid = parse_map_id(d.name)
            if mid:
                maps.append((mid, d.name))
    return maps


def clean_texture_name(name: str) -> str:
    """Strip non-printable prefix bytes from texture names (XBF sometimes has \\x02 prefix)."""
    return name.lstrip('\x00\x01\x02\x03\x04\x05\x06\x07\x08')


def load_png_as_bytes(name: str) -> bytes | None:
    """Load a PNG texture by TGA name, returning raw PNG bytes."""
    stem = Path(clean_texture_name(name)).stem
    png_path = TEXTURES_DIR / f"{stem}.png"
    if not png_path.exists():
        # Try case-insensitive
        for f in TEXTURES_DIR.iterdir():
            if f.stem.lower() == stem.lower() and f.suffix == '.png':
                png_path = f
                break
        else:
            return None
    return png_path.read_bytes()


def tga_to_png_bytes(tga_name: str, map_dir: Path) -> bytes | None:
    """Convert TGA from extracted map dir to PNG bytes as fallback."""
    tga_path = map_dir / clean_texture_name(tga_name)
    if not tga_path.exists():
        return None
    try:
        img = Image.open(tga_path).convert("RGBA")
        import numpy as np
        data = np.array(img)
        mask = (data[:, :, 0] == 255) & (data[:, :, 1] == 0) & (data[:, :, 2] == 255)
        data[mask, 3] = 0
        buf = io.BytesIO()
        Image.fromarray(data).save(buf, format='PNG')
        return buf.getvalue()
    except Exception:
        return None


def parse_fxdata_heightmap(fxdata: bytes) -> tuple[int, int, list[float]] | None:
    """Parse FXData to extract dimensions and float32 heightmap.
    Returns (width, height, heights_list) or None."""
    pos = 0
    sections = {}
    while pos + 8 <= len(fxdata):
        tag = struct.unpack_from('<I', fxdata, pos)[0]
        size = struct.unpack_from('<I', fxdata, pos + 4)[0]
        if (tag & 0xFFFF0000) != 0xA0000000:
            break
        section_id = tag & 0xFFFF
        sections[section_id] = fxdata[pos + 8: pos + 8 + size]
        pos += 8 + size

    if 2 not in sections or 1 not in sections:
        return None

    w, h = struct.unpack_from('<II', sections[2], 0)
    expected = (w + 1) * (h + 1)
    sec1 = sections[1]
    num_floats = len(sec1) // 4
    if num_floats < expected:
        return None

    heights = []
    for i in range(expected):
        heights.append(struct.unpack_from('<f', sec1, i * 4)[0])

    return w, h, heights


def convert_terrain(map_id: str) -> bool:
    """Convert a single map's terrain XBF to .glb + .heights files."""
    map_dir = find_map_dir(map_id)
    if not map_dir:
        print(f"  SKIP: Map directory not found for {map_id}")
        return False

    xbf_path = map_dir / "test.xbf"
    if not xbf_path.exists():
        print(f"  SKIP: No test.xbf in {map_dir.name}")
        return False

    # Load XBF scene
    scene = load_xbf(str(xbf_path))

    # Get texture names
    if not scene.textureNameData:
        print(f"  SKIP: No texture data in {map_id}")
        return False

    tex_names = [n.decode('ascii', 'replace')
                 for n in scene.textureNameData.split(b'\x00') if n]

    # --- Merge all node faces by texture index ---
    # groups[tex_idx] = { 'positions': [], 'normals': [], 'uvs': [], 'indices': [],
    #                      'vertex_map': {}, 'idx_counter': 0 }
    groups: dict[int, dict] = {}

    for node in scene.nodes:
        if not node.faces or not node.vertices:
            continue
        for face in node.faces:
            tex_idx = face.texture_index
            if tex_idx not in groups:
                groups[tex_idx] = {
                    'positions': [], 'normals': [], 'uvs': [],
                    'indices': [], 'vertex_map': {}, 'idx_counter': 0
                }
            g = groups[tex_idx]
            face_indices = []

            for j, vi in enumerate(face.vertex_indices):
                v = node.vertices[vi]
                # Get UV coords
                u = face.uv_coords[j][0] if j < len(face.uv_coords) else 0.0
                uv_v = 1.0 - (face.uv_coords[j][1] if j < len(face.uv_coords) else 0.0)

                # Coordinate transform: XBF -> web
                web_x = v.position.x * SCALE
                web_y = v.position.y * SCALE
                web_z = -v.position.z * SCALE  # negate Z

                # Normal transform
                nx = v.normal.x
                ny = v.normal.y
                nz = -v.normal.z  # negate Z

                # De-duplicate vertices by (node_id, vertex_index, uv)
                key = (id(node), vi, round(u, 6), round(uv_v, 6))
                if key not in g['vertex_map']:
                    g['vertex_map'][key] = g['idx_counter']
                    g['positions'].extend([web_x, web_y, web_z])
                    g['normals'].extend([nx, ny, nz])
                    g['uvs'].extend([u, uv_v])
                    g['idx_counter'] += 1

                face_indices.append(g['vertex_map'][key])

            # All faces are triangles
            if len(face_indices) >= 3:
                g['indices'].extend(face_indices[:3])
            if len(face_indices) == 4:
                g['indices'].extend([face_indices[0], face_indices[2], face_indices[3]])

    if not groups:
        print(f"  SKIP: No geometry in {map_id}")
        return False

    # --- Build glTF binary (.glb) ---
    binary_data = bytearray()
    buffer_views = []
    accessors = []
    primitives = []
    materials = []
    textures_list = []
    images_list = []
    samplers = [{"wrapS": 10497, "wrapT": 10497, "magFilter": 9729, "minFilter": 9987}]

    def add_buffer_view(data: bytes, target: int | None = None) -> int:
        offset = len(binary_data)
        binary_data.extend(data)
        # Pad to 4-byte alignment
        while len(binary_data) % 4 != 0:
            binary_data.append(0)
        bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            bv["target"] = target
        idx = len(buffer_views)
        buffer_views.append(bv)
        return idx

    def add_accessor(bv_idx: int, comp_type: int, count: int, acc_type: str,
                     min_vals=None, max_vals=None) -> int:
        acc = {
            "bufferView": bv_idx,
            "componentType": comp_type,
            "count": count,
            "type": acc_type,
        }
        if min_vals is not None:
            acc["min"] = min_vals
        if max_vals is not None:
            acc["max"] = max_vals
        idx = len(accessors)
        accessors.append(acc)
        return idx

    # Load and embed textures, create materials
    tex_image_map = {}  # tex_idx -> glTF image index
    for tex_idx in sorted(groups.keys()):
        if tex_idx >= len(tex_names):
            continue
        tga_name = tex_names[tex_idx]

        # Try loading pre-converted PNG first, then TGA from map dir
        png_bytes = load_png_as_bytes(tga_name)
        if not png_bytes:
            png_bytes = tga_to_png_bytes(tga_name, map_dir)

        if png_bytes:
            # Embed PNG as buffer view
            img_bv = add_buffer_view(png_bytes)
            img_idx = len(images_list)
            images_list.append({"bufferView": img_bv, "mimeType": "image/png"})
            tex_image_map[tex_idx] = img_idx

            tex_gltf_idx = len(textures_list)
            textures_list.append({"source": img_idx, "sampler": 0})

            materials.append({
                "name": Path(clean_texture_name(tga_name)).stem,
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": tex_gltf_idx},
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0,
                },
            })
        else:
            # No texture found - create a plain material
            materials.append({
                "name": Path(clean_texture_name(tga_name)).stem if tex_idx < len(tex_names) else f"unknown_{tex_idx}",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.76, 0.65, 0.31, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0,
                },
            })

    # Map original texture indices to material indices
    mat_idx_map = {}  # original tex_idx -> glTF material index
    for i, tex_idx in enumerate(sorted(groups.keys())):
        mat_idx_map[tex_idx] = i

    # Build mesh primitives per texture group
    for tex_idx in sorted(groups.keys()):
        g = groups[tex_idx]
        if not g['positions'] or not g['indices']:
            continue

        num_verts = g['idx_counter']
        positions = g['positions']
        normals = g['normals']
        uvs = g['uvs']
        indices = g['indices']

        # Position accessor
        pos_data = struct.pack(f'<{len(positions)}f', *positions)
        pos_min = [min(positions[i::3]) for i in range(3)]
        pos_max = [max(positions[i::3]) for i in range(3)]
        pos_bv = add_buffer_view(pos_data, 34962)
        pos_acc = add_accessor(pos_bv, 5126, num_verts, "VEC3", pos_min, pos_max)

        # Normal accessor
        norm_data = struct.pack(f'<{len(normals)}f', *normals)
        norm_bv = add_buffer_view(norm_data, 34962)
        norm_acc = add_accessor(norm_bv, 5126, num_verts, "VEC3")

        # UV accessor
        uv_data = struct.pack(f'<{len(uvs)}f', *uvs)
        uv_bv = add_buffer_view(uv_data, 34962)
        uv_acc = add_accessor(uv_bv, 5126, num_verts, "VEC2")

        # Index accessor (uint16 or uint32)
        max_idx = max(indices) if indices else 0
        if max_idx <= 65535:
            idx_data = struct.pack(f'<{len(indices)}H', *indices)
            idx_comp = 5123  # UNSIGNED_SHORT
        else:
            idx_data = struct.pack(f'<{len(indices)}I', *indices)
            idx_comp = 5125  # UNSIGNED_INT
        idx_bv = add_buffer_view(idx_data, 34963)
        idx_acc = add_accessor(idx_bv, idx_comp, len(indices), "SCALAR")

        prim = {
            "attributes": {
                "POSITION": pos_acc,
                "NORMAL": norm_acc,
                "TEXCOORD_0": uv_acc,
            },
            "indices": idx_acc,
        }
        if tex_idx in mat_idx_map:
            prim["material"] = mat_idx_map[tex_idx]
        primitives.append(prim)

    # Assemble glTF JSON
    gltf = {
        "asset": {"version": "2.0", "generator": "ebfd-terrain-converter"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": f"terrain_{map_id}", "mesh": 0}],
        "meshes": [{"name": f"terrain_{map_id}", "primitives": primitives}],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(binary_data)}],
        "materials": materials,
        "samplers": samplers,
    }
    if textures_list:
        gltf["textures"] = textures_list
    if images_list:
        gltf["images"] = images_list

    # Write .glb (binary glTF)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    glb_path = OUTPUT_DIR / f"{map_id}.terrain.glb"

    json_str = json.dumps(gltf, separators=(',', ':'))
    # Pad JSON to 4-byte alignment
    while len(json_str) % 4 != 0:
        json_str += ' '
    json_bytes = json_str.encode('utf-8')

    # GLB header: magic + version + length
    # JSON chunk: length + type('JSON') + data
    # BIN chunk: length + type('BIN\0') + data
    bin_bytes = bytes(binary_data)
    total_length = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)

    with open(glb_path, 'wb') as f:
        # GLB header
        f.write(struct.pack('<III', 0x46546C67, 2, total_length))  # glTF magic, v2
        # JSON chunk
        f.write(struct.pack('<II', len(json_bytes), 0x4E4F534A))  # 'JSON'
        f.write(json_bytes)
        # BIN chunk
        f.write(struct.pack('<II', len(bin_bytes), 0x004E4942))  # 'BIN\0'
        f.write(bin_bytes)

    glb_size = glb_path.stat().st_size

    # --- Write .terrain.heights ---
    heights_path = OUTPUT_DIR / f"{map_id}.terrain.heights"
    heightmap_data = parse_fxdata_heightmap(scene.FXData) if scene.FXData else None

    if heightmap_data:
        w, h, heights = heightmap_data
        with open(heights_path, 'wb') as f:
            # Header: W(u16), H(u16), yScale(f32)
            f.write(struct.pack('<HHf', w, h, SCALE))
            # (W+1)*(H+1) float32 values, pre-scaled
            for val in heights:
                f.write(struct.pack('<f', val * SCALE))
        heights_size = heights_path.stat().st_size
        print(f"  OK: {map_id} -> {glb_path.name} ({glb_size/1024:.0f}KB), "
              f"{heights_path.name} ({heights_size/1024:.0f}KB), "
              f"{len(tex_names)} textures, {sum(len(g['indices'])//3 for g in groups.values())} tris")
    else:
        print(f"  OK: {map_id} -> {glb_path.name} ({glb_size/1024:.0f}KB), "
              f"no heightmap, {len(tex_names)} textures")

    return True


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python3 tools/convert_terrain_mesh.py --map T5   # Single map")
        print("  python3 tools/convert_terrain_mesh.py --all      # All maps")
        print("  python3 tools/convert_terrain_mesh.py --list     # List maps")
        sys.exit(1)

    if sys.argv[1] == '--list':
        maps = list_maps()
        print(f"Found {len(maps)} maps:")
        for mid, name in maps:
            print(f"  {mid:5s} {name}")
        sys.exit(0)

    if sys.argv[1] == '--all':
        maps = list_maps()
        print(f"Converting {len(maps)} terrain meshes...")
        success = 0
        failed = 0
        for mid, name in maps:
            try:
                if convert_terrain(mid):
                    success += 1
                else:
                    failed += 1
            except Exception as e:
                print(f"  FAIL: {mid}: {e}")
                failed += 1
        print(f"\nDone! {success} converted, {failed} failed")
        sys.exit(0 if failed == 0 else 1)

    if sys.argv[1] == '--map' and len(sys.argv) >= 3:
        map_id = sys.argv[2]
        try:
            if convert_terrain(map_id):
                print("Done!")
            else:
                sys.exit(1)
        except Exception as e:
            print(f"FAIL: {map_id}: {e}")
            import traceback
            traceback.print_exc()
            sys.exit(1)
        sys.exit(0)

    print(f"Unknown argument: {sys.argv[1]}")
    sys.exit(1)


if __name__ == '__main__':
    main()
