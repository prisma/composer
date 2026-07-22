/**
 * `pg-outbox-store` against a real local Postgres: DDL idempotence (creating
 * the store twice against the same database does not error), the
 * unique-key conflict path, array filters (`to` matching any entry), and
 * keyset pagination — the same contract `memory-outbox-store.test.ts`
 * proves against the in-memory store.
 *
 * Skipped only on a dev machine with no Postgres; on CI the harness throws
 * if none is available (see pg-harness.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { NewEmailRow, OutboxStore } from '../outbox-store.ts';
import { createPgOutboxStore } from '../pg-outbox-store.ts';
import { createTestDatabase, startTestPostgres, type TestDatabase } from './pg-harness.ts';

const pg = startTestPostgres();
const suite = pg ? describe : describe.skip;

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

suite('pg-outbox-store integration (local Postgres)', () => {
  let db: TestDatabase;
  let store: OutboxStore;

  beforeAll(async () => {
    const base = pg;
    if (!base) throw new Error('no Postgres available');
    db = await createTestDatabase(base.url);
    store = await createPgOutboxStore(db.url);
  });

  afterAll(async () => {
    await db?.drop();
    pg?.stop();
  });

  test('DDL is idempotent — connecting a second store to the same database does not error', async () => {
    await expect(createPgOutboxStore(db.url)).resolves.toBeDefined();
  });

  test('insert then getById round-trips every column', async () => {
    const inserted = await store.insert(
      row({
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        replyTo: 'reply@example.com',
        text: 'hi',
      }),
    );
    expect(inserted.inserted).toBe(true);

    const fetched = await store.getById(inserted.row.id);
    expect(fetched).toEqual(inserted.row);
    expect(fetched?.cc).toEqual(['cc@example.com']);
    expect(fetched?.bcc).toEqual(['bcc@example.com']);
    expect(fetched?.replyTo).toBe('reply@example.com');
    expect(fetched?.text).toBe('hi');
    expect(fetched?.attempts).toBe(0);
    expect(typeof fetched?.createdAt).toBe('string');
  });

  test('a repeated idempotency key conflicts and returns the original row, no second insert', async () => {
    const key = crypto.randomUUID();
    const first = await store.insert(row({ idempotencyKey: key, subject: 'first' }));
    const second = await store.insert(row({ idempotencyKey: key, subject: 'second, ignored' }));

    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.subject).toBe('first');
  });

  test('updateDelivery adds the reported attempts and sets status/providerMessageId/error', async () => {
    const { row: inserted } = await store.insert(row({ status: 'queued' }));
    const sent = await store.updateDelivery(inserted.id, {
      status: 'sent',
      providerMessageId: 'msg_1',
      attempts: 1,
    });
    expect(sent.status).toBe('sent');
    expect(sent.providerMessageId).toBe('msg_1');
    expect(sent.error).toBeNull();
    expect(sent.attempts).toBe(1);

    const failed = await store.updateDelivery(inserted.id, {
      status: 'failed',
      error: 'boom',
      attempts: 2,
    });
    expect(failed.status).toBe('failed');
    expect(failed.providerMessageId).toBeNull();
    expect(failed.error).toBe('boom');
    expect(failed.attempts).toBe(3);
  });

  test('getById returns null for an unknown id', async () => {
    expect(await store.getById(crypto.randomUUID())).toBeNull();
  });

  test('list filters by to (array membership), templateId, and status, combined with AND', async () => {
    const marker = crypto.randomUUID();
    await store.insert(
      row({ to: [`a-${marker}@example.com`], templateId: 'welcome', status: 'stored' }),
    );
    await store.insert(
      row({ to: [`b-${marker}@example.com`], templateId: 'welcome', status: 'stored' }),
    );
    const { row: verificationRow } = await store.insert(
      row({
        to: [`a-${marker}@example.com`, `b-${marker}@example.com`],
        templateId: 'verification',
        status: 'queued',
      }),
    );
    await store.updateDelivery(verificationRow.id, {
      status: 'sent',
      providerMessageId: null,
      attempts: 1,
    });

    const byTo = await store.list({ to: `a-${marker}@example.com`, limit: 50 });
    expect(byTo.rows).toHaveLength(2);

    const byToAndStatus = await store.list({
      to: `a-${marker}@example.com`,
      status: 'sent',
      limit: 50,
    });
    expect(byToAndStatus.rows).toHaveLength(1);
    expect(byToAndStatus.rows[0]?.templateId).toBe('verification');
  });

  test('list paginates newest-first via keyset cursor', async () => {
    const marker = crypto.randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { row: inserted } = await store.insert(row({ templateId: `page-${marker}` }));
      ids.push(inserted.id);
    }

    const all = await store.list({ templateId: `page-${marker}`, limit: 50 });
    expect(all.rows).toHaveLength(5);
    expect(all.hasMore).toBe(false);
    const expectedIds = all.rows.map((r) => r.id);

    const page1 = await store.list({ templateId: `page-${marker}`, limit: 2 });
    expect(page1.hasMore).toBe(true);
    expect(page1.rows.map((r) => r.id)).toEqual(expectedIds.slice(0, 2));

    const afterPage1 = page1.rows.at(-1);
    if (afterPage1 === undefined) throw new Error('unreachable: page1 has 2 rows');
    const page2 = await store.list({
      templateId: `page-${marker}`,
      limit: 2,
      after: { createdAt: afterPage1.createdAt, id: afterPage1.id },
    });
    expect(page2.hasMore).toBe(true);
    expect(page2.rows.map((r) => r.id)).toEqual(expectedIds.slice(2, 4));

    const afterPage2 = page2.rows.at(-1);
    if (afterPage2 === undefined) throw new Error('unreachable: page2 has 2 rows');
    const page3 = await store.list({
      templateId: `page-${marker}`,
      limit: 2,
      after: { createdAt: afterPage2.createdAt, id: afterPage2.id },
    });
    expect(page3.hasMore).toBe(false);
    expect(page3.rows.map((r) => r.id)).toEqual(expectedIds.slice(4, 5));
  });
});
