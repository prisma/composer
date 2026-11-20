import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import { OrmMigrationError, PrismaOrmError } from '../orm-migrate.ts';

describe('PrismaOrmError from a failed migrate', () => {
  test("is a structured error carrying the ORM's code, why, advice and docs link", () => {
    const error = new PrismaOrmError({
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

    expect(error).toBeInstanceOf(CliStructuredError);
    expect(error.toEnvelope()).toEqual({
      ok: false,
      code: 'MIGRATION.MARKER_MISMATCH',
      severity: 'error',
      summary: error.message,
      why: 'The marker names abc.',
      fix: [
        'Unless it changes only through migrations:',
        'Reconcile the database: prisma db update --db <url>',
      ].join('\n'),
      docsUrl: 'https://docs.prisma.io/x',
    });
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

  test('writes each line of the fix as its own step when the failure has no next actions', () => {
    const error = new PrismaOrmError({
      code: 'MIGRATION.EXECUTION_FAILED',
      message: 'Operation x failed',
      fix: 'Resolve the cause.\n\n  Then re-run `{bin} db migrate`.',
    });

    expect(error.fix).toBe('Resolve the cause.\nThen re-run `prisma db migrate`.');
    expect(error.message).toBe(
      ['Operation x failed', '→ Resolve the cause.', '→ Then re-run `prisma db migrate`.'].join(
        '\n',
      ),
    );
  });

  test('indents every line of a multi-line why and names the binary in it', () => {
    const error = new PrismaOrmError({
      code: 'MIGRATION.PATH_UNREACHABLE',
      message: 'No path',
      why: 'First line.\nThen run {bin} migration list.',
    });

    expect(error.why).toBe('First line.\nThen run prisma migration list.');
    expect(error.message).toBe(
      ['No path', '  why: First line.', '       Then run prisma migration list.'].join('\n'),
    );
  });

  test('a next action whose command is its label is written once', () => {
    const error = new PrismaOrmError({
      code: 'MIGRATION.PATH_UNREACHABLE',
      message: 'No path',
      nextActions: [{ label: '{bin} migration list', command: '{bin} migration list' }],
    });

    expect(error.message).toBe(['No path', '→ prisma migration list'].join('\n'));
  });
});

describe('OrmMigrationError', () => {
  test('is a check Composer makes before Prisma ORM runs, not a structured error', () => {
    const error = new OrmMigrationError('CONTRACT_INVALID', 'no storage hash');

    expect(CliStructuredError.is(error)).toBe(false);
    expect(error.code).toBe('CONTRACT_INVALID');
    expect(error.message).toBe('Prisma ORM migrate (CONTRACT_INVALID): no storage hash');
  });
});
