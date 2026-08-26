import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig } from '@prisma/orm-postgres/config';
import { gadgetPack } from '../pack.ts';

// `extensions` is the postgres defineConfig option name; resolveOrmConfig
// reads it and hands it on as `extensionPacks`, Composer's own word for it.
export default definePrismaConfig({
  orm: defineConfig({
    contract: './contract.ts',
    db: { connection: 'postgres://localhost:5432/placeholder' },
    extensions: [gadgetPack],
  }),
});
