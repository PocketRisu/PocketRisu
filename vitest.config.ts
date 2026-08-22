import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    svelte(),
  ],
  resolve: {
    alias: {
      src: '/src',
    },
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts'],
    // compat/server suites have their own node-environment configs
    // (vitest.config.compat.ts / vitest.config.server.ts); exclude here so
    // `pnpm test` doesn't pick them up under the wrong environment.
    exclude: ['node_modules/**', 'test/compat/**', 'server/node/**'],
  },
})
