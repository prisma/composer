/**
 * The auth System: a reusable unit that owns its own Postgres. Provisions the
 * database and the auth compute service (service.ts), wires the db into the
 * service's `db` input, and exposes the service's `rpc` port as the System's
 * own output. A consumer never provisions auth's storage itself — it wires
 * only the exposed `rpc` contract (system-composition.md).
 *
 * The provision id for the database is "database", not "db": the
 * prisma-cloud target passes it through as the Prisma resource name, and the
 * Connection API rejects names shorter than 3 characters. The wiring key
 * (the service's own input name) stays "db" — the deployed env key derives
 * from that, not the provision id.
 */
import { system } from '@prisma/app';
import { postgres } from '@prisma/app-cloud';
import { authContract } from './contract.ts';
import authService from './service.ts';

export default system('auth', { expose: { rpc: authContract } }, ({ provision }) => {
  const db = provision('database', postgres({ name: 'database' }));
  const service = provision('service', authService, { db });
  return { rpc: service.rpc };
});
