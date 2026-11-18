import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    'stop-app-main': 'src/exports/stop-app-main.ts',
  },
});
