import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  entry: { casts: 'src/casts.ts', assertions: 'src/assertions.ts', secret: 'src/secret.ts' },
});
