import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    ...baseConfig,
    entry: {
      index: 'src/exports/index.ts',
      'queue-service': 'src/exports/queue-service.ts',
      'dispatcher-service': 'src/exports/dispatcher-service.ts',
    },
    exports: false,
    clean: true,
  },
  {
    ...baseConfig,
    entry: { 'queue-entrypoint': 'src/exports/queue-entrypoint.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//, /^@prisma\//, /^arktype/, /^@standard-schema\//],
  },
  {
    ...baseConfig,
    entry: { 'dispatcher-entrypoint': 'src/exports/dispatcher-entrypoint.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//, /^@prisma\//, /^arktype/, /^@standard-schema\//],
  },
]);
