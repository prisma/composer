#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/37a51f5613ada855a5cfabe9b5b25d154acf46e13ffd472c047817d8e42e3633/contract';
import endContract from '../../snapshots/37a51f5613ada855a5cfabe9b5b25d154acf46e13ffd472c047817d8e42e3633/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'order',
        columns: [
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('placedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('productId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('productName', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('quantity', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('totalCents', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
