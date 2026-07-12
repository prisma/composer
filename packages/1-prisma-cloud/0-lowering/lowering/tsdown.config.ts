import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  entry: ['src/index.ts', 'src/postgres/index.ts', 'src/compute/index.ts', 'src/state/index.ts'],
});
