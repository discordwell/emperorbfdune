import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tools/visual-oracle/oracle/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
