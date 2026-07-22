/**
 * In-memory `OutboxStore` — the store unit tests run against, and what
 * `startLocalEmailServer` (a later dispatch) serves locally. Same interface
 * and ordering/filter semantics as `pg-outbox-store.ts`; no persistence.
 */
import type {
  DeliveryUpdate,
  EmailRow,
  InsertOutcome,
  ListFilters,
  ListPage,
  NewEmailRow,
  OutboxStore,
} from './outbox-store.ts';

class MemoryOutboxStore implements OutboxStore {
  private readonly rowsById = new Map<string, EmailRow>();
  private readonly idByIdempotencyKey = new Map<string, string>();

  async insert(row: NewEmailRow): Promise<InsertOutcome> {
    const existingId = this.idByIdempotencyKey.get(row.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.rowsById.get(existingId);
      if (existing === undefined) {
        throw new Error(`outbox insert: idempotency index pointed at a missing row ${existingId}`);
      }
      return { row: existing, inserted: false };
    }

    const now = new Date().toISOString();
    const inserted: EmailRow = {
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
      providerMessageId: null,
      error: null,
      idempotencyKey: row.idempotencyKey,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.rowsById.set(row.id, inserted);
    this.idByIdempotencyKey.set(row.idempotencyKey, row.id);
    return { row: inserted, inserted: true };
  }

  async updateDelivery(id: string, update: DeliveryUpdate): Promise<EmailRow> {
    const existing = this.rowsById.get(id);
    if (existing === undefined) {
      throw new Error(`outbox updateDelivery: no row found for id ${id}`);
    }
    const updated: EmailRow = {
      ...existing,
      status: update.status,
      providerMessageId: update.status === 'sent' ? update.providerMessageId : null,
      error: update.status === 'failed' ? update.error : null,
      attempts: existing.attempts + update.attempts,
      updatedAt: new Date().toISOString(),
    };
    this.rowsById.set(id, updated);
    return updated;
  }

  async getById(id: string): Promise<EmailRow | null> {
    return this.rowsById.get(id) ?? null;
  }

  async list(filters: ListFilters): Promise<ListPage> {
    const matches = [...this.rowsById.values()]
      .filter((row) => filters.to === undefined || row.to.includes(filters.to))
      .filter((row) => filters.templateId === undefined || row.templateId === filters.templateId)
      .filter((row) => filters.status === undefined || row.status === filters.status)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
        return a.id < b.id ? 1 : -1;
      })
      .filter((row) => {
        const after = filters.after;
        if (after === undefined) return true;
        if (row.createdAt !== after.createdAt) return row.createdAt < after.createdAt;
        return row.id < after.id;
      });

    const hasMore = matches.length > filters.limit;
    return { rows: hasMore ? matches.slice(0, filters.limit) : matches, hasMore };
  }
}

export function createMemoryOutboxStore(): OutboxStore {
  return new MemoryOutboxStore();
}
