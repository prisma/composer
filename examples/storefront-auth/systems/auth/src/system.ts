/**
 * The auth System: a reusable unit that owns its own Postgres. Provisions the
 * database and the auth compute service (service.ts), wires the db into the
 * service's `db` input, and exposes the service's `rpc` port as the System's
 * own output. A consumer never provisions auth's storage itself — it wires
 * only the exposed `rpc` contract (system-composition.md).
 *
 * The database name is "database", not "db": it becomes the provision id (the
 * prisma-cloud target passes that through as the Prisma resource name, and the
 * Connection API rejects names shorter than 3 characters). The wiring key (the
 * service's own input name) stays "db" — the deployed env key derives from
 * that, not the provision id.
 *
 * The auth service keeps an explicit "service" id: its own name is "auth", the
 * same as this enclosing system, so a defaulted id would read as "auth.auth".
 */
import { system } from '@prisma/app';
import { postgres } from '@prisma/app-cloud';
import { authContract } from './contract.ts';
import authService from './service.ts';

export default system('auth', { expose: { rpc: authContract } }, ({ provision }) => {
  const db = provision(postgres({ name: 'database' }));
  const service = provision('service', authService, { db });
  return { rpc: service.rpc };
});
