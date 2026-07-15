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
      index: 'src/index.ts',
      config: 'src/config.ts',
      deploy: 'src/deploy.ts',
      testing: 'src/testing.ts',
      casts: 'src/casts.ts',
      assertions: 'src/assertions.ts',
      rpc: 'src/rpc.ts',
      node: 'src/node.ts',
      'node-control': 'src/node-control.ts',
      nextjs: 'src/nextjs.ts',
      'nextjs-control': 'src/nextjs-control.ts',
      tsdown: 'src/tsdown.ts',
    },
    exports: false,
    clean: true,
    skipNodeModulesBundle: false,
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
