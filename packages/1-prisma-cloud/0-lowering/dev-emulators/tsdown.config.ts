import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    'compute-main': 'src/exports/compute-main.ts',
    'buckets-main': 'src/exports/buckets-main.ts',
    'postgres-main': 'src/exports/postgres-main.ts',
  },
});
