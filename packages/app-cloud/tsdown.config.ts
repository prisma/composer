import { defineConfig } from '@prisma/app-tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/control.ts', 'src/prisma-next.ts', 'src/testing.ts'],
});
