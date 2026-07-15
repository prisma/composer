/**
 * The auth Module: a reusable unit that owns its own Postgres. Provisions the
 * database and the auth compute service (service.ts), wires the db into the
 * service's `db` input, and exposes the service's `rpc` port as the Module's
 * own output. A consumer never provisions auth's storage itself — it wires
 * only the exposed `rpc` contract (module-composition.md).
 *
 * The database name is "database", not "db": it becomes the provision id (the
 * prisma-cloud target passes that through as the Prisma resource name, and the
 * Connection API rejects names shorter than 3 characters). The wiring key (the
 * service's own input name) stays "db" — the deployed env key derives from
 * that, not the provision id.
 *
 * The auth service keeps an explicit "service" id: its own name is "auth", the
 * same as this enclosing module, so a defaulted id would read as "auth.auth".
 */
import { module, secret } from '@prisma/compose';
import { postgres } from '@prisma/compose-prisma-cloud';
import { authContract } from './contract.ts';
import authService from './service.ts';

export default module(
  'auth',
  // Declare the secret NEED as a forwardable module input; the root binds it to
  // a platform name. This module never learns the name (ADR-0029) — that is the
  // point of the forwarding model.
  { secrets: { signingKey: secret() }, expose: { rpc: authContract } },
  ({ secrets, provision }) => {
    const db = provision(postgres({ name: 'database' }));
    const service = provision(authService, {
      id: 'service',
      deps: { db },
      secrets: { signingKey: secrets.signingKey },
    });
    return { rpc: service.rpc };
  },
);
