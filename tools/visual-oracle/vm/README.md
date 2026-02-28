# Visual Oracle — VM Setup

One-time setup to create a QEMU VM running Windows 7 with Emperor: Battle for Dune
and dgVoodoo2 for D3D7 software rendering via WARP.

## Why Windows 7?

Emperor uses Direct3D 7 (DDraw/D3DImm), and QEMU provides no GPU acceleration.
dgVoodoo2 translates D3D7 → D3D11, then uses WARP (Windows software rasterizer)
for CPU-based rendering. WARP requires D3D11, which means Windows 7 SP1 minimum.

Windows XP was tested but **all D3D7 wrappers fail** on it:
- dgVoodoo2: needs D3D11 (Win7+)
- DXGL: needs `SHGetKnownFolderPath` (Vista+)
- WineD3D: needs Vista+ APIs or `ucrtbase.dll`

## Prerequisites

```bash
brew install qemu    # ~500MB, provides qemu-system-i386
```

## Quick Setup

```bash
# Downloads Win7 ISO, creates VM, installs everything
bash tools/visual-oracle/vm/setup-win7.sh
```

Or run individual steps:

```bash
bash tools/visual-oracle/vm/setup-win7.sh 1   # Install Windows 7
bash tools/visual-oracle/vm/setup-win7.sh 2   # Install Emperor
bash tools/visual-oracle/vm/setup-win7.sh 3   # Install dgVoodoo2
```

## Manual Setup

### 1. Get Windows 7 SP1 x86 ISO

Download from [Archive.org](https://archive.org/details/win-7-pro-sp1-english):
```bash
curl -L -o tools/visual-oracle/vm/win7-pro-sp1-x86.iso \
  "https://archive.org/download/win-7-pro-sp1-english/Win7_Pro_SP1_English_x32.iso"
```

### 2. Create disk + install Windows

```bash
qemu-img create -f qcow2 tools/visual-oracle/vm/emperor-win7.qcow2 20G

qemu-system-i386 \
  -hda tools/visual-oracle/vm/emperor-win7.qcow2 \
  -cdrom tools/visual-oracle/vm/win7-pro-sp1-x86.iso \
  -m 2G -vga std -accel tcg -cpu pentium3 \
  -usb -device usb-tablet -display cocoa -boot d \
  -qmp unix:/tmp/ebfd-visual-oracle-qmp.sock,server,nowait
```

### 3. Install Emperor from ISOs

Swap CDs via QMP:
```bash
# Eject
echo '{"execute":"eject","arguments":{"device":"ide1-cd0","force":true}}' | nc -U /tmp/ebfd-visual-oracle-qmp.sock
# Insert next disc
echo '{"execute":"blockdev-change-medium","arguments":{"device":"ide1-cd0","filename":"/path/to/EMPEROR2.iso"}}' | nc -U /tmp/ebfd-visual-oracle-qmp.sock
```

### 4. Install dgVoodoo2

Copy from `tools/visual-oracle/vm/dgvoodoo2/`:
- `MS/x86/DDraw.dll` → `C:\Westwood\Emperor\`
- `MS/x86/D3DImm.dll` → `C:\Westwood\Emperor\`
- `dgVoodoo-emperor.conf` → `C:\Westwood\Emperor\dgVoodoo.conf`

Key config: `OutputAPI = d3d11warp`, `Environment = QEmu`, `FullScreenMode = false`

### 5. Create snapshot

```bash
qemu-img snapshot -c ready tools/visual-oracle/vm/emperor-win7.qcow2
```

## Headless Screenshot Mode

Once set up, launch headless and capture screenshots via QMP:
```bash
qemu-system-i386 \
  -hda tools/visual-oracle/vm/emperor-win7.qcow2 \
  -cdrom isos/EMPEROR1.iso \
  -m 2G -vga std -accel tcg -cpu pentium3 \
  -display none \
  -qmp unix:/tmp/ebfd-visual-oracle-qmp.sock,server,nowait

# Screenshot via QMP
echo '{"execute":"screendump","arguments":{"filename":"/tmp/screenshot.ppm"}}' | nc -U /tmp/ebfd-visual-oracle-qmp.sock
```

## Troubleshooting

- **Black screen**: Try `-vga cirrus` instead of `-vga std`
- **No sound**: Not needed for visual oracle
- **Slow boot**: TCG on ARM Mac is slow; expect 2-3 min boot times
- **Game crashes**: Ensure dgVoodoo2 DLLs AND `dgVoodoo.conf` are in the game directory
- **"d3d11warp" fails**: WARP is only available on Win7 SP1+ with Platform Update
