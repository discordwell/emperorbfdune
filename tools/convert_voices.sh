#!/usr/bin/env bash
# Convert voice WAV files from extracted/AUDIO/ to assets/audio/voices/ as OGG (Opus)
# Only converts:
#   1) Numbered unit voices: NN-*.wav (e.g. 00-US02.wav, 13-UM01.wav)
#   2) Faction generic voices: *Select*.wav, *Move*.wav, *Attack*.wav
#     (matching ATRSelect1.wav, HARMove2.wav, ORDAttack1.wav, etc.)

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)/extracted/AUDIO"
DST_DIR="$(cd "$(dirname "$0")/.." && pwd)/assets/audio/voices"

mkdir -p "$DST_DIR"

converted=0
skipped=0

for wav in "$SRC_DIR"/*.wav; do
  base="$(basename "$wav")"

  # Check if file matches our patterns
  match=0

  # Pattern 1: NN-*.wav (numbered unit voices)
  if [[ "$base" =~ ^[0-9]+-.*\.wav$ ]]; then
    match=1
  fi

  # Pattern 2: Faction voice files with Select/Move/Attack in name
  if [[ "$base" =~ (Select|Move|Attack) ]]; then
    # Only match faction-prefixed ones (ATR, HAR, ORD, FRE, Sar, GUI, IX)
    if [[ "$base" =~ ^(ATR|HAR|ORD|FRE|Sar|GUI|IX) ]]; then
      match=1
    fi
  fi

  if [[ $match -eq 0 ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  ogg="${base%.wav}.ogg"
  out="$DST_DIR/$ogg"

  # Skip if already converted
  if [[ -f "$out" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  ffmpeg -y -i "$wav" -c:a libopus -b:a 64k -ar 48000 "$out" -loglevel error
  converted=$((converted + 1))
done

echo "Voice conversion complete: $converted converted, $skipped skipped"
echo "Output directory: $DST_DIR"
