// The reusable boot module the auth service's build points `entry` at (see
// authService's `node({ entry: './auth-entrypoint.mjs' })`). Mirrors email's
// entrypoint: load() hands the hydrated `db` and `email` bindings, input() the
// validated input document (baseUrl plus the instance secret as a redacting
// SecretString box, ADR-0041/ADR-0042), port() the reserved listen port — no
// env reads outside the framework accessors, and NO schema work at boot: the
// deploy migrated and marker-signed the auth space before this process exists.

import { serve } from '@internal/service-rpc';
import { composeServiceFetch } from '@internal/service-rpc/compose-fetch';
import { betterAuth } from 'better-auth';
import { buildAuthOptions } from '../auth-options.ts';
import { authService } from '../auth-service.ts';
import { createAuthHandlers } from '../handlers.ts';
import { createPgAuthStore } from '../pg-auth-store.ts';

const service = authService();

const { db, email } = service.load();
const { baseUrl, secret, signUp } = service.input();
const port = service.port();

const auth = betterAuth(
  buildAuthOptions({ databaseUrl: db.url, secret: secret.expose(), baseUrl, email, signUp }),
);

// DB-direct handlers: the ports authorize via wiring, never via
// Better Auth admin sessions — so they speak SQL through the service's own
// store, not auth.api.*.
const handlers = createAuthHandlers(createPgAuthStore(db.url));
const rpcHandler = serve(service, { session: handlers.session, admin: handlers.admin });

// The public Better Auth surface rides under /api/auth (it IS the
// authentication, so no bearer); /rpc/* stays key-checked inside serve().
const fetchHandler = composeServiceFetch({
  rpcHandler,
  publicHandler: { pathPrefix: '/api/auth', handler: auth.handler },
});

Bun.serve({ port, hostname: '0.0.0.0', fetch: fetchHandler });
