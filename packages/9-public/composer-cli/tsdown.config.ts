import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// Thin re-export entries over @internal/cli's built dist; the @internal scope
// is inlined so the published tarball is self-contained (ADR-0028) — external
// npm deps stay imports. `exports` is hand-maintained in package.json, so
// exports:false.
//
// `@prisma/composer` stays external without appearing in `external`: it is a
// declared dependency, and tsdown leaves declared dependencies as real
// imports on its own.
//
// `alchemy` stays a declared dependency although no source file here imports
// it: the inlined core code imports from `alchemy` (`alchemy/State/LocalState`),
// so the packed dist does. The workspace installs hoisted, which would hide
// its removal from every local check; only a strict pnpm install of the
// tarball would fail.
export default defineConfig({
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
});
