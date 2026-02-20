import esbuild from 'esbuild';

const isProduction = process.argv.includes('--production');

const buildOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/game.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: !isProduction,
  minify: isProduction,
  loader: {
    '.ts': 'ts',
  },
  define: {
    'process.env.NODE_ENV': isProduction ? '"production"' : '"development"',
  },
};

// Worker bundle (separate entry point, self-contained)
const workerBuildOptions = {
  entryPoints: ['src/workers/pathfinder.worker.ts'],
  bundle: true,
  outfile: 'dist/pathfinder.worker.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: !isProduction,
  minify: isProduction,
  loader: {
    '.ts': 'ts',
  },
};

if (isProduction) {
  await Promise.all([
    esbuild.build(buildOptions),
    esbuild.build(workerBuildOptions),
  ]);
  console.log('Production build complete.');
} else {
  // Build worker first, then start dev server
  await esbuild.build(workerBuildOptions);
  const ctx = await esbuild.context({
    ...buildOptions,
    // Also rebuild worker on changes
    plugins: [{
      name: 'worker-rebuild',
      setup(build) {
        build.onEnd(async () => {
          await esbuild.build(workerBuildOptions).catch(() => {});
        });
      },
    }],
  });
  const { host, port } = await ctx.serve({
    servedir: '.',
    port: 8080,
  });
  console.log(`Dev server running at http://localhost:${port}`);
}
