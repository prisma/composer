/**
 * The email compute service (spec §"Service definition"): a Postgres `db`
 * dependency, ONE input schema — `deliveryMode`/`deliveryUrl`/`from` plus the
 * `deliveryCredential` secret leaf (a `SecretString`-typed field, ADR-0042) —
 * and the two exposed ports (`send`, `outbox`). The module (`email-module.ts`)
 * binds the input at provision: forwarded boundary params/secret as leaves,
 * `deliveryUrl` as a literal. Build/entry mechanics copied from storage's
 * service file (`storage/src/storage-service.ts`), not re-derived:
 * `build.module` points at this file's own built output so the deploy
 * bootstrap can re-import it as `main` and call `main.run(address, boot)`;
 * `entry` resolves the sibling entrypoint pass in the same dist directory.
 */
import { secretString } from '@internal/foundation/arktype';
import node from '@internal/node';
import { compute, postgres } from '@internal/prisma-cloud';
import { type } from 'arktype';
import { emailOutboxContract, emailSendContract } from './contract.ts';

const emailInputSchema = type({
  deliveryMode: "'resend'|'smtp'|'none'",
  deliveryUrl: 'string',
  from: 'string',
  deliveryCredential: secretString(),
});

export function emailService() {
  return compute({
    name: 'email',
    deps: { db: postgres() },
    input: emailInputSchema,
    expose: { send: emailSendContract, outbox: emailOutboxContract },
    build: node({
      module: new URL('./email-service.mjs', import.meta.url).href,
      entry: './email-entrypoint.mjs',
    }),
  });
}

export default emailService();
