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
    entry: { index: 'src/exports/index.ts', 'streams-service': 'src/exports/streams-service.ts' },
    exports: false,
    clean: true,
    // The wire client (@durable-streams/client, pinned 0.2.1 — the version
    // @prisma/streams-server 0.1.11's own repo pairs with) is inlined so
    // neither this dist nor the umbrella grows a runtime dependency; it is
    // pure fetch-based JS (~90 kB + fastq/fetch-event-source), no node:/bun
    // tokens, so the authoring barrel stays pure.
    skipNodeModulesBundle: false,
    noExternal: [/^@durable-streams\//, /^@microsoft\//, /^fastq/, /^reusify/],
  },
  {
    ...baseConfig,
    entry: { 'streams-entrypoint': 'src/exports/streams-entrypoint.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [
      /^@internal\//,
      /^@prisma\//,
      /^arktype/,
      /^@standard-schema\//,
      /^@durable-streams\//,
      /^@microsoft\//,
      /^fastq/,
      /^reusify/,
    ],
    // assemble() copies the entrypoint out with no siblings; the server's
    // dynamic-import chain must not split into chunks.
    outputOptions: { inlineDynamicImports: true },
  },
  {
    ...baseConfig,
    entry: { testing: 'src/exports/testing.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//, /^@prisma\//, /^fastq/, /^reusify/],
  },
]);
