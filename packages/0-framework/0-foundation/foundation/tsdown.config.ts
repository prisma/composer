import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  entry: {
    casts: 'src/exports/casts.ts',
    assertions: 'src/exports/assertions.ts',
    secret: 'src/exports/secret.ts',
    arktype: 'src/exports/arktype.ts',
  },
});
