import { defineConfig } from '@prisma/app-tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/control.ts', 'src/testing.ts'],
});
