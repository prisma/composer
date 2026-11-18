import { baseConfig, defineConfig } from '@internal/tsdown-config';

const generated = typeof baseConfig.exports === 'object' ? baseConfig.exports : {};
const generatedExports = generated.customExports;

export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
  },
  exports: {
    ...generated,
    customExports: async (exports, context) => ({
      ...(typeof generatedExports === 'function'
        ? await generatedExports(exports, context)
        : exports),
      './bundling': './src/exports/bundling.ts',
    }),
  },
});
