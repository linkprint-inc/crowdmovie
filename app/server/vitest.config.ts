import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // The database-backed suites share one PostgreSQL database and schema.test.ts
    // drops and recreates its schema, so test files must not run concurrently.
    fileParallelism: false,
  },
});
