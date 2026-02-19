#!/usr/bin/env python3
"""
Convert XBF 3D models to glTF 2.0 format using xanlib.

Standalone converter that doesn't require Blender.
Outputs .gltf (JSON + binary) files suitable for web use with Three.js/Babylon.js.
Includes full animation support: KeyAnimation (bone transforms) and VertexAnimation (morph targets).

Usage:
    python3 xbf_to_gltf.py <xbf_dir> <texture_dir> <output_dir>
"""

import json
import struct
import sys
import math
from pathlib import Path
from PIL import Image
import numpy as np
import xanlib

FPS = 25.0  # Original game runs at ~25fps


def tga_to_png_with_alpha(tga_path: Path, output_path: Path):
    """Convert TGA to PNG, treating magenta (255,0,255) as transparent."""
    try:
        img = Image.open(tga_path).convert("RGBA")
        data = np.array(img)
        mask = (data[:, :, 0] == 255) & (data[:, :, 1] == 0) & (data[:, :, 2] == 255)
        data[mask, 3] = 0
        Image.fromarray(data).save(output_path)
        return True
    except Exception as e:
        print(f"  WARNING: Failed to convert {tga_path}: {e}")
        return False


def parse_fxdata_clips(fxdata: bytes) -> list:
    """Parse animation clip definitions from FXData binary.
    Returns list of (name, start_frame, end_frame) tuples."""
    if not fxdata:
        return []
    marker = bytes([0x01, 0xCC, 0xCC, 0xCC])
    clips = []
    pos = 0
    while pos < len(fxdata) - 12:
        idx = fxdata.find(marker, pos)
        if idx < 0:
            break
        start_frame = struct.unpack_from('<I', fxdata, idx + 4)[0]
        end_frame = struct.unpack_from('<I', fxdata, idx + 8)[0]
        name_start = idx + 12
        # Find null terminator
        name_end = name_start
        while name_end < len(fxdata) and fxdata[name_end] != 0:
            name_end += 1
        name = fxdata[name_start:name_end].decode('ascii', errors='replace').strip()
        if name and end_frame >= start_frame and end_frame < 100000:
            clips.append((name, start_frame, end_frame))
        pos = idx + 60  # Records are 60 bytes each
    return clips


def decompose_3x4_colmajor(m):
    """Decompose a column-major 3x4 matrix (12 floats) into (translation, quaternion, scale).
    Layout: [c0x c0y c0z c1x c1y c1z c2x c2y c2z tx ty tz]"""
    # Build 3x3 rotation matrix (columns)
    col0 = np.array([m[0], m[1], m[2]])
    col1 = np.array([m[3], m[4], m[5]])
    col2 = np.array([m[6], m[7], m[8]])
    t = [float(m[9]), float(m[10]), float(m[11])]

    # Extract scale from column magnitudes
    sx = float(np.linalg.norm(col0))
    sy = float(np.linalg.norm(col1))
    sz = float(np.linalg.norm(col2))

    if sx < 1e-10: sx = 1.0
    if sy < 1e-10: sy = 1.0
    if sz < 1e-10: sz = 1.0

    # Normalize rotation columns
    r00, r10, r20 = col0 / sx
    r01, r11, r21 = col1 / sy
    r02, r12, r22 = col2 / sz

    # Check for reflection (negative determinant)
    det = r00 * (r11 * r22 - r12 * r21) - r01 * (r10 * r22 - r12 * r20) + r02 * (r10 * r21 - r11 * r20)
    if det < 0:
        sx = -sx
        r00, r10, r20 = -r00, -r10, -r20

    # Convert 3x3 rotation to quaternion (Shepperd's method)
    trace = r00 + r11 + r22
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        w = 0.25 * s
        x = (r21 - r12) / s
        y = (r02 - r20) / s
        z = (r10 - r01) / s
    elif r00 > r11 and r00 > r22:
        s = math.sqrt(1.0 + r00 - r11 - r22) * 2
        w = (r21 - r12) / s
        x = 0.25 * s
        y = (r01 + r10) / s
        z = (r02 + r20) / s
    elif r11 > r22:
        s = math.sqrt(1.0 + r11 - r00 - r22) * 2
        w = (r02 - r20) / s
        x = (r01 + r10) / s
        y = 0.25 * s
        z = (r12 + r21) / s
    else:
        s = math.sqrt(1.0 + r22 - r00 - r11) * 2
        w = (r10 - r01) / s
        x = (r02 + r20) / s
        y = (r12 + r21) / s
        z = 0.25 * s

    # Normalize quaternion
    ql = math.sqrt(x*x + y*y + z*z + w*w)
    if ql > 1e-10:
        x, y, z, w = x/ql, y/ql, z/ql, w/ql

    # glTF quaternion is [x, y, z, w]
    return t, [float(x), float(y), float(z), float(w)], [float(sx), float(sy), float(sz)]


def get_ka_transform_at_frame(ka, frame: int):
    """Get the 3x4 matrix for a KeyAnimation at a given display frame.
    Returns the matrix tuple (12 floats) or None."""
    if ka.flags == -3:
        # Sparse lookup: extra_data[frame] -> matrix index
        if not ka.extra_data or not ka.matrices:
            return None
        clamped = min(frame, len(ka.extra_data) - 1)
        mat_idx = ka.extra_data[clamped]
        if mat_idx >= len(ka.matrices):
            mat_idx = len(ka.matrices) - 1
        return ka.matrices[mat_idx]
    elif ka.flags == -2:
        # Direct: one matrix per frame
        if not ka.matrices:
            return None
        clamped = min(frame, len(ka.matrices) - 1)
        return ka.matrices[clamped]
    elif ka.flags == -1:
        # Full 4x4 matrices - take the 3x4 portion
        if not ka.matrices:
            return None
        clamped = min(frame, len(ka.matrices) - 1)
        m = ka.matrices[clamped]
        # 4x4 column-major -> extract 3x4 (skip bottom row)
        if len(m) == 16:
            return (m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14])
        return m
    # flags > 0: sparse quaternion keyframes (not commonly used, skip)
    return None


def build_gltf(scene: xanlib.Scene, texture_dir: Path, output_path: Path):
    """Build a glTF 2.0 file from an xanlib Scene with animations."""
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
        "animations": [],
    }

    binary_data = bytearray()

    def add_buffer_view(data: bytes, target: int = None) -> int:
        offset = len(binary_data)
        binary_data.extend(data)
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

    # Track nodes with animations for later
    # node_index -> (xanlib_node, ka_or_va)
    ka_nodes = {}  # gltf_node_idx -> key_animation
    va_nodes = {}  # gltf_node_idx -> (vertex_animation, mesh_idx, base_vertices, vertex_map_per_prim)

    def process_node(node: xanlib.Node, parent_idx: int = None) -> int:
        node_idx = len(gltf["nodes"])
        gltf_node = {"name": node.name}
        gltf["nodes"].append(gltf_node)

        # Apply transform
        if node.transform:
            t = node.transform
            gltf_node["matrix"] = list(t)

        if parent_idx is not None:
            if "children" not in gltf["nodes"][parent_idx]:
                gltf["nodes"][parent_idx]["children"] = []
            gltf["nodes"][parent_idx]["children"].append(node_idx)

        # Track KeyAnimation
        if node.key_animation and not should_skip(node.name):
            ka_nodes[node_idx] = node.key_animation

        # Skip hidden nodes but still process children
        if should_skip(node.name):
            for child in node.children:
                process_node(child, node_idx)
            return node_idx

        # Build mesh if there are faces
        if node.faces and node.vertices:
            face_groups = {}
            for face in node.faces:
                tex_idx = face.texture_index
                if tex_idx not in face_groups:
                    face_groups[tex_idx] = []
                face_groups[tex_idx].append(face)

            primitives = []
            # Track vertex mapping for morph targets
            prim_vertex_maps = []

            for tex_idx, faces in face_groups.items():
                positions = []
                normals = []
                uvs = []
                indices = []
                vertex_map = {}  # (vertex_idx, u, v) -> output_idx
                idx_counter = 0

                for face in faces:
                    face_indices = []
                    for j, vi in enumerate(face.vertex_indices):
                        v = node.vertices[vi]
                        u = face.uv_coords[j][0] if j < len(face.uv_coords) else 0.0
                        uv_v = 1.0 - (face.uv_coords[j][1] if j < len(face.uv_coords) else 0.0)

                        key = (vi, round(u, 6), round(uv_v, 6))
                        if key not in vertex_map:
                            vertex_map[key] = idx_counter
                            positions.extend(v.position)
                            normals.extend(v.normal)
                            uvs.extend([u, uv_v])
                            idx_counter += 1

                        face_indices.append(vertex_map[key])

                    if len(face_indices) >= 3:
                        indices.extend(face_indices[:3])
                    if len(face_indices) == 4:
                        indices.extend([face_indices[0], face_indices[2], face_indices[3]])

                if not positions or not indices:
                    continue

                num_verts = idx_counter

                pos_data = struct.pack(f'<{len(positions)}f', *positions)
                pos_min = [min(positions[i::3]) for i in range(3)]
                pos_max = [max(positions[i::3]) for i in range(3)]
                pos_bv = add_buffer_view(pos_data, 34962)
                pos_acc = add_accessor(pos_bv, 5126, num_verts, "VEC3", pos_min, pos_max)

                norm_data = struct.pack(f'<{len(normals)}f', *normals)
                norm_bv = add_buffer_view(norm_data, 34962)
                norm_acc = add_accessor(norm_bv, 5126, num_verts, "VEC3")

                uv_data = struct.pack(f'<{len(uvs)}f', *uvs)
                uv_bv = add_buffer_view(uv_data, 34962)
                uv_acc = add_accessor(uv_bv, 5126, num_verts, "VEC2")

                max_idx = max(indices) if indices else 0
                if max_idx <= 65535:
                    idx_data = struct.pack(f'<{len(indices)}H', *indices)
                    idx_comp_type = 5123
                else:
                    idx_data = struct.pack(f'<{len(indices)}I', *indices)
                    idx_comp_type = 5125
                idx_bv = add_buffer_view(idx_data, 34963)
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
                prim_vertex_maps.append(vertex_map)

            if primitives:
                mesh_idx = len(gltf["meshes"])
                gltf["meshes"].append({"name": node.name, "primitives": primitives})
                gltf_node["mesh"] = mesh_idx

                # Track VertexAnimation for morph target export
                if node.vertex_animation and node.vertex_animation.frames:
                    va_nodes[node_idx] = (node.vertex_animation, mesh_idx, node.vertices, prim_vertex_maps)

        # Process children
        for child in node.children:
            process_node(child, node_idx)

        return node_idx

    # Process all root nodes
    for node in scene.nodes:
        idx = process_node(node)
        gltf["scenes"][0]["nodes"].append(idx)

    # --- Parse animation clips ---
    clips = parse_fxdata_clips(scene.FXData) if scene.FXData else []

    # Determine total frame count from all animated nodes
    max_frames = 0
    for ka in ka_nodes.values():
        max_frames = max(max_frames, ka.frame_count)
    for va_data in va_nodes.values():
        max_frames = max(max_frames, va_data[0].frame_count)

    # If no clips parsed but we have animations, create a single "All" clip
    if not clips and max_frames > 0:
        clips = [("All", 0, max_frames)]

    # Filter clips to only valid frame ranges
    clips = [(name, s, e) for name, s, e in clips if e <= max_frames + 1 and s <= max_frames + 1]

    # --- Add morph targets for VertexAnimation nodes ---
    # For each VA node, we export a subsampled set of keyframes as morph targets.
    # Then per clip, we animate the morph weights.

    va_morph_info = {}  # node_idx -> { 'target_frames': [frame_indices], 'num_targets': int }

    for node_idx, (va, mesh_idx, base_verts, prim_vmaps) in va_nodes.items():
        if not va.frames:
            continue

        scale_bits = va.scale & 0x7FFFFFFF if va.scale else 1
        scale_factor = 1.0 / (2 ** scale_bits) if scale_bits < 30 else 1.0

        # Determine which keyframes to export as morph targets
        # va.keys maps keyframe_index -> display_frame
        # va.frames[kf_index] has the vertex data for that keyframe
        num_keyframes = len(va.frames)

        # Subsample: max 64 morph targets to keep file sizes reasonable
        MAX_TARGETS = 64
        if num_keyframes <= MAX_TARGETS:
            target_kf_indices = list(range(num_keyframes))
        else:
            step = num_keyframes / MAX_TARGETS
            target_kf_indices = [int(i * step) for i in range(MAX_TARGETS)]

        num_targets = len(target_kf_indices)
        mesh = gltf["meshes"][mesh_idx]

        # For each primitive, add morph targets (position deltas from base)
        for prim_i, prim in enumerate(mesh["primitives"]):
            vmap = prim_vmaps[prim_i]
            num_verts = max(vmap.values()) + 1 if vmap else 0
            if num_verts == 0:
                continue

            targets = []
            for kf_idx in target_kf_indices:
                kf_verts = va.frames[kf_idx]
                # Build delta positions: morph_pos - base_pos
                deltas = [0.0] * (num_verts * 3)
                for (orig_vi, _, _), out_idx in vmap.items():
                    if orig_vi < len(base_verts) and orig_vi < len(kf_verts):
                        bv = base_verts[orig_vi]
                        cv = kf_verts[orig_vi]
                        # Compressed vertex position = int16 * scale_factor
                        dx = cv.x * scale_factor - bv.position.x
                        dy = cv.y * scale_factor - bv.position.y
                        dz = cv.z * scale_factor - bv.position.z
                        deltas[out_idx * 3] = dx
                        deltas[out_idx * 3 + 1] = dy
                        deltas[out_idx * 3 + 2] = dz

                delta_data = struct.pack(f'<{len(deltas)}f', *deltas)
                d_min = [min(deltas[i::3]) for i in range(3)]
                d_max = [max(deltas[i::3]) for i in range(3)]
                bv = add_buffer_view(delta_data, 34962)
                acc = add_accessor(bv, 5126, num_verts, "VEC3", d_min, d_max)
                targets.append({"POSITION": acc})

            if targets:
                prim["targets"] = targets

        # Set all morph target weights to 0
        gltf["meshes"][mesh_idx]["weights"] = [0.0] * num_targets

        # Store info for animation export
        # Build a mapping: display_frame -> (target_a, target_b, blend)
        # Using va.keys to know which display frame each keyframe corresponds to
        va_morph_info[node_idx] = {
            'target_kf_indices': target_kf_indices,
            'num_targets': num_targets,
            'va': va,
            'scale_factor': scale_factor,
            'mesh_idx': mesh_idx,
            'keys': va.keys,  # keyframe_idx -> display_frame
        }

    # --- Build animations ---
    for clip_name, clip_start, clip_end in clips:
        if clip_start == clip_end:
            # Single-frame clip: skip (it's just a pose)
            continue

        num_frames = clip_end - clip_start + 1
        if num_frames < 2:
            continue

        samplers = []
        channels = []

        # Time values for this clip
        times = [float(f) / FPS for f in range(num_frames)]
        time_data = struct.pack(f'<{len(times)}f', *times)
        time_bv = add_buffer_view(time_data)
        time_acc = add_accessor(time_bv, 5126, len(times), "SCALAR",
                                [float(times[0])], [float(times[-1])])

        # --- KeyAnimation channels ---
        for node_idx, ka in ka_nodes.items():
            if not ka.matrices:
                continue

            translations = []
            rotations = []
            scales = []

            for f in range(clip_start, clip_end + 1):
                m = get_ka_transform_at_frame(ka, f)
                if m is None:
                    translations.extend([0.0, 0.0, 0.0])
                    rotations.extend([0.0, 0.0, 0.0, 1.0])
                    scales.extend([1.0, 1.0, 1.0])
                    continue

                t, q, s = decompose_3x4_colmajor(m)
                translations.extend(t)
                rotations.extend(q)
                scales.extend(s)

            sampler_base = len(samplers)

            # Translation sampler
            t_data = struct.pack(f'<{len(translations)}f', *translations)
            t_bv = add_buffer_view(t_data)
            t_acc = add_accessor(t_bv, 5126, num_frames, "VEC3")
            samplers.append({"input": time_acc, "output": t_acc, "interpolation": "LINEAR"})

            # Rotation sampler (quaternion)
            r_data = struct.pack(f'<{len(rotations)}f', *rotations)
            r_bv = add_buffer_view(r_data)
            r_acc = add_accessor(r_bv, 5126, num_frames, "VEC4")
            samplers.append({"input": time_acc, "output": r_acc, "interpolation": "LINEAR"})

            # Scale sampler
            s_data = struct.pack(f'<{len(scales)}f', *scales)
            s_bv = add_buffer_view(s_data)
            s_acc = add_accessor(s_bv, 5126, num_frames, "VEC3")
            samplers.append({"input": time_acc, "output": s_acc, "interpolation": "LINEAR"})

            channels.append({"sampler": sampler_base, "target": {"node": node_idx, "path": "translation"}})
            channels.append({"sampler": sampler_base + 1, "target": {"node": node_idx, "path": "rotation"}})
            channels.append({"sampler": sampler_base + 2, "target": {"node": node_idx, "path": "scale"}})

        # --- VertexAnimation morph weight channels ---
        for node_idx, morph_info in va_morph_info.items():
            va = morph_info['va']
            target_kf_indices = morph_info['target_kf_indices']
            num_targets = morph_info['num_targets']
            keys = morph_info['keys']

            if num_targets == 0:
                continue

            # Build weights for each frame in clip
            # weights[frame][target] = weight value
            all_weights = []
            for f in range(clip_start, clip_end + 1):
                weights = [0.0] * num_targets

                # Find the closest keyframe to this display frame
                best_kf = None
                best_dist = 999999
                for kf_i, display_f in enumerate(keys):
                    d = abs(display_f - f)
                    if d < best_dist:
                        best_dist = d
                        best_kf = kf_i

                if best_kf is not None:
                    # Find which morph target index this keyframe maps to
                    # target_kf_indices maps target_idx -> keyframe_idx
                    # Find the closest target
                    closest_target = 0
                    closest_dist = abs(target_kf_indices[0] - best_kf)
                    for ti, tki in enumerate(target_kf_indices):
                        d = abs(tki - best_kf)
                        if d < closest_dist:
                            closest_dist = d
                            closest_target = ti

                    # Simple: snap to nearest target
                    weights[closest_target] = 1.0

                    # Blend between two adjacent targets if between keyframes
                    if closest_dist > 0 and num_targets > 1:
                        # Find the two bracketing targets
                        if best_kf < target_kf_indices[closest_target]:
                            other = max(0, closest_target - 1)
                        else:
                            other = min(num_targets - 1, closest_target + 1)
                        if other != closest_target:
                            span = abs(target_kf_indices[closest_target] - target_kf_indices[other])
                            if span > 0:
                                blend = closest_dist / span
                                blend = min(1.0, blend)
                                weights[closest_target] = 1.0 - blend
                                weights[other] = blend

                all_weights.extend(weights)

            # Output morph weights as a single interleaved accessor
            # glTF requires: for STEP/LINEAR morph weights, output is SCALAR with count = frames * num_targets
            w_data = struct.pack(f'<{len(all_weights)}f', *all_weights)
            w_bv = add_buffer_view(w_data)
            w_acc = add_accessor(w_bv, 5126, num_frames * num_targets, "SCALAR")

            sampler_idx = len(samplers)
            samplers.append({"input": time_acc, "output": w_acc, "interpolation": "STEP"})
            channels.append({"sampler": sampler_idx, "target": {"node": node_idx, "path": "weights"}})

        if channels:
            gltf["animations"].append({
                "name": clip_name,
                "samplers": samplers,
                "channels": channels,
            })

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
        json.dump(gltf, f)

    # Report animation count
    anim_count = len(gltf.get("animations", []))
    if anim_count > 0:
        anim_names = [a["name"] for a in gltf["animations"]]
        return anim_count, anim_names
    return 0, []


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
    total_anims = 0
    for xbf_path in xbf_files:
        relative = xbf_path.relative_to(xbf_dir)
        gltf_path = output_dir / relative.with_suffix('.gltf')

        try:
            scene = xanlib.load_xbf(str(xbf_path))
            anim_count, anim_names = build_gltf(scene, texture_dir, gltf_path)
            if anim_count > 0:
                print(f"  OK: {relative} ({anim_count} anims: {', '.join(anim_names[:5])}{'...' if len(anim_names) > 5 else ''})")
                total_anims += anim_count
            else:
                print(f"  OK: {relative} (static)")
            success += 1
        except Exception as e:
            print(f"  FAIL: {relative}: {e}")
            failed += 1

    print(f"\nDone! {success} converted, {failed} failed, {total_anims} total animations")


if __name__ == '__main__':
    main()
