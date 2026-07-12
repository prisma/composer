import { defineConfig } from '@prisma-next/postgres/config';

export default defineConfig({
  contract: './contract.ts',
  db: { connection: 'postgres://localhost:5432/placeholder' },
});
