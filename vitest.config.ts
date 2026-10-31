import { defineConfig } from 'vitest/config';

// No DOM: the package runs under plain Node, and so do its tests.
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 120_000 },
});
