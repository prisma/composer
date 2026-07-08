import { defineConfig } from 'tsdown';

// Two SEPARATE builds into one bundle dir, not one multi-entry build: a single
// build would dedupe the shared service.ts into a chunk both entries import — one
// module instance. run() (main.js) and load() (server.js) must be independent
// instances that hand off through process.env, so each is its own self-contained
// build. `server.js` is the app's runnable (the build adapter's `entry`);
// `main.js` is the MakerKit wrapper the bootstrap imports. @makerkit/* and
// arktype are inlined (node_modules isn't shipped); `bun` is a Compute runtime
// built-in.
const shared = {
  outDir: 'dist/bundle',
  format: 'esm',
  platform: 'node',
  external: ['bun'],
  noExternal: [/^@makerkit\//, /^arktype/],
  dts: false,
  sourcemap: false,
} as const;

export default defineConfig([
  { ...shared, entry: { server: 'src/server.ts' }, clean: true },
  { ...shared, entry: { main: 'src/service.ts' }, clean: false },
]);
