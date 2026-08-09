import { defineConfig } from '@prisma/orm-postgres/config';

export default defineConfig({
  contract: './contract.prisma',
  output: '../emitted',
  db: { connection: 'postgres://localhost:5432/placeholder' },
});
