import { type QueueConsumerMessage, serveQueues } from '@prisma/composer-prisma-cloud/queues';
import { demoQueues } from '../queues.ts';
import { page } from './page.ts';
import service from './service.ts';

interface DeliveryEvent extends QueueConsumerMessage<{ text: string }> {
  readonly status: 'failed' | 'consumed';
  readonly eventAt: string;
}

const events: DeliveryEvent[] = [];
const MAX_FEED_MESSAGES = 200;
let failAttemptOne = false;
let failingMessageId: string | undefined;
let failureRecorded = false;

function record(event: DeliveryEvent): void {
  events.unshift(event);
  if (events.length > MAX_FEED_MESSAGES) events.length = MAX_FEED_MESSAGES;
}

const rpcHandler = serveQueues(service, demoQueues, {
  messages: async (message) => {
    if (
      failAttemptOne &&
      message.attempt === 1 &&
      (failingMessageId === undefined || failingMessageId === message.id)
    ) {
      failingMessageId = message.id;
      if (!failureRecorded) {
        failureRecorded = true;
        record({ ...message, status: 'failed', eventAt: new Date().toISOString() });
      }
      throw new Error('retry demo failed this consumer delivery');
    }
    if (failingMessageId === message.id) {
      failAttemptOne = false;
      failingMessageId = undefined;
      failureRecorded = false;
    }
    record({ ...message, status: 'consumed', eventAt: new Date().toISOString() });
  },
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function enqueueInput(
  value: unknown,
): { message: string; count: number; failFirstAttempt: boolean } | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('message' in value) || !('count' in value)) return null;
  if (
    typeof value.message !== 'string' ||
    value.message.length < 1 ||
    value.message.length > 2000
  ) {
    return null;
  }
  if (typeof value.count !== 'number' || !Number.isInteger(value.count)) return null;
  if (value.count < 1 || value.count > 50) return null;
  const failFirstAttempt = 'failFirstAttempt' in value ? value.failFirstAttempt : false;
  if (failFirstAttempt !== undefined && typeof failFirstAttempt !== 'boolean') {
    return null;
  }
  return {
    message: value.message,
    count: value.count,
    failFirstAttempt: failFirstAttempt === true,
  };
}

async function fetchHandler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/rpc/')) return rpcHandler(request);

  if (request.method === 'GET' && url.pathname === '/') {
    return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });
  if (request.method === 'GET' && url.pathname === '/api/consumed') {
    return json({ messages: events });
  }
  if (request.method === 'POST' && url.pathname === '/api/messages') {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: 'Request body must be JSON.' }, 400);
    }
    const input = enqueueInput(raw);
    if (input === null) {
      return json({ error: 'Message must be 1–2000 characters and copies must be 1–50.' }, 400);
    }

    const { queues } = service.load();
    if (input.failFirstAttempt) {
      failAttemptOne = true;
      failingMessageId = undefined;
      failureRecorded = false;
    }
    const ids = await Promise.all(
      Array.from({ length: input.count }, () => queues.messages.send({ text: input.message })),
    );
    return json({ count: ids.length, ids: ids.map(({ id }) => id) }, 202);
  }
  return new Response('Not found', { status: 404 });
}

Bun.serve({ port: service.port(), hostname: '0.0.0.0', fetch: fetchHandler });
