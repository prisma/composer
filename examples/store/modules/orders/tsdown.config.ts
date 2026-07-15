import { defineConfig } from 'tsdown';

// Build only the runnable (src/server.ts). @prisma/*, @store/* and arktype are
// inlined — node_modules isn't shipped; `bun` is a Compute runtime built-in.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  external: ['bun'],
  noExternal: [/^@prisma\//, /^@prisma-next\//, /^@store\//, /^arktype/, /^pg$/, /^pg-/, /^pathe$/],
  dts: false,
  sourcemap: false,
  clean: true,
});
