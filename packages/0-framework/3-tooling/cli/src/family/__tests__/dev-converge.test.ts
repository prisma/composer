/** How `prisma dev` renders its in-process converges, and how Ctrl-C during the first one settles. */
import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk } from '@internal/foundation/result';
import type { EngineEvent } from '@prisma/cli-engine';
import { createTestCli } from '@prisma/cli-engine/testing';
import type { DevEvent } from '../../operations/dev.ts';
import { createOperationsDouble } from '../../testing/operations-double.ts';
import { type ComposerOperations, createComposerFamily } from '../family.ts';
import { commandAt } from './command-at.ts';
import { validComposerSection } from './fixtures/composer-section.ts';

function cliWith(operations: ComposerOperations) {
  const family = createComposerFamily({ operations });
  return createTestCli({
    commandFamilies: [family],
    commands: { deploy: commandAt(family, 'deploy'), dev: commandAt(family, 'dev') },
    config: { composer: validComposerSection() },
  });
}

/** Runs `dev` against a session double that sends `devEvents`, and stops it once the last of them is reported. */
async function runWithEvents(
  devEvents: readonly DevEvent[],
  last: (event: EngineEvent) => boolean,
) {
  const double = createOperationsDouble({
    devEndpoints: [{ address: 'shop.web', url: 'http://localhost:3000' }],
    devEvents,
  });
  const interrupt = new AbortController();
  const result = await cliWith(double.operations).run(['dev', '--entry', 'src/service.ts'], {
    isTty: { stdout: true, stderr: true },
    cwd: '/repo/shop',
    abort: interrupt.signal,
    onEvent: (event: EngineEvent) => {
      if (last(event)) interrupt.abort();
    },
  });
  return { result, double };
}

describe('dev — converging in process', () => {
  test("hands the run's signal to the operation and starts no child", async () => {
    const { result, double } = await runWithEvents(
      [],
      (event) => event.kind === 'status' && event.status === 'ready',
    );

    expect(double.calls.dev[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(double.calls.deps.dev[0]?.alchemy).toBeUndefined();
    expect(commandAt(createComposerFamily({ operations: double.operations }), 'dev').maySpawn).toBe(
      false,
    );
    expect(result.exitCode).toBe(130);
  });

  test('each converge is a step with its resources inside it, and log lines are messages', async () => {
    const rebuild = { name: 'converge', id: 'dev.rebuild.2' } as const;
    const web = {
      name: 'apply-resource',
      converge: 'dev.rebuild.2',
      fqn: 'shop.web',
      resourceType: 'Local.Compute',
    } as const;
    const { result } = await runWithEvents(
      [
        { kind: 'step-started', step: rebuild },
        { kind: 'step-started', step: { ...web, status: 'updating' } },
        { kind: 'message', severity: 'info', text: 'Plan: 1 to update' },
        {
          kind: 'step-finished',
          step: { ...web, status: 'updated' },
          outcome: 'ok',
          durationMs: 5,
        },
        { kind: 'step-finished', step: rebuild, outcome: 'ok', durationMs: 9 },
      ],
      (event) => event.kind === 'step-finished' && event.id === 'dev.rebuild.2',
    );

    expect(result.events).toContainEqual({
      kind: 'step-started',
      step: 'rebuild 2',
      id: 'dev.rebuild.2',
    });
    expect(result.events).toContainEqual({
      kind: 'step-started',
      step: 'updating shop.web',
      id: 'dev.rebuild.2.shop.web',
      parentId: 'dev.rebuild.2',
      data: { resourceType: 'Local.Compute' },
    });
    expect(result.events).toContainEqual({
      kind: 'step-finished',
      step: 'updated shop.web',
      id: 'dev.rebuild.2.shop.web',
      outcome: 'ok',
      data: { durationMs: 5 },
    });
    expect(result.events).toContainEqual({
      kind: 'message',
      severity: 'info',
      text: 'Plan: 1 to update',
    });
  });

  test('a failed rebuild is a warning with the cause, and no reproduce command', async () => {
    const text =
      'Converge failed; the running app is untouched and dev is still watching.\nProviderError: the provider refused';
    const { result } = await runWithEvents(
      [
        {
          kind: 'converge-failed',
          code: 'DEV.CONVERGE_FAILED',
          message: 'ProviderError: the provider refused',
          reasons: [{ tag: 'ProviderError', message: 'the provider refused' }],
        },
      ],
      (event) => event.kind === 'message' && event.text === text,
    );

    expect(result.events).toContainEqual({
      kind: 'message',
      severity: 'warn',
      text,
      data: {
        code: 'DEV.CONVERGE_FAILED',
        reasons: [{ tag: 'ProviderError', message: 'the provider refused' }],
      },
    });
    expect(result.events.some((event) => event.kind === 'remediation')).toBe(false);
  });

  test('an edit to the app definition renders as a warning that asks for a restart', async () => {
    const text =
      '/repo/shop/src/service.ts changed. dev loaded the app definition files when it started and cannot load them again; restart dev to apply the change. Rebuilds are paused until then.';
    const { result } = await runWithEvents(
      [{ kind: 'definition-changed', files: ['/repo/shop/src/service.ts'] }],
      (event) => event.kind === 'message' && event.text === text,
    );

    expect(result.events).toContainEqual({ kind: 'message', severity: 'warn', text });
  });

  test('Ctrl-C during the first converge settles 130, reporting the interruption, not an error', async () => {
    const double = createOperationsDouble({});
    const interrupt = new AbortController();
    const operations: ComposerOperations = {
      ...double.operations,
      dev: async () => {
        interrupt.abort();
        return notOk(
          new CliStructuredError('DEV.INTERRUPTED', 'dev was interrupted while it converged.', {
            fix: 'Run dev again to finish.',
          }),
        );
      },
    };

    const result = await cliWith(operations).run(['dev', '--entry', 'src/service.ts', '--json'], {
      abort: interrupt.signal,
    });

    expect(result.exitCode).toBe(130);
    expect(result.events).toContainEqual({
      kind: 'message',
      severity: 'warn',
      text: 'dev was interrupted while it converged. Run dev again to finish.',
    });
  });
});
