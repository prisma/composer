// The reusable boot module the email service's build points `entry` at (see
// emailService's `node({ entry: './email-entrypoint.mjs' })`). Mirrors
// storage's entrypoint: load() hands the hydrated `db` binding, config()
// the params, secrets() the credential; this is where the pg outbox store
// (D2), the delivery backing (D3, chosen by deliveryMode), and handlers.ts
// meet the framework, served over serve()'s generated fetch handler.

import { serve } from '@internal/service-rpc';
import type { Delivery } from '../delivery.ts';
import { noneDelivery } from '../delivery.ts';
import { createResendDelivery } from '../delivery-resend.ts';
import { createSmtpDelivery } from '../delivery-smtp.ts';
import { emailService } from '../email-service.ts';
import { createHandlers } from '../handlers.ts';
import { createPgOutboxStore } from '../pg-outbox-store.ts';
import { checkDeliveryUrl } from './check-delivery-url.ts';

const service = emailService();

const { db } = service.load();
const { deliveryMode, deliveryUrl, from, port } = service.config();
const { deliveryCredential } = service.secrets();

const deliveryUrlError = checkDeliveryUrl(deliveryMode, deliveryUrl);
if (deliveryUrlError !== null) throw new Error(deliveryUrlError);

const store = await createPgOutboxStore(db.url);

const delivery: Delivery =
  deliveryMode === 'resend'
    ? createResendDelivery({ deliveryUrl, credential: deliveryCredential })
    : deliveryMode === 'smtp'
      ? createSmtpDelivery({ deliveryUrl, credential: deliveryCredential })
      : noneDelivery;

const handlers = createHandlers({ store, delivery, deliveryMode, from });

const fetchHandler = serve(service, {
  send: { send: handlers.send },
  outbox: { getEmail: handlers.getEmail, listEmails: handlers.listEmails },
});

Bun.serve({ port, hostname: '0.0.0.0', fetch: fetchHandler });
