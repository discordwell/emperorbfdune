#!/usr/bin/env python3
"""
Emperor: Battle for Dune asset extractor.
Extracts files from RFH/RFD archives and BAG audio archives.

Based on format specs from IceReaper/ebfd-re.

Usage:
    python3 extract_ebfd.py <game_data_dir> [output_dir]
"""

import struct
import zlib
import os
import sys
from pathlib import Path


# ── RFH/RFD Archive Extraction ──────────────────────────────────────────────

def extract_rfh(rfh_path: Path, output_dir: Path):
    """Extract all files from an RFH/RFD archive pair."""
    rfd_path = rfh_path.with_suffix('.RFD' if rfh_path.suffix == '.RFH' else '.rfd')
    if not rfd_path.exists():
        # Try case variations
        for ext in ['.RFD', '.rfd', '.Rfd']:
            candidate = rfh_path.with_suffix(ext)
            if candidate.exists():
                rfd_path = candidate
                break
        else:
            print(f"  WARNING: No matching RFD for {rfh_path}")
            return 0

    archive_name = rfh_path.stem
    archive_output = output_dir / archive_name

    with open(rfh_path, 'rb') as hf, open(rfd_path, 'rb') as df:
        header_data = hf.read()
        data_blob = df.read()

    pos = 0
    count = 0
    while pos < len(header_data):
        # Read entry header: nameLength(4) + date(4) + flags(4) + compSize(4) + uncompSize(4) + offset(4) = 24 bytes
        if pos + 24 > len(header_data):
            break

        name_length, date, flags, comp_size, uncomp_size, offset = struct.unpack_from('<6I', header_data, pos)
        pos += 24

        if pos + name_length > len(header_data):
            break

        name = header_data[pos:pos + name_length].split(b'\x00')[0].decode('ascii', errors='replace')
        pos += name_length

        # Read data from RFD
        is_compressed = (flags & 2) != 0

        if is_compressed:
            # Compressed: skip 6-byte header (4 bytes uncompressed size + 2 bytes zlib magic)
            raw_data = data_blob[offset + 6:offset + 6 + comp_size]
            try:
                # Try raw deflate first
                file_data = zlib.decompress(raw_data, -15)
            except zlib.error:
                try:
                    # Try with zlib header (include the 2-byte magic)
                    raw_with_header = data_blob[offset + 4:offset + 4 + comp_size + 2]
                    file_data = zlib.decompress(raw_with_header)
                except zlib.error:
                    print(f"  WARNING: Failed to decompress {name}")
                    continue
        else:
            # Uncompressed: skip 6-byte header
            file_data = data_blob[offset + 6:offset + 6 + comp_size]

        # Write file
        file_path = archive_output / name
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(file_data)
        count += 1

    return count


# ── BAG Audio Extraction ────────────────────────────────────────────────────

# IMA ADPCM decode tables
INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8]
STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41,
    45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209,
    230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876,
    963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
    3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
    10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086,
    29794, 32767
]


def adpcm_decode(nibble: int, index: int, current: int) -> tuple[int, int, int]:
    """Decode a single IMA ADPCM nibble."""
    delta = nibble & 0x07
    diff = STEP_TABLE[index] * (2 * delta + 1) // 16

    if nibble & 0x08:
        diff = -diff

    current = max(-32768, min(32767, current + diff))
    index = max(0, min(len(STEP_TABLE) - 1, index + INDEX_TABLE[delta]))

    return current, index, struct.pack('<h', current)


def make_wav_header(data_size: int, sample_rate: int, channels: int, bits: int) -> bytes:
    """Create a WAV file header."""
    byte_rate = sample_rate * channels * (bits // 8)
    block_align = channels * (bits // 8)

    header = struct.pack('<4sI4s', b'RIFF', data_size + 36, b'WAVE')
    header += struct.pack('<4sIHHIIHH', b'fmt ', 16, 1, channels, sample_rate, byte_rate, block_align, bits)
    header += struct.pack('<4sI', b'data', data_size)
    return header


def extract_bag(bag_path: Path, output_dir: Path):
    """Extract all audio files from a BAG archive."""
    archive_name = bag_path.stem
    archive_output = output_dir / archive_name

    with open(bag_path, 'rb') as f:
        data = f.read()

    # Check magic
    magic = data[:4]
    if magic != b'GABA':
        print(f"  WARNING: {bag_path} is not a valid BAG file (magic: {magic})")
        return 0

    version, num_files, stride = struct.unpack_from('<III', data, 4)
    if version != 4:
        print(f"  WARNING: Unknown BAG version {version}")
        return 0

    entry_start = 16  # After header (4 magic + 4 version + 4 numFiles + 4 stride)
    count = 0

    for i in range(num_files):
        entry_pos = entry_start + i * stride

        # Entry: name(32) + offset(4) + length(4) + sampleRate(4) + flags(4) + unk(4)
        name_raw = data[entry_pos:entry_pos + 32]
        name = name_raw.split(b'\x00')[0].decode('ascii', errors='replace')

        offset, length, sample_rate, flags, unk = struct.unpack_from('<5I', data, entry_pos + 32)

        is_mp3 = (flags & 32) != 0
        is_compressed = (flags & 8) != 0
        is_uncompressed = (flags & 2) != 0
        is_stereo = (flags & 1) != 0
        is_16bit = (flags & 4) != 0

        ext = '.mp3' if is_mp3 else '.wav'
        file_path = archive_output / (name + ext)
        file_path.parent.mkdir(parents=True, exist_ok=True)

        raw = data[offset:offset + length]

        if is_mp3:
            file_path.write_bytes(raw)
        elif is_compressed:
            # IMA ADPCM decode
            current_sample = 0
            index = 0
            pcm_data = bytearray()

            for byte_val in raw:
                lo_nibble = byte_val & 0x0F
                hi_nibble = (byte_val >> 4) & 0x0F

                current_sample, index, sample_bytes = adpcm_decode(lo_nibble, index, current_sample)
                pcm_data.extend(sample_bytes)
                current_sample, index, sample_bytes = adpcm_decode(hi_nibble, index, current_sample)
                pcm_data.extend(sample_bytes)

            channels = 2 if is_stereo else 1
            header = make_wav_header(len(pcm_data), sample_rate, channels, 16)
            file_path.write_bytes(header + bytes(pcm_data))
        elif is_uncompressed:
            channels = 2 if is_stereo else 1
            bits = 16 if is_16bit else 8
            header = make_wav_header(length, sample_rate, channels, bits)
            file_path.write_bytes(header + raw)
        else:
            print(f"  WARNING: Unknown flags for {name}: {flags}")
            continue

        count += 1

    return count


# ── Main ────────────────────────────────────────────────────────────────────

def find_archives(root: Path) -> tuple[list[Path], list[Path]]:
    """Find all RFH and BAG files recursively."""
    rfh_files = sorted(root.rglob('*.RFH')) + sorted(root.rglob('*.rfh'))
    bag_files = sorted(root.rglob('*.BAG')) + sorted(root.rglob('*.bag'))
    # Deduplicate (case-insensitive)
    seen_rfh = set()
    unique_rfh = []
    for f in rfh_files:
        key = str(f).lower()
        if key not in seen_rfh:
            seen_rfh.add(key)
            unique_rfh.append(f)
    seen_bag = set()
    unique_bag = []
    for f in bag_files:
        key = str(f).lower()
        if key not in seen_bag:
            seen_bag.add(key)
            unique_bag.append(f)
    return unique_rfh, unique_bag


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 extract_ebfd.py <game_data_dir> [output_dir]")
        print("  game_data_dir: Path to the Emperor game DATA directory")
        print("  output_dir:    Where to write extracted files (default: ./extracted)")
        sys.exit(1)

    game_dir = Path(sys.argv[1])
    output_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('extracted')

    if not game_dir.exists():
        print(f"ERROR: {game_dir} does not exist")
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Scanning {game_dir} for archives...")
    rfh_files, bag_files = find_archives(game_dir)
    print(f"Found {len(rfh_files)} RFH archives and {len(bag_files)} BAG archives")

    total = 0
    for rfh in rfh_files:
        print(f"\nExtracting RFH: {rfh.name}")
        count = extract_rfh(rfh, output_dir)
        print(f"  -> {count} files")
        total += count

    for bag in bag_files:
        print(f"\nExtracting BAG: {bag.name}")
        count = extract_bag(bag, output_dir)
        print(f"  -> {count} files")
        total += count

    print(f"\nDone! Extracted {total} files to {output_dir}")


if __name__ == '__main__':
    main()
