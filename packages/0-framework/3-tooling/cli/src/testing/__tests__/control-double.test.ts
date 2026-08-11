/**
 * The control-API double behaves like the operations it stands in for: same
 * Result shapes, per-operation fixtures, a DevSession that actually runs its
 * lifecycle, a log stream that replays and filters. Signature conformance is
 * compile-time (the double is typed as ComposerOperations = typeof the real
 * operations); what is tested here is the behavior a host's tests depend on.
 */
import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk } from '@internal/foundation/result';
import { createControlDouble } from '../control-double.ts';

const ENTRY = './app/main.ts';

describe('createControlDouble()', () => {
  test('deploy succeeds by default, with no summary, and records its input', async () => {
    const double = createControlDouble();
    const result = await double.operations.deploy({ entry: ENTRY, stage: 'preview' }, {});
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ summary: undefined });
    expect(double.calls.deploy).toEqual([{ entry: ENTRY, stage: 'preview' }]);
  });

  test('a fixture failure comes back exactly as given', async () => {
    const failure = new CliStructuredError('DEPLOY.STAGE_INVALID', 'Bad stage.', {
      fix: 'Pick a valid stage.',
    });
    const double = createControlDouble({ deploy: notOk(failure) });
    const result = await double.operations.deploy({ entry: ENTRY }, {});
    expect(!result.ok && result.failure).toBe(failure);
  });

  test('destroy delivers fixture events to onEvent before resolving ok', async () => {
    const double = createControlDouble({
      destroyEvents: [{ kind: 'no-local-deploy-state', cwd: '/app' }],
    });
    const events: unknown[] = [];
    const result = await double.operations.destroy(
      {
        entry: ENTRY,
        target: { kind: 'production' },
        onEvent: (event) => events.push(event),
      },
      {},
    );
    expect(result.ok).toBe(true);
    expect(events).toEqual([{ kind: 'no-local-deploy-state', cwd: '/app' }]);
  });

  test('the DevSession double runs the whole lifecycle: ready, endpoints, stop, closed', async () => {
    const endpoints = [{ address: 'web', url: 'http://localhost:3000' }];
    const double = createControlDouble({ devEndpoints: endpoints });
    const events: Array<{ kind: string }> = [];
    const result = await double.operations.dev(
      {
        entry: ENTRY,
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

  test('log replays the fixture lines and ends', async () => {
    const double = createControlDouble({
      logAppName: 'store',
      logLines: [
        { service: 'web', line: 'listening' },
        { service: 'worker', line: 'polling' },
      ],
    });
    const attached = (await double.operations.log({ entry: ENTRY }, {})).assertOk();
    expect(attached.appName).toBe('store');
    const lines = [];
    for await (const line of attached.lines) lines.push(line);
    expect(lines).toHaveLength(2);
  });

  test('log filters to the requested address, like the real merged stream', async () => {
    const double = createControlDouble({
      logLines: [
        { service: 'web', line: 'listening' },
        { service: 'worker', line: 'polling' },
      ],
    });
    const attached = (
      await double.operations.log({ entry: ENTRY, address: 'worker' }, {})
    ).assertOk();
    const lines = [];
    for await (const line of attached.lines) lines.push(line);
    expect(lines).toEqual([{ service: 'worker', line: 'polling' }]);
  });

  test('an aborted signal ends the log stream early', async () => {
    const controller = new AbortController();
    controller.abort();
    const double = createControlDouble({ logLines: [{ service: 'web', line: 'never' }] });
    const attached = (
      await double.operations.log({ entry: ENTRY, signal: controller.signal }, {})
    ).assertOk();
    const lines = [];
    for await (const line of attached.lines) lines.push(line);
    expect(lines).toEqual([]);
  });
});
