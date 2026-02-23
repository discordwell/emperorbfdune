# Visual Oracle — VM Setup

One-time manual setup to create a QEMU VM with Emperor: Battle for Dune installed.

## Prerequisites

```bash
brew install qemu    # ~500MB, provides qemu-system-i386
```

## Steps

### 1. Create disk image

```bash
./tools/visual-oracle/vm/create-disk.sh
```

This creates a 20GB QCOW2 disk at `tools/visual-oracle/vm/emperor-win10.qcow2`.

### 2. Install Windows

Download a Windows 10 evaluation ISO from Microsoft, then boot the VM:

```bash
qemu-system-i386 \
  -hda tools/visual-oracle/vm/emperor-win10.qcow2 \
  -cdrom ~/Downloads/Win10_eval.iso \
  -m 4G -vga std -boot d \
  -usb -device usb-tablet
```

Complete the Windows installation (~30 min). Shut down the VM when done.

### 3. Install Emperor: Battle for Dune

Boot the VM again with the game ISO mounted:

```bash
qemu-system-i386 \
  -hda tools/visual-oracle/vm/emperor-win10.qcow2 \
  -cdrom isos/Emperor_Battle_for_Dune_Disc_1.iso \
  -m 4G -vga std \
  -usb -device usb-tablet
```

Run the installer from the CD. You may need to swap ISOs during installation:
- Use QEMU monitor (Ctrl+Alt+2) and `change ide1-cd0 path/to/disc2.iso`

### 4. Install dgVoodoo2

Download dgVoodoo2 from the official site. Copy the D3D wrapper DLLs into the Emperor installation directory. This translates D3D7 calls to D3D11, which works better under QEMU's VGA emulation.

### 5. Test the game launches

Boot the VM, launch Emperor, verify it reaches the title screen.

### 6. Create a snapshot

```bash
qemu-img snapshot -c ready tools/visual-oracle/vm/emperor-win10.qcow2
```

This saves the "game installed, ready to launch" state for fast restoration.

## File Size

The QCOW2 file will be ~8-12GB after Windows + Emperor installation. It is gitignored.

## Troubleshooting

- **Black screen**: Try `-vga cirrus` instead of `-vga std`
- **No sound**: Sound is not needed for visual oracle — the VM runs headless
- **Slow boot**: TCG (software emulation) on ARM Mac is slow; expect 2-3 min boot times
- **Game won't start**: Ensure dgVoodoo2 DLLs are in the game directory
