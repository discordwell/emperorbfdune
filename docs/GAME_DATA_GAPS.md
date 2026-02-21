# Game Data Gaps: Mocked vs. Extractable

Audit of places where the codebase uses hardcoded/mocked/inferred values instead of real game data from extracted assets. Organized by whether real data actually exists and is actionable.

---

## Tier 1: Real data exists in rules.txt, we're ignoring it

These are straightforward fixes — the RulesParser already reads rules.txt, we just need to wire the values through.

### Superweapon Config — RESOLVED
**Status:** Dynamic from rules.txt with fallback. `buildSuperweaponConfig()` reads BuildTime, bullet damage/radius from unit defs.

### Combat System Hardcodes — PARTIALLY RESOLVED
**File:** `src/simulation/CombatSystem.ts`
**Resolved:**
- Infantry damage bonus (`InfDamageRangeBonus`) ✓
- InfantryRock range bonus (`InfRockRangeBonus`, `HeightRangeBonus`) ✓
- Suppression probability (`SuppressionProb`) and duration (`SuppressionDelay`) ✓
**Remaining (no rules.txt keys found):**
- Veterancy fallback tables `[1.0, 1.15, 1.30, 1.50]` / `[1.0, 0.9, 0.8, 0.7]` — hand-tuned
- Sandstorm accuracy penalty `0.7` — hand-tuned
- Damage degradation min `0.5` — hand-tuned

### Spice Mechanics Constants — PARTIALLY RESOLVED
**File:** `src/utils/Constants.ts`
**Resolved:** SpiceMound config now loaded from rules.txt `[SpiceMound]` section:
- `SPICE_MOUND_MIN_DURATION` ← `Size`
- `SPICE_MOUND_RANDOM_DURATION` ← `Cost`
- `SPICE_BLOOM_RADIUS` ← `BlastRadius`
- `SPICE_MOUND_REGROW_MIN` ← `MinRange`
- `SPICE_MOUND_REGROW_MAX` ← `MaxRange`
- `SPICE_BLOOM_DAMAGE_RADIUS` derived from `BlastRadius * TILE_SIZE`
**Remaining (no rules.txt keys):**
- `SPICE_SPREAD_INTERVAL`, `SPICE_SPREAD_CHANCE`, `SPICE_GROWTH_RATE` — hand-tuned

### Sandworm Parameters — PARTIALLY RESOLVED
**Resolved:** Thumper duration, worm ride delays, worm rider lifespan all wired from rules.txt `[General]`.
**Remaining (no rules.txt keys):** Roaming/hunting/mounted speeds, attraction multipliers — hand-tuned.

### Fog of War View Ranges — RESOLVED
**Status:** `ViewRange` component is populated from per-unit/building `viewRange` def at spawn time (EntityFactory.ts:119, :226). FogOfWar reads `ViewRange.range[eid]` with fallback to `GameConstants.DEFAULT_*_VIEW_RANGE`.

### Ability System Defaults — RESOLVED
**Status:** Stealth delays wired from rules.txt `[General]` (`StealthDelay`, `StealthDelayAfterFiring`). Per-unit overrides via `StealthedWhenStill`/`StealthDelay`/`StealthDelayAfterFiring` in unit defs.

---

## Tier 2: Data exists in extracted files, needs parsing or wiring

### Display Names — RESOLVED
**Status:** `tools/extract_strings.py` parses `Text strings.txt` (UTF-16LE) → `assets/data/display-names.json` (597 entries). `DisplayNames.ts` loads JSON at init, falls back to hardcoded names.

### Campaign Phase Rules — RESOLVED
**Status:** `tools/extract_strings.py` parses `PhaseRules.txt` → `assets/data/phase-rules.json` (10 phases, 8 tech levels). `CampaignPhaseManager.ts` loads JSON at init with `loadPhaseRules()`, falls back to hardcoded rules.

### Sound ID Mapping — RESOLVED
**Status:** Already wired in VoiceManager.init() — builds dynamic map from parsed rules.

### Dialog Audio Index — RESOLVED
**Status:** `tools/extract_strings.py` parses `UISPOKEN.TXT` → `assets/data/dialog-index.json` (96 entries). `DialogManager.ts` loads JSON via `loadDialogIndex()` before preloading, falls back to hardcoded map.

### Mission Briefings — RESOLVED
**Status:** Already loaded from `campaign-strings.json`.

### Campaign Credits/Difficulty/Survival — NOT ACTIONABLE
**Status:** `CREDITS_BY_PHASE`, `DIFFICULTY_CONFIG`, `SURVIVAL_MISSION_TICKS` have no source data in extracted files. Must remain hand-tuned.

---

## Tier 3: .tok Interpreter Gaps

### Implemented Functions
| Function | Implementation |
|----------|---------------|
| `ObjectVisibleToSide` | Checks FogOfWar visibility for player 0; non-player sides assume visible |
| `ObjectTypeVisibleToSide` | Searches all units of type, checks fog visibility |
| `SideAIDone` | Returns 0 while any unit of side has `MoveTarget.active === 1` |
| `ObjectDeploy` | MCV→ConYard conversion via spawn/kill |
| `AirStrike` | Spawns units at entrance, attack-moves to target, tracks strike ID |
| `AirStrikeDone` | Returns 1 when all strike units dead or stopped moving |
| `SideNuke` | Fires superweapon at given position via `SuperweaponSystem.fire()` |
| `SideNukeAll` | Fires at each active side's centroid |
| `SideAIBehaviour*` | Sets behavior override on AIPlayer (aggressive/defensive/retreat/normal) |
| `ObjectToolTip` | Stores tooltip ID silently (cosmetic, no UI hook) |

### Script Point Functions — RESOLVED
| Function | Resolution |
|----------|------------|
| `getScriptPoint` | Reads indexed points from test.xbf FXData |
| `getEntrancePoint` | Reads entrance markers from test.xbf FXData |
| `getNeutralEntrancePoint` | Reads generic entrances (marker=99) from test.xbf FXData |
| `getUnusedBasePoint` | Uses unused spawn points from test.xbf FXData |

### Remaining Stubs
| Function | Status |
|----------|--------|
| `ObjectUndeploy` | No-op (0 uses in missions) |
| `FireSpecialWeapon` | No-op (0 uses in campaign missions) |
| `SideAIEncounterIgnore` | No-op (niche) |
| `SideAIEnterBuilding` | No-op (niche) |
| `SideAIHeadlessChicken` | No-op (niche) |
| `SideAIShuffle` | No-op (niche) |

---

## Tier 4: Not actionable (no extractable data)

### AI System
**File:** `src/ai/AIPlayer.ts`
**Problem:** Entire AI is invented — difficulty settings, personality biases, unit composition, build orders, attack timing.
**Reality:** Original game's AI logic is compiled into GAME.EXE, not data-driven. No config files exist for AI behavior.
**Status:** Must remain hand-tuned. Now supports `behaviorOverride` from mission scripts.

### Procedural Terrain
**Status:** Real map terrain is loaded for all 82 maps. Procedural fallback only for maps without binary data.

### Audio Synthesis
**Status:** Intentional fallbacks when real audio files aren't loaded. Working as designed.

### Animation Data
**Status:** Must remain hand-tuned or extracted from model analysis.
