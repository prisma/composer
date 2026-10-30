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
 *
 * The signing key is a secretString() field of the module's input. The root
 * binds it to a platform variable; this module never learns the name.
 */
import { module } from '@prisma/composer';
import { secretString } from '@prisma/composer/arktype';
import { rawPostgres } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';
import { authContract } from './contract.ts';
import authService from './service.ts';

export default module(
  'auth',
  { input: type({ signingKey: secretString() }), expose: { rpc: authContract } },
  ({ input, provision }) => {
    const db = provision(rawPostgres({ name: 'database' }));
    const service = provision(authService, {
      id: 'service',
      deps: { db },
      input: { signingKey: input.signingKey },
    });
    return { rpc: service.rpc };
  },
);
