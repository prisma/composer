/** How `prisma dev` renders a change in what the config or secrets adapters return. */
import { describe, expect, test } from 'bun:test';
import type { EngineEvent } from '@prisma/cli-engine';
import { createTestCli } from '@prisma/cli-engine/testing';
import { createOperationsDouble } from '../../testing/operations-double.ts';
import { createComposerFamily } from '../family.ts';
import { commandAt } from './command-at.ts';
import { validComposerSection } from './fixtures/composer-section.ts';

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
});
