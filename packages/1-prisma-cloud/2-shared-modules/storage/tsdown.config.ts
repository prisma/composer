import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// index + the service node in ONE pass at the dist root so any shared chunk
// sits beside them. The service node's file is emitted as `service.mjs` (NOT
// `storage-service.mjs`): @prisma/compose/node's assemble() re-bundles
// `build.module` and requires the output basename to be `service.*` — so
// `build.module` points at `./service.mjs` and resolves it from the calling
// code (import.meta.url). storage-entrypoint stands alone and is fully inlined
// (assemble() copies it out with no siblings); `bun` stays external (a runtime
// builtin, ADR-0008), so `import { SQL } from 'bun'` and Bun.serve resolve at
// runtime, not at build.
export default defineConfig([
  {
    ...baseConfig,
    entry: { index: 'src/index.ts', service: 'src/storage-service.ts' },
    exports: false,
    clean: true,
  },
  {
    ...baseConfig,
    entry: { 'storage-entrypoint': 'src/storage-entrypoint.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//, /^@prisma\//, /^arktype/, /^@standard-schema\//],
  },
  {
    // The /testing local stand-in (createPgStore + startStorageServer). Its own
    // pass with `bun` external so the engine's `import { SQL } from 'bun'` and
    // Bun.serve resolve at runtime; kept off the index pass so index.mjs never
    // shares a chunk carrying a runtime token. `@internal/` is inlined (the pure
    // `@internal/prisma-cloud/connection` retry helper) so the bundle's only
    // externals stay `bun` + `node:` builtins.
    ...baseConfig,
    entry: { testing: 'src/testing.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//],
  },
]);
