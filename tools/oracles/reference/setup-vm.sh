#!/bin/bash
# Setup script for Windows VM to capture original game traces.
# Requires UTM (macOS VM manager) and Emperor: Battle for Dune ISOs.
#
# This script automates the preparation steps. Manual steps are noted.
#
# Usage: bash tools/oracles/reference/setup-vm.sh

set -e

echo "=== Emperor: Battle for Dune — VM Capture Setup ==="
echo ""

# Step 1: Check for UTM
if ! command -v /Applications/UTM.app/Contents/MacOS/utmctl &> /dev/null; then
  echo "UTM not found. Installing via Homebrew..."
  echo "  brew install --cask utm"
  echo ""
  echo "Run this after installing UTM."
  echo "NOTE: This requires ~2GB download + ~20GB disk for the VM."
  exit 1
fi
echo "[OK] UTM found"

# Step 2: Check for game ISOs
ISO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)/isos"
if [ ! -d "$ISO_DIR" ]; then
  echo "[WARN] No isos/ directory found. Expected at: $ISO_DIR"
  echo "  Emperor ISOs should be: EMPEROR1.iso, EMPEROR2.iso, EMPEROR3.iso, EMPEROR4.iso"
  exit 1
fi

ISO_COUNT=$(ls "$ISO_DIR"/*.iso 2>/dev/null | wc -l | tr -d ' ')
echo "[OK] Found $ISO_COUNT ISO files in $ISO_DIR"

# Step 3: Generate capture manifest and hook header
echo ""
echo "Generating capture manifest..."
npm run oracle:reference:workflow:prepare 2>/dev/null || echo "[WARN] Manifest generation failed (may need npm install first)"

# Step 4: Print manual steps
echo ""
echo "=== MANUAL STEPS REQUIRED ==="
echo ""
echo "1. Download Windows 10 x86 evaluation ISO:"
echo "   https://www.microsoft.com/en-us/evalcenter/evaluate-windows-10-enterprise"
echo "   (Select 32-bit ISO for best compatibility with 2001 game)"
echo ""
echo "2. Create VM in UTM:"
echo "   - Type: Emulate (x86 on ARM = QEMU TCG)"
echo "   - RAM: 4 GB"
echo "   - Disk: 20 GB"
echo "   - Display: VGA"
echo "   - Mount Windows ISO as boot CD"
echo ""
echo "3. Install Windows, then mount Emperor ISOs and install the game"
echo ""
echo "4. Copy hook header into the VM:"
echo "   tools/oracles/reference/tok_capture_manifest.generated.h"
echo ""
echo "5. Build the hook DLL (see HOOK_INTEGRATION_GUIDE.md)"
echo ""
echo "6. Run missions with hook, capture TOKTRACE output"
echo ""
echo "7. Extract and merge traces:"
echo "   npm run oracle:reference:extract -- --input /path/to/game.log --output captures/part_001.jsonl"
echo "   npm run oracle:reference:merge"
echo ""
echo "8. Validate and finalize:"
echo "   npm run oracle:reference:workflow:finalize"
echo ""
echo "=== END ==="
