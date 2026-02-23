#!/bin/bash
# Creates a QEMU disk image for the Visual Oracle VM.
# This only creates the blank disk — Windows and Emperor must be installed manually.
# See README.md in this directory for full setup instructions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISK_IMAGE="$SCRIPT_DIR/emperor-win10.qcow2"
DISK_SIZE="20G"

# Check for QEMU
if ! command -v qemu-img &>/dev/null; then
  echo "Error: qemu-img not found. Install QEMU first:"
  echo "  brew install qemu"
  exit 1
fi

# Check if disk already exists
if [ -f "$DISK_IMAGE" ]; then
  echo "Disk image already exists: $DISK_IMAGE"
  echo "Delete it first if you want to recreate."
  exit 1
fi

echo "Creating QCOW2 disk image ($DISK_SIZE)..."
qemu-img create -f qcow2 "$DISK_IMAGE" "$DISK_SIZE"
echo "Created: $DISK_IMAGE"
echo ""
echo "Next steps:"
echo "  1. Download a Windows 10 evaluation ISO"
echo "  2. Install Windows in QEMU:"
echo "     qemu-system-i386 -hda '$DISK_IMAGE' -cdrom <win10.iso> -m 4G -vga std -boot d"
echo "  3. Install Emperor: Battle for Dune from the game ISOs"
echo "  4. Install dgVoodoo2 for D3D7→D3D11 translation"
echo "  5. Create a snapshot: qemu-img snapshot -c ready '$DISK_IMAGE'"
echo ""
echo "See README.md for detailed instructions."
