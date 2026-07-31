import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { server: 'src/app/server.ts' },
  outDir: 'dist/app',
  format: 'esm',
  platform: 'node',
  external: [/^bun$/, /^bun:/, /^node:/],
  noExternal: [/.*/],
  outputOptions: { inlineDynamicImports: true },
  dts: false,
  sourcemap: false,
  clean: true,
});
