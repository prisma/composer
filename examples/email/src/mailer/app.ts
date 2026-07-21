/**
 * The mailer example app: a plain HTTP surface over the email module's two
 * ports, wired through the app's own dependencies — never through the
 * module's ports directly. `POST /send/:template` calls a typed template
 * method (validates `data`, renders, calls the `send` port); `GET
 * /emails/:id` and `GET /emails` read back through the `outbox` port. The
 * deploy smoke and the local integration test both drive this same
 * `Request → Response` handler — an external request to this app is the
 * only way either proves the send actually happened (spec's end-to-end
 * requirement).
 *
 *   POST /send/welcome       { "to", "name", "idempotencyKey"? }
 *   POST /send/verification  { "to", "link", "idempotencyKey"? }
 *   GET  /emails/:id
 *   GET  /emails             optional ?to=&templateId=&status=&cursor=&limit=
 *
 * `createEmailApp` returns a plain handler so the same app runs behind
 * `Bun.serve` in the deployed service and inside the integration test with
 * no server (mirrors the storage example's `createBlobApp`).
 *
 * This surface is deliberately unauthenticated, for the smoke's simplicity
 * — a real app must protect anything that can read the outbox (`GET
 * /emails` especially), since stored bodies contain live links.
 */

import type { Client } from '@prisma/composer/service-rpc';
import type { EmailSender, emailOutboxContract } from '@prisma/composer-prisma-cloud/email';
import type { templates } from './templates.ts';

type Templates = typeof templates;
type Outbox = Client<typeof emailOutboxContract>;

interface SendBody {
  readonly to: string;
  readonly [key: string]: unknown;
}

function isSendBody(value: unknown): value is SendBody {
  return (
    typeof value === 'object' && value !== null && 'to' in value && typeof value.to === 'string'
  );
}

type EmailStatus = 'stored' | 'queued' | 'sent' | 'failed';
const EMAIL_STATUSES: readonly string[] = ['stored', 'queued', 'sent', 'failed'];

function isEmailStatus(value: string): value is EmailStatus {
  return EMAIL_STATUSES.includes(value);
}

/** Forwarded to `emailSender`'s method only when the caller supplies one — otherwise it mints its own per spec's default. */
function idempotencyKeyOf(body: SendBody): string | undefined {
  return typeof body['idempotencyKey'] === 'string' ? body['idempotencyKey'] : undefined;
}

async function handleSendWelcome(email: EmailSender<Templates>, req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => undefined);
  if (!isSendBody(body) || typeof body['name'] !== 'string') {
    return Response.json({ error: '"to" and "name" are required strings' }, { status: 400 });
  }
  const idempotencyKey = idempotencyKeyOf(body);
  const result = await email.welcome({
    to: body.to,
    data: { name: body['name'] },
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  });
  return Response.json(result, { status: 201 });
}

async function handleSendVerification(
  email: EmailSender<Templates>,
  req: Request,
): Promise<Response> {
  const body: unknown = await req.json().catch(() => undefined);
  if (!isSendBody(body) || typeof body['link'] !== 'string') {
    return Response.json({ error: '"to" and "link" are required strings' }, { status: 400 });
  }
  const idempotencyKey = idempotencyKeyOf(body);
  const result = await email.verification({
    to: body.to,
    data: { link: body['link'] },
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  });
  return Response.json(result, { status: 201 });
}

async function handleGetEmail(outbox: Outbox, id: string): Promise<Response> {
  const { email } = await outbox.getEmail({ id });
  if (email === null) return new Response('not found', { status: 404 });
  return Response.json(email);
}

async function handleListEmails(outbox: Outbox, url: URL): Promise<Response> {
  const params = url.searchParams;
  const to = params.get('to');
  const templateId = params.get('templateId');
  const status = params.get('status');
  const cursor = params.get('cursor');
  const limitRaw = params.get('limit');
  const result = await outbox.listEmails({
    ...(to !== null ? { to } : {}),
    ...(templateId !== null ? { templateId } : {}),
    // An unrecognized status is dropped rather than forwarded — the filter is
    // just ignored, not a 400; the app owns validating its own query params.
    ...(status !== null && isEmailStatus(status) ? { status } : {}),
    ...(cursor !== null ? { cursor } : {}),
    ...(limitRaw !== null && Number.isFinite(Number(limitRaw)) ? { limit: Number(limitRaw) } : {}),
  });
  return Response.json(result);
}

export function createEmailApp(
  email: EmailSender<Templates>,
  outbox: Outbox,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/' || path === '/health') {
      return new Response(
        'mailer example — POST /send/welcome, POST /send/verification, GET /emails/:id, GET /emails\n',
        { status: 200 },
      );
    }

    if (req.method === 'POST' && path === '/send/welcome') return handleSendWelcome(email, req);
    if (req.method === 'POST' && path === '/send/verification') {
      return handleSendVerification(email, req);
    }

    if (req.method === 'GET' && path === '/emails') return handleListEmails(outbox, url);
    if (req.method === 'GET' && path.startsWith('/emails/')) {
      const id = decodeURIComponent(path.slice('/emails/'.length));
      if (id.length === 0) return new Response('missing id', { status: 400 });
      return handleGetEmail(outbox, id);
    }

    return new Response('not found', { status: 404 });
  };
}
