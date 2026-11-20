/**
 * How a failed Prisma ORM `migrate` reads in a deploy: the ORM's own error,
 * written the way the `prisma` CLI writes a diagnostic. No database; the
 * failures are built by hand so every part of the format is pinned. The
 * ORM's real failures are asserted end to end in
 * `orm-migrate.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { type OrmMigrateFailure, OrmMigrationError } from '../orm-migrate.ts';

function failure(fields: {
  readonly code: `${string}.${string}`;
  readonly message: string;
  readonly why?: string;
  readonly fix?: string;
  readonly nextActions?: readonly {
    readonly kind: 'run-command' | 'user-choice';
    readonly label: string;
    readonly command?: string;
  }[];
  readonly docsUrl?: string;
}): OrmMigrateFailure {
  return { name: 'CliStructuredError', severity: 'error', ...fields } as OrmMigrateFailure;
}

describe('OrmMigrationError from a failed migrate', () => {
  test('keeps the ORM code and why, and writes code, summary, why, next actions and docs', () => {
    const error = new OrmMigrationError(
      failure({
        code: 'MIGRATION.MARKER_MISMATCH',
        message: 'The database is at a contract that is not in the migration graph',
        why: 'The marker names abc.',
        fix: 'Run {bin} db update.',
        nextActions: [
          { kind: 'user-choice', label: 'Unless it changes only through migrations:' },
          {
            kind: 'run-command',
            label: 'Reconcile the database',
            command: '{bin} db update --db <url>',
          },
        ],
        docsUrl: 'https://docs.prisma.io/x',
      }),
    );

    expect(error.code).toBe('MIGRATION.MARKER_MISMATCH');
    expect(error.why).toBe('The marker names abc.');
    expect(error.message).toBe(
      [
        '[MIGRATION.MARKER_MISMATCH] The database is at a contract that is not in the migration graph',
        '  why: The marker names abc.',
        '→ Unless it changes only through migrations:',
        '→ Reconcile the database: prisma db update --db <url>',
        '  docs: https://docs.prisma.io/x',
      ].join('\n'),
    );
  });

  test('writes the fix when the failure has no next actions', () => {
    const error = new OrmMigrationError(
      failure({
        code: 'MIGRATION.EXECUTION_FAILED',
        message: 'Operation x failed',
        fix: 'Resolve the cause, then re-run `{bin} db migrate`.',
      }),
    );

    expect(error.message).toBe(
      [
        '[MIGRATION.EXECUTION_FAILED] Operation x failed',
        '→ Resolve the cause, then re-run `prisma db migrate`.',
      ].join('\n'),
    );
  });

  test('indents every line of a multi-line why and names the binary in it', () => {
    const error = new OrmMigrationError(
      failure({
        code: 'MIGRATION.PATH_UNREACHABLE',
        message: 'No path',
        why: 'First line.\nThen run {bin} migration list.',
      }),
    );

    expect(error.message).toBe(
      [
        '[MIGRATION.PATH_UNREACHABLE] No path',
        '  why: First line.',
        '       Then run prisma migration list.',
      ].join('\n'),
    );
  });

  test('a next action whose command is its label is written once', () => {
    const error = new OrmMigrationError(
      failure({
        code: 'MIGRATION.PATH_UNREACHABLE',
        message: 'No path',
        nextActions: [
          { kind: 'run-command', label: '{bin} migration list', command: '{bin} migration list' },
        ],
      }),
    );

    expect(error.message).toBe(
      ['[MIGRATION.PATH_UNREACHABLE] No path', '→ prisma migration list'].join('\n'),
    );
  });
});
