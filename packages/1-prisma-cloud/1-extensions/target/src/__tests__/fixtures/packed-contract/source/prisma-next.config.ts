import { defineConfig } from '@prisma-next/postgres/config';
import { gadgetPack } from '../pack.ts';

// `extensions` is the postgres defineConfig option name; it lands in the
// loaded config as `extensionPacks` (the field resolvePrismaNextConfig reads).
export default defineConfig({
  contract: './contract.ts',
  db: { connection: 'postgres://localhost:5432/placeholder' },
  extensions: [gadgetPack],
});
