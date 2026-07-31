import { retryTransientConnect } from '@internal/prisma-cloud/connection';
import { SQL } from 'bun';
import type {
  LeasedQueueMessage,
  QueueReleaseOutcome,
  QueueRuntimeConfiguration,
  QueueStore,
} from '../queue-store.ts';

interface MessageRow {
  readonly id: string;
  readonly queue_name: string;
  readonly body: unknown;
  readonly attempts: number;
  readonly created_at: Date | string;
  readonly lease_token: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

class PgQueueStore implements QueueStore {
  constructor(private readonly sql: SQL) {}

  async enqueue(input: {
    readonly queue: string;
    readonly body: unknown;
    readonly enqueueKey: string;
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    const inserted: Array<{ id: string }> = await this.sql`
      insert into queue_messages (id, queue_name, body, enqueue_key)
      values (${id}, ${input.queue}, ${input.body}, ${input.enqueueKey})
      on conflict (enqueue_key) do nothing
      returning id`;
    const insertedRow = inserted[0];
    if (insertedRow !== undefined) return { id: insertedRow.id };

    const existing: Array<{ id: string }> = await this.sql`
      select id from queue_messages where enqueue_key = ${input.enqueueKey}`;
    const existingRow = existing[0];
    if (existingRow === undefined) {
      throw new Error('queue enqueue conflict did not return its existing message');
    }
    return { id: existingRow.id };
  }

  async claim(leaseSeconds: number): Promise<LeasedQueueMessage | null> {
    const leaseToken = crypto.randomUUID();
    const rows: MessageRow[] = await this.sql`
      with exhausted as (
        update queue_messages as message
        set
          state = 'failed',
          failed_at = now(),
          lease_token = null,
          leased_until = null
        from queue_configurations as config
        where message.queue_name = config.queue_name
          and message.state = 'leased'
          and message.leased_until <= now()
          and message.attempts >= config.max_attempts
      ), candidate as (
        select message.id
        from queue_messages as message
        join queue_configurations as config on config.queue_name = message.queue_name
        where
          message.attempts < config.max_attempts
          and (
            (message.state = 'ready' and message.available_at <= now())
            or (message.state = 'leased' and message.leased_until <= now())
          )
        order by message.available_at, message.created_at, message.id
        for update skip locked
        limit 1
      )
      update queue_messages as message
      set
        state = 'leased',
        lease_token = ${leaseToken},
        leased_until = now() + (${leaseSeconds} * interval '1 second'),
        attempts = attempts + 1
      from candidate
      where message.id = candidate.id
      returning message.id, message.queue_name, message.body, message.attempts,
                message.created_at, message.lease_token`;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      leaseToken: row.lease_token,
      message: {
        id: row.id,
        queue: row.queue_name,
        body: row.body,
        attempt: Number(row.attempts),
        enqueuedAt: toIso(row.created_at),
      },
    };
  }

  async complete(messageId: string, leaseToken: string): Promise<boolean> {
    const rows = await this.sql`
      update queue_messages
      set state = 'completed', completed_at = now(), lease_token = null, leased_until = null
      where id = ${messageId} and state = 'leased' and lease_token = ${leaseToken}
      returning id`;
    return rows.length === 1;
  }

  async release(messageId: string, leaseToken: string): Promise<QueueReleaseOutcome> {
    const rows: Array<{ state: string }> = await this.sql`
      update queue_messages as message
      set
        state = case when message.attempts >= config.max_attempts then 'failed' else 'ready' end,
        available_at = case
          when message.attempts >= config.max_attempts then message.available_at
          else now() + (config.retry_delay_ms * interval '1 millisecond')
        end,
        lease_token = null,
        leased_until = null,
        failed_at = case when message.attempts >= config.max_attempts then now() else null end
      from queue_configurations as config
      where message.queue_name = config.queue_name
        and message.id = ${messageId}
        and message.state = 'leased'
        and message.lease_token = ${leaseToken}
      returning message.state`;
    const row = rows[0];
    if (row === undefined) return 'lost';
    return row.state === 'failed' ? 'failed' : 'retrying';
  }
}

/** Connects to Postgres and applies the walking-skeleton queue schema idempotently. */
export async function createPgQueueStore(
  url: string,
  queues: readonly QueueRuntimeConfiguration[],
): Promise<QueueStore> {
  const sql = new SQL({ url, max: 4, idleTimeout: 10 });
  await retryTransientConnect(async () => {
    await sql`
      create table if not exists queue_configurations (
        queue_name text primary key,
        max_attempts integer not null check (max_attempts between 1 and 100),
        retry_delay_ms integer not null check (retry_delay_ms between 1000 and 86400000),
        updated_at timestamptz not null default now()
      )`;
    await sql`
      create table if not exists queue_messages (
        id text primary key,
        queue_name text not null,
        body jsonb not null,
        enqueue_key text not null unique,
        state text not null default 'ready'
          check (state in ('ready', 'leased', 'completed', 'failed')),
        attempts integer not null default 0,
        available_at timestamptz not null default now(),
        lease_token text,
        leased_until timestamptz,
        created_at timestamptz not null default now(),
        completed_at timestamptz,
        failed_at timestamptz
      )`;
    await sql`alter table queue_messages add column if not exists failed_at timestamptz`;
    await sql`
      do $$
      declare current_definition text;
      begin
        select pg_get_constraintdef(oid)
        into current_definition
        from pg_constraint
        where conrelid = 'queue_messages'::regclass
          and conname = 'queue_messages_state_check';

        if current_definition is null or current_definition not like '%failed%' then
          alter table queue_messages drop constraint if exists queue_messages_state_check;
          alter table queue_messages add constraint queue_messages_state_check
            check (state in ('ready', 'leased', 'completed', 'failed'));
        end if;
      end $$`;
    await sql`
      create index if not exists queue_messages_claim_idx
      on queue_messages (available_at, created_at, id)
      where state in ('ready', 'leased')`;

    for (const queue of queues) {
      await sql`
        insert into queue_configurations (queue_name, max_attempts, retry_delay_ms)
        values (${queue.name}, ${queue.maxAttempts}, ${queue.retryDelayMs})
        on conflict (queue_name) do update set
          max_attempts = excluded.max_attempts,
          retry_delay_ms = excluded.retry_delay_ms,
          updated_at = now()`;
    }
  });
  return new PgQueueStore(sql);
}
