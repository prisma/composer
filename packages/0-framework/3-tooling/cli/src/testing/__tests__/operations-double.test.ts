/**
 * The operations double behaves like the operations it stands in for: same
 * Result shapes, per-operation fixtures, a DevSession that actually runs its
 * lifecycle. Signature conformance is
 * compile-time (the double is typed as ComposerOperations = typeof the real
 * operations); what is tested here is the behavior a host's tests depend on.
 */
import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk } from '@internal/foundation/result';
import type { ComposerConfigSource } from '../../composer-config.ts';
import { createOperationsDouble } from '../operations-double.ts';

const ENTRY = './app/main.ts';
const CONFIG = {
  value: { extensions: [], state: { extension: 'x', create: () => undefined } },
  file: 'prisma.config.ts',
} as unknown as ComposerConfigSource;

describe('createOperationsDouble()', () => {
  test('deploy succeeds by default, with no summary, and records its input', async () => {
    const double = createOperationsDouble();
    const result = await double.operations.deploy(
      { entry: ENTRY, config: CONFIG, stage: 'preview' },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ summary: undefined });
    expect(double.calls.deploy).toEqual([{ entry: ENTRY, config: CONFIG, stage: 'preview' }]);
  });

  test('a fixture failure comes back exactly as given', async () => {
    const failure = new CliStructuredError('DEPLOY.STAGE_INVALID', 'Bad stage.', {
      fix: 'Pick a valid stage.',
    });
    const double = createOperationsDouble({ deploy: notOk(failure) });
    const result = await double.operations.deploy({ entry: ENTRY, config: CONFIG }, {});
    expect(!result.ok && result.failure).toBe(failure);
  });

  test('the DevSession double runs the whole lifecycle: ready, endpoints, stop, closed', async () => {
    const endpoints = [{ address: 'web', url: 'http://localhost:3000' }];
    const double = createOperationsDouble({ devEndpoints: endpoints });
    const events: Array<{ kind: string }> = [];
    const result = await double.operations.dev(
      {
        entry: ENTRY,
        config: CONFIG,
        onEvent: (event) => events.push(event),
      },
      {},
    );
    const session = result.assertOk();
    expect(session.endpoints).toEqual(endpoints);
    expect(events.map((event) => event.kind)).toEqual(['ready']);

    let closed = false;
    void session.closed.then(() => {
      closed = true;
    });
    await session.stop();
    await session.closed;
    expect(closed).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(['ready', 'stopping', 'stopped']);

    // Idempotent: a second stop emits nothing further.
    await session.stop();
    expect(events).toHaveLength(3);
  });
});
