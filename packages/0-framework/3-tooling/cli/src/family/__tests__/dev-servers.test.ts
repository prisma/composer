/** How `prisma dev` renders a service that runs its build adapter's dev server (ADR-0056). */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import type { EngineEvent } from '@prisma/cli-engine';
import { createTestCli } from '@prisma/cli-engine/testing';
import { createOperationsDouble } from '../../testing/operations-double.ts';
import { createComposerFamily } from '../family.ts';
import { commandAt } from './command-at.ts';
import { validComposerSection } from './fixtures/composer-section.ts';

const AS_TTY = { isTty: { stdout: true, stderr: true } } as const;

describe('dev — dev servers', () => {
  test('announces each dev server, marks it on the front door, reports a restart, and prefixes its output with the address', async () => {
    const cwd = '/repo/shop';
    const double = createOperationsDouble({
      devEndpoints: [
        { address: 'api', url: 'http://localhost:3000' },
        { address: 'web', url: 'http://localhost:3001', devServer: 'next dev' },
      ],
      devEvents: [
        {
          kind: 'dev-server',
          address: 'web',
          command: 'next dev',
          cwd: path.join(cwd, 'apps', 'web'),
        },
        { kind: 'dev-server-restarted', address: 'web', command: 'next dev' },
        { kind: 'dev-server-output', address: 'web', line: ' ✓ Ready in 1.2s' },
      ],
    });
    const family = createComposerFamily({ operations: double.operations });
    const cli = createTestCli({
      commandFamilies: [family],
      commands: { deploy: commandAt(family, 'deploy'), dev: commandAt(family, 'dev') },
      config: { composer: validComposerSection() },
    });
    const interrupt = new AbortController();

    const result = await cli.run(['dev', '--entry', 'src/service.ts'], {
      ...AS_TTY,
      cwd,
      abort: interrupt.signal,
      onEvent: (event: EngineEvent) => {
        if (event.kind === 'message' && event.text.startsWith('[web]')) interrupt.abort();
      },
    });

    expect(result.events).toContainEqual({
      kind: 'endpoint',
      name: 'api',
      url: 'http://localhost:3000',
    });
    expect(result.events).toContainEqual({
      kind: 'endpoint',
      name: 'web',
      url: 'http://localhost:3001',
      data: { devServer: 'next dev' },
    });
    const messages = result.events.flatMap((e) => (e.kind === 'message' ? [e.text] : []));
    expect(messages).toContain(`web: runs \`next dev\` in ${path.join('apps', 'web')}`);
    expect(messages).toContain('web: its environment changed; `next dev` restarted');
    expect(messages).toContain('[web]  ✓ Ready in 1.2s');
  });
});
