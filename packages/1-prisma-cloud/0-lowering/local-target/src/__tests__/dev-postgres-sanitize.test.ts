import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ContainerInstance, DevProvidersInput } from '@internal/core/config';
import * as Effect from 'effect/Effect';
import { LocalDatabaseProvider } from '../dev/postgres.ts';
import { Database } from '../postgres/Database.ts';

/**
 * A failing `prisma dev --name ... --detach` never leaks the connection
 * URL's password into the thrown message (the mid-flight spec update: the
 * behavior contract's no-value-logging rule applies to embedded CLI
 * diagnostics too, not just stashed config values).
 */
describe('LocalDatabaseProvider — the could-not-read-URL error sanitizes captured output', () => {
  let cwd: string;
  let previousCwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-postgres-sanitize-test-'));
    previousCwd = process.cwd();
    process.chdir(cwd);

    const binDir = path.join(cwd, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakePrisma = path.join(binDir, 'prisma');
    fs.writeFileSync(
      fakePrisma,
      '#!/bin/sh\n' +
        'echo "connecting via postgres://myuser:hunter2secret@localhost:59999/db failed"\n' +
        'exit 1\n',
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('the thrown message masks the password but keeps the rest of the output legible', async () => {
    const container: ContainerInstance = {
      input: { appName: 'sanitizetestapp', stage: undefined },
      serialize: () => 'x',
    };
    const input: DevProvidersInput = {
      container,
      devDir: path.join(cwd, '.prisma-composer', 'dev'),
    };

    const service = await Effect.runPromise(
      Database.Provider.pipe(Effect.provide(LocalDatabaseProvider(input))),
    );

    const error: unknown = await Effect.runPromise(
      service.reconcile({
        id: 'db',
        instanceId: 'db',
        news: { projectId: 'p', name: 'db', region: 'us-east-1' },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const text = (error as Error).message;

    expect(text).toContain('could not read the database URL');
    expect(text).toContain('postgres://myuser:***@localhost:59999/db');
    expect(text).not.toContain('hunter2secret');
  });
});
