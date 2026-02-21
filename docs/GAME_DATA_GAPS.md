# Game Data Gaps: Mocked vs. Extractable

Audit of places where the codebase uses hardcoded/mocked/inferred values instead of real game data from extracted assets. Organized by whether real data actually exists and is actionable.

---

## Tier 1: Real data exists in rules.txt, we're ignoring it

These are straightforward fixes — the RulesParser already reads rules.txt, we just need to wire the values through.

### Superweapon Config
**File:** `src/simulation/SuperweaponSystem.ts` lines 19-24
**Problem:** `SUPERWEAPON_CONFIG` hardcodes charge time, radius, and damage for all 4 palace types (HKPalace, ATPalace, ORPalace, GUPalace).
**Source:** `rules.txt` sections `[HKPalace]`, `[ATPalace]`, `[ORPalace]`, `[GUPalace]` — keys like `ChargeTime`, `DeathWeapon`, linked warhead definitions for radius/damage.
**Fix:** Read from parsed building definitions at runtime. Remove the hardcoded config object entirely.

### Combat System Hardcodes
**File:** `src/simulation/CombatSystem.ts`
**Problems:**
- Veterancy damage reduction `[1.0, 0.9, 0.8, 0.7]` and bonus `[1.0, 1.15, 1.30, 1.50]` — fallback tables when unit def has no veterancy data
- Infantry damage bonus `1.5x` (line ~757)
- InfantryRock range bonus `+6` (line ~428)
- Sandstorm accuracy penalty `0.7` (line ~745)
- Suppression probability `0.2` and duration `200` ticks (lines ~638-639)
- Damage degradation formula `0.5 + hpRatio * 0.5` (line ~735)
- Base fallback damage `100` (line ~711)

**Source:** `rules.txt` `[General]` and `[GameConstants]` sections. Veterancy values are under `[Veterancy]`. Suppression under `[Combat]` or `[General]`.
**Fix:** Add these keys to the `loadConstants()` function in `Constants.ts`, then reference them in CombatSystem instead of magic numbers.

### Spice Mechanics Constants
**File:** `src/utils/Constants.ts`
**Problems:**
- `SPICE_SPREAD_INTERVAL = 100`
- `SPICE_SPREAD_CHANCE = 0.03`
- `SPICE_GROWTH_RATE = 0.002`
- `SPICE_BLOOM_DAMAGE = 200`
- `SPICE_BLOOM_DAMAGE_RADIUS = 12`

**Source:** `rules.txt` `[General]` section likely has SpiceGrowth, SpiceBloom, etc.
**Fix:** Check rules.txt for matching keys, wire through `loadConstants()`.

### Sandworm Parameters
**File:** `src/simulation/SandwormSystem.ts`
**Problems:**
- Roaming speed `0.3`, hunting speed `0.6`, mounted speed `0.8`
- Thumper duration `500` ticks
- Attraction multipliers `0.5` (harvesters), `0.3` (tastyToWorms)

**Source:** `rules.txt` `[Sandworm]` section or individual unit sections with `TastyToWorms` flag.
**Fix:** Read from parsed unit/game definitions.

### Fog of War View Ranges
**File:** `src/rendering/FogOfWar.ts`
**Problems:**
- Default unit view range `10` (line 191)
- Default building view range `20` (line 200)

**Source:** `rules.txt` per-unit `SightRange` values (already parsed into unit defs).
**Fix:** Ensure `ViewRange` component is populated from unit def `sightRange` at spawn time. The fallback values should only apply to entities without definitions.

### Ability System Defaults
**File:** `src/simulation/AbilitySystem.ts`
**Problems:**
- Stealth delay after firing `125` ticks (line ~254)
- Stealth activation delay `75` ticks (line ~408)

**Source:** `rules.txt` per-unit ability definitions.
**Fix:** Read from unit definitions instead of hardcoding.

---

## Tier 2: Data exists in extracted files, needs parsing or wiring

These require reading additional game data files or parsing new sections of rules.txt.

### Display Names
**File:** `src/config/DisplayNames.ts`
**Problem:** All unit/building display names are hardcoded English strings (~100 entries).
**Source:** `extracted/` contains UI string files (UISTRINGS.TXT or similar). The game's localization data has proper display names.
**Fix:** Parse the UI string file, build a lookup table keyed by type name. Fall back to the hardcoded names for any missing entries.

### Campaign Progression Config
**Files:** `src/campaign/CampaignData.ts`, `CampaignPhaseManager.ts`, `MissionConfig.ts`, `MissionRuntime.ts`
**Problems:**
- `CREDITS_BY_PHASE` starting credits (attack: 5000, defend: 2500, etc.)
- `PHASE_RULES` (10 phases with battles/captured/maxBattles)
- `TECH_LEVEL_RULES` (8 levels tied to phases)
- `DIFFICULTY_CONFIG` with region-relative-difference values
- `SURVIVAL_MISSION_TICKS = 25 * 60 * 8` (8-minute timer)
- AI credit bonus formula

**Source:** Some from `PhaseRules.txt`, `TechLevels.txt` in extracted data. Starting credits may be in mission-specific .tok scripts or rules.txt `[Campaign]` section. Survival timer may be in .tok scripts.
**Fix:** Audit `extracted/` for campaign config files. Parse and wire through. Cross-reference .tok mission scripts for per-mission overrides.

### Sound ID Mapping
**File:** `src/audio/VoiceManager.ts` lines 30-81
**Problem:** `SOUND_ID_MAP` hardcoded from commented-out rules.txt properties.
**Source:** `rules.txt` per-unit sections contain `SoundID=N` entries (currently parsed but the reverse map is manually maintained).
**Fix:** Build `SOUND_ID_MAP` dynamically from parsed rules at init time.

### Dialog Audio Index
**File:** `src/audio/DialogManager.ts`
**Problem:** `STRING_KEY_TO_FILE` mapping and audio entry index formula `(index - 1) * 2 + 4` are hardcoded.
**Source:** UISPOKEN.TXT and UI-G BAG audio archive structure.
**Fix:** Parse UISPOKEN.TXT for the key-to-index mapping. The index formula may need verification against the BAG archive header.

---

## Tier 3: .tok Interpreter Gaps

Functions in `TokFunctions.ts` that return dummy values, causing mission scripts to behave incorrectly at runtime.

### Stubbed Functions (return dummy values)
| Function | Current Behavior | Correct Behavior |
|----------|-----------------|-------------------|
| `ObjectVisibleToSide` | Always returns `1` | Check fog of war visibility |
| `SideAIDone` | Always returns `1` | Check if AI side has completed its current order |
| `ObjectDeploy` / `ObjectUndeploy` | No-op | Trigger MCV<->ConYard conversion, deploy siege tanks |
| `SideNuke` | No-op | Launch Death Hand missile at target |
| `AirStrike` | No-op | Call in air strike at target position |
| `FireSpecialWeapon` | No-op | Activate palace superweapon |
| `SideAI*` behavior functions | No-op | Set AI behavior mode for a side |
| `ObjectToolTip` | No-op | Set tooltip ID on entity |

### Script Point Functions — RESOLVED
| Function | Previous Behavior | Resolution |
|----------|-----------------|------------|
| `getScriptPoint` | Returned `{x:50, z:50}` | Reads indexed points (up to 24/map) from test.xbf FXData |
| `getEntrancePoint` | Hardcoded map edge | Reads entrance markers with IDs from test.xbf FXData |
| `getNeutralEntrancePoint` | Hardcoded map edge | Reads generic entrances (marker=99) from test.xbf FXData |
| `getUnusedBasePoint` | Random center area | Uses unused spawn points from test.xbf FXData |

**Resolved:** Map metadata (script points, entrances, spawn positions) was found in `test.xbf` FXData section 0xA0000005 — NOT in `.dme` files. The `.dme` format is a DuneMapEditor project file that was never shipped with the game. All 82 maps now have metadata extracted and wired into the scripting system via `manifest.json`.

---

## Tier 4: Not actionable (no extractable data)

### AI System
**File:** `src/ai/AIPlayer.ts`
**Problem:** Entire AI is invented — difficulty settings, personality biases, unit composition, build orders, attack timing.
**Reality:** Original game's AI logic is compiled into GAME.EXE, not data-driven. No config files exist for AI behavior.
**Status:** Must remain hand-tuned. Could be improved by observing original game behavior, but there's nothing to extract.

### Procedural Terrain
**File:** `src/rendering/TerrainRenderer.ts`
**Problem:** Fallback procedural terrain when no real map data.
**Reality:** `.dme` is actually the DuneMapEditor project format, never shipped with the game. The actual map terrain data lives in `test.xbf` FXData (heightmap, passability, texture indices) and `test.CPT`/`test.CPF`/`texture.dat` files — all of which are now parsed and loaded via `convert_maps.py`. Entity/spawn data is in FXData section 0xA0000005 and is fully decoded.
**Status:** Real map terrain is loaded for all 82 maps. The procedural fallback exists only for maps without binary data.

### Audio Synthesis
**File:** `src/audio/AudioManager.ts`
**Problem:** ~20 synthesized SFX methods as fallbacks.
**Reality:** These are intentional fallbacks when real audio files aren't loaded. Real WAV audio exists in BAG archives and is loaded when available.
**Status:** Working as designed. Low priority.

### Animation Data
**Files:** `src/rendering/EffectsManager.ts`, unit renderers
**Problem:** Projectile behaviors, muzzle flash positions, explosion scales are hardcoded.
**Reality:** Animation data is baked into XBF model files (already converted to glTF). Projectile arc heights and effect scales have no separate config — they're likely in GAME.EXE code.
**Status:** Must remain hand-tuned or extracted from model analysis.

---

## Suggested Work Order

1. **rules.txt value extraction** (Tier 1) — Biggest bang for buck. Wire superweapon config, combat values, spice constants, sandworm params, view ranges, and ability delays through the existing rules parser. Pure data plumbing, no new formats to reverse-engineer.

2. **.tok stub implementation** (Tier 3 top half) — Implement `ObjectDeploy`/`ObjectUndeploy` (MCV conversion), `FireSpecialWeapon` (hooks into superweapon system), `ObjectVisibleToSide` (hooks into fog of war). These are the stubs most likely to break mission scripts.

3. **Display names + sound ID mapping** (Tier 2) — Parse UI string files from extracted data, build dynamic sound ID map from rules.txt. Improves polish.

4. **Campaign config extraction** (Tier 2) — Audit extracted files for phase rules, tech levels, starting credits. Wire through parsed data.

5. ~~**Per-mission script point overrides**~~ — DONE. Real script points, entrances, and spawn positions extracted from test.xbf FXData for all 82 maps.
