import { defineConfig } from '@prisma/compose-tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/postgres/index.ts', 'src/compute/index.ts', 'src/state/index.ts'],
});
