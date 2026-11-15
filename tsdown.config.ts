import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { portcall: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  dts: false,
})
