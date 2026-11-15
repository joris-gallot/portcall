import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // cli.test.ts drives real processes and waits for their ports.
    testTimeout: 30_000,
  },
})
