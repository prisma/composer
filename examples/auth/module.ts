import { module } from '@prisma/composer';
import { envParam, envSecret } from '@prisma/composer-prisma-cloud';
import { auth } from '@prisma/composer-prisma-cloud/auth';
import { email } from '@prisma/composer-prisma-cloud/email';
import { pnPostgres } from '@prisma/composer-prisma-cloud/prisma-next';
import apiService from './src/api/service.ts';
import { appContract } from './src/contract.ts';
import opsService from './src/ops/service.ts';

/**
 * The auth example: a dedicated Prisma Next database carrying ONLY the auth
 * extension pack (empty app space), the `auth()` module wired to it, the
 * `email()` module wired as its `email` boundary dep (verification/reset/
 * magic-link delivery — the module-depends-on-module proof), and two
 * consumer services proving least-privilege wiring:
 *
 *   - `api` — the app origin: proxies `/api/auth/*` to the auth service,
 *     JWT-verifies `/me`, and answers session lookups. Holds the `api` +
 *     `session` ports and the verifier; CANNOT touch admin ops.
 *   - `ops` — the back office: holds ONLY the `admin` port.
 *
 * `baseUrl` is the PUBLIC origin browsers would see (the api service).
 * `deliveryMode`/`from` are the email module's own boundary params, bound to
 * env vars like the email example, so a stage changes delivery without
 * changing the topology;
 * `deliveryCredential` is a boundary secret, unconditionally required even
 * in `none` mode (the junk-credential wart shared with the email example —
 * the env file binds a junk value for `none`). A closed root: no boundary
 * argument, no return — it only provisions.
 */
export default module('auth-example', ({ provision }) => {
  const db = provision(
    pnPostgres({ name: 'database', contract: appContract, config: './prisma-next.config.ts' }),
    { id: 'database' },
  );
  const mail = provision(email(), {
    id: 'mail',
    params: {
      deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
      from: envParam('EMAIL_FROM'),
    },
    secrets: { deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') },
  });
  const identity = provision(auth(), {
    id: 'auth',
    deps: { db, email: mail.send },
    params: { baseUrl: envParam('AUTH_BASE_URL') },
  });
  provision(apiService, {
    id: 'api',
    deps: { authApi: identity.api, verifier: identity.api, session: identity.session },
  });
  provision(opsService, { id: 'ops', deps: { admin: identity.admin, outbox: mail.outbox } });
});
