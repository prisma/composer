/**
 * The `./control/testing` double: fixture-scripted outcomes on the REAL
 * operation signatures — defaults, per-operation overrides, the DevSession
 * lifecycle, and the log stream's replay/filter/abort behavior.
 */
import { describe, expect, test } from 'bun:test';
import { createControlDouble, notOk, ok, structuredFailure } from '../control-double.ts';
import type { DevEvent } from '../dev.ts';
import type { LogLine } from '../log.ts';

describe('createControlDouble() defaults', () => {
  test('deploy succeeds with no summary; destroy succeeds void', async () => {
    const double = createControlDouble();

    const deployed = await double.deploy({ entry: 'app.ts' });
    expect(deployed.ok).toBe(true);
    if (!deployed.ok) throw new Error('unreachable');
    expect(deployed.value.summary).toBeUndefined();

    const destroyed = await double.destroy({ entry: 'app.ts', target: { kind: 'production' } });
    expect(destroyed.ok).toBe(true);
  });

  test('dev returns a session with no endpoints; log an attachment with no services and a finished stream', async () => {
    const double = createControlDouble();

    const dev = await double.dev({ entry: 'app.ts' });
    if (!dev.ok) throw new Error('expected ok');
    expect(dev.value.endpoints).toEqual([]);

    const log = await double.log({ entry: 'app.ts' });
    if (!log.ok) throw new Error('expected ok');
    expect(log.value.services).toEqual([]);
    const lines: LogLine[] = [];
    for await (const line of log.value.lines) lines.push(line);
    expect(lines).toEqual([]);
  });
});

describe('fixtures', () => {
  test('a canned failure comes back verbatim — the host branches on failure.code as with the real operation', async () => {
    const failure = structuredFailure(
      'DEPLOY.ENGINE_FAILED',
      'alchemy deploy exited with status 1.',
      {
        why: 'scripted by the test',
      },
    );
    const double = createControlDouble({ deploy: notOk(failure) });

    const result = await double.deploy({ entry: 'app.ts', stage: 'feat-auth' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toBe(failure);
    expect(result.failure.code).toBe('DEPLOY.ENGINE_FAILED');
  });

  test('a function fixture sees the operation input and can branch per call', async () => {
    const double = createControlDouble({
      deploy: (input) =>
        input.stage === 'broken'
          ? notOk(structuredFailure('DEPLOY.STAGE_INVALID', `Bad stage "${String(input.stage)}".`))
          : ok({ summary: undefined }),
    });

    expect((await double.deploy({ entry: 'app.ts', stage: 'ok' })).ok).toBe(true);
    const failed = await double.deploy({ entry: 'app.ts', stage: 'broken' });
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('unreachable');
    expect(failed.failure.code).toBe('DEPLOY.STAGE_INVALID');
  });
});

describe('the DevSession double', () => {
  test('endpoints come from the fixture; stop() emits stopping/stopped, settles closed, and is idempotent', async () => {
    const endpoints = [{ address: 'shop.service', url: 'http://localhost:3000' }];
    const double = createControlDouble({ dev: { endpoints } });
    const events: DevEvent['kind'][] = [];

    const result = await double.dev({ entry: 'app.ts', onEvent: (e) => events.push(e.kind) });
    if (!result.ok) throw new Error('expected ok');
    const session = result.value;
    expect(session.endpoints).toEqual(endpoints);

    let closed = false;
    void session.closed.then(() => {
      closed = true;
    });
    await session.stop();
    await session.stop();
    await session.closed;
    expect(closed).toBe(true);
    expect(events).toEqual(['stopping', 'stopped']);
  });

  test('a dev failure fixture comes back as the failure', async () => {
    const double = createControlDouble({
      dev: notOk(structuredFailure('DEV.PLATFORM_UNSUPPORTED', 'scripted')),
    });
    const result = await double.dev({ entry: 'app.ts' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.PLATFORM_UNSUPPORTED');
  });
});

describe('the log double', () => {
  const fixture = {
    appName: 'shop',
    services: [
      { address: 'shop.service', url: 'http://localhost:3000' },
      { address: 'shop.worker', url: 'http://localhost:3001' },
    ],
    lines: [
      { service: 'shop.service', line: 'listening' },
      { service: 'shop.worker', line: 'polling' },
      { service: 'shop.service', line: 'GET /' },
    ],
  };

  test('replays the fixture lines in order, then ends', async () => {
    const double = createControlDouble({ log: fixture });
    const result = await double.log({ entry: 'app.ts' });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.appName).toBe('shop');
    expect(result.value.services).toHaveLength(2);
    const lines: string[] = [];
    for await (const line of result.value.lines) lines.push(`[${line.service}] ${line.line}`);
    expect(lines).toEqual([
      '[shop.service] listening',
      '[shop.worker] polling',
      '[shop.service] GET /',
    ]);
  });

  test('an address filter keeps only that service, like the real operation', async () => {
    const double = createControlDouble({ log: fixture });
    const result = await double.log({ entry: 'app.ts', address: 'shop.worker' });
    if (!result.ok) throw new Error('expected ok');
    const lines: string[] = [];
    for await (const line of result.value.lines) lines.push(line.line);
    expect(lines).toEqual(['polling']);
  });

  test('an aborted signal ends the stream', async () => {
    const controller = new AbortController();
    const double = createControlDouble({ log: fixture });
    const result = await double.log({ entry: 'app.ts', signal: controller.signal });
    if (!result.ok) throw new Error('expected ok');
    controller.abort();
    const lines: LogLine[] = [];
    for await (const line of result.value.lines) lines.push(line);
    expect(lines).toEqual([]);
  });
});
