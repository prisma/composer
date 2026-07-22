/**
 * The `OutboxStore` interface every email is written to (spec D6: stored
 * first, delivery attempted after) and read back through the outbox port.
 * `pg-outbox-store.ts` and `memory-outbox-store.ts` both implement this
 * against the same row shape. The cursor codec (`base64(createdAtISO + '|' +
 * id)`) lives here because both stores and `handlers.ts`'s `listEmails`
 * share it.
 */

export type EmailStatus = 'stored' | 'queued' | 'sent' | 'failed';

/** One outbox row, as read back — the store's internal shape (includes `idempotencyKey`, which the wire `emailRecord` does not expose). */
export interface EmailRow {
  readonly id: string;
  readonly templateId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly replyTo: string | null;
  readonly from: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string | null;
  readonly status: EmailStatus;
  readonly providerMessageId: string | null;
  readonly error: string | null;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What `send` inserts before any delivery attempt — status is `'stored'` (mode `none`) or `'queued'` (mode `resend`/`smtp`). */
export interface NewEmailRow {
  readonly id: string;
  readonly templateId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly replyTo: string | null;
  readonly from: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string | null;
  readonly status: 'stored' | 'queued';
  readonly idempotencyKey: string;
}

/** `inserted: false` means the row already existed for this idempotency key (D10); `row` is the pre-existing row and no delivery is attempted. */
export interface InsertOutcome {
  readonly row: EmailRow;
  readonly inserted: boolean;
}

/** `attempts` is the number of provider tries that delivery invocation made — added to the row's running total, not a flat +1 (redeliveries accumulate). */
export type DeliveryUpdate =
  | {
      readonly status: 'sent';
      readonly providerMessageId: string | null;
      readonly attempts: number;
    }
  | { readonly status: 'failed'; readonly error: string; readonly attempts: number };

/** The decoded form of an opaque `listEmails` cursor: the `(createdAt, id)` keyset position. */
export interface Cursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface ListFilters {
  readonly to?: string;
  readonly templateId?: string;
  readonly status?: EmailStatus;
  /** Keyset position to resume after — rows strictly newer than the cursor are excluded. */
  readonly after?: Cursor;
  readonly limit: number;
}

export interface ListPage {
  /** Newest-first (`createdAt desc, id desc`), already trimmed to `limit`. */
  readonly rows: readonly EmailRow[];
  readonly hasMore: boolean;
}

export interface OutboxStore {
  /** `on conflict (idempotencyKey) do nothing` semantics (D10) — see {@link InsertOutcome}. */
  insert(row: NewEmailRow): Promise<InsertOutcome>;
  /** Applies a delivery outcome; adds `update.attempts` to the row's running `attempts` total and sets `updatedAt`. Throws if `id` does not exist. */
  updateDelivery(id: string, update: DeliveryUpdate): Promise<EmailRow>;
  getById(id: string): Promise<EmailRow | null>;
  list(filters: ListFilters): Promise<ListPage>;
}

/** Not documented to consumers as parseable (spec) — treat the string as opaque outside this pair. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf-8').toString('base64');
}

export function decodeCursor(value: string): Cursor {
  const decoded = Buffer.from(value, 'base64').toString('utf-8');
  const separatorIndex = decoded.indexOf('|');
  if (separatorIndex === -1) {
    throw new Error(`invalid outbox cursor: ${value}`);
  }
  return {
    createdAt: decoded.slice(0, separatorIndex),
    id: decoded.slice(separatorIndex + 1),
  };
}
