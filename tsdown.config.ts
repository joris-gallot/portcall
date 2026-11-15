import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { portcall: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  dts: false,
  // Fails the build if anything else from node_modules ends up bundled.
  deps: { onlyBundle: ['zod'] },
})
