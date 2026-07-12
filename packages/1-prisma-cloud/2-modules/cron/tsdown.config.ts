import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// index + scheduler-service in ONE pass at the dist root so any shared chunk
// sits beside them — cronScheduler resolves `./scheduler-service.mjs` from the
// code that calls it (import.meta.url). scheduler-entrypoint stands alone and
// is fully inlined (assemble() copies it out with no siblings).
export default defineConfig([
  {
    ...baseConfig,
    entry: { index: 'src/index.ts', 'scheduler-service': 'src/scheduler-service.ts' },
    exports: false,
    clean: true,
  },
  {
    ...baseConfig,
    entry: { 'scheduler-entrypoint': 'src/scheduler-entrypoint.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    noExternal: [/^@internal\//, /^@prisma\//, /^arktype/, /^@standard-schema\//],
  },
]);
