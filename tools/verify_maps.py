#!/usr/bin/env python3
"""
Map verification tool: renders CPF, CPT, and texture.dat as color-coded PNGs
alongside TGA thumbnails for visual comparison.

Outputs to tools/map_debug/ for manual inspection.
Scale relationships:
  - CPT / texture.dat: 2048×2048 grid, 8 pixels per game tile
  - CPF: 512×512 nibble grid, 2 cells per game tile
  - map.inf: W×H = game tile dimensions (playable area)
"""

import os
import struct
import sys
import numpy as np
from PIL import Image

MAPS_DIR = os.path.join(os.path.dirname(__file__), '..', 'extracted', 'MAPS0001')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), 'map_debug')

# 16 distinct colors for CPF nibble values (0-15)
CPF_COLORS = [
    (0, 0, 0),        # 0  - black
    (128, 0, 0),      # 1  - dark red
    (0, 128, 0),      # 2  - dark green
    (128, 128, 0),    # 3  - olive
    (0, 0, 128),      # 4  - dark blue
    (128, 0, 128),    # 5  - purple
    (0, 128, 128),    # 6  - teal
    (192, 192, 192),  # 7  - silver
    (128, 128, 128),  # 8  - gray
    (255, 0, 0),      # 9  - red
    (255, 255, 0),    # 10 - yellow (most common = sand)
    (0, 255, 0),      # 11 - green
    (0, 0, 255),      # 12 - blue
    (255, 0, 255),    # 13 - magenta
    (0, 255, 255),    # 14 - cyan
    (255, 255, 255),  # 15 - white
]


def parse_map_inf(path: str) -> tuple[int, int]:
    """Parse map.inf to get width and height."""
    with open(path, 'rb') as f:
        data = f.read()
    lines = data.split(b'\r\n')
    w = int(lines[0])
    h = int(lines[1].split()[-1])
    return w, h


def read_cpt(path: str) -> np.ndarray:
    """Read CPT heightmap: 8-byte header + 2048×2048 bytes."""
    with open(path, 'rb') as f:
        f.read(8)  # skip header (2x uint32 LE: 2048, 2048)
        data = np.frombuffer(f.read(2048 * 2048), dtype=np.uint8)
    return data.reshape(2048, 2048)


def read_cpf(path: str) -> np.ndarray:
    """Read CPF passability: 512×512 nibbles packed as 131072 bytes."""
    with open(path, 'rb') as f:
        raw = np.frombuffer(f.read(131072), dtype=np.uint8)
    # Unpack nibbles: low nibble first, high nibble second
    cpf = np.zeros((512, 512), dtype=np.uint8)
    for row in range(512):
        for col in range(256):
            byte = raw[row * 256 + col]
            cpf[row, col * 2] = byte & 0x0F
            cpf[row, col * 2 + 1] = (byte >> 4) & 0x0F
    return cpf


def read_texture_dat(path: str) -> np.ndarray:
    """Read texture.dat: 2048×2048 bytes (palette indices)."""
    with open(path, 'rb') as f:
        data = np.frombuffer(f.read(2048 * 2048), dtype=np.uint8)
    return data.reshape(2048, 2048)


def read_thumbnail(path: str) -> Image.Image | None:
    """Read TGA thumbnail."""
    try:
        return Image.open(path).convert('RGB')
    except Exception:
        return None


def render_cpf(cpf: np.ndarray, w: int, h: int) -> Image.Image:
    """Render CPF as color-coded image at 2× game tile resolution."""
    cpf_w = w * 2
    cpf_h = h * 2
    img = Image.new('RGB', (cpf_w, cpf_h))
    pixels = img.load()
    for row in range(cpf_h):
        for col in range(cpf_w):
            val = int(cpf[row, col])
            pixels[col, row] = CPF_COLORS[val]
    return img


def render_cpt(cpt: np.ndarray, w: int, h: int) -> Image.Image:
    """Render CPT as grayscale image, downsampled to game tile resolution."""
    # Sample center of each 8×8 block
    img = Image.new('L', (w, h))
    pixels = img.load()
    for row in range(h):
        for col in range(w):
            # Take center pixel of 8×8 block
            sr = min(row * 8 + 4, 2047)
            sc = min(col * 8 + 4, 2047)
            pixels[col, row] = int(cpt[sr, sc])
    return img


def render_texture(tex: np.ndarray, w: int, h: int) -> Image.Image:
    """Render texture.dat as color-coded image by unique index values."""
    # Assign a random but consistent color per unique texture index
    rng = np.random.RandomState(42)
    palette = {}
    for val in range(256):
        palette[val] = tuple(rng.randint(50, 255, 3).tolist())

    img = Image.new('RGB', (w, h))
    pixels = img.load()
    for row in range(h):
        for col in range(w):
            sr = min(row * 8 + 4, 2047)
            sc = min(col * 8 + 4, 2047)
            val = int(tex[sr, sc])
            pixels[col, row] = palette[val]
    return img


def analyze_cpf_values(cpf: np.ndarray, w: int, h: int) -> dict:
    """Count frequency of each CPF nibble value in the playable area."""
    cpf_area = cpf[:h * 2, :w * 2]
    unique, counts = np.unique(cpf_area, return_counts=True)
    total = cpf_area.size
    result = {}
    for u, c in zip(unique, counts):
        result[int(u)] = {'count': int(c), 'pct': round(float(c) / total * 100, 1)}
    return result


def process_map(map_dir: str, map_name: str):
    """Process a single map directory and output debug images."""
    inf_path = os.path.join(map_dir, 'map.inf')
    cpt_path = os.path.join(map_dir, 'test.CPT')
    cpf_path = os.path.join(map_dir, 'test.CPF')
    tex_path = os.path.join(map_dir, 'texture.dat')

    # Find thumbnail
    thumb_path = None
    for f in os.listdir(map_dir):
        if f.endswith('.tga') and 'thumb' in f.lower():
            thumb_path = os.path.join(map_dir, f)
            break

    if not all(os.path.exists(p) for p in [inf_path, cpt_path, cpf_path, tex_path]):
        print(f'  Skipping {map_name}: missing files')
        return

    w, h = parse_map_inf(inf_path)
    print(f'  {map_name}: {w}×{h}')

    cpt = read_cpt(cpt_path)
    cpf = read_cpf(cpf_path)
    tex = read_texture_dat(tex_path)

    # Analyze CPF values
    cpf_stats = analyze_cpf_values(cpf, w, h)
    print(f'    CPF value frequencies:')
    for val in sorted(cpf_stats.keys()):
        s = cpf_stats[val]
        print(f'      {val:2d}: {s["count"]:6d} ({s["pct"]:5.1f}%)')

    # Render individual layers
    cpf_img = render_cpf(cpf, w, h)
    cpt_img = render_cpt(cpt, w, h).convert('RGB')
    tex_img = render_texture(tex, w, h)

    # Load thumbnail
    thumb = read_thumbnail(thumb_path) if thumb_path else None

    # Create composite: [thumbnail | CPT height | CPF passability | texture]
    panel_h = max(h, 128)
    panels = []

    if thumb:
        # Scale thumbnail to match height
        tw, th = thumb.size
        scale = panel_h / th
        thumb_resized = thumb.resize((int(tw * scale), panel_h), Image.NEAREST)
        panels.append(thumb_resized)

    # Scale other panels to match height
    for img in [cpt_img, cpf_img, tex_img]:
        iw, ih = img.size
        scale = panel_h / ih
        panels.append(img.resize((int(iw * scale), panel_h), Image.NEAREST))

    # Composite side-by-side
    total_w = sum(p.width for p in panels) + (len(panels) - 1) * 4
    composite = Image.new('RGB', (total_w, panel_h + 20), (32, 32, 32))

    x = 0
    labels = ['Thumbnail', 'Height (CPT)', 'Passability (CPF)', 'Texture']
    if not thumb:
        labels = labels[1:]

    for i, panel in enumerate(panels):
        composite.paste(panel, (x, 0))
        x += panel.width + 4

    # Save
    safe_name = map_name.replace(' ', '_').replace('#', '')
    composite.save(os.path.join(OUTPUT_DIR, f'{safe_name}.png'))
    cpf_img.save(os.path.join(OUTPUT_DIR, f'{safe_name}_cpf.png'))
    cpt_img.save(os.path.join(OUTPUT_DIR, f'{safe_name}_cpt.png'))
    tex_img.save(os.path.join(OUTPUT_DIR, f'{safe_name}_tex.png'))


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Representative maps to analyze
    target_maps = [
        '#T5 JF The Cauldron S LOD2',         # 200×200 campaign
        '#T1 GM Harkonnen Jump Point S LOD2',  # campaign
        '#M29 GM Fishes Plain S 8',            # 240×240 skirmish 8p
        '#C1 Harkonnen Civil War Attack LOD2',  # 256×256 full size
        '#D2 Ordos Homeworld Defense LOD2',    # 256×96 rectangular
        '#U1 AT Start S LOD2',                 # Tutorial
    ]

    # If specific maps requested via args, use those instead
    if len(sys.argv) > 1:
        target_maps = sys.argv[1:]

    for map_name in target_maps:
        map_dir = os.path.join(MAPS_DIR, map_name)
        if not os.path.isdir(map_dir):
            print(f'  Map not found: {map_name}')
            # Try partial match
            for d in os.listdir(MAPS_DIR):
                if map_name.lstrip('#') in d:
                    map_dir = os.path.join(MAPS_DIR, d)
                    map_name = d
                    break
            if not os.path.isdir(map_dir):
                continue

        process_map(map_dir, map_name)

    print(f'\nOutput saved to {OUTPUT_DIR}/')

    # Print CPF color legend
    print('\nCPF Color Legend:')
    for i, color in enumerate(CPF_COLORS):
        print(f'  {i:2d}: RGB{color}')


if __name__ == '__main__':
    main()
