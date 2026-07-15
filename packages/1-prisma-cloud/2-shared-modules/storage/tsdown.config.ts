import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// index + storage-service in ONE pass at the dist root so any shared chunk
// sits beside them — storageService resolves `./storage-service.mjs` from the
// code that calls it (import.meta.url). storage-entrypoint stands alone and is
// fully inlined (assemble() copies it out with no siblings); `bun` stays
// external (a runtime builtin, ADR-0008), so `import { SQL } from 'bun'` and
// Bun.serve resolve at runtime, not at build.
export default defineConfig([
  {
    ...baseConfig,
    entry: { index: 'src/index.ts', 'storage-service': 'src/storage-service.ts' },
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
