/**
 * The `storage()` module (like cron's `module.ts`): a self-contained,
 * deployable object store. It owns its Postgres `db`, its minted `credentials`,
 * and the storage `service` wired to both, and exposes a single `store` port
 * (`s3Contract`). A consumer provisions it and wires `ref.store` into an `s3()`
 * slot — the module's internals never leak.
 */
import type { ModuleNode } from '@internal/core';
import { module } from '@internal/core';
import { postgres, s3Credentials } from '@internal/prisma-cloud';
import { s3Contract } from './contract.ts';
import { storageService } from './storage-service.ts';

export function storage(opts?: {
  name?: string;
  bucket?: string;
}): ModuleNode<Record<never, never>, { store: typeof s3Contract }> {
  return module(opts?.name ?? 'storage', { expose: { store: s3Contract } }, ({ provision }) => {
    const db = provision(postgres({ name: 'db' }), { id: 'db' });
    const credentials = provision(s3Credentials({ name: 'credentials' }), { id: 'credentials' });
    const service = provision(storageService({ bucket: opts?.bucket ?? 'storage' }), {
      id: 'service',
      deps: { db, credentials },
    });
    return { store: service.store };
  });
}
