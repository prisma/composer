import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// Cloud-domain internals (@internal/lowering, /prisma-cloud, /cron) are
// inlined from their built dist. Framework internals are NOT bundled — a
// resolve hook rewrites them to the public `@prisma/composer` subpaths and
// marks them external, so both the emitted JS and the rolled .d.mts reference
// the one installed framework copy (type identity: core's node brand is a
// unique symbol; two bundled declaration copies would not unify).
const FRAMEWORK: Record<string, string> = {
  '@internal/foundation/casts': '@prisma/composer/casts',
  '@internal/foundation/assertions': '@prisma/composer/assertions',
  '@internal/core/config': '@prisma/composer/config',
  '@internal/core/deploy': '@prisma/composer/deploy',
  '@internal/core/testing': '@prisma/composer/testing',
  '@internal/core': '@prisma/composer',
  '@internal/rpc': '@prisma/composer/rpc',
  '@internal/node/control': '@prisma/composer/node/control',
  '@internal/node': '@prisma/composer/node',
  '@internal/nextjs/control': '@prisma/composer/nextjs/control',
  '@internal/nextjs': '@prisma/composer/nextjs',
};
const externalizeFramework = {
  name: 'externalize-framework-internals',
  resolveId(id: string) {
    const pub = FRAMEWORK[id];
    if (pub) return { id: pub, external: true as const };
    return null;
  },
};

// Three passes, mirroring the pre-consolidation layout: 1. library entries;
// 2. cron index into dist/cron/ (cronScheduler resolves
// `./scheduler-service.mjs` relative to the calling code's directory);
// 3. the standalone programs, re-emitted from @internal/cron's dist where
// scheduler-entrypoint was already fully inlined by that package's own build.
const cronDist = '../../1-prisma-cloud/2-shared-modules/cron/dist';
const storageDist = '../../1-prisma-cloud/2-shared-modules/storage/dist';
const streamsDist = '../../1-prisma-cloud/2-shared-modules/streams/dist';
export default defineConfig([
  {
    ...baseConfig,
    entry: {
      index: 'src/index.ts',
      control: 'src/control.ts',
      'prisma-next': 'src/prisma-next.ts',
      testing: 'src/testing.ts',
    },
    exports: false,
    clean: true,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    ...baseConfig,
    entry: { index: 'src/cron.ts' },
    outDir: 'dist/cron',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    ...baseConfig,
    dts: false,
    entry: {
      'scheduler-service': `${cronDist}/scheduler-service.mjs`,
      'scheduler-entrypoint': `${cronDist}/scheduler-entrypoint.mjs`,
    },
    outDir: 'dist/cron',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    ...baseConfig,
    entry: { index: 'src/storage.ts' },
    outDir: 'dist/storage',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    ...baseConfig,
    dts: false,
    entry: {
      'storage-service': `${storageDist}/storage-service.mjs`,
      'storage-entrypoint': `${storageDist}/storage-entrypoint.mjs`,
    },
    outDir: 'dist/storage',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    // `bun` is a runtime builtin — keep it external in the re-emitted entrypoint.
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    // The /storage/testing local stand-in — inlines @internal/storage/testing's
    // engine; `bun` stays external (the store uses Bun's SQL + Bun.serve).
    ...baseConfig,
    entry: { testing: 'src/storage-testing.ts' },
    outDir: 'dist/storage',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    ...baseConfig,
    entry: { index: 'src/streams.ts' },
    outDir: 'dist/streams',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    // Re-emitted from @internal/streams' dist, where streams-entrypoint was
    // already fully inlined (the streams server + its dynamic-import chain) by
    // that package's own build.
    ...baseConfig,
    dts: false,
    entry: {
      'streams-service': `${streamsDist}/streams-service.mjs`,
      'streams-entrypoint': `${streamsDist}/streams-entrypoint.mjs`,
    },
    outDir: 'dist/streams',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    // The /streams/testing local stand-in (@prisma/streams-local, already
    // inlined by @internal/streams' own build).
    ...baseConfig,
    entry: { testing: 'src/streams-testing.ts' },
    outDir: 'dist/streams',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
]);
