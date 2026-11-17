import { appRoot } from '@prisma/composer';
import { variable } from '@prisma/composer-prisma-cloud';
import { email, emailDeliveryModes } from '@prisma/composer-prisma-cloud/email';
import { type } from 'arktype';
import mailerService from './src/mailer/service.ts';

/**
 * The email example: a `mailer` app backed by the `email()` module. The root's
 * input comes from the config adapters in prisma.config.ts, and its schema
 * checks the delivery mode before anything is created. The credential is a
 * platform secret the root provisions; it is required even in `none` mode.
 */
export default appRoot(
  'email-example',
  {
    input: type({
      EMAIL_DELIVERY_MODE: type.enumerated(...emailDeliveryModes),
      EMAIL_FROM: 'string',
    }),
  },
  ({ input, provision }) => {
    const deliveryCredential = provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }));
    const mail = provision(email(), {
      input: {
        deliveryMode: input.EMAIL_DELIVERY_MODE,
        from: input.EMAIL_FROM,
        deliveryCredential,
      },
    });
    provision(mailerService, { deps: { email: mail.send, outbox: mail.outbox } });
  },
);
