import { defineConfig } from '@prisma/orm-postgres/config';

export default defineConfig({
  contract: './contract.ts',
  output: '../emitted',
  db: { connection: 'postgres://localhost:5432/placeholder' },
});
