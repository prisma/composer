/**
 * The `OutboxStore` over Postgres (spec DDL verbatim). Schema is applied
 * idempotently at first connect behind the same cold-start retry storage
 * uses (`storage/src/pg-store.ts`) — copied, not re-derived. Filters combine
 * with AND; `to` matches `$n = any(to_addrs)`. Keyset pagination compares
 * the `(created_at, id)` tuple against the decoded cursor.
 *
 * `created_at`/`updated_at` are written as `date_trunc('milliseconds',
 * now())` rather than the DDL's plain `now()` default, because the
 * row-mapping layer reads timestamps back as a JS `Date` (millisecond
 * precision). Writing at that same precision means the raw column can be
 * ordered/compared directly — `list` needs no `date_trunc` at read time,
 * so `emails_created_at_id_idx` (a plain column index) still applies.
 *
 * Runtime engine code (Bun's `SQL`); NOT re-exported from the authoring
 * barrel.
 */
import { retryTransientConnect } from '@internal/prisma-cloud/connection';
import { SQL } from 'bun';
import type {
  DeliveryUpdate,
  EmailRow,
  EmailStatus,
  InsertOutcome,
  ListFilters,
  ListPage,
  NewEmailRow,
  OutboxStore,
} from './outbox-store.ts';

interface PgEmailRow {
  readonly id: string;
  readonly template_id: string;
  readonly to_addrs: unknown;
  readonly cc_addrs: unknown;
  readonly bcc_addrs: unknown;
  readonly reply_to: string | null;
  readonly from_addr: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string | null;
  readonly status: EmailStatus;
  readonly provider_message_id: string | null;
  readonly error: string | null;
  readonly idempotency_key: string;
  readonly attempts: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

/** Postgres arrays come back as JS arrays already; fail closed on anything else rather than returning wrong data. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  throw new TypeError(`expected a Postgres array to decode as an array, got ${typeof value}`);
}

/** timestamptz comes back as a Date; fail closed on anything else. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(`expected timestamptz to decode as a Date, got ${typeof value}`);
}

function toEmailRow(row: PgEmailRow): EmailRow {
  return {
    id: row.id,
    templateId: row.template_id,
    to: toStringArray(row.to_addrs),
    cc: toStringArray(row.cc_addrs),
    bcc: toStringArray(row.bcc_addrs),
    replyTo: row.reply_to,
    from: row.from_addr,
    subject: row.subject,
    html: row.html,
    text: row.text,
    status: row.status,
    providerMessageId: row.provider_message_id,
    error: row.error,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

class PgOutboxStore implements OutboxStore {
  constructor(private readonly sql: SQL) {}

  async insert(row: NewEmailRow): Promise<InsertOutcome> {
    const inserted = await this.sql<PgEmailRow[]>`
      insert into emails (
        id, template_id, to_addrs, cc_addrs, bcc_addrs, reply_to, from_addr,
        subject, html, text, status, idempotency_key, created_at, updated_at
      ) values (
        ${row.id}, ${row.templateId}, ${this.sql.array([...row.to], 'text')},
        ${this.sql.array([...row.cc], 'text')}, ${this.sql.array([...row.bcc], 'text')},
        ${row.replyTo}, ${row.from}, ${row.subject}, ${row.html}, ${row.text},
        ${row.status}, ${row.idempotencyKey},
        date_trunc('milliseconds', now()), date_trunc('milliseconds', now())
      )
      on conflict (idempotency_key) do nothing
      returning *`;
    const insertedRow = inserted[0];
    if (insertedRow !== undefined) {
      return { row: toEmailRow(insertedRow), inserted: true };
    }

    const existing = await this.sql<
      PgEmailRow[]
    >`select * from emails where idempotency_key = ${row.idempotencyKey}`;
    const existingRow = existing[0];
    if (existingRow === undefined) {
      throw new Error(
        `outbox insert conflicted on idempotency_key ${row.idempotencyKey} but no existing row was found`,
      );
    }
    return { row: toEmailRow(existingRow), inserted: false };
  }

  async updateDelivery(id: string, update: DeliveryUpdate): Promise<EmailRow> {
    // One parameterized query for both outcomes — sent/failed differ only in
    // which of providerMessageId/error carries a value, so branching on
    // status here would risk a future field change landing on only one path.
    const providerMessageId = update.status === 'sent' ? update.providerMessageId : null;
    const error = update.status === 'failed' ? update.error : null;
    const rows = await this.sql<PgEmailRow[]>`
      update emails set
        status = ${update.status}, provider_message_id = ${providerMessageId},
        error = ${error}, attempts = attempts + ${update.attempts},
        updated_at = date_trunc('milliseconds', now())
      where id = ${id}
      returning *`;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`outbox updateDelivery: no row found for id ${id}`);
    }
    return toEmailRow(row);
  }

  async getById(id: string): Promise<EmailRow | null> {
    const rows = await this.sql<PgEmailRow[]>`select * from emails where id = ${id}`;
    const row = rows[0];
    return row === undefined ? null : toEmailRow(row);
  }

  async list(filters: ListFilters): Promise<ListPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.to !== undefined) {
      params.push(filters.to);
      conditions.push(`$${params.length} = any(to_addrs)`);
    }
    if (filters.templateId !== undefined) {
      params.push(filters.templateId);
      conditions.push(`template_id = $${params.length}`);
    }
    if (filters.status !== undefined) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filters.after !== undefined) {
      params.push(filters.after.createdAt, filters.after.id);
      const createdAtIdx = params.length - 1;
      const idIdx = params.length;
      conditions.push(`(created_at, id) < ($${createdAtIdx}::timestamptz, $${idIdx}::uuid)`);
    }

    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
    params.push(filters.limit + 1); // one extra row tells us whether more remain
    const limitIdx = params.length;

    const rows = await this.sql.unsafe<PgEmailRow[]>(
      `select * from emails ${where} order by created_at desc, id desc limit $${limitIdx}`,
      params,
    );
    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    return { rows: page.map(toEmailRow), hasMore };
  }
}

/**
 * Connect (`max: 1`, matching storage's cold-start posture), apply the
 * schema idempotently behind the retry, and return the store.
 */
export async function createPgOutboxStore(url: string): Promise<OutboxStore> {
  const sql = new SQL({ url, max: 1, idleTimeout: 10 });
  await retryTransientConnect(
    () => sql`
      create table if not exists emails (
        id uuid primary key,
        template_id text not null,
        to_addrs text[] not null,
        cc_addrs text[] not null default '{}',
        bcc_addrs text[] not null default '{}',
        reply_to text,
        from_addr text not null,
        subject text not null,
        html text not null,
        text text,
        status text not null check (status in ('stored','queued','sent','failed')),
        provider_message_id text,
        error text,
        idempotency_key text not null unique,
        attempts integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
  );
  await sql`create index if not exists emails_created_at_id_idx on emails (created_at desc, id desc)`;
  return new PgOutboxStore(sql);
}
