import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  // Object form: the key is the output name (and generated export subpath), so
  // `app-config.ts` is published as `./config` — `config.ts` is already the
  // internal typed-config module.
  entry: {
    index: 'src/exports/index.ts',
    deploy: 'src/exports/deploy.ts',
    config: 'src/exports/app-config.ts',
    'local-target': 'src/exports/local-target.ts',
    testing: 'src/exports/testing.ts',
  },
});
