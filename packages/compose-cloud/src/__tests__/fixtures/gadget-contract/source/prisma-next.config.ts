import { defineConfig } from '@prisma-next/postgres/config';

// PSL-first: the contract source is a `.prisma` file. `defineConfig` picks the
// PSL provider from the `.prisma` extension — same `{ contract: <path> }` shape
// the widget fixture uses to point at its TS source.
export default defineConfig({
  contract: './contract.prisma',
  db: { connection: 'postgres://localhost:5432/placeholder' },
});
