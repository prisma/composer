/**
 * The `email()` module (spec §"Module factory"): a self-contained,
 * deployable email service. It owns its Postgres `db` and the `service`
 * wired to it, and exposes two independent ports (`send`, `outbox`) — the
 * least-privilege split from D4 (a consumer that can send must not
 * automatically read every email ever sent). `deliveryMode` and `from` are
 * module-boundary param slots: the enclosing app must bind a source
 * (`envParam(...)`), so both vary per stage. The db is invisible to
 * consumers, exactly like storage's.
 */
import type { ModuleNode, ParamNeed, SecretNeed } from '@internal/core';
import { module, paramNeed, secret } from '@internal/core';
import { postgres } from '@internal/prisma-cloud';
import { emailOutboxContract, emailSendContract } from './contract.ts';
import { emailService } from './email-service.ts';

export function email(opts?: {
  name?: string;
  deliveryUrl?: string;
}): ModuleNode<
  Record<never, never>,
  { send: typeof emailSendContract; outbox: typeof emailOutboxContract },
  { deliveryCredential: SecretNeed },
  { deliveryMode: ParamNeed; from: ParamNeed }
> {
  return module(
    opts?.name ?? 'email',
    {
      params: { deliveryMode: paramNeed(), from: paramNeed() },
      secrets: { deliveryCredential: secret() },
      expose: { send: emailSendContract, outbox: emailOutboxContract },
    },
    ({ params, secrets, provision }) => {
      const db = provision(postgres({ name: 'db' }), { id: 'db' });
      const service = provision(
        emailService(opts?.deliveryUrl !== undefined ? { deliveryUrl: opts.deliveryUrl } : {}),
        {
          id: 'service',
          deps: { db },
          params: { deliveryMode: params.deliveryMode, from: params.from },
          secrets: { deliveryCredential: secrets.deliveryCredential },
        },
      );
      return { send: service.send, outbox: service.outbox };
    },
  );
}
