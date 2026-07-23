/**
 * The ops service: the back office — holds the auth module's admin port
 * plus the email module's outbox port (read-only; the ops surface never
 * holds `send`). The outbox wiring backs a smoke-only endpoint that reads a
 * sent verification/magic-link email back through the app's OWN route,
 * never the module's outbox port directly (least-privilege by wiring,
 * mirroring the email example's mailer app).
 */
import node from '@prisma/composer/node';
import { rpc } from '@prisma/composer/service-rpc';
import { compute } from '@prisma/composer-prisma-cloud';
import { authAdminContract } from '@prisma/composer-prisma-cloud/auth';
import { emailOutboxContract } from '@prisma/composer-prisma-cloud/email';

export default compute({
  name: 'ops',
  deps: { admin: rpc(authAdminContract), outbox: rpc(emailOutboxContract) },
  build: node({ module: import.meta.url, entry: '../../dist/ops/server.mjs' }),
});
