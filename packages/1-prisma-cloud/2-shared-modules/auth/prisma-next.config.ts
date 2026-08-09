// The pack's own PN project: `prisma-next contract emit` regenerates
// src/pack/contract.{json,d.ts} from contract.prisma, and the migration
// tooling authors the shipped migration packages against it. Never loaded at
// runtime — consumers get the pack through `@internal/auth/pack`.
import { defineConfig } from '@prisma/orm-postgres/config';

export default defineConfig({
  contract: './src/pack/contract.prisma',
  migrations: { dir: './src/pack/migrations' },
  db: { connection: 'postgres://localhost:5432/placeholder' },
});
