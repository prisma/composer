import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// index + scheduler-service in ONE pass at the dist root so any shared chunk
// sits beside them — cronScheduler resolves `./scheduler-service.mjs` from the
// code that calls it (import.meta.url). scheduler-entrypoint stands alone and
// is fully inlined (assemble() copies it out with no siblings).
export default defineConfig([
  {
    ...baseConfig,
    entry: {
      index: 'src/exports/index.ts',
      'scheduler-service': 'src/exports/scheduler-service.ts',
    },
    exports: false,
    clean: true,
  },
  {
    ...baseConfig,
    entry: { 'scheduler-entrypoint': 'src/exports/scheduler-entrypoint.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//, /^@prisma\/(?!orm-)/, /^arktype/, /^@standard-schema\//],
  },
]);
