#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/175be57590fa5824e15c09338d2e8c3fd18a5d96d8cf804d8e86eff38010e7ee/contract';
import endContract from '../../snapshots/175be57590fa5824e15c09338d2e8c3fd18a5d96d8cf804d8e86eff38010e7ee/contract.json' with { type: 'json' };
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
