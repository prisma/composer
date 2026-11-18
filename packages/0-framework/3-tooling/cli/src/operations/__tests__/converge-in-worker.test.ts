/**
 * `prisma dev`'s converge in a real worker thread, against an app on disk
 * whose lowering records what it saw in `seen.txt`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { convergeInWorker, convergeInWorkerWith } from '../converge-in-worker.ts';
import { type DevEvent, devWithDeps } from '../dev.ts';
import type { DevConvergeReport } from '../dev-converge.ts';
import { entrySource, jobFor, makeWorkerApp, type WorkerApp } from './fixtures/worker-app.ts';

const apps: WorkerApp[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) fs.rmSync(app.dir, { recursive: true, force: true });
});

function workerApp(label?: string): WorkerApp {
  const app = makeWorkerApp(label);
  apps.push(app);
  return app;
}

const quiet: DevConvergeReport = { onEvent: () => undefined, output: () => undefined };

const waitUntil = async (done: () => boolean, ms = 20_000): Promise<void> => {
  for (let waited = 0; !done() && waited < ms; waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe.skipIf(process.platform === 'win32')('a dev converge in a worker thread', () => {
  test('imports a definition file the entry imports as it is now, so an edit reaches the next converge', async () => {
    const app = workerApp('v1');
    const before = process.cwd();

    const first = await convergeInWorker(jobFor(app), quiet);
    app.label('v2');
    const second = await convergeInWorker(jobFor(app), quiet);

    expect([first, second]).toEqual([{ kind: 'applied' }, { kind: 'applied' }]);
    expect(app.seen()).toEqual([`v1 ${app.dir}`, `v2 ${app.dir}`]);
    expect(app.dir).not.toBe(before);
    expect(process.cwd()).toBe(before);
  }, 60_000);

  test('under Node too', () => {
    const result = spawnSync(
      'node',
      [path.join(import.meta.dir, 'fixtures', 'converge-in-worker-under-node.ts')],
      { encoding: 'utf8' },
    );

    if (result.status !== 0) throw new Error(result.stderr);
    const { outcomes, seen, dir } = JSON.parse(result.stdout);
    expect(outcomes).toEqual([{ kind: 'applied' }, { kind: 'applied' }]);
    expect(seen).toEqual([`v1 ${dir}`, `v2 ${dir}`]);
  }, 60_000);

  test('an interrupted converge returns interrupted once its worker ends, and releases the process for the next one', async () => {
    const app = workerApp('block');
    const before = process.cwd();
    const controller = new AbortController();

    const running = convergeInWorker(jobFor(app), quiet, controller.signal);
    await waitUntil(() => app.seen().includes('blocking'));
    const meanwhile = await convergeInWorker(jobFor(app), quiet);
    controller.abort();
    const interrupted = await running;
    app.label('v1');
    const next = await convergeInWorker(jobFor(app), quiet);

    expect(meanwhile).toEqual({ kind: 'refused', reason: 'already-running' });
    expect(interrupted).toEqual({ kind: 'interrupted' });
    expect(next).toEqual({ kind: 'applied' });
    expect(process.cwd()).toBe(before);
  }, 60_000);

  test('a converge that does not stop when interrupted is ended after the stop timeout, and fails saying so', async () => {
    const app = workerApp('stubborn');
    const before = process.cwd();
    const controller = new AbortController();

    const running = convergeInWorkerWith({ stopTimeoutMs: 500 })(
      jobFor(app),
      quiet,
      controller.signal,
    );
    await waitUntil(() => app.seen().includes('blocking'));
    controller.abort();
    const outcome = await running;

    expect(outcome).toEqual({
      kind: 'failed',
      reasons: [
        {
          tag: 'ConvergeNotStopped',
          message:
            'The converge did not stop within 0.5s of being interrupted, so its worker thread was ended. It may have left its state lease held.',
        },
      ],
    });
    expect(process.cwd()).toBe(before);
  }, 60_000);

  test('a failed converge restores the working directory', async () => {
    const app = workerApp('fail');
    const before = process.cwd();

    const outcome = await convergeInWorker(jobFor(app), quiet);

    expect(outcome).toMatchObject({ kind: 'failed', reasons: [{ message: 'the thing refused' }] });
    expect(process.cwd()).toBe(before);
  }, 60_000);

  test('an edited file that does not parse fails the converge with the import error', async () => {
    const app = workerApp('v1');
    fs.writeFileSync(app.labelFile, 'export const label = ;\n');

    const outcome = await convergeInWorker(jobFor(app), quiet);

    if (outcome.kind !== 'failed') throw new Error(`expected a failure, got ${outcome.kind}`);
    expect(outcome.reasons).toHaveLength(1);
    expect(outcome.reasons[0]?.message).toStartWith(
      `Failed to import entry module "${app.entry}": `,
    );
  }, 60_000);

  test('a worker that exits before it reports an outcome fails the converge naming its exit code', async () => {
    const app = workerApp('exit');

    const outcome = await convergeInWorker(jobFor(app), quiet);

    expect(outcome).toEqual({
      kind: 'failed',
      reasons: [
        {
          tag: 'ConvergeWorkerExited',
          message: 'The converge worker thread exited with code 7 before it reported an outcome.',
        },
      ],
    });
  }, 60_000);
});

/** A started dev session over `app`, whose definition-file watch the test fires by hand. */
async function devSession(app: WorkerApp, events: DevEvent[]) {
  const composer = (await import(pathToFileURL(app.configFile).href)).default.composer;
  let change: () => void = () => undefined;
  const start = await devWithDeps(
    {
      config: { value: composer, file: app.configFile },
      entry: app.entry,
      cwd: app.dir,
      onEvent: (event) => void events.push(event),
    },
    {
      watch: (targets, onChange) => {
        if (targets.some((target) => target.paths.includes(app.labelFile))) change = onChange;
        return { ready: Promise.resolve(), stop: () => undefined };
      },
    },
  );
  if (!start.ok) throw start.failure;
  return { session: start.value, change: () => change() };
}

const countOf = (events: readonly DevEvent[], kind: DevEvent['kind']): number =>
  events.filter((event) => event.kind === kind).length;

describe.skipIf(process.platform === 'win32')('dev with its converge in a worker thread', () => {
  test("a secret the app's code prints in the worker is redacted in what dev reports", async () => {
    const app = workerApp('print');
    const token = 'fixture-token-value-123';
    process.env['FIXTURE_API_TOKEN'] = token;
    const events: DevEvent[] = [];
    try {
      const { session } = await devSession(app, events);
      await session.stop();
    } finally {
      delete process.env['FIXTURE_API_TOKEN'];
    }

    const reported = JSON.stringify(events);
    expect(reported).not.toContain(token);
    expect(events).toContainEqual({
      kind: 'message',
      severity: 'info',
      text: 'the token is [redacted]',
    });
  }, 60_000);

  test('a definition file that stops parsing fails that rebuild, and dev keeps watching and applies the fix', async () => {
    const app = workerApp('v1');
    const events: DevEvent[] = [];

    const { session, change } = await devSession(app, events);
    fs.writeFileSync(app.labelFile, 'export const label = ;\n');
    change();
    await waitUntil(() => countOf(events, 'converge-failed') === 1);
    app.label('v2');
    change();
    await waitUntil(() => countOf(events, 'ready') === 2);
    await session.stop();

    expect(countOf(events, 'converge-failed')).toBe(1);
    expect(app.seen()).toEqual([`v1 ${app.dir}`, `v2 ${app.dir}`]);
  }, 60_000);

  test('an edit that adds a node fails the rebuild, saying dev must be restarted', async () => {
    const app = workerApp('v1');
    const events: DevEvent[] = [];

    const { session, change } = await devSession(app, events);
    fs.writeFileSync(app.entry, entrySource(['thing', 'other']));
    change();
    await waitUntil(() => countOf(events, 'converge-failed') === 1);
    await session.stop();

    const failed = events.find((event) => event.kind === 'converge-failed');
    expect(failed).toMatchObject({
      kind: 'converge-failed',
      code: 'DEV.CONVERGE_FAILED',
      message:
        'The app now has a node added or removed. A running `prisma dev` keeps the nodes it started with, so restart `prisma dev` to apply the change.',
      reasons: [{ tag: 'GraphChangedError' }],
    });
  }, 60_000);
});
