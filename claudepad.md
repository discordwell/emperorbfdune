# Claudepad - Emperor: Battle for Dune Project

## Session Summaries

### 2026-03-19T21:00UTC - Campaign Navigation: Root Cause Found + Path Forward
- **Root cause confirmed**: `selectScreenEntry("Campaign")` crashes because the Campaign mode handler (0x4E52B0/0x4E5320) dereferences `[0x808CDC]` (campaign state pointer) which is NULL on the title screen. The campaign state object is only created when entering campaign mode through the game's normal UI flow.
- **Proof**: `selectScreenEntry("Options")` works perfectly — game stays alive, `so=185`. Campaign is the ONLY entry that crashes.
- **Inline Bink patching works**: pokevp overwrites Bink DLL functions at their original addresses (0x1000xxxx range, already executable .text pages). VirtualProtect marks pages dirty → won't be evicted. No IAT patching or GDB needed for Bink.
- **Fake campaign state**: Tried allocating zeroed memory at 0x81A000, setting vtable=0x5C6718, difficulty, house index. Still crashes — the object needs deeply nested sub-objects properly initialized via C++ constructors.
- **Disassembly findings** (via sub-agent, full RE of mode handlers):
  - Game modes registered at 0x4E4E10: Load, Single, MPlayer, Skirmish, EasyCampaign, NormalCampaign, HardCampaign, Campaign, Internet, MainTutorial, Lan, Back, Options, Exit
  - Single handler (0x4E5090): `findScreen("MainMenuManager")`, sets `[obj+0xF4]=1` (gameMode=Single)
  - NormalCampaign handler (0x4E5320): reads `[0x808CDC]`, sets `[state+0xD38]=0x5C7FD0` (Normal difficulty), calls `openScreen("House", 1)`
  - Campaign state object layout: vtable at +0, house at +0x52C, difficulty at +0xD38, player objects at +0xC98, mission data at +0xCB8
  - Screen manager singleton at 0x809830 (different from TCP hook's 0x818718 screen stack)
  - openScreen at 0x4D8580, findScreen at 0x4D8440
  - No command-line args or IPC payload can bypass title screen — game always starts at title menu
- **Saved snapshots**: `title-clean-v2` (fresh game on title screen, new DLL, clean state), `desktop-new-dll` (desktop with DLL deployed, no game)
- **Next step**: Binary-patch GAME.EXE to add a NULL check before `[0x808CDC]` dereference in Campaign/NormalCampaign handlers, OR patch to call the Campaign state constructor before the handler runs

### 2026-03-19T12:00UTC - DInput Hook v2: Full Navigation Testing + Key Discoveries
- **Built & deployed new DInput hook** to QEMU VM via floppy image (game dir: `C:\Users\User\Emperor\`)
- **Snapshots**: `desktop-new-dll` (desktop + new hook DLL), `title-new-hook` (title screen + new hook running)
- **GDB direct shellcode works**: `title-to-campaign-inject.ts` — enters game context, writes Bink stubs via GDB (bypasses page permissions), calls prepScreen+openScreen+commitScreen → DEADBEEF+CAFEBABE confirmed
- **BUT**: Campaign map renders as static frame only. The shellcode's GetMessage loop replaces the game's real rendering loop → DInput polling stops, game frozen. Campaign-v45 has the same issue — it was never truly interactive.
- **Key discoveries**:
  - `pokevp` stubs crash (0xC0000005) because .data section pages are non-executable. GDB writes bypass this. Even with DEP=AlwaysOff, page-level NX is still set.
  - `selectFn(1)` from title screen enters a BLOCKING event loop (house-select screen's main loop). It doesn't return → HW breakpoint on crash handler never fires.
  - Interrupt after selectFn(1) lands in kernel mode. Single-stepping through kernel requires 50+ steps and still doesn't reach user mode. **Fix needed**: set breakpoint at PeekMessageA or similar frequently-called game function.
  - For interactive campaign: game MUST go through normal exit→relaunch flow (launcher re-launches GAME.EXE with campaign params). The shellcode shortcut only produces a static frame.
- **Path forward for interactive campaign**:
  1. **Option A**: Figure out the launcher's IPC protocol (0xBEEF message + shared memory) to launch GAME.EXE directly in campaign mode
  2. **Option B**: After selectFn(1) interrupt, use breakpoint at a game-loop function (e.g., hooked PeekMessageA) to re-enter game context, then call selectFn(3). Let the crash proceed normally → game exits → launcher relaunches in campaign mode → new DLL hooks the new process
  3. **Option C**: Wine backend (macOS) — game runs with macOS focus, DInput hook intercepts input. Wine doesn't need the relaunch workaround since it runs in a virtual desktop. But requires solving the macOS foreground focus requirement.

### 2026-03-19T09:00UTC - DInput Hook v2 Build + QEMU Deployment + Navigation Testing
- **Built updated DInput hook** (842 new lines): both QEMU (`dinput.dll`, TCP_HOST=10.0.2.2) and Wine (`dinput-wine.dll`, TCP_HOST=127.0.0.1) variants
- **New hook features tested**: `pokevp`, `forceclick`, `moveclick`, `timerscreen`, `timernav`, `houseselect`, `selectidx`, `gaslog`, PeekMessageA hook
- **Deployed new DLL to QEMU VM**: cold-booted Win7, copied via floppy image (mtools + QMP `change floppy0`), game dir is `C:\Users\User\Emperor\`
- **Saved snapshots**: `desktop-new-dll` (desktop with new DLL), `title-new-hook` (title screen, game running with new hook)
- **TCP hook confirmed working**: Hook polls 10.0.2.2:18890, all new commands respond correctly
- **Key findings**:
  - `wmkey 27` (Escape) successfully skips intro videos — confirmed WM_KEYDOWN delivery works
  - `screenentrysync Campaign` finds the correct screen entry but game crashes (0xC0000005) during transition
  - **Root cause**: Bink video stubs written via `pokevp` are on non-executable pages (PAGE_READWRITE .data section); game crashes executing them. GDB writes bypass page permissions — that's why GDB injection works but TCP doesn't
  - `forceclick` successfully moves cursor + forces GetAsyncKeyState/GetCursorPos but title menu ignores it (gas=3 total calls, not polled during menu)
  - `moveclick` pure DInput injection completes (state=7=COMPLETE) but menu still ignores clicks
  - PeekMessageA saw 8 mouse button events from forceclick but menu doesn't use PeekMessage for button detection
  - QMP keyboard (Down/Enter/Space) doesn't navigate title menu items
  - Title menu buttons resist ALL synthetic input methods — DInput, Win32 API, QMP keyboard, QMP mouse
- **GDB injection from title screen**: Created `title-to-campaign-inject.ts` — gets to game context, writes stubs, calls selectFn(1) for Campaign entry. HW breakpoint on crash handler fires but GDB register read fails. **Needs fix**: 2-step navigation (selectFn(1)→Campaign, then selectFn(3)→Atreides) and proper GDB error handling
- **Architecture conclusion**: GDB injection required for menu navigation (title→house-select→campaign). TCP hook handles in-game control (clicks, keys, observation)

### 2026-03-18T04:07UTC - GdbClient Module Extraction + readDword Null Safety
- Extracted `GdbClient` class from `house-select-inject.ts` into standalone `tools/visual-oracle/qemu/GdbClient.ts`
- `readDword` now returns `number | null` (was `number` returning -1 on error)
- All callers in `house-select-inject.ts` updated: `readDwordOrThrow()` helper for critical reads, null checks for loop iterations
- Made `QemuController.qmpCommand` public for external script access
- 19 new unit tests for GdbClient (mock TCP socket), all passing
- 77 total visual-oracle tests passing (5 files)

### 2026-03-17T10:00UTC - QEMU GDB Injection: House Select → Campaign Map WORKING
- **BREAKTHROUGH**: Navigated Emperor past house-select screen to campaign map in QEMU VM using GDB stub injection
- Technique: selectFn (vtable[0x3C] entry=3) → HW breakpoint on crash handler (0x5b44fc) → redirect EIP to campaign shellcode
- v42/v43 failures: "process dead" was (a) reading breadcrumbs from wrong process context (QEMU GDB uses virtual addresses via current page table), (b) `mov esp, 0x16F000` in uncommitted stack guard pages causing nested exception
- v44 FIX: SW breakpoint at shellcode guarantees game context; single-step confirms breadcrumbs DEADBEEF+CAFEBABE
- v45 FIX: `sub esp, 0x200` from crash handler's ESP (committed stack region); full shellcode (prepScreen → openScreen → commitScreen → flushScreenQueue) completes successfully
- Campaign map renders: golden elliptical planet view with territory boundaries visible in QMP screendump
- Snapshot `campaign-v45` saved — Atreides selected, campaign map screen active
- Key insight: Crash handler at 0x5b44fc is game code — no process filtering needed (unlike ExitProcess at 0x75a5214f which fires for all processes)
- Key insight: QEMU GDB IAT patches get evicted (dirty bit bypass) — only HW breakpoints + code-address BPs survive
- Reference script: `/tmp/qemu-gdb-callfn45.ts`

### 2026-03-11T13:50UTC - Parser Bug Fixes: Case Sensitivity, ViewRange, Armour
- **CRITICAL FIX**: 4 bullet types (Cal50_B→[cal50_B], Mortar_B→[MORTAR_B], KobraHowitzer_B→[KOBRAHOWITZER_B], Howitzer_B→[HOWITZER_B]) had case-mismatched section headers. Parser now uses case-insensitive fallback via `getSection()` helper.
  - Sniper was doing 100 dmg instead of 600, Mortar doing 100 instead of 375, Kobra deployed doing 100 instead of 600
- **ViewRange fix**: Extended values parsed — "4,8,InfRock" now captures viewRangeExtended=8, viewRangeExtendedTerrain=InfRock (40+ units affected)
- **Armour fix**: Terrain bonus parsed — "None, 50, InfRock" now captures armourTerrainBonus=50, armourTerrainType=InfRock (36+ infantry affected)
- Added 4 new UnitDef fields: viewRangeExtended, viewRangeExtendedTerrain, armourTerrainBonus, armourTerrainType
- Source truth: 13,389 fields (up from 12,785), 0 mismatches
- All 772 tests pass (6 new regression tests)

### 2026-03-11T12:30UTC - Parity Verification System Implementation
- Implemented 3-layer parity verification system (Zachathon pattern)
- **Layer 1**: Source truth audit — independent raw INI parser + RulesParser cross-check → 12,785 fields, 0 mismatches
- **Layer 2**: 11 new behavioral test files (345 total tests) covering GN/CB/WH/VT/PR/MV/HV/SM/WM/SW/BL codes
- **Layer 3**: Documentation (PARITY_WORKFLOW.md, MISSING_FEATURES.md)
- New files: `scripts/parity/rawIniParser.ts`, `scripts/parity/sourceTruth.ts`, `scripts/report-source-parity.ts`
- Package.json: `parity:source`, `parity:source:strict`, `parity:tests` scripts added
- Key findings during testing:
  - ThumperDuration not in rules.txt (uses default 500)
  - GUMaker has wormAttraction=-20 (repels worms)
  - AntiPersonnel and Flare_W warheads declared but have no section definitions
  - DeathHandSplat_B has damageFriendly=true but friendlyDamageAmount=0
- All 766 tests pass across 55 files, zero regressions

### 2026-03-10T06:30UTC - QEMU VNC Display + Click Input Investigation
- **CRITICAL**: `-display none` breaks ALL input to VM. Must use `-vnc :0` for QMP input events to reach guest
- Updated QemuController.ts: `-vnc :0`, network port forwarding, mouseClick uses HMP `mouse_button` instead of `input-send-event btn`
- Updated qemu-config.ts: added `vncDisplay` and `portForwards` config
- All 14 QemuController unit tests passing
- **UNSOLVED**: Game title screen menu buttons resist ALL click methods:
  - input-send-event btn (tablet) — NO
  - HMP mouse_button (PS/2) — NO (but DID advance title intro animation once)
  - VNC client click (vncdo) — NO
  - PostMessage WM_LBUTTONDOWN — NO
  - SendInput from within VM (siclick.exe) — NO
  - mouse_event absolute — NO
  - SendMessage WM_LBUTTONDOWN — NO
  - DInput hook TCP buffer injection — command served but click didn't register
  - QMP send-key keyboard — NO
- **Cursor hover DOES work** via usb-tablet absolute positioning (proven by menu highlight effects)
- Game window: `proc=Game.exe cls=DuneIII title='Dune'`
- Deployed tools in VM: siclick.exe (SetCursorPos + SendInput + window activation), wmclick HTTP endpoint
- VM snapshot `vnc-with-tools` saved with all tools + game running on title screen
- **Next steps**: (1) Try hooking GetAsyncKeyState in DInput hook DLL, (2) Try game CLI args to skip menu, (3) Inject WndProc call from within DInput hook, (4) Use debugger to find menu click handler

### 2026-03-08T01:05UTC - QEMU VM Game Running: WineD3D + resource.cfg Fix
- **ROOT CAUSE FOUND**: Game crash at 0x0052A58C was NOT DirectDraw — it was RULES.TXT not found
- `resource.cfg` had wrong paths: all mapped to `data` instead of `data\model`, `data\3ddata`, etc.
- Correct `resource.cfg` at `gamedata/resource.cfg` (506 bytes) uses subdirectory paths
- WineD3D + Mesa llvmpipe software rendering WORKS: DDraw.dll(592K) → wined3d.dll → opengl32.dll → libgallium_wgl.dll
- dgVoodoo2 does NOT work on Win7 SP1 (needs Platform Update KB2670838 for D3D 11.1)
- Game reaches title screen, fully interactive (v1.09 confirmed in-game)
- VM snapshot saved as `game-ready` for instant restore
- Disassembled GAME.EXE v1.09 (2,510,848 bytes) crash site: game prints error but doesn't bail out → NULL dereference
- Created `/tmp/qmp-type.py` helper for typing text into VM via QMP
- Key VM facts: AutoPlay still triggers despite registry, ISO batch files need 8.3 filenames

### 2026-03-04T18:40UTC - QEMU + QMP Backend for Reference Game
- Added mouse input (mouseMove, mouseClick) and snapshot loading (loadSnapshot) to QemuController
- mouseMove/mouseClick use QMP `input-send-event` with `usb-tablet` absolute positioning (0-32767 range)
- loadSnapshot uses `human-monitor-command` (loadvm is HMP, not native QMP)
- Created QemuAdapter implementing GameAdapter: observe via screendump + VisionExtractor, act via QMP mouse/keyboard
- Extracted shared sidebar constants (SIDEBAR, BUILDING_ORDER, INFANTRY_ORDER, VEHICLE_ORDER) to SidebarLayout.ts
- Added `--backend=qemu` to oracle-cli.ts with lazy import pattern
- 9 unit tests for QemuController (mock QMP socket), all passing
- Integration test: test-qemu-nav.ts (boot VM → capture → click → verify screen change)
- Code review fixed 2 critical bugs: wrong QMP InputButton values (mouse-left → left), loadvm not a QMP command
- All 488 tests pass across 43 files

### 2026-02-26T16:50UTC - Wine Backend: D3D Screenshot Capture WORKING End-to-End
- Wine D3D rendering via MoltenVK/Metal is INVISIBLE to all per-window capture APIs
- Solution: `capture-window.swift` using `SCContentFilter(display:excludingApplications:)` + brief activation
  - `including:` filter fails with -3811 for Wine (empty bundle ID)
  - `excluding:` with all non-Wine apps removed + `sourceRect` crop to window bounds works
  - Brief NSRunningApplication activation needed for D3D to render to capture buffer
  - Tool restores previously-focused app after capture
- Fixed: `findWineWindow` must match "Dune" name + "wine" owner exactly (no fallback — launcher.exe matched otherwise)
- Wine stderr filtered to suppress MoltenVK/Vulkan extension spam (~200 lines per launch)
- Full CLI pipeline tested: `npx tsx tools/visual-oracle/cli.ts --backend=wine --scenario title-screen --capture-only --skip-remake` — captures 2 screenshots of original title screen (821KB + 856KB, rich game content)
- CRITICAL: capture-window binary requires Screen Recording permission. NEVER use `tccutil reset ScreenCapture`

### 2026-02-22T09:30UTC - Agent Telemetry Harness + Critical Agent Fixes
- Fixed agent building placement: player 0 buildings were entering interactive placement (waiting for mouse clicks). Added `ctx.agentAI` to GameContext, agent buildings now auto-place via `getNextBuildingPlacement()` spiral search
- Fixed missing terrain names in BuildingPlacement: NBRock, InfRock, Ramp, DustBowl now mapped to correct TerrainType enums
- Fixed Chrome background tab issue: `requestAnimationFrame` completely paused for hidden tabs. Added `Game.setHeadless(true)` using `setInterval` instead, runs at ~5 tps throttled
- Built telemetry harness: `AgentTelemetry.ts` (console capture + game state POST), `telemetry-server.mjs` (HTTP server on :8081), `agent-ctl.sh` (CLI control)
- Document title updated with machine-readable game state (readable via AppleScript)
- Agent successfully running: 23 units, 6 buildings, $4681 at tick 1779. Enemy: 19u/7b/$113
- CPF terrain analysis: T19 has 0.7% Rock, 37% Cliff, 56% Sand — matches original game's small rock platforms

### 2026-02-22T19:00UTC - Game Capture Assessment, Binary Validation Tool, Build Verification
- Created `tools/validate_game_exe.py`: reads GAME.EXE function table at 0x1FE0B0, validates 181/181 entries match (162 functions + 19 keywords), extracts argument count + flags metadata per function
- Metadata reveals 4 flag categories: query (46 funcs), action (94), returns_pos (18), returns_obj (4)
- Created `tools/serve.sh`: build + serve script for playtesting (esbuild production build + python http.server)
- Verified: 271 tests pass, tsc --noEmit clean, production build succeeds (1.1MB bundle)
- Deferred runtime game capture via Wine (static validation + oracle tests sufficient)
- Sub-agent audits: rendering pipeline 95% complete, codebase overall 7.5/10 maturity

### 2026-02-20T19:00UTC - Phase 0+1+2: Testing, Walls, Stealth, Visual Polish
- Phase 0 complete: 140 tests (MathUtils, SpatialGrid, Constants, GameHelpers, RulesParser, ArtIniParser, ProductionSystem, PathfindingSystem), CI pipeline
- Phase 1A: WallSystem.ts created, BuildingPlacement wall drag-to-build mode, EventHandlers wires wall production to startWallPlacement with per-tile cost
- Phase 1B+1D: Already implemented (concrete grid overlay, rally point flag+line)
- Phase 1C: Stealth shimmer (oscillating opacity for friendly stealthed units) + decloak flash effect
- Phase 2: Solaris smooth ticker animation, power bar dual gen/consumption bars, building collapse animation, unit shadow circles, sandstorm fog density increase
- GameContext now includes wallSystem, GameTickHandler updates wall tiles every 10 ticks
- All 140 tests pass, typecheck clean, build succeeds

### 2026-02-21T10:00UTC - 8 Remaining Audit Fixes: DialogManager, Production, Save/Load, ID Recycling
- Fix: DialogManager baseUnderAttack fires for enemy-vs-enemy combat (added ownerChecker param)
- Fix: ProductionSystem repeat-mode population cap off-by-one (just-completed unit not counted)
- Fix: DisplayNames lookup order (check full name before stripping faction prefix)
- Fix: SandwormSystem entity ID recycling (store huntingOwner + riderOwner at assignment, verify on tick)
- Fix: SelectionManager control group recall verifies Owner.playerId (entity ID recycling guard)
- Fix: AbilitySystem save/load for deviated units, leech targets, kobra deploy state
- Fix: index.ts wires ability state to SaveData interface and restore path
- SuperweaponSystem AI targeting confirmed correct (audit was wrong, filter logic is fine)
- Full project review in progress
- Awaiting code review + commit

### 2026-02-21T08:00UTC - 8+ Bug Fixes: SelectionPanel, BuildingPlacement, MinimapRenderer
- Fix: SelectionPanel DPS formula showed shots/sec not damage/sec (missing bullet damage lookup)
- Fix: SelectionPanel hardcoded player ID 0 for upgrade queries (now uses Owner.playerId[eid])
- Fix: SelectionPanel missing dispose() (EventBus listeners + DOM element leaked)
- Fix: BuildingPlacement concreteMode not reset in startPlacement (building placement silently failed after concrete mode)
- Fix: BuildingPlacement Escape key in concrete mode triggered incorrect refund event (now matches right-click behavior)
- Fix: BuildingPlacement shared THREE.Color reference assignment (.color = ref instead of .color.copy())
- Fix: BuildingPlacement cancel() didn't reset concreteMode/onConcrete flags
- Fix: MinimapRenderer dead code removed (unused double-click detection fields)
- Also from previous session: SelectionManager dispose() + text input guard, CommandManager unregisterEntity + dispose + text input guard
- Full audit of all 59 .ts files in progress via 4 parallel sub-agents
- Awaiting code review + commit

### 2026-02-21T06:00UTC - 4 Bug Fixes: AI Save/Load, Entity Tracking, Ghost Spawns
- Fix: AI placedBuildings empty after save/load — reconstructFromWorldState now rebuilds from ECS data with ConYard-anchored base
- Fix: Ghost harvester spawning when Refinery destroyed during construction (deferred action lacked health check)
- Fix: descendingUnits + repairingBuildings not cleaned on entity death (entity ID recycling risk)
- Fix: repairingBuildings not cleaned on building sell
- Cross-system audit completed: entity lifecycle, save/load round-trips, Map/Set cleanup patterns all verified
- Commit: bb1171e

### 2026-02-20T22:00UTC - 2 Bug Fixes + Full Codebase Audit Complete
- Fix: killPassengers mutation-during-iteration (delete map entry BEFORE iterating, prevents ghost entities)
- Fix: buildSaveData `world` vs `w` variable inconsistency (Shield component check used wrong scope)
- Full audit of ALL 57 .ts files complete — no further bugs found
- Commit: 1e6a2a8

### 2026-02-20T12:00UTC - 8 Bug Fixes: CombatSystem, EventBus, AI Player
- Fix: CombatSystem death check before slowdown/suppression (prevents stale state on entity ID recycling)
- Fix: EventBus try/catch + snapshot listeners (one exception no longer blocks other listeners)
- Fix: AI base position anchored to ConYard (was center-of-mass drift from expansion buildings)
- Fix: AI difficulty formula inverted (was multiplying by difficulty making AI less aggressive at higher levels)
- Fix: Power multiplier clamped to 0.1 minimum (was division-by-zero -> Infinity fire timer)
- Fix: Escort follow logic overrides current move when target moves away (was only following when idle)
- Fix: Defenders excluded from idle rally (was pulling defenders away from base)
- Fix: Blast damage skips unowned entities (was treating neutral entities as player 0 friendlies)

### 2026-02-20T11:00UTC - 9 Bug Fixes: Worm Spawns, Rendering, Dispose, Fog
- Fix: Worm spawn chance scaled by 100-tick check interval (was 100x too rare, worms never spawned)
- Fix: eatUnit guards against already-dead units (prevents double death events)
- Fix: Sand particles wrap in both directions (was one-way, particles vanished when panning)
- Fix: Sand particles removed from scene on dispose (was leaking in scene graph)
- Fix: Team color tinting uses pre-cloned materials from ModelManager (was double-cloning)
- Fix: Null guard on currentWorld in shield visuals
- Fix: Sidebar dispose() cleans up keyboard listener
- Fix: MinimapRenderer dispose() cleans up event listeners
- Fix: Fog array bounds check treats OOB tiles as unexplored (was rendering as visible)
- Commit: 46af2cd

### 2026-02-20T10:00UTC - 6 Bug Fixes: Leech, Ordos Heal, Campaign, Audio
- Fix: Leech double-spawn on target kill (handleUnitDeath already spawns, updateLeech was spawning again)
- Fix: Ordos units double healing (faction bonus + canSelfRepair both healing 1%/2s → now skips canSelfRepair units in faction bonus)
- Fix: Phase 3 victory-without-capture missing lose check (only warning was checked, lose threshold ignored)
- Fix: Orphaned HTMLAudioElement during rapid crossfade (previous fading element never paused)
- Fix: Crossfade volume pop on unmute (fadingOutElement jumped to full volume mid-fade)
- Fix: Ambient wind on unmute before game (windEverStarted flag prevents premature wind start)

### 2026-02-20T20:00UTC - 28 Bug Fixes in 5 Commits: Entity ID Recycling, Combat, AI, UI
- Commits: 0954376, b1d774a, a4e2b4f, 09ffc64, 782784e
- Major theme: Entity ID recycling guards across all systems (bitECS reuses IDs)
- CombatSystem: death check before slowdown, power clamp, escort follow, blast ownership
- EventBus: try/catch + snapshot listeners prevent exception propagation
- AIPlayer: ConYard-anchored base, inverted difficulty fix, defender rally skip
- HarvestSystem: bloom damage constant fix (200), refinery ID validation
- MovementSystem: comprehensive unregisterEntity() cleanup
- ProductionSystem: queue progress clamp
- FogOfWar: reinitialize tickCounter match
- SelectionPanel: dead entity removal, sell timer clear
- InputManager: dispose(), consumeKey(), named handlers
- EffectsManager: worm visual position init
- SandwormSystem: hunting target hasComponent guard
- UnitRenderer: move interrupts fire anim, clearDyingObjects()
- Sidebar: Starport tab reset on expiry
- Constants: SPICE_BLOOM_DAMAGE updated 10->200
- spawnUnit/spawnBuilding: zero stale AttackTarget/Velocity/Combat fields



## Key Findings

### Game Engine
- EBFD uses Intelligent Games' **Xanadu engine** (not W3D as sometimes claimed)
- W3D was Westwood's separate engine that later became SAGE for C&C Generals
- XBF is the Xanadu engine's 3D model format
- Game was the first Westwood-branded RTS to use full 3D
- Direct3D 7, 4:3 aspect ratios only

### File Formats

#### Archive Formats: RFH/RFD (NOT .big)
EBFD does NOT use the .big archive format. It uses its own **RFH/RFD** paired archive system plus **BAG** files.

**RFH (Resource File Header) Structure:**
- Sequential records, each 24 bytes + variable filename length
- Offset 0-4: Filename string length (uint32)
- Offset 4-8: File date (uint32)
- Offset 8-12: Compressed flag (uint32)
- Offset 12-16: Compressed file size (uint32)
- Offset 16-20: Uncompressed file size (uint32)
- Offset 20-24: Start offset in corresponding .rfd data file (uint32)
- Offset 24+: Zero-terminated filename string

**RFD (Resource File Data) Structure:**
- Sequential data records as defined in the paired .rfh file
- If compressed, 6-byte header precedes data:
  - Offset 0-4: Uncompressed file size (uint32)
  - Offset 4-6: Magic number 0x78DA (zlib deflate marker)
- Compression: Deflate (same as zip - Huffman coding + LZ77)

**BAG Files:**
- Archive/container format for audio (music, dialog)
- Extractable but re-compression not yet supported by community tools

#### 3D Model Format: XBF
- Xanadu engine native 3D format
- 1521 XBF files in the game total
- Scene hierarchy with named objects
- 4x4 transformation matrices (column-major, 16 floats)
- Vertex geometry + normals
- Vertex animation with frame ranges (e.g., "Stationary: 104-133", "Idle", "Fire")
- Python library: xanlib (https://github.com/Lunaji/xanlib)
- Blender export supported via xanlib

#### Texture Format: TGA
- Standard TGA format for textures
- Referenced by XBF model files

#### Video Format: BIK (Bink Video)
- Cutscenes stored as .BIK files
- Located in DATA/MOVIES folder

#### Unit/Game Balance: rules.txt + artini.txt
- Text-based INI-style configuration files
- Must be placed in: `Westwood/Emperor/DATA/model/` (create "model" folder)
- Generated by TibEd tool, then hand-editable
- Controls: unit stats, costs, build times, movement speeds, turn rates, HP, damage, fire rates, attack ranges, harvester capacity, building properties
- Header text must match original for changes to register
- Multiplayer requires all players have matching rules.txt or "Out of Synch" error occurs

#### Map Format
- .dme extension for map files
- Official Map Editor released with patch v1.09 (beta, unsupported)
- Map format parsing: UNIMPLEMENTED in reverse engineering efforts
- Mission format: Also UNIMPLEMENTED

### Data Directory Structure (from resource.cfg)
```
MODEL_DATA    -> data/model/      (rules.txt, artini.txt, unit definitions)
AI_DATA       -> data/ai/         (AI behavior)
UIDATA        -> data/ui/         (user interface)
AUDIO         -> data/audio/      (sound effects)
3DDATA        -> data/3ddata/     (XBF models, TGA textures)
MAPS          -> data/maps/       (map files)
CAMPAIGN_DATA -> data/campaign/   (campaign definitions)
MISSION_DATA  -> data/missions/   (mission scripts)
SOUNDS        -> data/sounds/     (additional sound data)
STRINGS       -> data/strings/    (localization text)
SAVED_GAMES   -> data/saves/      (save game files)
```

CD disc data files:
- DIALOG.BAG - voice dialog audio
- MUSIC.BAG - music audio
- MOVIES0001.RFD/.RFH - cutscene video archives

### Modding Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| **DuneEx** | View/extract/edit RFH/RFD/BAG archives | Primary extraction tool by Scorpio9a |
| **BagTool v0.3** | Custom BAG files for music/dialog | Can combine CD + HDD BAG files |
| **TibEd v1.53** | Generate rules.txt and artini.txt | Only tool that generates these files |
| **Dune Visual Mod Creator v1.12** | Edit unit/structure settings | Includes source code |
| **Emperor Ini Editor v0.6** | Edit rules.txt directly | Unit costs, build times |
| **Official Map Editor** | Create maps | Beta, unsupported, requires patch v1.09 |
| **Map Packer** | Pack/install custom maps | Required for sharing maps |
| **Dragon UnPACKer** | Extract BAG files | Third-party general archive tool |
| **xanlib (Python)** | Parse XBF 3D models | Export to Blender, handles all 1521 XBF files |
| **ebfd-re (GitHub)** | Format reverse engineering | IceReaper's project, C# |

### Unit Stats - All Three Houses

#### ATREIDES
**Infantry:**
| Unit | Cost | Prerequisites | Role |
|------|------|---------------|------|
| Scout | $30 | None | Unarmed recon, stealthed suit |
| Light Infantry | $60 | None | Assault rifle, anti-infantry |
| Sniper | $150 | None | Long-range anti-infantry |
| Kindjal Infantry | $150 | Upgraded Barracks | Pistol/deployed mortar |
| Engineer | $400 | Upgraded Barracks | Capture buildings, repair |

**Vehicles:**
| Unit | Cost | Prerequisites | Role |
|------|------|---------------|------|
| Sand Bike | $300 | None | Fast scout, anti-infantry |
| Mongoose | $800 | None | Bipedal mech, anti-armor |
| Harvester | $1000 | Refinery | Spice collection |
| APC | $600 | Upgraded Factory | Troop transport, stealthed when stationary |
| Repair Vehicle | $650 | Upgraded Factory | Repairs vehicles |
| Minotaurus | $1300 | Upgraded Factory | Artillery mech, anti-infantry/structure |
| Sonic Tank | $1400 | Starport | Sonic waves, friendly fire risk |
| MCV | $2000 | None | Deploys to Construction Yard |

**Aircraft:**
| Unit | Cost | Prerequisites | Role |
|------|------|---------------|------|
| Air Drone | $800 | None | Air-to-air |
| Ornithopter | $1000 | Upgraded Hangar | Missile strikes, needs rearming |
| Carryall | $1100 | None | Harvester transport |
| Advanced Carryall | $1800 | Upgraded Hangar | Any vehicle transport |

**Superweapon:** Hawk Strike (via Palace)

#### HARKONNEN
**Infantry:**
| Unit | Cost | Prerequisites | Role |
|------|------|---------------|------|
| Scout | $30 | None | Unarmed recon, stealthed |
| Light Infantry | $50 | None | Assault rifle |
| Trooper | $90 | None | Anti-vehicle, ranged |
| Flamethrower Infantry | $150 | Upgraded Barracks | Area denial, flame |
| Engineer | $400 | Upgraded Barracks | Capture/repair |

**Vehicles:**
| Unit | Cost | Prerequisites | Role |
|------|------|---------------|------|
| Buzzsaw | $350 | None | Fast scout, blade + cannons |
| Assault Tank | $900 | None | Standard anti-armor |
| Harvester | $1000 | Refinery | Spice collection |
| Flame Tank | $900 | Upgraded Factory | Dual flamethrowers, multi-target |
| Inkvine Catapult | $1000 | Upgraded Factory | Artillery, toxic residue DoT |
| Missile Tank | $1200 | Upgraded Factory | Anti-vehicle/aircraft |
| Devastator | $1750 | Starport | Heavy: dual plasma + missiles + self-destruct |
| MCV | $2000 | None | Deploys to Construction Yard |

**Aircraft:**
| Unit | Cost | Prerequisites | Role |
|------|------|---------------|------|
| Air Defense Platform | $1500 | None | Air-to-air + ground |
| Gunship | $1000 | Upgraded Hangar | Guided rockets, needs rearming |
| Carryall | $1100 | None | Harvester transport |
| Advanced Carryall | $1800 | Upgraded Hangar | Any vehicle transport |

**Superweapon:** Death Hand Missile (via Palace)

#### ORDOS
**Infantry:**
| Unit | Cost | Prerequisites | Role |
|------|------|---------------|------|
| Scout | $30 | None | Unarmed recon, stealthed |
| Chemical Trooper | $50 | None | Chemical weapon, area denial |
| AA Trooper | $100 | None | Anti-aircraft |
| Mortar Infantry | $100 | Upgraded Barracks | Deployed mortar, anti-vehicle |
| Saboteur | $150 | Upgraded Barracks | Suicide building destroyer |
| Engineer | $400 | Upgraded Barracks | Capture/repair |

**Vehicles:**
| Unit | Cost | Prerequisites | Role |
|------|------|---------------|------|
| Dust Scout | $350 | None | Fast, can burrow for stealth |
| Laser Tank | $700 | None | Anti-armor hovercraft, laser reflects off shields |
| APC | $900 | Upgraded Factory | Missile-armed transport, shielded |
| Harvester | $1000 | Refinery | Spice collection |
| Kobra | $1200 | Upgraded Factory | Artillery, mobile fire, deployed extends range |
| Deviator | $950 | Starport | Converts enemy vehicles via missiles |
| MCV | $2000 | None | Deploys to Construction Yard |

**Aircraft:**
| Unit | Cost | Prerequisites | Role |
|------|------|---------------|------|
| AA Mine | $600 | None | Airborne ram mine |
| Carryall | $1100 | None | Harvester transport |
| Advanced Carryall | $1800 | Upgraded Hangar | Any vehicle transport |
| Eye In The Sky | $2000 | Upgraded Hangar | Drops Saboteur on target |

**Superweapon:** Chaos Lightning (via Palace)

### Sub-House Units

#### FREMEN
| Unit/Building | Cost | Prerequisites | Notes |
|---------------|------|---------------|-------|
| Fremen Camp | $600 / $1000 upgrade | Barracks | 0 power, trains Fremen |
| Fremen Warrior | $150 | Fremen Camp | Anti-infantry, stealthed, doesn't attract worms |
| Fremen Fedaykin | $250 | Upgraded Camp | Sonic beam weapon, can ride sandworms with Thumper Infantry |

#### SARDAUKAR
| Unit/Building | Cost | Prerequisites | Notes |
|---------------|------|---------------|-------|
| Sardaukar Barracks | $700 / $1000 upgrade | Barracks | -30 power, dark terrain only |
| Imperial Sardaukar | $300 | Sardaukar Barracks | Heavy infantry, machine guns, cannot be suppressed |
| Imperial Sardaukar Elite | $1100 | Upgraded Barracks | Rapid laser + melee, very tough |

#### IX
| Unit/Building | Cost | Prerequisites | Notes |
|---------------|------|---------------|-------|
| Ix Research Center | $1000 / $1500 upgrade | Factory | -60 power |
| Infiltrator | $500 | Ix Research Center | Suicide, stealthed, reveals stealthed enemies |
| Projector | $1500 | Upgraded Center | Creates holographic unit copies |

#### TLEILAXU
| Unit/Building | Cost | Prerequisites | Notes |
|---------------|------|---------------|-------|
| Flesh Vat | $1000 / $1500 upgrade | Factory | -60 power, dark terrain only |
| Contaminator | $300 | Flesh Vat | Infects organic units, replicates on kill |
| Leech | $800 | Upgraded Vat | Parasitizes vehicles, drains into new Leeches |

#### SPACING GUILD
| Unit/Building | Cost | Prerequisites | Notes |
|---------------|------|---------------|-------|
| Guild Palace | $2000 / $1600 upgrade | Factory | -180 power, dark terrain only |
| Maker | $1000 | Guild Palace | Heavy infantry, slow, doesn't attract worms |
| NIAB Tank | $2000 | Upgraded Palace | Multi-target electric discharge, can teleport |

**Sub-House Restrictions:** Ix and Tleilaxu are mutually exclusive. Up to 2 sub-houses in skirmish/multiplayer. Guild cannot be allied in campaign (only skirmish).

### Shared Building Tech Tree (All Houses)

| Building | Cost | Upgrade Cost | Power | Prerequisites |
|----------|------|-------------|-------|---------------|
| Construction Yard | $2000 (MCV) | - | 0 | None |
| Wind Trap | $225 | - | +100 | None |
| Wall | $20/tile | - | 0 | None |
| Refinery | $1500 | - | -40 | Wind Trap |
| Refinery Pad | $1200 | - | -20 | Refinery |
| Barracks | $225 | $800 | -20 | Wind Trap |
| Factory | $1000 | $1200 | -40 | Wind Trap |
| Outpost | $400 | - | -60 | Wind Trap |
| Machinegun Post | $550 | - | 0 | Barracks |
| Rocket Turret | $1200 | - | -75 | Barracks |
| Hangar | $1300 | $1200 | -50 | Factory |
| Landing Pad | $800 | - | -30 | Hangar |
| Starport | $1500 | - | -100 | Hangar |
| Palace | $1600 | - | -150 | Starport |

**Tech tree flow:** Wind Trap -> Refinery/Barracks/Factory -> Factory -> Hangar -> Starport -> Palace
**Upgrade unlocks:** Upgraded Barracks = advanced infantry; Upgraded Factory = advanced vehicles; Upgraded Hangar = advanced aircraft

### Veterancy System
- 3 ranks (chevrons), earned via combat kills
- Bonuses to HP/damage/range + special abilities at higher ranks
- Atreides unique: barracks veterans train new troops to next rank
- Harkonnen unique: units stay at full power until destroyed (no damage degradation)
- Ordos unique: units self-regenerate health

### Campaign Structure

#### Territory Map
- Arrakis divided into conquerable territories
- Player chooses which adjacent territory to invade next
- Choice of territory affects mission objectives and alliances
- "Reinforcement" units moved on world map affect in-game battles
- Enemy AI can recapture previously conquered territories
- If you revisit a previously won map, base remnants persist (debris, craters, partial base, explored fog)
- Not every battle needs to be won - can retreat or give up territories
- Losing too many territories = campaign loss

#### Mission Types
- Standard conquest missions
- Territory defense missions (when enemy attacks your territory)
- Capital/homeworld missions (attacking enemy home planets)
- Missions with random events (smuggler bases, neutral structures)
- Maps have unique features: neutral structures, recruitable units, scrap resources

#### Sub-House Alliance System (Campaign)
- 5 sub-houses: Fremen, Sardaukar, Ix, Tleilaxu, Spacing Guild
- Alliances form through campaign territory choices
- Ix and Tleilaxu are mutually exclusive
- Smuggler interactions provide funding bonuses or sabotage penalties
- Atreides campaign: heavily tied to Fremen alliance
- Ordos campaign: manipulation and ghola-based treachery against sub-houses

#### Story Branching
- Each house has unique campaign with distinct narrative
- Harkonnen: Choose between brothers Gunseng and Copec (loser gets tortured)
- All campaigns converge on Emperor Worm endgame
- Final act: Spacing Guild betrays victorious house, strands them on conquered homeworld
- Guild + Tleilaxu engineer Emperor Worm with psychic powers (empowered by Lady Elara)

### Currency
- Solaris (not "credits" though often called that colloquially)

### Asset Extraction Pipeline

#### Step 1: Extract from archives (RFH/RFD/BAG)
- **EbfdExtractor** (C#, .NET 5.0): `dotnet run --project EbfdExtractor -- /path/to/game/DATA`
- **DuneEx** (Windows): GUI tool from dune2k.com/Download/33 (782 KB)
- **BagTool v0.3**: For BAG files specifically (67 KB)
- RFH/RFD: Deflate-compressed, EbfdExtractor auto-decompresses
- BAG: Magic "GABA", version 4, contains audio (MP3/WAV/ADPCM-compressed)

#### Step 2: 3D Models (XBF -> Web)
- `pip install xanlib` (v0.1.0, Python >=3.10)
- Load: `scene = xanlib.load_xbf('path.xbf')`
- Blender import: `blender --python examples/blender_import.py`
- Export from Blender: File > Export > glTF 2.0 (.glb)
- Batch: `blender --background --python batch_script.py`
- Textures referenced in scene.textures list, found in 3DDATA0001/Textures/

#### Step 3: Audio (BAG -> WAV/MP3)
- EbfdExtractor extracts BAG entries with proper WAV headers (including ADPCM decode)
- MP3 tracks extracted as-is (music.bag contains MP3s)
- ADPCM compression: IMA ADPCM 4-bit nibbles, ebfd-re has full decoder in BagEntry.cs
- Uncompressed WAV entries: direct extraction with WAV header
- Convert to OGG: `ffmpeg -i input.wav -c:a libvorbis -q:a 5 output.ogg`

#### Step 4: Textures (TGA -> PNG/WebP)
- TGA files are standard format (some with custom palette handling)
- LibEmperor Tga.cs handles: 8/16/24/32-bit, RLE compression, palettized, flip options
- Magenta (0xFF00FF) = transparency key
- Convert: `convert input.tga output.png` (ImageMagick) or Pillow
- Batch: `for f in *.tga; do convert "$f" "${f%.tga}.png"; done`

### Key Community Resources
- FED2k Forums: https://forum.dune2k.com/ (primary modding community)
- Dune2k.com: https://dune2k.com/ (downloads, editors, mods)
- CNCNZ.com: https://cncnz.com/games/emperor-battle-for-dune/ (unit/structure databases)
- ModDB: https://www.moddb.com/games/emperor-battle-for-dune/ (mods, downloads)
- GameBanana: https://gamebanana.com/games/3946 (mods, tutorials)
- ebfd-re (GitHub): https://github.com/IceReaper/ebfd-re (format reverse engineering, C#)
- xanlib (GitHub): https://github.com/Lunaji/xanlib (XBF Python library)
- pyBIG (GitHub): https://github.com/ClementJ18/pyBIG (BIG file library - for other Westwood games, NOT EBFD)
- ModdingWiki: https://moddingwiki.shikadi.net/wiki/Category:Westwood_Studios_File_Formats (Westwood format docs)
- XentaxWiki: http://wiki.xentax.com/index.php/Emperor_-_Battle_For_Dune_RFH (RFH format spec)
