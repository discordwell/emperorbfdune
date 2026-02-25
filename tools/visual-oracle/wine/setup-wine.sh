#!/usr/bin/env bash
#
# setup-wine.sh — Install Emperor: Battle for Dune into a Wine prefix for the visual oracle.
#
# Extracts game files from the 4 original ISOs (in isos/) into a Wine prefix,
# rewrites resource.cfg so the game doesn't need mounted CDs, and does a test launch.
#
# Prerequisites:
#   - Wine (brew install --cask wine-stable)
#   - cabextract (brew install cabextract)
#   - Rosetta 2 on Apple Silicon (softwareupdate --install-rosetta)
#   - ISOs in isos/EMPEROR{1,2,3,4}.iso
#
# Usage:
#   bash tools/visual-oracle/wine/setup-wine.sh [--minimal]
#
# Options:
#   --minimal    Skip movies and optional audio (saves ~1.5GB, game still runs)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ISOS_DIR="$PROJECT_ROOT/isos"
PREFIX="$SCRIPT_DIR/prefix"
GAME_DIR="$PREFIX/drive_c/Westwood/Emperor"
DATA_DIR="$GAME_DIR/data"

# Track mounted ISOs for cleanup on error
MOUNTED_ISOS=()
cleanup_mounts() {
  for mnt in "${MOUNTED_ISOS[@]+"${MOUNTED_ISOS[@]}"}"; do
    [[ -n "$mnt" ]] && hdiutil detach "$mnt" 2>/dev/null || true
  done
}
trap cleanup_mounts EXIT

MINIMAL=false
for arg in "$@"; do
  case "$arg" in
    --minimal) MINIMAL=true ;;
    --help|-h)
      echo "Usage: bash $0 [--minimal]"
      echo "  --minimal  Skip movies and optional audio (~1.5GB smaller)"
      exit 0
      ;;
  esac
done

# --- Step 1: Check prerequisites ---

echo "=== Step 1: Checking prerequisites ==="

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: $1 not found. $2"
    exit 1
  fi
  echo "  ✓ $1 found: $(command -v "$1")"
}

check_cmd wine "Install via: brew install --cask wine-stable"
check_cmd cabextract "Install via: brew install cabextract"

# Check for Rosetta 2 on ARM Macs
if [[ "$(uname -m)" == "arm64" ]]; then
  if ! /usr/bin/pgrep -q oahd 2>/dev/null; then
    echo "WARNING: Rosetta 2 may not be installed. Install via: softwareupdate --install-rosetta"
  else
    echo "  ✓ Rosetta 2 detected"
  fi
fi

# Check ISOs exist
for i in 1 2 3 4; do
  ISO="$ISOS_DIR/EMPEROR${i}.iso"
  if [[ ! -f "$ISO" ]]; then
    echo "ERROR: ISO not found: $ISO"
    echo "       Place the 4 Emperor: Battle for Dune ISOs in isos/"
    exit 1
  fi
done
echo "  ✓ All 4 ISOs found"

# --- Step 2: Create Wine prefix ---

echo ""
echo "=== Step 2: Creating Wine prefix ==="

if [[ -d "$PREFIX" ]]; then
  echo "  Wine prefix already exists at $PREFIX"
  echo "  To recreate, delete it first: rm -rf $PREFIX"
else
  echo "  Creating Wine prefix at $PREFIX ..."
  WINEPREFIX="$PREFIX" wineboot --init 2>/dev/null
  echo "  ✓ Wine prefix created"
fi

# --- Step 3: Extract game files from ISOs ---

echo ""
echo "=== Step 3: Extracting game files ==="

mkdir -p "$GAME_DIR" "$DATA_DIR"

# Mount ISO 1
MNT1=$(hdiutil attach "$ISOS_DIR/EMPEROR1.iso" -nobrowse -readonly | grep -o '/Volumes/.*' | head -1)
if [[ -z "$MNT1" || ! -d "$MNT1" ]]; then
  echo "ERROR: Failed to mount $ISOS_DIR/EMPEROR1.iso"
  exit 1
fi
MOUNTED_ISOS+=("$MNT1")
echo "  Mounted ISO 1 at $MNT1"

# Extract Game1.cab (GAME.EXE, binkw32.dll, resource.cfg, RFH files, small RFDs, etc.)
echo "  Extracting Game1.cab ..."
cabextract -q -d "$GAME_DIR" "$MNT1/INSTALL/Game1.cab"
echo "  ✓ Game1.cab extracted"

# Copy EMPEROR.EXE (the launcher — may not be needed but good to have)
cp "$MNT1/INSTALL/EMPEROR.EXE" "$GAME_DIR/" 2>/dev/null || true

# Copy large RFD files that aren't in the cab
echo "  Copying large data files from ISO 1 ..."
cp "$MNT1/INSTALL/DATA/3DDATA0001.RFD" "$DATA_DIR/" 2>/dev/null || true
cp "$MNT1/INSTALL/DATA/3DDATA0002.RFD" "$DATA_DIR/" 2>/dev/null || true
cp "$MNT1/INSTALL/DATA/3DDATA0002.RFH" "$DATA_DIR/" 2>/dev/null || true
cp "$MNT1/INSTALL/DATA/MAPS0001.RFD" "$DATA_DIR/" 2>/dev/null || true

# Copy SFX
mkdir -p "$DATA_DIR/sounds"
if [[ -f "$MNT1/INSTALL/DATA/SFX/AUDIO.BAG" ]]; then
  cp "$MNT1/INSTALL/DATA/SFX/AUDIO.BAG" "$DATA_DIR/sounds/" 2>/dev/null || true
  echo "  ✓ SFX audio copied"
fi

# Copy music
mkdir -p "$DATA_DIR/audio"
if [[ -f "$MNT1/INSTALL/DATA/MUSIC/music.bag" ]]; then
  cp "$MNT1/INSTALL/DATA/MUSIC/music.bag" "$DATA_DIR/audio/" 2>/dev/null || true
  echo "  ✓ Music copied"
fi

# Copy intro movies from ISO 1
if [[ "$MINIMAL" == false ]]; then
  mkdir -p "$DATA_DIR/movies"
  echo "  Copying movies from ISO 1 ..."
  cp "$MNT1/INSTALL/DATA/MOVIES/"*.BIK "$DATA_DIR/movies/" 2>/dev/null || true
fi

# Copy dialog from ISO 1
mkdir -p "$DATA_DIR/Dialog"
if [[ -f "$MNT1/INSTALL/DATA/DIALOG/DIALOG.BAG" ]]; then
  cp "$MNT1/INSTALL/DATA/DIALOG/DIALOG.BAG" "$DATA_DIR/Dialog/" 2>/dev/null || true
  echo "  ✓ Dialog audio copied"
fi

hdiutil detach "$MNT1" 2>/dev/null || true
MOUNTED_ISOS=("${MOUNTED_ISOS[@]/$MNT1}")
echo "  ✓ ISO 1 done"

# ISOs 2-4: Movies, dialog, and music (optional with --minimal)
if [[ "$MINIMAL" == false ]]; then
  for i in 2 3 4; do
    ISO="$ISOS_DIR/EMPEROR${i}.iso"
    MNT=$(hdiutil attach "$ISO" -nobrowse -readonly | grep -o '/Volumes/.*' | head -1)
    if [[ -z "$MNT" || ! -d "$MNT" ]]; then
      echo "  WARNING: Failed to mount $ISO, skipping"
      continue
    fi
    MOUNTED_ISOS+=("$MNT")
    echo "  Mounted ISO $i at $MNT"

    # Each disc has MOVIES0001.RFD/RFH, DIALOG.BAG, MUSIC.BAG
    if [[ -f "$MNT/MOVIES0001.RFD" ]]; then
      # Name them per-disc to avoid overwriting
      cp "$MNT/MOVIES0001.RFD" "$DATA_DIR/movies/MOVIES000${i}.RFD" 2>/dev/null || true
      cp "$MNT/MOVIES0001.RFH" "$DATA_DIR/movies/MOVIES000${i}.RFH" 2>/dev/null || true
    fi

    hdiutil detach "$MNT" 2>/dev/null || true
    MOUNTED_ISOS=("${MOUNTED_ISOS[@]/$MNT}")
    echo "  ✓ ISO $i done"
  done
else
  echo "  (--minimal: skipping ISOs 2-4)"
fi

echo "  ✓ All game files extracted"

# --- Step 4: Rewrite resource.cfg ---

echo ""
echo "=== Step 4: Rewriting resource.cfg ==="

# The original resource.cfg points CD paths to D:\
# We rewrite them to point to the local data directory
cat > "$GAME_DIR/resource.cfg" << 'RESOURCE_EOF'
MODEL_DATA
data\model

AI_DATA
data\ai

AI_SCRIPTS_DATA
data\ai\scripts

UIDATA
data\ui

AUDIO
data\audio

3DDATA
data\3ddata

MAPS
data\maps

CAMPAIGN_DATA
data\campaign

MISSION_DATA
data\missions

MOVIES
data\movies

MOVIES1
data\movies

MOVIES2
data\movies

MOVIES3
data\movies

MOVIES4
data\movies

SAVED_GAMES
data\saves

PLAYER_DETAILS
data\details

STRINGS
data\strings

RECORD
data\record

LOGS
logs

SOUNDS
data\sounds

CD1
data

CD2
data

CD3
data

CD4
data
RESOURCE_EOF

echo "  ✓ resource.cfg rewritten (all paths local)"

# Create directories referenced by resource.cfg
mkdir -p "$DATA_DIR"/{model,ai/scripts,ui,audio,3ddata,maps,campaign,missions,movies,saves,details,strings,record,sounds}
mkdir -p "$GAME_DIR/logs"

# --- Step 5: Mount ISO as D: drive ---

echo ""
echo "=== Step 5: Mounting ISO as D: drive ==="

# Emperor's SecuROM check needs a CD in the drive
ln -sfn "$ISOS_DIR/EMPEROR1.iso" "$PREFIX/dosdevices/d::" 2>/dev/null || true
echo "  Note: The game requires either a mounted ISO or a no-CD patched GAME.EXE"
echo "  Mount ISO before running: hdiutil attach $ISOS_DIR/EMPEROR1.iso -nobrowse -readonly"
echo "  Then link: ln -sfn /Volumes/EMPEROR1 $PREFIX/dosdevices/d:"
echo ""
echo "  SecuROM 4.x copy protection may still prevent the game from starting under Wine."
echo "  If the game exits immediately, you need a no-CD patched GAME.EXE (v1.09)."
echo "  Search: 'Emperor Battle for Dune v1.09 no-CD' on GameCopyWorld or similar."
echo "  Place the patched GAME.EXE in: $GAME_DIR/"

# --- Step 6: Add registry entries ---

echo ""
echo "=== Step 6: Adding registry entries ==="

cat > /tmp/emperor-reg.reg << 'REGEOF'
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\Software\Westwood\Emperor]
"InstallPath"="C:\\Westwood\\Emperor\\"
"Version"="1.0"
"Language"="English"
"Serial"="000000000000"

[HKEY_LOCAL_MACHINE\Software\Westwood\Emperor\Options]

[HKEY_LOCAL_MACHINE\Software\Westwood\Emperor\Options\Graphics]
"ScreenWidth"=dword:00000400
"ScreenHeight"=dword:00000300
"BitDepth"=dword:00000010

[HKEY_LOCAL_MACHINE\Software\Westwood\Emperor\Options\Sound]
"SFXVolume"=dword:00000064
"MusicVolume"=dword:00000064
"DialogVolume"=dword:00000064

[HKEY_LOCAL_MACHINE\Software\Westwood\Emperor\Options\Game]

[HKEY_LOCAL_MACHINE\Software\Westwood\Emperor\Options\Movies]

[HKEY_CURRENT_USER\Software\Wine\AppDefaults\GAME.EXE]
"Version"="winxp"
REGEOF

WINEPREFIX="$PREFIX" wine regedit /tmp/emperor-reg.reg 2>/dev/null
rm -f /tmp/emperor-reg.reg
echo "  ✓ Registry entries added"

# --- Step 7: Test launch ---

echo ""
echo "=== Step 7: Test launch ==="

# Mount ISO for CD check
ISO_MNT=$(hdiutil attach "$ISOS_DIR/EMPEROR1.iso" -nobrowse -readonly 2>/dev/null | grep -o '/Volumes/.*' | head -1)
if [[ -n "$ISO_MNT" ]]; then
  ln -sfn "$ISO_MNT" "$PREFIX/dosdevices/d:"
  MOUNTED_ISOS+=("$ISO_MNT")
fi

echo "  Starting game with 10s timeout to verify it launches ..."

WINEPREFIX="$PREFIX" wine explorer /desktop=EmperorTest,1024x768 "C:\\Westwood\\Emperor\\GAME.EXE" 2>/dev/null &
WINE_PID=$!

sleep 10

# Check if Wine process is still running (game didn't crash immediately)
if kill -0 "$WINE_PID" 2>/dev/null; then
  echo "  ✓ Game launched successfully (still running after 10s)"
  WINEPREFIX="$PREFIX" wineserver -k 2>/dev/null || kill "$WINE_PID" 2>/dev/null || true
  wait "$WINE_PID" 2>/dev/null || true
else
  echo "  ✗ Game process exited early"
  echo "    This is likely SecuROM copy protection detecting Wine."
  echo "    Replace GAME.EXE with a no-CD patched version (v1.09) to fix this."
fi

if [[ -n "$ISO_MNT" ]]; then
  hdiutil detach "$ISO_MNT" 2>/dev/null || true
  MOUNTED_ISOS=("${MOUNTED_ISOS[@]/$ISO_MNT}")
fi

# --- Done ---

echo ""
echo "========================================"
echo "  Wine setup complete!"
echo ""
echo "  Prefix:  $PREFIX"
echo "  Game:    $GAME_DIR"
echo ""
echo "  Run the visual oracle:"
echo "    npx tsx tools/visual-oracle/cli.ts --backend=wine --scenario title-screen --capture-only"
echo ""
echo "  Or launch the game manually:"
echo "    WINEPREFIX=$PREFIX wine explorer /desktop=Emperor,1024x768 C:\\\\Westwood\\\\Emperor\\\\GAME.EXE"
echo "========================================"
