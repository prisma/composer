/**
 * The ops service's request handling — a minimal admin passthrough proving
 * the admin port wires to a SECOND service (least-privilege by wiring).
 * The service has a public URL, so every `/admin/*` route requires
 * `Authorization: Bearer <operatorToken>` (401 otherwise) — without it,
 * anyone could look up a user and delete the account.
 * Routing is Hono, the email example's pattern.
 *
 *   /admin/find-user               → POST { email } → findUser
 *   /admin/revoke-user-sessions    → POST { userId } → revokeUserSessions
 *   /admin/remove-user             → POST { userId } → removeUser (account
 *                                     deletion: the user row, its sessions,
 *                                     accounts, and pending verifications)
 *   /admin/find-sent-email         → POST { to, templateId } → the outbox
 *                                     port's listEmails, most recent first —
 *                                     the smoke script's own route onto the
 *                                     email module's outbox (never the raw
 *                                     port), proving the module-depends-on-
 *                                     module wiring against a real deploy.
 *   /health                        → 200
 */
import { type } from 'arktype';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import type opsService from './service.ts';

const findUserBody = type({ email: 'string' });
const userIdBody = type({ userId: 'string' });
const findSentEmailBody = type({ to: 'string', 'templateId?': 'string' });

export function createOpsApp(
  deps: ReturnType<typeof opsService.load>,
  operatorToken: string,
): (request: Request) => Promise<Response> {
  const app = new Hono();
  app.use('/admin/*', bearerAuth({ token: operatorToken }));

  app.post('/admin/find-user', async (c) => {
    const body = findUserBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) return c.json({ error: 'email required' }, 400);
    return c.json(await deps.admin.findUser({ email: body.email }));
  });

  app.post('/admin/revoke-user-sessions', async (c) => {
    const body = userIdBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) return c.json({ error: 'userId required' }, 400);
    return c.json(await deps.admin.revokeUserSessions({ userId: body.userId }));
  });

  app.post('/admin/remove-user', async (c) => {
    const body = userIdBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) return c.json({ error: 'userId required' }, 400);
    return c.json(await deps.admin.removeUser({ userId: body.userId }));
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
