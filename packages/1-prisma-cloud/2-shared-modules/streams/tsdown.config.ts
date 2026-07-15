import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// Mirrors storage's three passes. index + streams-service share the dist root
// so any shared chunk sits beside them — streamsService resolves
// `./streams-service.mjs` from the code that calls it (import.meta.url).
// streams-entrypoint stands alone and fully inlines its graph — including
// `@prisma/streams-server`, which ships raw TypeScript — so the bundle's only
// externals are `bun`/`bun:*` and `node:` builtins (ADR-0008). The testing
// pass inlines `@prisma/streams-local` the same way.
export default defineConfig([
  {
    ...baseConfig,
    entry: { index: 'src/index.ts', 'streams-service': 'src/streams-service.ts' },
    exports: false,
    clean: true,
  },
  {
    ...baseConfig,
    entry: { 'streams-entrypoint': 'src/streams-entrypoint.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//, /^@prisma\//, /^arktype/, /^@standard-schema\//],
    // assemble() copies the entrypoint out with no siblings; the server's
    // dynamic-import chain must not split into chunks.
    outputOptions: { inlineDynamicImports: true },
  },
  {
    ...baseConfig,
    entry: { testing: 'src/testing.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//, /^@prisma\//],
  },
]);
