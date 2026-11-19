import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  entry: {
    'app-identity': 'src/exports/app-identity.ts',
    config: 'src/exports/config.ts',
    control: 'src/exports/control.ts',
    converge: 'src/exports/converge.ts',
    'dev-converge-worker': 'src/exports/dev-converge-worker.ts',
    'converge-contract': 'src/exports/converge-contract.ts',
    family: 'src/exports/family.ts',
    testing: 'src/exports/testing.ts',
  },
});
