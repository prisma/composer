/**
 * The `send`/`getEmail`/`listEmails` handler map (spec §"Service behavior").
 * A later dispatch wires this into `serve(emailService(...), handlers)`
 * (`execution/email-entrypoint.ts`) once the service definition exists;
 * `createHandlers` takes its store, delivery backing, and module config
 * (`deliveryMode`, `from`) already constructed, so it stays testable without
 * a running service.
 */
import type { Delivery, DeliveryResult } from './delivery.ts';
import {
  decodeCursor,
  type EmailRow,
  type EmailStatus,
  encodeCursor,
  type OutboxStore,
} from './outbox-store.ts';

const DEFAULT_LIST_LIMIT = 50;

export interface SendInput {
  readonly templateId: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly replyTo?: string;
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
  readonly idempotencyKey: string;
}

export interface SendResult {
  readonly id: string;
  readonly status: EmailStatus;
  readonly error?: string;
}

export interface EmailRecord {
  readonly id: string;
  readonly templateId: string;
  readonly to: string[];
  readonly cc: string[];
  readonly bcc: string[];
  readonly replyTo: string | null;
  readonly from: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string | null;
  readonly status: EmailStatus;
  readonly providerMessageId: string | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GetEmailInput {
  readonly id: string;
}

export interface GetEmailResult {
  readonly email: EmailRecord | null;
}

export interface ListEmailsInput {
  readonly to?: string;
  readonly templateId?: string;
  readonly status?: EmailStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListEmailsResult {
  readonly emails: EmailRecord[];
  readonly nextCursor?: string;
}

export interface EmailHandlers {
  send(input: SendInput): Promise<SendResult>;
  getEmail(input: GetEmailInput): Promise<GetEmailResult>;
  listEmails(input: ListEmailsInput): Promise<ListEmailsResult>;
}

export interface HandlersConfig {
  readonly store: OutboxStore;
  readonly delivery: Delivery;
  readonly deliveryMode: 'none' | 'resend' | 'smtp';
  /** The module-configured sender address (spec: not overridable per-send). */
  readonly from: string;
}

function toEmailRecord(row: EmailRow): EmailRecord {
  return {
    id: row.id,
    templateId: row.templateId,
    to: [...row.to],
    cc: [...row.cc],
    bcc: [...row.bcc],
    replyTo: row.replyTo,
    from: row.from,
    subject: row.subject,
    html: row.html,
    text: row.text,
    status: row.status,
    providerMessageId: row.providerMessageId,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSendResult(row: EmailRow): SendResult {
  return row.error === null
    ? { id: row.id, status: row.status }
    : { id: row.id, status: row.status, error: row.error };
}

export function createHandlers(config: HandlersConfig): EmailHandlers {
  const { store, delivery, deliveryMode, from } = config;

  async function send(input: SendInput): Promise<SendResult> {
    const status: 'stored' | 'queued' = deliveryMode === 'none' ? 'stored' : 'queued';
    const outcome = await store.insert({
      id: crypto.randomUUID(),
      templateId: input.templateId,
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      replyTo: input.replyTo ?? null,
      from,
      subject: input.subject,
      html: input.html,
      text: input.text ?? null,
      status,
      idempotencyKey: input.idempotencyKey,
    });

    // Dedup on conflict (D10): no delivery attempt, original row returned.
    if (!outcome.inserted || deliveryMode === 'none') {
      return toSendResult(outcome.row);
    }

    // A thrown/rejected deliver() is normalized to a failed result rather
    // than left unhandled — otherwise the row would strand at "queued"
    // forever, and a later dedup retry would keep returning that stale row
    // without ever attempting delivery again (no redelivery mechanism in v1).
    const result = await delivery.deliver(outcome.row).catch(
      (caught: unknown): DeliveryResult => ({
        ok: false,
        error: caught instanceof Error ? caught.message : String(caught),
        attempts: 1,
      }),
    );
    const updated = await store.updateDelivery(
      outcome.row.id,
      result.ok
        ? { status: 'sent', providerMessageId: result.providerMessageId, attempts: result.attempts }
        : { status: 'failed', error: result.error, attempts: result.attempts },
    );
    return toSendResult(updated);
  }

  async function getEmail(input: GetEmailInput): Promise<GetEmailResult> {
    const row = await store.getById(input.id);
    return { email: row === null ? null : toEmailRecord(row) };
  }

  async function listEmails(input: ListEmailsInput): Promise<ListEmailsResult> {
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const page = await store.list({
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(after !== undefined ? { after } : {}),
      limit,
    });
    const last = page.rows.at(-1);
    return {
      emails: page.rows.map(toEmailRecord),
      ...(page.hasMore && last !== undefined
        ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) }
        : {}),
    };
  }

  return { send, getEmail, listEmails };
}
