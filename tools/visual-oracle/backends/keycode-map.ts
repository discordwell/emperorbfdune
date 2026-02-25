/**
 * Maps QEMU keycode names (used in scenario definitions) to macOS virtual key codes
 * (used by AppleScript's `key code` command).
 *
 * Only keys actually used in the visual oracle scenarios are included.
 * See: https://eastmanreference.com/complete-list-of-applescript-key-codes
 */
export const QEMU_TO_MAC_KEYCODE: Record<string, number> = {
  // Navigation keys
  ret: 36,     // Return/Enter
  esc: 53,     // Escape

  // Number keys (top row)
  '1': 18,
  '2': 19,
  '3': 20,
  '4': 21,
  '5': 23,

  // Arrow keys
  up: 126,
  down: 125,
  left: 123,
  right: 124,

  // Function keys
  f1: 122,
  f2: 120,
  f3: 99,

  // Modifiers (for compound keys)
  shift: -1,   // handled specially in AppleScript
  ctrl: -2,    // handled specially in AppleScript
  alt: -3,     // handled specially in AppleScript

  // Common game keys
  spc: 49,     // Space
  tab: 48,
};
