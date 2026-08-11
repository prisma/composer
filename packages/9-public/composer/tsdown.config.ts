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
      control: 'src/exports/control.ts',
      family: 'src/exports/family.ts',
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
    // `@prisma/cli-engine` is the CLI front door composer's command family
    // mounts into. It must stay a real import so composer and the `prisma`
    // bin share ONE engine instance at runtime; inlining it would give the
    // tarball a private copy whose classes fail every cross-package
    // instanceof. scripts/check-cli-engine-pin.mjs enforces both that and
    // the exact-version agreement between the two manifests.
    external: ['esbuild', '@prisma/cli-engine'],
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
    // The same two the library entries externalize, for the same two reasons,
    // stated rather than inherited from what the bundler happens to do with a
    // declared dependency: esbuild refuses to run once bundled, and the
    // executable must run the ENGINE THE MANIFEST PINS — a private copy would
    // make the installed version and the running one different things.
    // scripts/check-cli-engine-pin.mjs checks dist/bin.mjs by name for exactly
    // this, and check-family-static-graph.mjs walks its graph.
    external: ['esbuild', '@prisma/cli-engine'],
    noExternal: [/^@internal\//],
  },
]);
