import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig } from '@prisma/orm-postgres/config';

export default definePrismaConfig({
  orm: defineConfig({
    contract: './contract.prisma',
    output: '.',
    db: { connection: 'postgres://localhost:5432/placeholder' },
  }),
});
