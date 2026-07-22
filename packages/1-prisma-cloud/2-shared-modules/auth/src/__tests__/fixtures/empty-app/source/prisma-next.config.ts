import { defineConfig } from '@prisma-next/postgres/config';

export default defineConfig({
  contract: './contract.prisma',
  outputPath: '../emitted',
  db: { connection: 'postgres://localhost:5432/placeholder' },
});
