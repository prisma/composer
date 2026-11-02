import { module } from '@prisma/composer';
import { envParam, envSecret, serviceOrigin } from '@prisma/composer-prisma-cloud';
import { auth } from '@prisma/composer-prisma-cloud/auth';
import { email } from '@prisma/composer-prisma-cloud/email';
import { postgres } from '@prisma/composer-prisma-cloud/orm';
import apiService from './src/api/service.ts';
import { appContract } from './src/contract.ts';
import opsService from './src/ops/service.ts';

/**
 * The auth example: a database carrying only the auth extension pack, the
 * `auth()` module wired to it, and the `email()` module as auth's email
 * dependency. `api` holds the `api` and `session` ports and the verifier; `ops`
 * holds `admin` and the smoke's read-only outbox. `baseUrl` is the api
 * service's public origin. The email module's input reads its delivery mode
 * and sender with envParam(), from the config adapters in prisma.config.ts;
 * its credential is required even in `none` mode.
 */
export default module('auth-example', ({ provision }) => {
  const db = provision(
    postgres({ name: 'database', contract: appContract, config: './prisma.config.ts' }),
    { id: 'database' },
  );
  const mail = provision(email(), {
    id: 'mail',
    input: {
      deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
      from: envParam('EMAIL_FROM'),
      deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
    },
  });
  const identity = provision(auth(), {
    id: 'auth',
    deps: { db, email: mail.send },
    input: { baseUrl: serviceOrigin('auth-example.api') },
  });
  provision(apiService, {
    id: 'api',
    deps: { authApi: identity.api, verifier: identity.api, session: identity.session },
  });
  provision(opsService, { id: 'ops', deps: { admin: identity.admin, outbox: mail.outbox } });
});
