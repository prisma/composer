/**
 * The mailer example app: a signup story, not an HTTP proxy over the email
 * module's operations. `POST /signup` sends a verification email as part of
 * a real business action; following its link (`GET /verify`) completes the
 * story and sends a welcome email. Routing is Hono — the app brings its own
 * HTTP framework, and since Hono's handler is a plain `Request → Response`
 * function, the same app runs behind `Bun.serve` in the deployed service
 * and inside the integration test with no server.
 *
 *   POST /signup           { "email", "name" } — sends the verification email, responds with its send id
 *   GET  /verify?token=…   marks the user verified, sends the welcome email, responds with its send id
 *   GET  /emails/:id       demo-only read-by-id through the outbox — a real app guards or omits this
 *
 * This surface is deliberately unauthenticated, for the smoke's simplicity
 * — a real app must protect anything that can read the outbox (`GET
 * /emails/:id` especially), since stored bodies contain live links.
 */
import type { Client } from '@prisma/composer/service-rpc';
import type { EmailSender, emailOutboxContract } from '@prisma/composer-prisma-cloud/email';
import { type } from 'arktype';
import { Hono } from 'hono';
import type { templates } from './templates.tsx';

type Templates = typeof templates;
type Outbox = Client<typeof emailOutboxContract>;

const signupBody = type({ email: 'string', name: 'string' });

interface PendingUser {
  readonly email: string;
  readonly name: string;
  verified: boolean;
}

export function createEmailApp(
  email: EmailSender<Templates>,
  outbox: Outbox,
): (req: Request) => Promise<Response> {
  const usersByToken = new Map<string, PendingUser>();
  const app = new Hono();

  app.post('/signup', async (c) => {
    const body = signupBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) return c.json({ error: body.summary }, 400);

    const token = crypto.randomUUID();
    usersByToken.set(token, { email: body.email, name: body.name, verified: false });

    const link = `${new URL(c.req.url).origin}/verify?token=${token}`;
    const sent = await email.verification({ to: body.email, data: { link } });
    return c.json({ id: sent.id }, 201);
  });

  app.get('/verify', async (c) => {
    const token = c.req.query('token');
    const user = token === undefined ? undefined : usersByToken.get(token);
    if (user === undefined) return c.text('unknown or expired token', 404);

    user.verified = true;
    // The token doubles as the welcome send's idempotencyKey — a repeated
    // /verify call (double-click, link-scanner prefetch, refresh) dedups to
    // the original send instead of mailing the welcome email twice.
    const sent = await email.welcome({
      to: user.email,
      data: { name: user.name },
      idempotencyKey: token,
    });
    return c.json({ verified: true, id: sent.id });
  });

  // Demo-only: a real app guards or omits a raw read-by-id — it can surface
  // any stored body, including a live verification link.
  app.get('/emails/:id', async (c) => {
    const { email: record } = await outbox.getEmail({ id: c.req.param('id') });
    if (record === null) return c.text('not found', 404);
    return c.json(record);
  });

  return async (req) => app.fetch(req);
}
