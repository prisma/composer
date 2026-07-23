/**
 * The ops service's request handling — a minimal admin passthrough proving
 * the admin port wires to a SECOND service (least-privilege by wiring).
 * Routing is Hono, the email example's pattern.
 *
 *   /admin/find-user               → POST { email } → findUser
 *   /admin/revoke-user-sessions    → POST { userId } → revokeUserSessions
 *   /admin/find-sent-email         → POST { to, templateId } → the outbox
 *                                     port's listEmails, most recent first —
 *                                     the smoke script's own route onto the
 *                                     email module's outbox (never the raw
 *                                     port), proving the module-depends-on-
 *                                     module wiring against a real deploy.
 *   /health                        → 200
 */
import type { Client } from '@prisma/composer/service-rpc';
import type { authAdminContract } from '@prisma/composer-prisma-cloud/auth';
import type { emailOutboxContract } from '@prisma/composer-prisma-cloud/email';
import { type } from 'arktype';
import { Hono } from 'hono';

const findUserBody = type({ email: 'string' });
const revokeBody = type({ userId: 'string' });
const findSentEmailBody = type({ to: 'string', 'templateId?': 'string' });

export interface OpsDeps {
  /** The admin rpc port, typed straight off its contract — the same client shape `rpc(authAdminContract)` hydrates. */
  readonly admin: Client<typeof authAdminContract>;
  /** The email module's outbox port, read-only — this service never holds `send`. */
  readonly outbox: Client<typeof emailOutboxContract>;
}

export function createOpsApp(deps: OpsDeps): (request: Request) => Promise<Response> {
  const app = new Hono();

  app.post('/admin/find-user', async (c) => {
    const body = findUserBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) return c.json({ error: 'email required' }, 400);
    return c.json(await deps.admin.findUser({ email: body.email }));
  });

  app.post('/admin/revoke-user-sessions', async (c) => {
    const body = revokeBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) return c.json({ error: 'userId required' }, 400);
    return c.json(await deps.admin.revokeUserSessions({ userId: body.userId }));
  });

  app.post('/admin/find-sent-email', async (c) => {
    const body = findSentEmailBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) return c.json({ error: 'to required' }, 400);
    const { emails } = await deps.outbox.listEmails(
      body.templateId === undefined
        ? { to: body.to }
        : { to: body.to, templateId: body.templateId },
    );
    const latest = emails[0];
    if (latest === undefined) return c.json({ error: 'no email found' }, 404);
    return c.json(latest);
  });

  app.all('/health', (c) => c.json({ ok: true }));
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  return async (request) => app.fetch(request);
}
