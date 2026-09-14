#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/2c0c3445737906d85590514e3cec242919c12f8112346c2cebe74e681d65f0f0/contract';
import endContract from '../../snapshots/2c0c3445737906d85590514e3cec242919c12f8112346c2cebe74e681d65f0f0/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'Widget',
        columns: [
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('label', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
