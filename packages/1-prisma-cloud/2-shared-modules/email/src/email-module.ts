/**
 * The `email()` module: an email service with its own Postgres `db`, exposing
 * `send` and `outbox` as separate ports, so a consumer that can send cannot
 * read every email ever sent. Its input is `deliveryMode`, `from` and the
 * secret `deliveryCredential`; `deliveryUrl` is a factory option.
 */
import type { ModuleNode } from '@internal/core';
import { module } from '@internal/core';
import { field, secretString } from '@internal/foundation/arktype';
import { rawPostgres } from '@internal/prisma-cloud';
import { type } from 'arktype';
import { emailOutboxContract, emailSendContract } from './contract.ts';
import { emailService } from './email-service.ts';

const emailModuleInput = type({
  deliveryMode: field(type('string')),
  from: field(type('string')),
  deliveryCredential: secretString(),
});

export function email(opts?: {
  name?: string;
  deliveryUrl?: string;
}): ModuleNode<
  Record<never, never>,
  { send: typeof emailSendContract; outbox: typeof emailOutboxContract },
  typeof emailModuleInput
> {
  return module(
    opts?.name ?? 'email',
    { input: emailModuleInput, expose: { send: emailSendContract, outbox: emailOutboxContract } },
    ({ input, provision }) => {
      const db = provision(rawPostgres({ name: 'db' }), { id: 'db' });
      const service = provision(emailService(), {
        id: 'service',
        deps: { db },
        input: {
          deliveryMode: input.deliveryMode,
          deliveryUrl: opts?.deliveryUrl ?? 'https://api.resend.com',
          from: input.from,
          deliveryCredential: input.deliveryCredential,
        },
      });
      return { send: service.send, outbox: service.outbox };
    },
  );
}
