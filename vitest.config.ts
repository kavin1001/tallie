import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // Better Auth's Kysely introspector scans every accessible PostgreSQL schema.
    // Keep suite-owned schema teardown from racing that scan. Concurrency tests
    // still run their competing transactions/promises in parallel within a file.
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
