import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  entry: {
    casts: 'src/exports/casts.ts',
    errors: 'src/exports/errors.ts',
    result: 'src/exports/result.ts',
    assertions: 'src/exports/assertions.ts',
    secret: 'src/exports/secret.ts',
    pointer: 'src/exports/pointer.ts',
    arktype: 'src/exports/arktype.ts',
  },
});
