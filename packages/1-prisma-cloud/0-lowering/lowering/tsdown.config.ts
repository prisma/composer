import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    buckets: 'src/exports/buckets.ts',
    compute: 'src/exports/compute.ts',
    state: 'src/exports/state.ts',
  },
});
