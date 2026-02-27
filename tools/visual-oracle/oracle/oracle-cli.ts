#!/usr/bin/env npx tsx
/**
 * Oracle CLI — AI agent that plays Emperor: Battle for Dune.
 *
 * Usage:
 *   npx tsx tools/visual-oracle/oracle/oracle-cli.ts --backend=remake --house=AT --no-llm --max-iterations=30
 *   npx tsx tools/visual-oracle/oracle/oracle-cli.ts --backend=wine --house=HK
 */

import { parseArgs } from 'node:util';
import { OracleLoop } from './OracleLoop.js';
import { RemakeAdapter } from './adapters/RemakeAdapter.js';
import type { GameAdapter } from './adapters/GameAdapter.js';
import type { HousePrefix } from './brain/BuildOrders.js';

const HOUSE_MAP: Record<string, { name: string; prefix: HousePrefix; subhouse: string }> = {
  AT: { name: 'Atreides', prefix: 'AT', subhouse: 'Fremen' },
  HK: { name: 'Harkonnen', prefix: 'HK', subhouse: 'Sardaukar' },
  OR: { name: 'Ordos', prefix: 'OR', subhouse: 'Ix' },
};

async function main() {
  const { values } = parseArgs({
    options: {
      backend: { type: 'string', default: 'remake' },
      house: { type: 'string', default: 'AT' },
      difficulty: { type: 'string', default: 'Easy' },
      map: { type: 'string', default: 'KOTH1' },
      'no-llm': { type: 'boolean', default: false },
      'max-iterations': { type: 'string', default: '0' },
      'interval-ms': { type: 'string', default: '2000' },
      url: { type: 'string', default: 'http://localhost:8080' },
      'skip-nav': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const house = HOUSE_MAP[values.house!.toUpperCase()];
  if (!house) {
    console.error(`Unknown house: ${values.house}. Use AT, HK, or OR.`);
    process.exit(1);
  }

  const backend = values.backend!;
  const noLlm = values['no-llm']!;
  const maxIterations = parseInt(values['max-iterations']!, 10);
  const intervalMs = parseInt(values['interval-ms']!, 10);

  console.log(`Oracle CLI — ${house.name} on ${backend} backend`);
  console.log(`  LLM: ${noLlm ? 'disabled' : 'enabled'}, maxIterations: ${maxIterations || 'unlimited'}`);

  let adapter: GameAdapter;

  if (backend === 'remake') {
    adapter = new RemakeAdapter({
      url: values.url,
      house: house.name,
      subhouse: house.subhouse,
      difficulty: values.difficulty as 'Easy' | 'Normal' | 'Hard',
      map: values.map,
      skipNavigation: values['skip-nav'],
    });
  } else if (backend === 'wine') {
    // Lazy import to avoid requiring Wine dependencies when using remake
    const { WineOracleAdapter } = await import('./adapters/WineAdapter.js');
    adapter = new WineOracleAdapter({ housePrefix: house.prefix });
  } else {
    console.error(`Unknown backend: ${backend}. Use 'remake' or 'wine'.`);
    process.exit(1);
  }

  const loop = new OracleLoop(adapter, {
    housePrefix: house.prefix,
    noLlm,
    maxIterations,
    intervalMs,
    onIteration: (i, state, actionCount) => {
      if (i % 5 === 0) {
        process.stdout.write(
          `\r[${i}] tick=${state.tick} units=${state.player.units.length} ` +
          `bldgs=${state.player.buildings.length} sol=${state.player.solaris} ` +
          `actions=${actionCount}  `,
        );
      }
    },
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Oracle] Shutting down...');
    loop.stop();
  });

  try {
    await adapter.connect();
    await loop.start();
  } catch (e) {
    console.error('[Oracle] Fatal error:', e);
  } finally {
    await adapter.disconnect();
  }
}

main().catch(console.error);
