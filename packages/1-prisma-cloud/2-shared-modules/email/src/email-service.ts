/**
 * The email compute service (spec §"Service definition"): a Postgres `db`
 * dependency, the `deliveryMode`/`deliveryUrl`/`from` params, the
 * `deliveryCredential` secret, and the two exposed ports (`send`, `outbox`).
 * Build/entry mechanics copied from storage's service file
 * (`storage/src/storage-service.ts`), not re-derived: `build.module` points
 * at this file's own built output so the deploy bootstrap can re-import it
 * as `main` and call `main.run(address, boot)`; `entry` resolves the
 * sibling entrypoint pass in the same dist directory.
 */
import { param, secret, string } from '@internal/core';
import node from '@internal/node';
import { compute, postgres } from '@internal/prisma-cloud';
import { type } from 'arktype';
import { emailOutboxContract, emailSendContract } from './contract.ts';

const deliveryModeSchema = type("'resend'|'smtp'|'none'");

export function emailService(opts?: { deliveryUrl?: string }) {
  return compute({
    name: 'email',
    deps: { db: postgres() },
    params: {
      deliveryMode: param(deliveryModeSchema),
      deliveryUrl: string({ default: opts?.deliveryUrl ?? 'https://api.resend.com' }),
      from: string(),
    },
    secrets: { deliveryCredential: secret() },
    expose: { send: emailSendContract, outbox: emailOutboxContract },
    build: node({
      module: new URL('./email-service.mjs', import.meta.url).href,
      entry: './email-entrypoint.mjs',
    }),
  });
}

export default emailService();
