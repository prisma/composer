import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// Thin re-export entries over @internal/cli's built dist; the @internal scope
// is inlined so the published tarball is self-contained (ADR-0028) — external
// npm deps stay imports. `exports` is hand-maintained in package.json (the bin
// must not be importable), so exports:false.
//
// `@prisma/composer` stays external without appearing in `external`: it is a
// declared dependency, and tsdown leaves declared dependencies as real
// imports on its own.
export default defineConfig([
  {
    ...baseConfig,
    entry: {
      family: 'src/exports/family.ts',
      testing: 'src/exports/testing.ts',
    },
    exports: false,
    clean: true,
    skipNodeModulesBundle: false,
    // esbuild's JS API refuses to run once bundled into another file (it
    // checks __filename/__dirname against its own package layout and throws
    // "The esbuild JavaScript API cannot be bundled" otherwise) — it must stay
    // a real import, not inlined like the rest of node_modules.
    // `@prisma/cli-engine` is the CLI front door this command family mounts
    // into, and it is a peerDependency here: the host that installs this
    // package supplies the one engine everyone shares. It must stay a real
    // import so this package and the `prisma` bin share ONE engine instance at
    // runtime; inlining it would give the tarball a private copy whose classes
    // fail every cross-package instanceof. scripts/check-cli-engine-pin.mjs
    // enforces both that and the exact-version agreement between the
    // manifests.
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
    // executable must run the ENGINE THE MANIFEST DECLARES AS A PEER — a
    // private copy would make the installed version and the running one
    // different things. scripts/check-cli-engine-pin.mjs checks dist/bin.mjs
    // by name for exactly this, and check-family-static-graph.mjs walks its
    // graph.
    external: ['esbuild', '@prisma/cli-engine'],
    noExternal: [/^@internal\//],
  },
  {
    // Preload module for the alchemy converge child. NODE_OPTIONS --import
    // points to this file so the resolve hook is active inside the child
    // process. Must live alongside dist/bin.mjs so the relative URL computed
    // in run-alchemy.ts resolves to the correct file after bundling.
    ...baseConfig,
    dts: false,
    entry: {
      'register-entry-resolution':
        '../../0-framework/3-tooling/cli/dist/register-entry-resolution.mjs',
    },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: ['esbuild', '@prisma/cli-engine'],
    noExternal: [/^@internal\//],
  },
]);
