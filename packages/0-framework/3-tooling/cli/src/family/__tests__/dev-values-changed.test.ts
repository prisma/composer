/** How `prisma dev` renders a change in what the config or secrets adapters return, or in the platform variables the app reads. */
import { describe, expect, test } from 'bun:test';
import type { EngineEvent } from '@prisma/cli-engine';
import { createTestCli } from '@prisma/cli-engine/testing';
import type { DevEvent } from '../../operations/dev.ts';
import { createOperationsDouble } from '../../testing/operations-double.ts';
import { createComposerFamily } from '../family.ts';
import { commandAt } from './command-at.ts';
import { validComposerSection } from './fixtures/composer-section.ts';

async function warningsFor(event: DevEvent, expected: string) {
  const double = createOperationsDouble({
    devEndpoints: [{ address: 'shop.web', url: 'http://localhost:3000' }],
    devEvents: [event],
  });
  const family = createComposerFamily({ operations: double.operations });
  const cli = createTestCli({
    commandFamilies: [family],
    commands: { deploy: commandAt(family, 'deploy'), dev: commandAt(family, 'dev') },
    config: { composer: validComposerSection() },
  });
  const interrupt = new AbortController();
  const result = await cli.run(['dev', '--entry', 'src/service.ts'], {
    isTty: { stdout: true, stderr: true },
    cwd: '/repo/shop',
    abort: interrupt.signal,
    onEvent: (engineEvent: EngineEvent) => {
      if (engineEvent.kind === 'message' && engineEvent.text === expected) interrupt.abort();
    },
  });
  return result.events.filter(
    (engineEvent) => engineEvent.kind === 'message' && engineEvent.severity === 'warn',
  );
}

const WARNING =
  'The values the config or secrets adapters return changed since dev started. Restart dev to apply them; rebuilds are paused until then.';

describe('dev — changed adapter values', () => {
  test('values-changed renders as a warning', async () => {
    const double = createOperationsDouble({
      devEndpoints: [{ address: 'shop.web', url: 'http://localhost:3000' }],
      devEvents: [{ kind: 'values-changed' }],
    });
    const family = createComposerFamily({ operations: double.operations });
    const cli = createTestCli({
      commandFamilies: [family],
      commands: { deploy: commandAt(family, 'deploy'), dev: commandAt(family, 'dev') },
      config: { composer: validComposerSection() },
    });
    const interrupt = new AbortController();

    const result = await cli.run(['dev', '--entry', 'src/service.ts'], {
      isTty: { stdout: true, stderr: true },
      cwd: '/repo/shop',
      abort: interrupt.signal,
      onEvent: (event: EngineEvent) => {
        if (event.kind === 'message' && event.text === WARNING) interrupt.abort();
      },
    });

    expect(result.events).toContainEqual({ kind: 'message', severity: 'warn', text: WARNING });
  });

  test('a change in the platform variables the app reads is a warning that names each node in one clause', async () => {
    const expected =
      'The platform variables the app reads changed since dev started: reads of "shop.smtpPort" were added, reads of "shop.emailFrom" were removed, and "shop.sender" was changed. Restart dev to apply them; rebuilds are paused until then.';

    const warnings = await warningsFor(
      {
        kind: 'value-reads-changed',
        added: ['shop.smtpPort'],
        removed: ['shop.emailFrom'],
        changed: ['shop.sender'],
      },
      expected,
    );

    expect(warnings).toEqual([{ kind: 'message', severity: 'warn', text: expected }]);
  });

  test('a change in the platform variables the app reads leaves out a clause with no nodes, and lists several nodes in one clause', async () => {
    const expected =
      'The platform variables the app reads changed since dev started: reads of "shop.a", "shop.b" and "shop.c" were added and "shop.d" and "shop.e" were changed. Restart dev to apply them; rebuilds are paused until then.';

    const warnings = await warningsFor(
      {
        kind: 'value-reads-changed',
        added: ['shop.a', 'shop.b', 'shop.c'],
        removed: [],
        changed: ['shop.d', 'shop.e'],
      },
      expected,
    );

    expect(warnings).toEqual([{ kind: 'message', severity: 'warn', text: expected }]);
  });
});
