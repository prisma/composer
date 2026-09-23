import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

export default defineConfig({
  ...baseConfig,
  entry: {
    index: 'src/exports/index.ts',
    control: 'src/exports/control.ts',
  },
  clean: true,
  external: [
    /^@prisma\/composer(\/|$)/,
    /^@alchemy\.run\/frontend-frameworks(\/|$)/,
    /^@effect\/platform-node(\/|$)/,
    /^effect(\/|$)/,
  ],
});
