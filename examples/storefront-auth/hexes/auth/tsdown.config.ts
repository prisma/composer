import { defineConfig } from 'tsdown';

// The app's own build (ADR-0005): only its runnable, src/server.ts, built to
// dist/server.js. The MakerKit wrapper (bundling src/service.ts to main.js,
// as an independent module instance) is no longer built here — `makerkit
// deploy` assembles it via `@makerkit/node/assemble`. @makerkit/* and arktype
// (the contract evaluates type() at import time) are inlined (node_modules
// isn't shipped); `bun` is a Compute runtime built-in.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  external: ['bun'],
  noExternal: [/^@makerkit\//, /^arktype/],
  dts: false,
  sourcemap: false,
  clean: true,
});
