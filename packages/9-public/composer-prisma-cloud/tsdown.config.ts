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
  '@internal/service-rpc': '@prisma/composer/service-rpc',
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
const emailDist = '../../1-prisma-cloud/2-shared-modules/email/dist';
const streamsDist = '../../1-prisma-cloud/2-shared-modules/streams/dist';
const devEmulatorsDist = '../../1-prisma-cloud/0-lowering/dev-emulators/dist';
export default defineConfig([
  {
    ...baseConfig,
    entry: {
      index: 'src/exports/index.ts',
      control: 'src/exports/control.ts',
      'local-target': 'src/exports/local-target.ts',
      'prisma-next': 'src/exports/prisma-next.ts',
      testing: 'src/exports/testing.ts',
    },
    exports: false,
    clean: true,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    ...baseConfig,
    entry: { index: 'src/exports/cron.ts' },
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
    // Re-emitted from @internal/dev-emulators' dist (spec § 2's publish
    // note): the daemon programs `ensureDaemon` spawns need a resolvable
    // entry inside a PUBLISHED install's own dependency tree — the private
    // `@internal/dev-emulators` package is never installed standalone.
    // outDir is the DEFAULT `dist` (not a subdirectory): `readOwnVersion()`
    // (baked into every one of these programs AND into this package's own
    // `local-target.mjs`, which calls `ensureDaemon`) resolves
    // `../package.json` relative to its own file — both sides must sit at
    // the SAME depth under `dist/` or they read different package.json
    // files and disagree on "own version", breaking `ensureDaemon`'s
    // staleness check.
    ...baseConfig,
    dts: false,
    entry: {
      'compute-main': `${devEmulatorsDist}/compute-main.mjs`,
      'buckets-main': `${devEmulatorsDist}/buckets-main.mjs`,
      'postgres-main': `${devEmulatorsDist}/postgres-main.mjs`,
    },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    ...baseConfig,
    entry: { index: 'src/exports/storage.ts' },
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
    entry: { testing: 'src/exports/storage-testing.ts' },
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
    entry: { index: 'src/exports/email.ts' },
    outDir: 'dist/email',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    // Re-emitted from @internal/email's dist, where email-entrypoint was
    // already fully inlined (nodemailer + arktype) by that package's own
    // build; `bun` stays external (the pg outbox store uses Bun's SQL, the
    // server Bun.serve).
    ...baseConfig,
    dts: false,
    entry: {
      'email-service': `${emailDist}/email-service.mjs`,
      'email-entrypoint': `${emailDist}/email-entrypoint.mjs`,
    },
    outDir: 'dist/email',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    // The /email/testing local stand-in — inlines @internal/email/testing's
    // engine; `bun` stays external (Bun.serve).
    ...baseConfig,
    entry: { testing: 'src/exports/email-testing.ts' },
    outDir: 'dist/email',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
  {
    ...baseConfig,
    entry: { index: 'src/exports/streams.ts' },
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
    entry: { testing: 'src/exports/streams-testing.ts' },
    outDir: 'dist/streams',
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//],
    plugins: [externalizeFramework],
  },
]);
