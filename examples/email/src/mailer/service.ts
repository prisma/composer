/**
 * The mailer service: a plain HTTP app wired to the email module's two ports
 * — `emailSender(templates)` on `email` (the `send` port) and
 * `rpc(emailOutboxContract)` on `outbox` (the `outbox` port). The root wires
 * both to the same `email()` module instance.
 *
 * Imports the compiled `templates.generated.ts` (built by `scripts/build.ts`
 * from `templates.tsx`), not the raw source — the deploy CLI loads this
 * file's import graph with Node's own loader, which has no JSX transform;
 * see `scripts/build.ts` for why.
 */
import node from '@prisma/composer/node';
import { rpc } from '@prisma/composer/service-rpc';
import { compute } from '@prisma/composer-prisma-cloud';
import { emailOutboxContract, emailSender } from '@prisma/composer-prisma-cloud/email';
import { templates } from '../../dist/mailer/templates.generated.ts';

export default compute({
  name: 'mailer',
  deps: { email: emailSender(templates), outbox: rpc(emailOutboxContract) },
  build: node({ module: import.meta.url, entry: '../../dist/mailer/server.mjs' }),
});
