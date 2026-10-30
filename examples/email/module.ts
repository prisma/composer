import { module } from '@prisma/composer';
import { envSecret } from '@prisma/composer-prisma-cloud';
import { email } from '@prisma/composer-prisma-cloud/email';
import { type } from 'arktype';
import mailerService from './src/mailer/service.ts';

/**
 * The email example: a `mailer` app backed by the `email()` module. The root's
 * input comes from the config adapters in prisma.config.ts, and its schema
 * checks the delivery mode before anything is created. The credential is a
 * secret, bound with envSecret(); it is required even in `none` mode.
 */
export default module(
  'email-example',
  { input: type({ EMAIL_DELIVERY_MODE: "'resend' | 'smtp' | 'none'", EMAIL_FROM: 'string' }) },
  ({ input, provision }) => {
    const mail = provision(email(), {
      input: {
        deliveryMode: input.EMAIL_DELIVERY_MODE,
        from: input.EMAIL_FROM,
        deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
      },
    });
    provision(mailerService, { deps: { email: mail.send, outbox: mail.outbox } });
  },
);
