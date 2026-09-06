import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    maxWorkers: 4,
    update: process.env.PGSTENCIL_UPDATE === '1',
    sequence: { concurrent: false },
  },
});
