import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// Thin re-export entries over the @internal/* packages' built dist; the
// @internal scope is inlined so the published tarball is self-contained
// (ADR-0028) — external npm deps stay imports. `exports` is hand-maintained
// in package.json, so exports:false. The command family and the
// `prisma-composer` bin live in @prisma/composer-cli, which is also the only
// package with an `@prisma/cli-engine` relationship — this library must not
// import the engine at all (scripts/check-cli-engine-pin.mjs asserts the
// packed dist is engine-free).
export default defineConfig({
  ...baseConfig,
  entry: {
    index: 'src/exports/index.ts',
    config: 'src/exports/config.ts',
    control: 'src/exports/control.ts',
    deploy: 'src/exports/deploy.ts',
    'local-target': 'src/exports/local-target.ts',
    report: 'src/exports/report.ts',
    testing: 'src/exports/testing.ts',
    casts: 'src/exports/casts.ts',
    assertions: 'src/exports/assertions.ts',
    arktype: 'src/exports/arktype.ts',
    'service-rpc': 'src/exports/service-rpc.ts',
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
});
