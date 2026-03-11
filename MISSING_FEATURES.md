# Missing Features Audit

Living audit of Emperor: Battle for Dune parity features. Status codes:
- `[x]` Verified — test exists and passes
- `[~]` Approximated — implemented but not exact match to original
- `[ ]` Missing — not yet implemented
- `[n/a]` Out of scope — intentionally not implementing

> Populated from parity test results. Run `npm run parity:source` to regenerate.

---

## General Constants (GN)

- [x] GN1: SpiceValue, RepairRate, RearmRate, FogRegrowRate, HarvReplacementDelay, BulletGravity
- [x] GN2: SuppressionDelay, SuppressionProb, derived SUPPRESSION_CHANCE
- [x] GN3: InfRockRangeBonus, HeightRangeBonus, InfDamageRangeBonus, derived INF_ROCK_DAMAGE_MULT
- [x] GN4: EasyBuildCost/Time, NormalBuildCost/Time, HardBuildCost/Time
- [x] GN5: StormMinWait, StormMaxWait, StormMinLife, StormMaxLife, StormKillChance
- [x] GN6: Worm spawn/lifetime/attraction constants (11 values)
- [x] GN7: Starport timing and pricing (7 values)
- [x] GN8: Campaign money, reinforcement values (14 values)
- [x] GN9: Stealth/ability durations, guard range, placement dist, carryall, repair (10 values)
- [x] GN10: Replica/hologram constants (5 values)

## Combat (CB)

- [x] CB1: Base damage from bullet definitions
- [x] CB2: Warhead vs armor multiplier application
- [x] CB3: Veterancy damage bonus formula (extraDamage + fallback array)
- [x] CB4: Veterancy defense bonus formula (extraArmour + fallback array)
- [x] CB5: Damage degradation (HP-ratio based, HK exempt)
- [x] CB6: Sandstorm 30% damage penalty (ground non-building units)
- [x] CB7: Infantry rock +50% damage bonus
- [x] CB8: AoE linear falloff with reduceDamageWithDistance
- [x] CB9: Friendly fire (friendlyDamageAmount percentage)
- [x] CB10: Hit slowdown (amount and duration per unit)
- [x] CB11: Suppression (chance, delay, speed multiplier)
- [x] CB12: Linger damage (gas/poison per-tick with warhead multiplier)

## Warhead Table (WH)

- [x] WH1: All declared warheads parsed
- [x] WH2: Complete armor type coverage per warhead
- [x] WH3: Individual multiplier values match raw INI

## Veterancy (VT)

- [x] VT1: Score thresholds per unit
- [x] VT2: ExtraDamage, ExtraArmour, ExtraRange per level
- [x] VT3: Health upgrades at vet levels
- [x] VT4: Elite flag and CanSelfRepair at correct levels

## Production Pipeline (PR)

- [x] PR1: Difficulty cost multipliers (Easy/Normal/Hard)
- [x] PR2: Difficulty time multipliers
- [x] PR3: AI inverse difficulty scaling
- [x] PR4: Factory speed bonus formula (1.0/1.5/1.75/2.0...)
- [x] PR5: Power multiplier effect on build speed
- [x] PR6: Tech level from owned buildings
- [x] PR7: Primary building prerequisites with alts (OR logic)
- [x] PR8: Secondary building prerequisites (AND logic)
- [x] PR9: Queue limit = 5
- [x] PR10: Upgrade cost from rules.txt
- [x] PR11: Upgrade time = buildTime * 0.5
- [x] PR12: Starport pricing variation (±40%)
- [x] PR13: Starport delivery timing and stock

## Movement (MV)

- [x] MV1: Speed from rules.txt
- [x] MV2: TurnRate interpretation
- [x] MV3: Derived acceleration categories (aircraft/infantry/heavy/medium/light)
- [x] MV4: Braking distance formula: v²/(2×decel)
- [x] MV5: Stuck detection: 30 ticks, <0.05 threshold
- [x] MV6: Flight altitude = 5.0

## Harvest Economy (HV)

- [x] HV1: SpiceValue = 200 per unit
- [x] HV2: Per-harvester spiceCapacity (default 700)
- [x] HV3: Per-harvester unloadRate (default 2)
- [x] HV4: HarvReplacementDelay = 1000
- [x] HV5: Cash fallback amounts [10k, 20k]
- [x] HV6: Cash fallback frequency [4000, 8000] ticks

## Spice Mound (SM)

- [x] SM1: Mound duration (Size + Cost randomness)
- [x] SM2: Bloom radius, health, capacity, appear delay
- [x] SM3: Regrow cooldown [MinRange, MaxRange]
- [x] SM4: Derived bloom damage = health; damage radius = bloom radius × TILE_SIZE

## Storm/Worm (WM)

- [x] WM1: Storm timing (min/max wait and lifetime)
- [x] WM2: StormKillChance = 127
- [x] WM3: Worm spawn/lifetime/disappear constants
- [x] WM4: WormAttractionRadius and per-unit attraction
- [x] WM5: Thumper/wormride durations

## Superweapon (SW)

- [x] SW1: HawkStrike, Lightning, Deviate durations
- [x] SW2: Superweapon unit→bullet→warhead chains
- [x] SW3: Blast radius conversion (game units → world space)
- [x] SW4: Palace prerequisite for superweapon units

## Building Details (BL)

- [x] BL1: PowerGenerated per faction
- [x] BL2: PowerUsed per building
- [x] BL3: UpgradeCost and UpgradeTechLevel
- [x] BL4: DeployTile coordinate arrays
- [x] BL5: Occupy footprint grids
- [x] BL6: Building Group field (icon deduplication)

---

## Not Yet Tested (Future Work)

- [ ] Terrain movement speed modifiers (sand vs rock vs dunes)
- [ ] Pathfinding accuracy vs original
- [ ] AI behavior patterns (build order, attack timing)
- [ ] Sound/music trigger accuracy
- [ ] Animation frame timing
- [ ] Network/multiplayer sync
- [ ] Map (.dme) format fidelity
- [ ] Fog of war reveal/shroud timing
