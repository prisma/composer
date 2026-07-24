/**
 * The storage service node (like cron's `scheduler.ts` + `scheduler-service.ts`
 * combined): `storageService` builds the `s3-store` service — a Postgres `db`
 * dependency, a minted `credentials` dependency, a `bucket` input key
 * (bound at provision by `storage()`, ADR-0042), and the `store` port exposing
 * `s3Contract`. The deploy bootstrap runs the default-exported bare node
 * (`main.run(address, boot)`); the real bucket comes from the stashed input
 * document at runtime — exactly like `scheduler-service.ts` default-exports a
 * schedule-free `cronScheduler()`.
 */
import node from '@internal/node';
import { postgres, s3Credentials, s3StoreService } from '@internal/prisma-cloud';
import { type } from 'arktype';
import { s3Contract } from './contract.ts';

const storageInputSchema = type({ bucket: 'string' });

export function storageService() {
  return s3StoreService({
    name: 'storage',
    deps: { db: postgres(), credentials: s3Credentials() },
    input: storageInputSchema,
    build: node({
      module: new URL('./storage-service.mjs', import.meta.url).href,
      entry: './storage-entrypoint.mjs',
    }),
    expose: { store: s3Contract },
  });
}

export default storageService();
