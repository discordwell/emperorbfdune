/**
 * RemakeAdapter: connects to the TS remake via Playwright.
 * Observes game state via page.evaluate(), issues commands via CommandManager/ProductionSystem APIs.
 */

import { chromium, type Browser, type Page } from 'playwright';
import type { GameAdapter } from './GameAdapter.js';
import type { GameState } from '../state/GameState.js';
import type { Action } from '../actions/Action.js';
import { extractGameState, installEventCollector } from '../state/StateExtractor.js';

export interface RemakeAdapterConfig {
  /** URL of the running game. Default: http://localhost:8080 */
  url?: string;
  /** House to play: 'Atreides' | 'Harkonnen' | 'Ordos'. Default: 'Atreides' */
  house?: string;
  /** Subhouse ally. Default: 'Fremen' */
  subhouse?: string;
  /** Difficulty. Default: 'Easy' */
  difficulty?: 'Easy' | 'Normal' | 'Hard';
  /** Map id for skirmish. Default: 'KOTH1' */
  map?: string;
  /** If true, skip menu navigation (connect to already-running game). Default: false */
  skipNavigation?: boolean;
  /** Player id the oracle controls. Default: 0 */
  playerId?: number;
}

const DEFAULTS: Required<RemakeAdapterConfig> = {
  url: 'http://localhost:8080',
  house: 'Atreides',
  subhouse: 'Fremen',
  difficulty: 'Easy',
  map: 'KOTH1',
  skipNavigation: false,
  playerId: 0,
};

export class RemakeAdapter implements GameAdapter {
  readonly name = 'remake';
  private config: Required<RemakeAdapterConfig>;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private eventsInstalled = false;
  private lastFailKey = '';

  constructor(config?: RemakeAdapterConfig) {
    this.config = { ...DEFAULTS, ...config };
  }

  async connect(): Promise<void> {
    console.log(`[RemakeAdapter] Connecting to ${this.config.url}`);
    this.browser = await chromium.launch({ headless: false });
    const context = await this.browser.newContext({ viewport: { width: 1280, height: 960 } });
    // Polyfill __name (esbuild/tsx decorator helper) for all page.evaluate() calls
    await context.addInitScript({ content: 'if(typeof __name==="undefined"){globalThis.__name=function(fn){return fn}}' });
    this.page = await context.newPage();

    if (this.config.skipNavigation) {
      await this.page.goto(this.config.url);
      await this.page.waitForFunction(
        () => (window as any).ctx?.game?.getTickCount() > 5,
        { timeout: 60_000 },
      );
    } else {
      await this.navigateToGame();
    }

    // Expose additional ECS refs needed by StateExtractor
    await this.exposeEcsRefs();

    // Install event collector
    await installEventCollector(this.page);
    this.eventsInstalled = true;

    // Install auto-placement for completed buildings (oracle is player 0)
    await this.installBuildingAutoPlacement();

    console.log('[RemakeAdapter] Connected and game is running');
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  async observe(): Promise<GameState> {
    this.ensurePage();
    return extractGameState(this.page!, this.config.playerId);
  }

  async pause(): Promise<void> {
    this.ensurePage();
    await this.page!.evaluate(() => {
      const game = (window as any).game;
      if (game && !game.isPaused()) game.pause();
    });
  }

  async resume(): Promise<void> {
    this.ensurePage();
    await this.page!.evaluate(() => {
      const game = (window as any).game;
      if (game && game.isPaused()) game.pause(); // toggle
    });
  }

  async execute(actions: Action[]): Promise<void> {
    this.ensurePage();
    for (const action of actions) {
      await this.executeOne(action);
    }
  }

  async screenshot(): Promise<Buffer> {
    this.ensurePage();
    return await this.page!.screenshot({ type: 'png' }) as Buffer;
  }

  private async executeOne(action: Action): Promise<void> {
    switch (action.type) {
      case 'move':
        await this.page!.evaluate(({ eids, x, z }) => {
          const ctx = (window as any).ctx;
          ctx.commandManager.issueMoveCommand(eids, x, z);
        }, { eids: action.entityIds, x: action.x, z: action.z });
        break;

      case 'attack':
        await this.page!.evaluate(({ eids, targetEid }) => {
          const ctx = (window as any).ctx;
          ctx.commandManager.issueAttackCommand(eids, targetEid);
        }, { eids: action.entityIds, targetEid: action.targetEid });
        break;

      case 'attack_move':
        await this.page!.evaluate(({ eids, x, z }) => {
          const ctx = (window as any).ctx;
          // Use the combat system's attack-move via command manager internals
          ctx.commandManager.issueMoveCommand(eids, x, z);
          ctx.combatSystem?.setAttackMove(eids);
        }, { eids: action.entityIds, x: action.x, z: action.z });
        break;

      case 'produce': {
        const result = await this.page!.evaluate(({ typeName, isBuilding }) => {
          const ctx = (window as any).ctx;
          const ps = ctx.productionSystem;
          const hs = ctx.harvestSystem;
          const solaris = hs?.getSolaris(0) ?? -1;

          const blockReason = ps?.getBuildBlockReason?.(0, typeName, isBuilding);
          if (blockReason) {
            return { ok: false, typeName, isBuilding, solaris, block: blockReason };
          }

          const ok = ps.startProduction(0, typeName, isBuilding);
          return { ok, typeName, isBuilding, solaris };
        }, { typeName: action.typeName, isBuilding: action.isBuilding });

        if (!result.ok) {
          // Only log unique failures to reduce noise
          const key = `${result.typeName}:${result.block?.reason}:${result.block?.detail}`;
          if (key !== this.lastFailKey) {
            console.log(`[RemakeAdapter] PRODUCE FAILED: ${JSON.stringify(result)}`);
            this.lastFailKey = key;
          }
        }
        break;
      }

      case 'build':
        await this.page!.evaluate(({ typeName, x, z }) => {
          const ctx = (window as any).ctx;
          ctx.spawnBuilding(ctx.game.getWorld(), typeName, 0, x, z);
          ctx.productionSystem.addPlayerBuilding(0, typeName);
        }, { typeName: action.typeName, x: action.x, z: action.z });
        break;

      case 'repair':
        await this.page!.evaluate(({ eid }) => {
          const ctx = (window as any).ctx;
          ctx.repairBuilding(eid);
        }, { eid: action.buildingEid });
        break;

      case 'set_rally':
        await this.page!.evaluate(({ x, z }) => {
          const ctx = (window as any).ctx;
          ctx.commandManager.getRallyPoint?.(0); // ensure initialized
          // Set rally via internal API
          (ctx.commandManager as any).rallyPoints?.set(0, { x, z });
        }, { x: action.x, z: action.z });
        break;

      case 'stop':
        await this.page!.evaluate(({ eids }) => {
          const ctx = (window as any).ctx;
          for (const eid of eids) {
            const { MoveTarget, AttackTarget } = (window as any)._ecsRefs;
            MoveTarget.active[eid] = 0;
            AttackTarget.active[eid] = 0;
          }
        }, { eids: action.entityIds });
        break;

      case 'guard':
        await this.page!.evaluate(({ eids }) => {
          const ctx = (window as any).ctx;
          for (const eid of eids) {
            const { MoveTarget, Position } = (window as any)._ecsRefs;
            MoveTarget.active[eid] = 0;
            ctx.combatSystem?.setGuardPosition(eid, Position.x[eid], Position.z[eid]);
          }
        }, { eids: action.entityIds });
        break;

      case 'sell':
        await this.page!.evaluate(({ eid }) => {
          const ctx = (window as any).ctx;
          ctx.sellBuilding(eid);
        }, { eid: action.buildingEid });
        break;
    }
  }

  private async navigateToGame(): Promise<void> {
    const page = this.page!;
    const { url, house, subhouse, difficulty, map } = this.config;

    // Use ?ui=2d for reliable DOM-based UI
    await page.goto(`${url}/?ui=2d`);

    // House selection
    await page.getByText('PLAY', { exact: true }).click();
    await page.getByText('Choose Your House').waitFor();
    await page.getByText(house, { exact: true }).click();

    // Game mode
    await page.getByText('Select Game Mode').waitFor();
    await page.getByText('Skirmish', { exact: true }).click();

    // Subhouse
    await page.getByText('Choose Your Subhouse Ally').waitFor();
    await page.getByText(subhouse, { exact: true }).first().click();

    // Difficulty
    await page.getByText('Select Difficulty').waitFor();
    await page.getByText(difficulty, { exact: true }).click();

    // Skirmish options
    await page.getByRole('button', { name: 'Continue' }).click();

    // Map selection
    await page.getByText('Select Battlefield').waitFor();
    await page.getByText('2-Player Maps').waitFor();
    await page.getByText(map).click();

    // Wait for in-game HUD
    await page.locator('#ui-overlay').waitFor({ timeout: 120_000 });

    // Wait for game to tick
    await page.waitForFunction(
      () => (window as any).game?.getTickCount() > 5,
      { timeout: 60_000 },
    );
  }

  private async exposeEcsRefs(): Promise<void> {
    // Verify _ecsRefs has all needed components (set in index.ts)
    const hasRefs = await this.page!.evaluate(() => {
      const refs = (window as any)._ecsRefs;
      if (!refs) return false;
      return !!(refs.Position && refs.UnitType && refs.BuildingType &&
        refs.Harvester && refs.MoveTarget && refs.AttackTarget && refs.hasComponent);
    });
    if (!hasRefs) {
      console.warn('[RemakeAdapter] _ecsRefs incomplete — state extraction may be limited');
    }
  }

  /**
   * Install a production:complete handler that auto-places completed buildings for player 0.
   * In the real game, the player clicks to place buildings after production finishes.
   * This handler mimics the AI auto-placement logic.
   */
  private async installBuildingAutoPlacement(): Promise<void> {
    await this.page!.evaluate(() => {
      const w = window as any;
      const ctx = w.ctx;
      const EB = w._eventBus;
      if (!EB || !ctx) return;

      // Track placed buildings for spacing
      let nextOffset = 0;

      EB.on('production:complete', (data: any) => {
        if (!data.isBuilding || data.owner !== 0) return;

        const typeName = data.unitType;
        const rules = ctx.gameRules;
        const bDef = rules.buildings.get(typeName);
        if (!bDef) return;

        // Find ConYard as base center
        const ECS = w._ecsRefs;
        const world = ctx.game.getWorld();
        let baseX = 0, baseZ = 0;
        for (const eid of ECS.buildingQuery(world)) {
          if (ECS.Owner.playerId[eid] !== 0) continue;
          if (ECS.Health.current[eid] <= 0) continue;
          const typeId = ECS.BuildingType.id[eid];
          const name = ctx.typeRegistry.buildingTypeNames[typeId] ?? '';
          if (name.includes('ConYard')) {
            baseX = ECS.Position.x[eid];
            baseZ = ECS.Position.z[eid];
            break;
          }
        }

        // Simple spiral placement around base
        const spacing = 6;
        const ring = Math.floor(nextOffset / 4);
        const side = nextOffset % 4;
        let px = baseX, pz = baseZ;
        const r = (ring + 2) * spacing;
        switch (side) {
          case 0: px += r; break;
          case 1: px -= r; break;
          case 2: pz += r; break;
          case 3: pz -= r; break;
        }
        nextOffset++;

        const eid = ctx.spawnBuilding(world, typeName, 0, px, pz);
        if (eid >= 0) {
          EB.emit('building:placed', { entityId: eid, buildingType: typeName, owner: 0 });
          EB.emit('building:completed', { entityId: eid, playerId: 0, typeName });
          // Spawn bonus unit if building provides one (e.g., Refinery → Harvester)
          if (bDef.getUnitWhenBuilt) {
            ctx.spawnUnit(world, bDef.getUnitWhenBuilt, 0, px + 3, pz + 3);
          }
        }
      });
    });
  }

  private ensurePage(): void {
    if (!this.page) throw new Error('Not connected — call connect() first');
  }
}
