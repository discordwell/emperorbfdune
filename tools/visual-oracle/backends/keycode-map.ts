/**
 * Maps QEMU keycode names (used in scenario definitions) to DirectInput
 * keyboard scan codes (DIK_ codes), used by the DInput hook proxy DLL.
 *
 * The DInput hook intercepts GetDeviceState and injects these codes into
 * the 256-byte keyboard state array that DirectInput returns to GAME.EXE.
 *
 * See: https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ee418641(v=vs.85)
 */
export const QEMU_TO_DIK_CODE: Record<string, number> = {
  // Navigation keys
  ret: 0x1C,     // DIK_RETURN (28)
  esc: 0x01,     // DIK_ESCAPE (1)

  // Number keys (top row)
  '1': 0x02,     // DIK_1 (2)
  '2': 0x03,     // DIK_2 (3)
  '3': 0x04,     // DIK_3 (4)
  '4': 0x05,     // DIK_4 (5)
  '5': 0x06,     // DIK_5 (6)

  // Arrow keys
  up: 0xC8,      // DIK_UP (200)
  down: 0xD0,    // DIK_DOWN (208)
  left: 0xCB,    // DIK_LEFT (203)
  right: 0xCD,   // DIK_RIGHT (205)

  // Function keys
  f1: 0x3B,      // DIK_F1 (59)
  f2: 0x3C,      // DIK_F2 (60)
  f3: 0x3D,      // DIK_F3 (61)
  f4: 0x3E,      // DIK_F4 (62)
  f5: 0x3F,      // DIK_F5 (63)
  f6: 0x40,      // DIK_F6 (64)
  f7: 0x41,      // DIK_F7 (65)
  f8: 0x42,      // DIK_F8 (66)
  f9: 0x43,      // DIK_F9 (67)
  f10: 0x44,     // DIK_F10 (68)

  // Modifiers
  shift: 0x2A,   // DIK_LSHIFT (42)
  ctrl: 0x1D,    // DIK_LCONTROL (29)
  alt: 0x38,     // DIK_LMENU/LALT (56)

  // Common game keys
  spc: 0x39,     // DIK_SPACE (57)
  tab: 0x0F,     // DIK_TAB (15)
};

