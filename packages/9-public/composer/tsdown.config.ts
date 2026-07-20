import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// Thin re-export entries over the @internal/* packages' built dist; the
// @internal scope is inlined so the published tarball is self-contained
// (ADR-0028) — external npm deps stay imports. `exports` is hand-maintained
// in package.json (the bin must not be importable), so exports:false.
export default defineConfig([
  {
    ...baseConfig,
    entry: {
      index: 'src/exports/index.ts',
      config: 'src/exports/config.ts',
      deploy: 'src/exports/deploy.ts',
      report: 'src/exports/report.ts',
      testing: 'src/exports/testing.ts',
      casts: 'src/exports/casts.ts',
      assertions: 'src/exports/assertions.ts',
      rpc: 'src/exports/rpc.ts',
      node: 'src/exports/node.ts',
      'node-control': 'src/exports/node-control.ts',
      nextjs: 'src/exports/nextjs.ts',
      'nextjs-control': 'src/exports/nextjs-control.ts',
    },
    exports: false,
    clean: true,
    skipNodeModulesBundle: false,
    // esbuild's JS API refuses to run once bundled into another file (it
    // checks __filename/__dirname against its own package layout and throws
    // "The esbuild JavaScript API cannot be bundled" otherwise) — it must stay
    // a real import, not inlined like the rest of node_modules.
    external: ['esbuild'],
    noExternal: [/^@internal\//],
  },
  {
    // The executable: bundled from @internal/cli's built bin — a program, not
    // an importable module, so no declarations.
    ...baseConfig,
    dts: false,
    entry: { bin: '../../0-framework/3-tooling/cli/dist/bin.mjs' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//],
  },
]);
