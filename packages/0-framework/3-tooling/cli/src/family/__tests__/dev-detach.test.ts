/** `dev --detach`: returns once the app is ready and leaves it running; Ctrl-C before then stops it. */
import { describe, expect, test } from 'bun:test';
import type { EngineEvent } from '@prisma/cli-engine';
import { createTestCli } from '@prisma/cli-engine/testing';
import { createOperationsDouble } from '../../testing/operations-double.ts';
import { createComposerFamily } from '../family.ts';
import { commandAt } from './command-at.ts';
import { validComposerSection } from './fixtures/composer-section.ts';

const AS_TTY = { isTty: { stdout: true, stderr: true } } as const;

function cliOver(double: ReturnType<typeof createOperationsDouble>) {
  const family = createComposerFamily({ operations: double.operations });
  return createTestCli({
    commandFamilies: [family],
    commands: { dev: commandAt(family, 'dev') },
    config: { composer: validComposerSection() },
  });
}

describe('dev --detach', () => {
  test('exits 0 once the app is ready, printing its URLs, and leaves it running', async () => {
    const double = createOperationsDouble({
      devEndpoints: [{ address: 'gateway', url: 'http://localhost:3001' }],
    });

    const result = await cliOver(double).run(
      ['dev', '--entry', 'src/service.ts', '--detach'],
      AS_TTY,
    );

    expect(result.exitCode).toBe(0);
    expect(double.calls.dev[0]?.detach).toBe(true);
    expect(result.events).toContainEqual({
      kind: 'endpoint',
      name: 'gateway',
      url: 'http://localhost:3001',
    });
    expect(result.events.some((e) => e.kind === 'step-started')).toBe(false);
    expect(double.calls.devStop).toHaveLength(0);
  });

  test('without --detach, dev asks the operation for a watching session', async () => {
    const double = createOperationsDouble({});
    const interrupt = new AbortController();

    await cliOver(double).run(['dev', '--entry', 'src/service.ts'], {
      ...AS_TTY,
      abort: interrupt.signal,
      onEvent: (event: EngineEvent) => {
        if (event.kind === 'status' && event.status === 'ready') interrupt.abort();
      },
    });

    expect(double.calls.dev[0]?.detach).toBe(false);
  });

  test('Ctrl-C before the detached app is ready stops it and settles 130', async () => {
    const double = createOperationsDouble({});
    const interrupt = new AbortController();

    const result = await cliOver(double).run(['dev', '--entry', 'src/service.ts', '--detach'], {
      ...AS_TTY,
      abort: interrupt.signal,
      onEvent: (event: EngineEvent) => {
        if (event.kind === 'status' && event.status === 'ready') interrupt.abort();
      },
    });

    expect(result.exitCode).toBe(130);
    expect(double.calls.devStop).toHaveLength(1);
    expect(double.calls.devStop[0]?.config).toEqual(double.calls.dev[0]?.config);
  });
});
