/**
 * The in-memory `OutboxStore` proves the same contract the Postgres store
 * implements: dedup-on-conflict, delivery updates increment `attempts`, and
 * `list`'s filters/ordering/keyset pagination.
 */
import { describe, expect, test } from 'bun:test';
import { createMemoryOutboxStore } from '../memory-outbox-store.ts';
import { decodeCursor, encodeCursor, type NewEmailRow } from '../outbox-store.ts';

function row(overrides: Partial<NewEmailRow> = {}): NewEmailRow {
  return {
    id: crypto.randomUUID(),
    templateId: 'welcome',
    to: ['user@example.com'],
    cc: [],
    bcc: [],
    replyTo: null,
    from: 'noreply@example.com',
    subject: 'Hi',
    html: '<p>hi</p>',
    text: null,
    status: 'stored',
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}

describe('insert', () => {
  test('inserts a new row', async () => {
    const store = createMemoryOutboxStore();
    const outcome = await store.insert(row());
    expect(outcome.inserted).toBe(true);
    expect(outcome.row.status).toBe('stored');
    expect(outcome.row.attempts).toBe(0);
    expect(outcome.row.providerMessageId).toBeNull();
    expect(outcome.row.error).toBeNull();
  });

  test('a repeated idempotency key returns the original row without inserting a second one', async () => {
    const store = createMemoryOutboxStore();
    const key = crypto.randomUUID();
    const first = await store.insert(row({ idempotencyKey: key, subject: 'first' }));
    const second = await store.insert(
      row({ idempotencyKey: key, subject: 'different payload, same key' }),
    );

    expect(second.inserted).toBe(false);
    expect(second.row).toEqual(first.row);
    expect(second.row.subject).toBe('first');
  });
});

describe('updateDelivery', () => {
  test('sent: sets providerMessageId, clears error, adds the reported attempts', async () => {
    const store = createMemoryOutboxStore();
    const { row: inserted } = await store.insert(row({ status: 'queued' }));
    const updated = await store.updateDelivery(inserted.id, {
      status: 'sent',
      providerMessageId: 'msg_1',
      attempts: 2,
    });
    expect(updated.status).toBe('sent');
    expect(updated.providerMessageId).toBe('msg_1');
    expect(updated.error).toBeNull();
    expect(updated.attempts).toBe(2);
  });

  test('failed: sets error, leaves providerMessageId null, adds the reported attempts', async () => {
    const store = createMemoryOutboxStore();
    const { row: inserted } = await store.insert(row({ status: 'queued' }));
    const updated = await store.updateDelivery(inserted.id, {
      status: 'failed',
      error: 'boom',
      attempts: 3,
    });
    expect(updated.status).toBe('failed');
    expect(updated.providerMessageId).toBeNull();
    expect(updated.error).toBe('boom');
    expect(updated.attempts).toBe(3);
  });

  test('a second delivery attempt accumulates onto the running total', async () => {
    const store = createMemoryOutboxStore();
    const { row: inserted } = await store.insert(row({ status: 'queued' }));
    await store.updateDelivery(inserted.id, { status: 'failed', error: 'boom', attempts: 1 });
    const second = await store.updateDelivery(inserted.id, {
      status: 'sent',
      providerMessageId: 'msg_1',
      attempts: 2,
    });
    expect(second.attempts).toBe(3);
  });

  test('throws for an unknown id', async () => {
    const store = createMemoryOutboxStore();
    await expect(
      store.updateDelivery('missing', { status: 'failed', error: 'boom', attempts: 1 }),
    ).rejects.toThrow();
  });
});

describe('getById', () => {
  test('null for an unknown id', async () => {
    const store = createMemoryOutboxStore();
    expect(await store.getById('missing')).toBeNull();
  });
});

describe('list', () => {
  test('filters by to (any entry), templateId, and status — combined with AND', async () => {
    const store = createMemoryOutboxStore();
    await store.insert(row({ to: ['a@example.com'], templateId: 'welcome', status: 'stored' }));
    await store.insert(row({ to: ['b@example.com'], templateId: 'welcome', status: 'stored' }));
    await store.insert(
      row({ to: ['a@example.com', 'b@example.com'], templateId: 'verification', status: 'stored' }),
    );

    const byTo = await store.list({ to: 'a@example.com', limit: 50 });
    expect(byTo.rows).toHaveLength(2);

    const byToAndTemplate = await store.list({
      to: 'a@example.com',
      templateId: 'verification',
      limit: 50,
    });
    expect(byToAndTemplate.rows).toHaveLength(1);
    expect(byToAndTemplate.rows[0]?.templateId).toBe('verification');
  });

  test('orders newest-first and paginates by keyset cursor', async () => {
    const store = createMemoryOutboxStore();
    for (let i = 0; i < 5; i++) {
      await store.insert(row());
    }

    // Ground truth: the unpaginated order (created_at desc, id desc).
    const all = await store.list({ limit: 50 });
    expect(all.rows).toHaveLength(5);
    expect(all.hasMore).toBe(false);
    const expectedIds = all.rows.map((r) => r.id);

    const page1 = await store.list({ limit: 2 });
    expect(page1.hasMore).toBe(true);
    expect(page1.rows.map((r) => r.id)).toEqual(expectedIds.slice(0, 2));

    const afterPage1 = page1.rows.at(-1);
    if (afterPage1 === undefined) throw new Error('unreachable: page1 has 2 rows');
    const page2 = await store.list({
      limit: 2,
      after: { createdAt: afterPage1.createdAt, id: afterPage1.id },
    });
    expect(page2.hasMore).toBe(true);
    expect(page2.rows.map((r) => r.id)).toEqual(expectedIds.slice(2, 4));

    const afterPage2 = page2.rows.at(-1);
    if (afterPage2 === undefined) throw new Error('unreachable: page2 has 2 rows');
    const page3 = await store.list({
      limit: 2,
      after: { createdAt: afterPage2.createdAt, id: afterPage2.id },
    });
    expect(page3.hasMore).toBe(false);
    expect(page3.rows.map((r) => r.id)).toEqual(expectedIds.slice(4, 5));
  });
});

describe('cursor codec', () => {
  test('round-trips createdAt and id', () => {
    const cursor = { createdAt: '2026-01-01T00:00:00.000Z', id: 'abc-123' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  test('rejects a malformed cursor', () => {
    expect(() => decodeCursor(Buffer.from('no-separator').toString('base64'))).toThrow();
  });
});
