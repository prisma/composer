/** How `prisma dev` renders a warning a target's preflight raised. */
import { describe, expect, test } from 'bun:test';
import type { EngineEvent } from '@prisma/cli-engine';
import { createTestCli } from '@prisma/cli-engine/testing';
import { createOperationsDouble } from '../../testing/operations-double.ts';
import { createComposerFamily } from '../family.ts';
import { commandAt } from './command-at.ts';
import { validComposerSection } from './fixtures/composer-section.ts';

const WARNING =
  'shop.site names the hostname shop.com. prisma dev ignores it and serves the service on its local URL.';

describe('dev — target warnings', () => {
  test('prints a target-warning event as a warning, word for word', async () => {
    const double = createOperationsDouble({
      devEndpoints: [{ address: 'shop.web', url: 'http://localhost:3000' }],
      devEvents: [{ kind: 'target-warning', message: WARNING }],
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
