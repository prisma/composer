import { defineConfig } from '@prisma/app-tsdown';

export default defineConfig({
  // Object form: the key is the output name (and generated export subpath), so
  // `app-config.ts` is published as `./config` — `config.ts` is already the
  // internal typed-config module.
  entry: {
    index: 'src/index.ts',
    deploy: 'src/deploy.ts',
    casts: 'src/casts.ts',
    assertions: 'src/assertions.ts',
    config: 'src/app-config.ts',
    testing: 'src/testing.ts',
  },
});
