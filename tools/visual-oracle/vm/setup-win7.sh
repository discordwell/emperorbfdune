#!/bin/bash
# Setup script for Windows 7 VM with Emperor: Battle for Dune + dgVoodoo2
# For visual oracle screenshot comparison with the web remake.
#
# Usage: bash tools/visual-oracle/vm/setup-win7.sh [step]
#   step 1: Create disk + install Windows 7 (interactive, ~30 min)
#   step 2: Install Emperor from ISOs (interactive, ~10 min)
#   step 3: Install dgVoodoo2 + launch game (automated)
#   (no arg): Run all steps sequentially

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DISK_IMAGE="$SCRIPT_DIR/emperor-win7.qcow2"
WIN7_ISO="$SCRIPT_DIR/win7-pro-sp1-x86.iso"
FLOPPY_IMG="/tmp/win7-floppy-raw.img"
QMP_SOCK="/tmp/ebfd-visual-oracle-qmp.sock"
DISK_SIZE="20G"
RAM="2G"

# Emperor ISOs
EMPEROR1="$PROJECT_DIR/isos/EMPEROR1.iso"
EMPEROR2="$PROJECT_DIR/isos/EMPEROR2.iso"
EMPEROR3="$PROJECT_DIR/isos/EMPEROR3.iso"

# dgVoodoo2 files
DGVOODOO_DIR="$SCRIPT_DIR/dgvoodoo2"

check_prereqs() {
    echo "=== Checking prerequisites ==="
    command -v qemu-system-i386 &>/dev/null || { echo "Error: qemu not found. Run: brew install qemu"; exit 1; }
    [ -f "$WIN7_ISO" ] || { echo "Error: Win7 ISO not found at $WIN7_ISO"; exit 1; }
    [ -f "$EMPEROR1" ] || { echo "Error: Emperor ISOs not found in $PROJECT_DIR/isos/"; exit 1; }
    echo "[OK] All prerequisites met"
}

step1_install_windows() {
    echo "=== Step 1: Create disk + Install Windows 7 ==="

    if [ -f "$DISK_IMAGE" ]; then
        echo "Disk image already exists. Delete it first to reinstall."
        echo "  rm $DISK_IMAGE"
        return 1
    fi

    # Create disk
    echo "Creating $DISK_SIZE QCOW2 disk..."
    qemu-img create -f qcow2 "$DISK_IMAGE" "$DISK_SIZE"

    echo "Starting QEMU for Windows 7 installation..."
    echo "The unattended setup should proceed automatically."
    echo "If prompted for a product key, skip it."
    echo ""
    echo "Press Ctrl+C when installation is complete and Windows is at the desktop."

    qemu-system-i386 \
        -hda "$DISK_IMAGE" \
        -cdrom "$WIN7_ISO" \
        -fda "$FLOPPY_IMG" \
        -m "$RAM" \
        -vga std \
        -accel tcg \
        -cpu pentium3 \
        -smp 1 \
        -usb -device usb-tablet \
        -display cocoa \
        -boot d \
        -qmp unix:"$QMP_SOCK",server,nowait \
        -name "Win7 Install"
}

step2_install_emperor() {
    echo "=== Step 2: Install Emperor: Battle for Dune ==="
    echo "Starting VM with Emperor Disc 1..."
    echo ""
    echo "Instructions:"
    echo "  1. Run D:\\SETUP.EXE from the CD"
    echo "  2. Follow the installer"
    echo "  3. When asked for Disc 2/3, use QMP to swap:"
    echo "     echo '{\"execute\":\"eject\",\"arguments\":{\"device\":\"ide1-cd0\",\"force\":true}}' | nc -U $QMP_SOCK"
    echo "     echo '{\"execute\":\"blockdev-change-medium\",\"arguments\":{\"device\":\"ide1-cd0\",\"filename\":\"$EMPEROR2\"}}' | nc -U $QMP_SOCK"
    echo ""

    qemu-system-i386 \
        -hda "$DISK_IMAGE" \
        -cdrom "$EMPEROR1" \
        -m "$RAM" \
        -vga std \
        -accel tcg \
        -cpu pentium3 \
        -smp 1 \
        -usb -device usb-tablet \
        -display cocoa \
        -qmp unix:"$QMP_SOCK",server,nowait \
        -name "Emperor Install"
}

step3_install_dgvoodoo() {
    echo "=== Step 3: Install dgVoodoo2 ==="

    # Create ISO with dgVoodoo2 files + config + install batch
    local STAGE_DIR="/tmp/dgvoodoo-stage"
    rm -rf "$STAGE_DIR"
    mkdir -p "$STAGE_DIR"

    # Copy x86 DirectX DLLs
    cp "$DGVOODOO_DIR/MS/x86/DDraw.dll" "$STAGE_DIR/"
    cp "$DGVOODOO_DIR/MS/x86/D3DImm.dll" "$STAGE_DIR/"

    # Copy Emperor-optimized config
    cp "$DGVOODOO_DIR/dgVoodoo-emperor.conf" "$STAGE_DIR/dgVoodoo.conf"

    # Create install batch
    cat > "$STAGE_DIR/INSTALL.BAT" << 'BATCH'
@echo off
echo === Installing dgVoodoo2 for Emperor ===
echo.
echo Copying DLLs to C:\Westwood\Emperor...
copy /y D:\DDraw.dll "C:\Westwood\Emperor\DDraw.dll"
copy /y D:\D3DImm.dll "C:\Westwood\Emperor\D3DImm.dll"
copy /y D:\dgVoodoo.conf "C:\Westwood\Emperor\dgVoodoo.conf"
echo.
echo Done! Files copied:
dir "C:\Westwood\Emperor\DDraw.dll" "C:\Westwood\Emperor\D3DImm.dll" "C:\Westwood\Emperor\dgVoodoo.conf"
echo.
echo Press any key to launch Emperor...
pause
C:\Westwood\Emperor\GAME.EXE
BATCH

    # Create ISO
    hdiutil makehybrid -iso -joliet -o /tmp/dgvoodoo-setup.iso "$STAGE_DIR" 2>/dev/null
    echo "dgVoodoo2 ISO created"

    echo "Starting VM with dgVoodoo2 setup ISO..."
    echo "Run D:\\INSTALL.BAT to install and test."
    echo ""

    qemu-system-i386 \
        -hda "$DISK_IMAGE" \
        -cdrom /tmp/dgvoodoo-setup.iso \
        -m "$RAM" \
        -vga std \
        -accel tcg \
        -cpu pentium3 \
        -smp 1 \
        -usb -device usb-tablet \
        -display cocoa \
        -qmp unix:"$QMP_SOCK",server,nowait \
        -name "Emperor dgVoodoo2"
}

# Main
check_prereqs

STEP="${1:-all}"
case "$STEP" in
    1) step1_install_windows ;;
    2) step2_install_emperor ;;
    3) step3_install_dgvoodoo ;;
    all)
        step1_install_windows
        step2_install_emperor
        step3_install_dgvoodoo
        echo ""
        echo "=== Setup Complete ==="
        echo "Create a snapshot: qemu-img snapshot -c ready $DISK_IMAGE"
        ;;
    *) echo "Usage: $0 [1|2|3|all]"; exit 1 ;;
esac
