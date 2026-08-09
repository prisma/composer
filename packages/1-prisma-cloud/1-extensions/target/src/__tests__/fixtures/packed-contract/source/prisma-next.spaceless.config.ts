import { defineConfig } from '@prisma/orm-postgres/config';
import { spacelessPack } from '../pack.ts';

// Same shape as prisma-next.config.ts, but the listed pack declares no
// contractSpace — so it satisfies a required pack id while carrying no head at
// all, which is the case the preflight reports as "(no contract space)".
export default defineConfig({
  contract: './contract.ts',
  db: { connection: 'postgres://localhost:5432/placeholder' },
  extensions: [spacelessPack],
});
