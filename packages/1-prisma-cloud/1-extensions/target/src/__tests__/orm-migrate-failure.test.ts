import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import { OrmMigrationError } from '../orm-migrate.ts';

describe('OrmMigrationError from a failed migrate', () => {
  test('keeps the ORM code and why, and writes summary, why, next actions and docs', () => {
    const error = new OrmMigrationError({
      code: 'MIGRATION.MARKER_MISMATCH',
      message: 'The database is at a contract that is not in the migration graph',
      why: 'The marker names abc.',
      fix: 'Run {bin} db update.',
      nextActions: [
        { label: 'Unless it changes only through migrations:' },
        { label: 'Reconcile the database', command: '{bin} db update --db <url>' },
      ],
      docsUrl: 'https://docs.prisma.io/x',
    });

    expect(error.code).toBe('MIGRATION.MARKER_MISMATCH');
    expect(error.why).toBe('The marker names abc.');
    expect(error.message).toBe(
      [
        'The database is at a contract that is not in the migration graph',
        '  why: The marker names abc.',
        '→ Unless it changes only through migrations:',
        '→ Reconcile the database: prisma db update --db <url>',
        '  docs: https://docs.prisma.io/x',
      ].join('\n'),
    );
  });

  test('is recognized as a structured error, so a failed converge reports its code', () => {
    const error = new OrmMigrationError({ code: 'MIGRATION.PATH_UNREACHABLE', message: 'No path' });

    expect(CliStructuredError.is(error)).toBe(true);
    expect(error._tag).toBe('OrmMigrationError');
    expect(error.toEnvelope()).toEqual({
      ok: false,
      code: 'MIGRATION.PATH_UNREACHABLE',
      severity: 'error',
      summary: 'No path',
    });
  });

  test("a failure Composer finds itself is not mistaken for the ORM's", () => {
    const error = new OrmMigrationError('CONTRACT_INVALID', 'no storage hash');

    expect(CliStructuredError.is(error)).toBe(false);
    expect(error.message).toBe('Prisma ORM migrate (CONTRACT_INVALID): no storage hash');
  });

  test('writes each line of the fix as its own step when the failure has no next actions', () => {
    const error = new OrmMigrationError({
      code: 'MIGRATION.EXECUTION_FAILED',
      message: 'Operation x failed',
      fix: 'Resolve the cause.\n\n  Then re-run `{bin} db migrate`.',
    });

    expect(error.message).toBe(
      ['Operation x failed', '→ Resolve the cause.', '→ Then re-run `prisma db migrate`.'].join(
        '\n',
      ),
    );
  });

  test('indents every line of a multi-line why and names the binary in it', () => {
    const error = new OrmMigrationError({
      code: 'MIGRATION.PATH_UNREACHABLE',
      message: 'No path',
      why: 'First line.\nThen run {bin} migration list.',
    });

    expect(error.message).toBe(
      ['No path', '  why: First line.', '       Then run prisma migration list.'].join('\n'),
    );
  });

  test('a next action whose command is its label is written once', () => {
    const error = new OrmMigrationError({
      code: 'MIGRATION.PATH_UNREACHABLE',
      message: 'No path',
      nextActions: [{ label: '{bin} migration list', command: '{bin} migration list' }],
    });

    expect(error.message).toBe(['No path', '→ prisma migration list'].join('\n'));
  });
});
