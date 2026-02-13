#!/usr/bin/env python3
"""
Convert XBF 3D models to glTF 2.0 format using xanlib.

Standalone converter that doesn't require Blender.
Outputs .gltf (JSON + binary) files suitable for web use with Three.js/Babylon.js.

Usage:
    python3 xbf_to_gltf.py <xbf_dir> <texture_dir> <output_dir>
"""

import json
import struct
import base64
import sys
import os
from pathlib import Path
from PIL import Image
import numpy as np
import xanlib


def tga_to_png_with_alpha(tga_path: Path, output_path: Path):
    """Convert TGA to PNG, treating magenta (255,0,255) as transparent."""
    try:
        img = Image.open(tga_path).convert("RGBA")
        data = np.array(img)
        # Set magenta pixels to transparent
        mask = (data[:, :, 0] == 255) & (data[:, :, 1] == 0) & (data[:, :, 2] == 255)
        data[mask, 3] = 0
        Image.fromarray(data).save(output_path)
        return True
    except Exception as e:
        print(f"  WARNING: Failed to convert {tga_path}: {e}")
        return False


def build_gltf(scene: xanlib.Scene, texture_dir: Path, output_path: Path):
    """Build a glTF 2.0 file from an xanlib Scene."""
    gltf = {
        "asset": {"version": "2.0", "generator": "ebfd-xbf-converter"},
        "scene": 0,
        "scenes": [{"nodes": []}],
        "nodes": [],
        "meshes": [],
        "accessors": [],
        "bufferViews": [],
        "buffers": [],
        "materials": [],
        "textures": [],
        "images": [],
    }

    # Collect all binary data
    binary_data = bytearray()

    def add_buffer_view(data: bytes, target: int = None) -> int:
        offset = len(binary_data)
        binary_data.extend(data)
        # Pad to 4-byte alignment
        while len(binary_data) % 4 != 0:
            binary_data.append(0)

        bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target:
            bv["target"] = target
        idx = len(gltf["bufferViews"])
        gltf["bufferViews"].append(bv)
        return idx

    def add_accessor(buffer_view: int, component_type: int, count: int,
                     accessor_type: str, min_vals=None, max_vals=None) -> int:
        acc = {
            "bufferView": buffer_view,
            "componentType": component_type,
            "count": count,
            "type": accessor_type,
        }
        if min_vals is not None:
            acc["min"] = min_vals
        if max_vals is not None:
            acc["max"] = max_vals
        idx = len(gltf["accessors"])
        gltf["accessors"].append(acc)
        return idx

    # Set up textures/materials
    png_dir = output_path.parent / "textures"
    png_dir.mkdir(parents=True, exist_ok=True)

    for i, tex_name in enumerate(scene.textures):
        # Convert TGA texture
        tga_path = texture_dir / tex_name
        png_name = Path(tex_name).stem + ".png"
        png_path = png_dir / png_name

        if tga_path.exists() and not png_path.exists():
            tga_to_png_with_alpha(tga_path, png_path)

        if png_path.exists():
            gltf["images"].append({"uri": f"textures/{png_name}"})
            gltf["textures"].append({"source": i})
            gltf["materials"].append({
                "name": tex_name,
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": i},
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.8,
                },
                "alphaMode": "MASK",
                "alphaCutoff": 0.5,
            })
        else:
            # Fallback material with no texture
            gltf["images"].append({"uri": f"textures/{png_name}"})
            gltf["textures"].append({"source": i})
            gltf["materials"].append({
                "name": tex_name,
                "pbrMetallicRoughness": {
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.8,
                },
            })

    def should_skip(name: str) -> bool:
        return name == "#^^0" or "{LEECH}" in name or name.startswith("SLCT")

    def process_node(node: xanlib.Node, parent_idx: int = None) -> int:
        node_idx = len(gltf["nodes"])
        gltf_node = {"name": node.name}
        gltf["nodes"].append(gltf_node)

        # Apply transform (4x4 column-major matrix)
        if node.transform:
            t = node.transform
            # xanlib stores as flat 16 floats, column-major
            # glTF expects column-major too
            gltf_node["matrix"] = list(t)

        if parent_idx is not None:
            if "children" not in gltf["nodes"][parent_idx]:
                gltf["nodes"][parent_idx]["children"] = []
            gltf["nodes"][parent_idx]["children"].append(node_idx)

        # Skip hidden nodes but still process children
        if should_skip(node.name):
            for child in node.children:
                process_node(child, node_idx)
            return node_idx

        # Build mesh if there are faces
        if node.faces and node.vertices:
            # Group faces by texture index (material)
            face_groups = {}
            for face in node.faces:
                tex_idx = face.texture_index
                if tex_idx not in face_groups:
                    face_groups[tex_idx] = []
                face_groups[tex_idx].append(face)

            primitives = []
            for tex_idx, faces in face_groups.items():
                # Build vertex data for this group
                # We need to de-index and create per-face-vertex data for UVs
                positions = []
                normals = []
                uvs = []
                indices = []
                vertex_map = {}
                idx_counter = 0

                for face in faces:
                    face_indices = []
                    for j, vi in enumerate(face.vertex_indices):
                        v = node.vertices[vi]
                        u = face.uv_coords[j][0] if j < len(face.uv_coords) else 0.0
                        uv_v = 1.0 - (face.uv_coords[j][1] if j < len(face.uv_coords) else 0.0)

                        # Create unique vertex key
                        key = (vi, round(u, 6), round(uv_v, 6))
                        if key not in vertex_map:
                            vertex_map[key] = idx_counter
                            positions.extend(v.position)
                            normals.extend(v.normal)
                            uvs.extend([u, uv_v])
                            idx_counter += 1

                        face_indices.append(vertex_map[key])

                    # Triangulate (faces should already be triangles from XBF)
                    if len(face_indices) >= 3:
                        indices.extend(face_indices[:3])
                    if len(face_indices) == 4:
                        indices.extend([face_indices[0], face_indices[2], face_indices[3]])

                if not positions or not indices:
                    continue

                num_verts = idx_counter

                # Pack position data (float32, VEC3)
                pos_data = struct.pack(f'<{len(positions)}f', *positions)
                pos_min = [min(positions[i::3]) for i in range(3)]
                pos_max = [max(positions[i::3]) for i in range(3)]
                pos_bv = add_buffer_view(pos_data, 34962)  # ARRAY_BUFFER
                pos_acc = add_accessor(pos_bv, 5126, num_verts, "VEC3", pos_min, pos_max)

                # Pack normal data (float32, VEC3)
                norm_data = struct.pack(f'<{len(normals)}f', *normals)
                norm_bv = add_buffer_view(norm_data, 34962)
                norm_acc = add_accessor(norm_bv, 5126, num_verts, "VEC3")

                # Pack UV data (float32, VEC2)
                uv_data = struct.pack(f'<{len(uvs)}f', *uvs)
                uv_bv = add_buffer_view(uv_data, 34962)
                uv_acc = add_accessor(uv_bv, 5126, num_verts, "VEC2")

                # Pack index data (uint16 if possible, uint32 otherwise)
                max_idx = max(indices) if indices else 0
                if max_idx <= 65535:
                    idx_data = struct.pack(f'<{len(indices)}H', *indices)
                    idx_comp_type = 5123  # UNSIGNED_SHORT
                else:
                    idx_data = struct.pack(f'<{len(indices)}I', *indices)
                    idx_comp_type = 5125  # UNSIGNED_INT
                idx_bv = add_buffer_view(idx_data, 34963)  # ELEMENT_ARRAY_BUFFER
                idx_acc = add_accessor(idx_bv, idx_comp_type, len(indices), "SCALAR")

                prim = {
                    "attributes": {
                        "POSITION": pos_acc,
                        "NORMAL": norm_acc,
                        "TEXCOORD_0": uv_acc,
                    },
                    "indices": idx_acc,
                }
                if tex_idx < len(gltf["materials"]):
                    prim["material"] = tex_idx
                primitives.append(prim)

            if primitives:
                mesh_idx = len(gltf["meshes"])
                gltf["meshes"].append({"name": node.name, "primitives": primitives})
                gltf_node["mesh"] = mesh_idx

        # Process children
        for child in node.children:
            process_node(child, node_idx)

        return node_idx

    # Process all root nodes
    for node in scene.nodes:
        idx = process_node(node)
        gltf["scenes"][0]["nodes"].append(idx)

    # Write binary buffer
    bin_path = output_path.with_suffix('.bin')
    bin_path.write_bytes(bytes(binary_data))

    gltf["buffers"].append({
        "uri": bin_path.name,
        "byteLength": len(binary_data),
    })

    # Clean up empty arrays
    for key in list(gltf.keys()):
        if isinstance(gltf[key], list) and len(gltf[key]) == 0:
            del gltf[key]

    # Write glTF JSON
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(gltf, f, indent=2)


def main():
    if len(sys.argv) < 4:
        print("Usage: python3 xbf_to_gltf.py <xbf_dir> <texture_dir> <output_dir>")
        print("  xbf_dir:     Directory containing extracted XBF files")
        print("  texture_dir: Directory containing TGA textures")
        print("  output_dir:  Where to write glTF output")
        sys.exit(1)

    xbf_dir = Path(sys.argv[1])
    texture_dir = Path(sys.argv[2])
    output_dir = Path(sys.argv[3])

    xbf_files = sorted(xbf_dir.rglob('*.xbf')) + sorted(xbf_dir.rglob('*.XBF'))
    print(f"Found {len(xbf_files)} XBF files")

    success = 0
    failed = 0
    for xbf_path in xbf_files:
        relative = xbf_path.relative_to(xbf_dir)
        gltf_path = output_dir / relative.with_suffix('.gltf')

        try:
            scene = xanlib.load_xbf(str(xbf_path))
            build_gltf(scene, texture_dir, gltf_path)
            print(f"  OK: {relative}")
            success += 1
        except Exception as e:
            print(f"  FAIL: {relative}: {e}")
            failed += 1

    print(f"\nDone! {success} converted, {failed} failed")


if __name__ == '__main__':
    main()
