import { defineConfig } from 'vitest/config'

// Server-side (.cjs) unit tests. Node environment — these exercise native
// modules (better-sqlite3) and pure data-layer logic, no DOM. Kept separate
// from the default happy-dom suite (vitest.config.ts) like the compat suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/node/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
