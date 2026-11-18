import { appRoot } from '@prisma/composer';
import { serviceOrigin, variable } from '@prisma/composer-prisma-cloud';
import { auth } from '@prisma/composer-prisma-cloud/auth';
import { email, emailDeliveryModes } from '@prisma/composer-prisma-cloud/email';
import { postgres } from '@prisma/composer-prisma-cloud/orm';
import { type } from 'arktype';
import apiService from './src/api/service.ts';
import { appContract } from './src/contract.ts';
import opsService from './src/ops/service.ts';

/**
 * The auth example: a database carrying only the auth extension pack, the
 * `auth()` module wired to it, and the `email()` module as auth's email
 * dependency. `api` holds the `api` and `session` ports and the verifier; `ops`
 * holds `admin` and the smoke's read-only outbox. `baseUrl` is the api
 * service's public origin. The email module's delivery mode comes from the
 * root's input, which the deploy reads from the config adapters in
 * prisma.config.ts; the root's schema checks it before anything is created.
 * The sender, EMAIL_FROM, and the credential, EMAIL_DELIVERY_CREDENTIAL, are
 * platform variables the mail service reads at boot: set them on the platform
 * with `prisma project env add`, and in .env for `prisma dev`. The credential
 * is required even in `none` mode.
 */
export default appRoot(
  'auth-example',
  { input: type({ EMAIL_DELIVERY_MODE: type.enumerated(...emailDeliveryModes) }) },
  ({ input, provision }) => {
    const from = provision(variable({ name: 'EMAIL_FROM' }));
    const deliveryCredential = provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }));
    const db = provision(
      postgres({ name: 'database', contract: appContract, config: './prisma.config.ts' }),
      { id: 'database' },
    );
    const mail = provision(email(), {
      id: 'mail',
      input: {
        deliveryMode: input.EMAIL_DELIVERY_MODE,
        from,
        deliveryCredential,
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
  },
);
