import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig } from '@prisma/orm-postgres/config';

// The pack's own PN project: from this directory, `prisma contract emit`
// regenerates contract.{json,d.ts} from contract.prisma, and `prisma
// migration plan` re-authors the shipped migration packages (reshape the
// planned `migrations/app/<stamp>_<name>/` into `migrations/0001_init/`,
// dropping migration.ts and snapshots/ — see index.ts). Never loaded at
// runtime — consumers get the pack through `@internal/auth/pack`.
export default definePrismaConfig({
  orm: defineConfig({
    contract: './contract.prisma',
    db: { connection: 'postgres://localhost:5432/placeholder' },
  }),
});
