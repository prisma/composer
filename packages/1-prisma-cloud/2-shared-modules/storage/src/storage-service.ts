/**
 * The storage service node (like cron's `scheduler.ts` + `scheduler-service.ts`
 * combined): `storageService` builds the `s3-store` service — a Postgres `db`
 * dependency, a minted `credentials` dependency, a `bucket` param, and the
 * `store` port exposing `s3Contract`. The deploy bootstrap runs the
 * default-exported bare node (`main.run(address, boot)`); the real bucket comes
 * from serialized config at runtime, so the default's `bucket` is only a
 * placeholder — exactly like `scheduler-service.ts` default-exports
 * `cronScheduler({ jobs: [] })`.
 */
import { string } from '@internal/core';
import node from '@internal/node';
import { postgres, s3Credentials, s3StoreService } from '@internal/prisma-cloud';
import { s3Contract } from './contract.ts';

export function storageService(opts: { bucket: string }) {
  return s3StoreService({
    name: 'storage',
    deps: { db: postgres(), credentials: s3Credentials() },
    params: { bucket: string({ default: opts.bucket }) },
    build: node({
      module: new URL('./service.mjs', import.meta.url).href,
      entry: './storage-entrypoint.mjs',
    }),
    expose: { store: s3Contract },
  });
}

export default storageService({ bucket: 'storage' });
