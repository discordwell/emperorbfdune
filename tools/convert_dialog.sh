#!/bin/bash
# Convert dialog WAV files from extracted/DIALOG/ to assets/audio/dialog/ as OGG (Opus)
# Converts all UI-G prefixed files (in-game spoken dialog lines)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_DIR/extracted/DIALOG"
DST_DIR="$PROJECT_DIR/assets/audio/dialog"

mkdir -p "$DST_DIR"

COUNT=0
SKIP=0
FAIL=0

for wav in "$SRC_DIR"/UI-G*.wav; do
  [ -f "$wav" ] || continue
  base=$(basename "$wav" .wav)
  ogg="$DST_DIR/${base}.ogg"

  # Skip if already converted
  if [ -f "$ogg" ]; then
    SKIP=$((SKIP + 1))
    continue
  fi

  if ffmpeg -y -i "$wav" -c:a libopus -b:a 48k -ar 48000 -ac 1 "$ogg" 2>/dev/null; then
    COUNT=$((COUNT + 1))
  else
    echo "FAILED: $base"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "Dialog conversion complete:"
echo "  Converted: $COUNT"
echo "  Skipped (already exist): $SKIP"
echo "  Failed: $FAIL"
echo "  Output: $DST_DIR"
