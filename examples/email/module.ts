import { module } from '@prisma/composer';
import { envParam, envSecret } from '@prisma/composer-prisma-cloud';
import { email } from '@prisma/composer-prisma-cloud/email';
import mailerService from './src/mailer/service.ts';

/**
 * The email example: a `mailer` app backed by the `email()` module.
 * `deliveryMode`/`from` are module-boundary params bound to platform env
 * vars (production sets `resend`/`smtp`; preview sets `none` — D6, no
 * topology change by stage); `deliveryCredential` is a boundary secret,
 * always required even in `none` mode (D8, the junk-credential wart). The
 * module's `send`/`outbox` ports wire into the mailer's own dependencies —
 * nothing outside this file (and nothing in the mailer's tests) ever calls
 * the module's ports directly.
 *
 * A closed root: no boundary argument, no return — it only provisions.
 */
export default module('email-example', ({ provision }) => {
  const mail = provision(email(), {
    params: {
      deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
      from: envParam('EMAIL_FROM'),
    },
    secrets: { deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') },
  });
  provision(mailerService, { deps: { email: mail.send, outbox: mail.outbox } });
});
