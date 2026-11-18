/**
 * `prisma dev`'s converge in a real worker thread, against an app on disk
 * whose lowering records what it saw in `seen.txt`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppRootNode, ModuleNode } from '@internal/core';
import type { PrismaAppConfig } from '@internal/core/config';
import { lower } from '@internal/core/deploy';
import { devState } from '@internal/core/local-target';
import { type ConvergeOutcome, convergeInProcess } from '../../converge-in-process.ts';
import { holdingConvergeProcess } from '../../converge-process.ts';
import { type DevEvent, devWithDeps } from '../dev.ts';
import type { DevConvergeReport, DevConvergeResult } from '../dev-converge.ts';
import { runDevConvergeInWorker, runDevConvergeInWorkerWith } from '../dev-converge-in-worker.ts';
import { entrySource, jobFor, makeWorkerApp, type WorkerApp } from './fixtures/worker-app.ts';

const apps: WorkerApp[] = [];
const links: string[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) fs.rmSync(app.dir, { recursive: true, force: true });
  for (const link of links.splice(0)) fs.rmSync(link, { force: true });
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

function outcomeOf(result: DevConvergeResult): ConvergeOutcome {
  if (result.kind !== 'outcome') throw new Error(`expected a converge, got ${result.kind}`);
  return result.outcome;
}

const converge = async (
  ...args: Parameters<typeof runDevConvergeInWorker>
): Promise<ConvergeOutcome> => outcomeOf(await runDevConvergeInWorker(...args));

describe.skipIf(process.platform === 'win32')('a dev converge in a worker thread', () => {
  test('imports a definition file the entry imports as it is now, so an edit reaches the next converge', async () => {
    const app = workerApp('v1');
    const before = process.cwd();

    const first = await converge(jobFor(app), quiet);
    app.label('v2');
    const second = await converge(jobFor(app), quiet);

    expect([first, second]).toEqual([{ kind: 'applied' }, { kind: 'applied' }]);
    expect(app.seen()).toEqual([`v1 ${app.dir}`, `v2 ${app.dir}`]);
    expect(app.dir).not.toBe(before);
    expect(process.cwd()).toBe(before);
  }, 60_000);

  test('under Node too, with a config that imports a sibling .ts file by a .js specifier, and an import of a missing extensionless file that names the file to create', () => {
    const result = spawnSync(
      'node',
      [path.join(import.meta.dir, 'fixtures', 'dev-converge-in-worker-under-node.ts')],
      { encoding: 'utf8' },
    );

    if (result.status !== 0) throw new Error(result.stderr);
    const { outcomes, seen, missing, dir } = JSON.parse(result.stdout);
    expect(outcomes).toEqual([{ kind: 'applied' }, { kind: 'applied' }, { kind: 'applied' }]);
    expect(seen).toEqual([`v1 ${dir}`, `v2 ${dir}`, `v3 ${dir}`]);
    expect(missing.kind).toBe('error');
    expect(missing.appFiles).toContain(path.join(dir, 'helpers.ts'));
  }, 60_000);

  for (const runtime of ['bun', 'node']) {
    test(`under ${runtime}, everything the app prints in the worker reaches the report and nothing reaches the terminal, and inspector-only console methods print nothing`, () => {
      const token = 'fixture-token-value-456';
      const result = spawnSync(
        runtime,
        [path.join(import.meta.dir, 'fixtures', 'print-in-worker.ts')],
        { encoding: 'utf8', env: { ...process.env, FIXTURE_API_TOKEN: token } },
      );

      if (result.status !== 0) throw new Error(result.stderr);
      expect(result.stderr).not.toContain(token);
      const { outcome, output } = JSON.parse(result.stdout);
      expect(outcome).toEqual({ kind: 'applied' });
      const methods = ['log', 'named', 'dir', 'table', 'count', 'assert', 'warning'];
      for (const printed of runtime === 'bun'
        ? [...methods, 'write']
        : [...methods, 'createTask']) {
        expect({ printed, reported: output.includes(printed) && output.includes(token) }).toEqual({
          printed,
          reported: true,
        });
      }
      expect(output).toContain(`log ${token}`);
      expect(output).toContain(`count ${token}`);
      expect(output).toContain(`assert ${token}`);
      expect(output).toContain(`warning ${token}`);
      expect(output).not.toContain('quiet');
    }, 60_000);
  }

  test('an interrupted converge returns interrupted once its worker ends, and releases the process for the next one', async () => {
    const app = workerApp('block');
    const before = process.cwd();
    const controller = new AbortController();

    const running = converge(jobFor(app), quiet, controller.signal);
    await waitUntil(() => app.seen().includes('blocking'));
    const meanwhile = await converge(jobFor(app), quiet);
    controller.abort();
    const interrupted = await running;
    app.label('v1');
    const next = await converge(jobFor(app), quiet);

    expect(meanwhile).toEqual({ kind: 'refused', reason: 'already-running' });
    expect(interrupted).toEqual({ kind: 'interrupted' });
    expect(next).toEqual({ kind: 'applied' });
    expect(process.cwd()).toBe(before);
  }, 60_000);

  test("a deploy's converge on the main thread and a dev converge in a worker refuse each other", async () => {
    const app = workerApp('block');
    const controller = new AbortController();
    const composer: PrismaAppConfig = (await import(pathToFileURL(app.configFile).href)).default
      .composer;
    const root: ModuleNode | AppRootNode = (await import(pathToFileURL(app.entry).href)).default;
    const deployRequest = () => ({
      operation: 'deploy' as const,
      stack: lower(root, composer, {
        name: 'shop',
        environment: 'dev',
        bundles: { 'shop.web': { dir: app.dir, entry: 'server.js' } },
        containers: new Map(),
        preflightPayloads: new Map(),
        state: devState(),
      }),
      stage: 'dev',
      cwd: app.dir,
      env: {},
    });

    const devRunning = converge(jobFor(app), quiet, controller.signal);
    await waitUntil(() => app.seen().includes('blocking'));
    const deployMeanwhile = await convergeInProcess(deployRequest());
    controller.abort();
    await devRunning;

    const deployController = new AbortController();
    fs.rmSync(path.join(app.dir, 'seen.txt'));
    const deployRunning = convergeInProcess({
      ...deployRequest(),
      signal: deployController.signal,
    });
    await waitUntil(() => app.seen().includes('blocking'));
    const devMeanwhile = await converge(jobFor(app), quiet);
    deployController.abort();
    await deployRunning;

    expect(deployMeanwhile).toEqual({ kind: 'refused', reason: 'already-running' });
    expect(devMeanwhile).toEqual({ kind: 'refused', reason: 'already-running' });
  }, 60_000);

  test('a dev converge while this thread holds the converge flag is refused, and starts no worker', async () => {
    const app = workerApp('v1');

    const held = await holdingConvergeProcess({}, process.cwd(), () =>
      converge(jobFor(app), quiet),
    );

    expect(held).toEqual({ held: true, value: { kind: 'refused', reason: 'already-running' } });
    expect(app.seen()).toEqual([]);
  }, 60_000);

  test('a converge that does not stop when interrupted is ended after the stop timeout, and fails saying so', async () => {
    const app = workerApp('stubborn');
    const before = process.cwd();
    const controller = new AbortController();

    const running = runDevConvergeInWorkerWith({ stopTimeoutMs: 500 })(
      jobFor(app),
      quiet,
      controller.signal,
    );
    await waitUntil(() => app.seen().includes('blocking'));
    controller.abort();
    const outcome = outcomeOf(await running);

    expect(outcome).toEqual({
      kind: 'failed',
      reasons: [
        {
          tag: 'ConvergeNotStopped',
          message:
            "The converge did not stop within 0.5s of being interrupted, so its worker thread was ended. Alchemy's local state may not record everything it changed; run `prisma dev` again, or `prisma dev --fresh` if that fails.",
        },
      ],
    });
    expect(process.cwd()).toBe(before);
  }, 60_000);

  test('a failed converge restores the working directory', async () => {
    const app = workerApp('fail');
    const before = process.cwd();

    const outcome = await converge(jobFor(app), quiet);

    expect(outcome).toMatchObject({ kind: 'failed', reasons: [{ message: 'the thing refused' }] });
    expect(process.cwd()).toBe(before);
  }, 60_000);

  test('an edited file that does not parse fails the converge with the import error, under its code', async () => {
    const app = workerApp('v1');
    fs.writeFileSync(app.labelFile, 'export const label = ;\n');

    const result = await runDevConvergeInWorker(jobFor(app), quiet);

    if (result.kind !== 'error') throw new Error(`expected an error, got ${result.kind}`);
    expect(result.error.code).toBe('COMPOSE.ENTRY_UNLOADABLE');
    expect(result.error.summary).toStartWith(`Failed to import entry module "${app.entry}": `);
    expect(result.appFiles).toContain(app.labelFile);
  }, 60_000);

  test("a structured error from loading the app's converge entry keeps its code, why and fix", async () => {
    const app = workerApp('v1');
    fs.rmSync(path.join(app.dir, 'node_modules'), { recursive: true });

    const result = await runDevConvergeInWorker(jobFor(app), quiet);

    expect(result).toMatchObject({
      kind: 'error',
      error: {
        code: 'DEPS.CONVERGE_UNRESOLVABLE',
        why: expect.stringContaining("run the lowering and Alchemy from the app's own install"),
        fix: expect.stringContaining('Install @prisma/composer in the app'),
      },
    });
  }, 60_000);

  test('a worker that exits before it reports an outcome fails the converge naming its exit code', async () => {
    const app = workerApp('exit');

    const outcome = await converge(jobFor(app), quiet);

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

  test('a worker that throws outside the converge fails it with the error', async () => {
    const app = workerApp('throw-later');

    const outcome = await converge(jobFor(app), quiet);

    expect(outcome).toEqual({
      kind: 'failed',
      reasons: [
        {
          tag: 'Error',
          message:
            'The converge worker thread failed before it reported an outcome: thrown outside the converge',
        },
      ],
    });
  }, 60_000);
});

/** A started dev session over `app`, whose watches the test fires by hand, by watched file. */
async function devSession(
  app: WorkerApp,
  events: DevEvent[],
  input: {
    readonly cwd?: string;
    readonly signal?: AbortSignal;
    readonly realWatch?: boolean;
  } = {},
) {
  const composer = (await import(pathToFileURL(app.configFile).href)).default.composer;
  const watched = new Map<string, () => void>();
  const start = await devWithDeps(
    {
      config: { value: composer, file: app.configFile },
      entry: app.entry,
      cwd: input.cwd ?? app.dir,
      onEvent: (event) => void events.push(event),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
    input.realWatch === true
      ? {}
      : {
          watch: (targets, onChange) => {
            for (const target of targets)
              for (const file of target.paths) watched.set(file, onChange);
            return { ready: Promise.resolve(), stop: () => undefined };
          },
        },
  );
  if (!start.ok) throw start.failure;
  const change = (file: string = app.labelFile): void => {
    const onChange = watched.get(file);
    if (onChange === undefined) throw new Error(`${file} is not watched`);
    onChange();
  };
  return { session: start.value, change, watched };
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

  test('dev converges with no service token in the environment', async () => {
    const app = workerApp('v1');
    const token = process.env['PRISMA_SERVICE_TOKEN'];
    delete process.env['PRISMA_SERVICE_TOKEN'];
    const events: DevEvent[] = [];
    try {
      const { session } = await devSession(app, events);
      await session.stop();
    } finally {
      if (token !== undefined) process.env['PRISMA_SERVICE_TOKEN'] = token;
    }

    expect(countOf(events, 'ready')).toBe(1);
    expect(app.seen()).toEqual([`v1 ${app.dir}`]);
  }, 60_000);

  test('dev converges from a cwd reached through a symlink', async () => {
    const app = workerApp('v1');
    const link = path.join(path.dirname(app.dir), `${path.basename(app.dir)}-link`);
    fs.symlinkSync(app.dir, link);
    links.push(link);
    const events: DevEvent[] = [];

    const { session } = await devSession(app, events, { cwd: link });
    await session.stop();

    expect(countOf(events, 'ready')).toBe(1);
    expect(app.seen()).toEqual([`v1 ${app.dir}`]);
  }, 60_000);

  test('dev converges from a cwd given relative to the process directory', async () => {
    const app = workerApp('v1');
    const events: DevEvent[] = [];

    const { session } = await devSession(app, events, {
      cwd: path.relative(process.cwd(), app.dir),
    });
    await session.stop();

    expect(countOf(events, 'ready')).toBe(1);
    expect(app.seen()).toEqual([`v1 ${app.dir}`]);
  }, 60_000);

  for (const specifier of ['./helpers.ts', './helpers', './helpers.js']) {
    test(`a file an edit imports as ${specifier} before it exists fails that rebuild, is watched, and creating it rebuilds and applies`, async () => {
      const app = workerApp('v1');
      const helpers = path.join(app.dir, 'helpers.ts');
      const events: DevEvent[] = [];

      const { session, change, watched } = await devSession(app, events);
      fs.writeFileSync(app.labelFile, `export { label } from '${specifier}';\n`);
      change();
      await waitUntil(() => countOf(events, 'converge-failed') === 1);
      const watchedAfterFailure = watched.has(helpers);
      fs.writeFileSync(helpers, "export const label = 'v2';\n");
      change(helpers);
      await waitUntil(() => countOf(events, 'ready') === 2);
      await session.stop();

      expect(watchedAfterFailure).toBe(true);
      expect(app.seen()).toEqual([`v1 ${app.dir}`, `v2 ${app.dir}`]);
    }, 60_000);
  }

  test('with the real file watch, a file an edit imports as ./lib/helpers before it or its directory exists is picked up once it is created', async () => {
    const app = workerApp('v1');
    const helpers = path.join(app.dir, 'lib', 'helpers.ts');
    const events: DevEvent[] = [];

    const { session } = await devSession(app, events, { realWatch: true });
    fs.writeFileSync(app.labelFile, "export { label } from './lib/helpers';\n");
    await waitUntil(() => countOf(events, 'converge-failed') === 1);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    fs.mkdirSync(path.dirname(helpers));
    fs.writeFileSync(helpers, "export const label = 'v2';\n");
    await waitUntil(() => countOf(events, 'ready') === 2);
    await session.stop();

    expect(countOf(events, 'converge-failed')).toBe(1);
    expect(app.seen()).toEqual([`v1 ${app.dir}`, `v2 ${app.dir}`]);
  }, 60_000);

  test('a definition file that stops parsing fails that rebuild with its code and fix, and dev keeps watching and applies the fix', async () => {
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

    const failed = events.find((event) => event.kind === 'converge-failed');
    expect(failed).toMatchObject({
      code: 'DEV.CONVERGE_FAILED',
      reasons: [{ tag: 'COMPOSE.ENTRY_UNLOADABLE' }],
    });
    expect(JSON.stringify(failed)).not.toContain('CliStructuredError');
    expect(countOf(events, 'converge-failed')).toBe(1);
    expect(app.seen()).toEqual([`v1 ${app.dir}`, `v2 ${app.dir}`]);
  }, 60_000);

  test('a file an edit newly imports is watched from then on', async () => {
    const app = workerApp('v1');
    const extra = path.join(app.dir, 'extra.ts');
    const events: DevEvent[] = [];

    const { session, change, watched } = await devSession(app, events);
    fs.writeFileSync(extra, "export const label = 'v2';\n");
    fs.writeFileSync(app.labelFile, "export { label } from './extra.ts';\n");
    change();
    await waitUntil(() => countOf(events, 'ready') === 2);
    const watchedAfterImport = watched.has(extra);
    fs.writeFileSync(extra, "export const label = 'v3';\n");
    change(extra);
    await waitUntil(() => countOf(events, 'ready') === 3);
    await session.stop();

    expect(watchedAfterImport).toBe(true);
    expect(app.seen()).toEqual([`v1 ${app.dir}`, `v2 ${app.dir}`, `v3 ${app.dir}`]);
  }, 60_000);

  test('an edit that adds a read of a platform variable does not converge, is reported, and pauses rebuilds', async () => {
    const app = workerApp('v1');
    const events: DevEvent[] = [];

    const { session, change } = await devSession(app, events);
    fs.writeFileSync(app.entry, entrySource({ readsVariable: true }));
    change(app.entry);
    await waitUntil(() => countOf(events, 'value-reads-changed') === 1);
    app.label('v2');
    change();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await session.stop();

    expect(events.filter((event) => event.kind === 'value-reads-changed')).toEqual([
      { kind: 'value-reads-changed', added: ['shop.smtpPort'], removed: [], changed: [] },
    ]);
    expect(countOf(events, 'converge-failed')).toBe(0);
    expect(app.seen()).toEqual([`v1 ${app.dir}`]);
  }, 60_000);

  test('an edit that makes the root pass on an input field dev did not read at start fails the rebuild, saying dev must be restarted', async () => {
    const app = workerApp('v1');
    const events: DevEvent[] = [];

    const { session, change } = await devSession(app, events);
    fs.writeFileSync(app.entry, entrySource({ passesOn: 'PATH' }));
    change(app.entry);
    await waitUntil(() => countOf(events, 'converge-failed') === 1);
    await session.stop();

    const failed = events.find((event) => event.kind === 'converge-failed');
    expect(failed).toMatchObject({
      kind: 'converge-failed',
      code: 'DEV.CONVERGE_FAILED',
      message:
        "The app's root now passes on a field of its input that dev did not read when it started, so the field has no value here. Restart `prisma dev` to apply the change.",
      reasons: [
        {
          tag: 'RootInputUnreadError',
          message:
            'input.PATH of root module "shop" was not read when this command started, so it has no value here. A module body must build the same graph every time; one that reads the process environment, a file or the clock can build a different one.',
        },
      ],
    });
    expect(app.seen()).toEqual([`v1 ${app.dir}`]);
  }, 60_000);

  test('an edit that adds a node fails the rebuild, saying dev must be restarted', async () => {
    const app = workerApp('v1');
    const events: DevEvent[] = [];

    const { session, change } = await devSession(app, events);
    fs.writeFileSync(app.entry, entrySource({ ids: ['thing', 'other'] }));
    change(app.entry);
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
