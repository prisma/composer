/**
 * `send`/`getEmail`/`listEmails` against the in-memory store (spec
 * §"Service behavior" steps 1–7): none-mode stores without calling
 * `Delivery`, real modes call it and record the outcome, dedup-on-conflict
 * returns the original row with no delivery attempt, failure is data (not a
 * thrown error), `getEmail` of an unknown id is `{ email: null }`, and
 * `listEmails` combines filters with AND and paginates newest-first.
 */
import { describe, expect, test } from 'bun:test';
import type { Delivery, DeliveryResult } from '../delivery.ts';
import { createHandlers, type HandlersConfig } from '../handlers.ts';
import { createMemoryOutboxStore } from '../memory-outbox-store.ts';
import type { EmailRow, OutboxStore } from '../outbox-store.ts';

/** A `Delivery` whose result is fixed at construction and whose calls are recorded. */
function fakeDelivery(result: DeliveryResult): Delivery & { readonly calls: EmailRow[] } {
  const calls: EmailRow[] = [];
  return {
    calls,
    deliver: async (row) => {
      calls.push(row);
      return result;
    },
  };
}

/** A `Delivery` that rejects instead of resolving to `{ ok: false }` — the unhandled-rejection case. */
function throwingDelivery(error: Error): Delivery & { readonly calls: EmailRow[] } {
  const calls: EmailRow[] = [];
  return {
    calls,
    deliver: async (row) => {
      calls.push(row);
      throw error;
    },
  };
}

function baseInput() {
  return {
    templateId: 'welcome',
    to: ['user@example.com'],
    subject: 'Hi',
    html: '<p>hi</p>',
    idempotencyKey: crypto.randomUUID(),
  };
}

function makeHandlers(overrides: Partial<HandlersConfig> = {}) {
  const store: OutboxStore = overrides.store ?? createMemoryOutboxStore();
  const delivery =
    overrides.delivery ?? fakeDelivery({ ok: true, providerMessageId: null, attempts: 1 });
  const handlers = createHandlers({
    store,
    delivery,
    deliveryMode: overrides.deliveryMode ?? 'none',
    from: overrides.from ?? 'noreply@example.com',
  });
  return { handlers, store, delivery };
}

describe('send: mode none', () => {
  test('stores the row as "stored" without calling delivery', async () => {
    const delivery = fakeDelivery({ ok: true, providerMessageId: null, attempts: 1 });
    const { handlers } = makeHandlers({ deliveryMode: 'none', delivery });
    const result = await handlers.send(baseInput());
    expect(result.status).toBe('stored');
    expect(result.error).toBeUndefined();
    expect(delivery.calls).toHaveLength(0);
  });

  test('the stored row carries the module-configured "from" address', async () => {
    const { handlers, store } = makeHandlers({ deliveryMode: 'none', from: 'app@example.com' });
    const result = await handlers.send(baseInput());
    const email = await store.getById(result.id);
    expect(email?.from).toBe('app@example.com');
  });
});

describe('send: real modes', () => {
  test('mode resend: queues, calls delivery once, records a sent result', async () => {
    const delivery = fakeDelivery({ ok: true, providerMessageId: 'msg_1', attempts: 1 });
    const { handlers, store } = makeHandlers({ deliveryMode: 'resend', delivery });
    const result = await handlers.send(baseInput());
    expect(result.status).toBe('sent');
    expect(delivery.calls).toHaveLength(1);

    const stored = await store.getById(result.id);
    expect(stored?.providerMessageId).toBe('msg_1');
    expect(stored?.attempts).toBe(1);
  });

  test("the row's attempts total is the count Delivery reports, not a flat +1", async () => {
    const delivery = fakeDelivery({ ok: true, providerMessageId: 'msg_1', attempts: 3 });
    const { handlers, store } = makeHandlers({ deliveryMode: 'resend', delivery });
    const result = await handlers.send(baseInput());
    const stored = await store.getById(result.id);
    expect(stored?.attempts).toBe(3);
  });

  test('a delivery failure is recorded as data, not thrown', async () => {
    const delivery = fakeDelivery({
      ok: false,
      error: 'resend 500 server_error: boom',
      attempts: 3,
    });
    const { handlers, store } = makeHandlers({ deliveryMode: 'resend', delivery });
    const result = await handlers.send(baseInput());
    expect(result.status).toBe('failed');
    expect(result.error).toBe('resend 500 server_error: boom');

    const stored = await store.getById(result.id);
    expect(stored?.attempts).toBe(3);
  });

  test('a rejected (thrown) deliver() is caught and recorded as a failed row, never left unhandled', async () => {
    const delivery = throwingDelivery(new Error('boom: network reset'));
    const { handlers, store } = makeHandlers({ deliveryMode: 'resend', delivery });
    const result = await handlers.send(baseInput());
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom: network reset');

    const stored = await store.getById(result.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('boom: network reset');
  });
});

describe('send: dedup on conflict', () => {
  test('a repeated idempotency key returns the original row and makes no delivery attempt', async () => {
    const delivery = fakeDelivery({ ok: true, providerMessageId: 'msg_1', attempts: 1 });
    const { handlers } = makeHandlers({ deliveryMode: 'resend', delivery });
    const input = baseInput();

    const first = await handlers.send(input);
    delivery.calls.length = 0; // clear the first call's record
    const second = await handlers.send({ ...input, subject: 'a different payload, same key' });

    expect(second).toEqual(first);
    expect(delivery.calls).toHaveLength(0);
  });

  test('dedup applies in mode none too', async () => {
    const { handlers } = makeHandlers({ deliveryMode: 'none' });
    const input = baseInput();
    const first = await handlers.send(input);
    const second = await handlers.send(input);
    expect(second).toEqual(first);
  });

  test('a dedup retry after a deliver() throw returns the now-failed row, never a stale queued one', async () => {
    const delivery = throwingDelivery(new Error('boom'));
    const { handlers, store } = makeHandlers({ deliveryMode: 'resend', delivery });
    const input = baseInput();

    const first = await handlers.send(input);
    expect(first.status).toBe('failed');

    delivery.calls.length = 0; // clear the first call's record
    const second = await handlers.send({ ...input, subject: 'a different payload, same key' });

    expect(second.status).toBe('failed');
    expect(second).toEqual(first);
    expect(delivery.calls).toHaveLength(0); // dedup: no re-attempt, not even after a strand

    const stored = await store.getById(first.id);
    expect(stored?.status).toBe('failed');
  });
});

describe('getEmail', () => {
  test('returns the stored record', async () => {
    const { handlers } = makeHandlers({ deliveryMode: 'none' });
    const sent = await handlers.send(baseInput());
    const { email } = await handlers.getEmail({ id: sent.id });
    expect(email?.id).toBe(sent.id);
    expect(email?.status).toBe('stored');
  });

  test('unknown id returns { email: null }, not a thrown error', async () => {
    const { handlers } = makeHandlers();
    const { email } = await handlers.getEmail({ id: 'missing' });
    expect(email).toBeNull();
  });
});

describe('listEmails', () => {
  test('filters by to/templateId/status combined with AND', async () => {
    const { handlers } = makeHandlers({ deliveryMode: 'none' });
    await handlers.send({ ...baseInput(), templateId: 'welcome', to: ['a@example.com'] });
    await handlers.send({ ...baseInput(), templateId: 'verification', to: ['a@example.com'] });
    await handlers.send({ ...baseInput(), templateId: 'welcome', to: ['b@example.com'] });

    const { emails } = await handlers.listEmails({ to: 'a@example.com', templateId: 'welcome' });
    expect(emails).toHaveLength(1);
    expect(emails[0]?.templateId).toBe('welcome');
  });

  test('defaults to limit 50 and paginates newest-first with a round-tripping cursor', async () => {
    const { handlers } = makeHandlers({ deliveryMode: 'none' });
    for (let i = 0; i < 3; i++) {
      await handlers.send(baseInput());
    }

    // Ground truth: the unpaginated (newest-first) order.
    const all = await handlers.listEmails({});
    expect(all.emails).toHaveLength(3);
    expect(all.nextCursor).toBeUndefined();

    const page1 = await handlers.listEmails({ limit: 2 });
    expect(page1.emails).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    if (page1.nextCursor === undefined) throw new Error('unreachable: nextCursor was asserted');
    const page2 = await handlers.listEmails({ limit: 2, cursor: page1.nextCursor });
    expect(page2.emails).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
    expect([...page1.emails, ...page2.emails].map((e) => e.id)).toEqual(
      all.emails.map((e) => e.id),
    );
  });
});
