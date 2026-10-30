import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    builds: 'src/exports/builds.ts',
    deployed: 'src/exports/deployed.ts',
    compute: 'src/exports/compute.ts',
    state: 'src/exports/state.ts',
    testing: 'src/exports/testing.ts',
  },
});
