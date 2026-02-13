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

if (isProduction) {
  await esbuild.build(buildOptions);
  console.log('Production build complete.');
} else {
  const ctx = await esbuild.context(buildOptions);
  const { host, port } = await ctx.serve({
    servedir: '.',
    port: 8080,
  });
  console.log(`Dev server running at http://localhost:${port}`);
}
