import { describe, expect, test } from 'bun:test';
import type { NextAction } from '@prisma/cli-engine/protocol';
import { createTestCli, type TestCli } from '@prisma/cli-engine/testing';
import { createOperationsDouble } from '../../testing/operations-double.ts';
import { createComposerFamily } from '../family.ts';
import { validComposerSection } from './fixtures/composer-section.ts';
import { mountAsHost } from './host-mount.ts';

const BIN = 'prisma-test';
const UPPERCASE_LETTER = /[A-Z]/g;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function composerCli() {
  const double = createOperationsDouble({});
  const family = createComposerFamily({ operations: double.operations });
  const cli = createTestCli({
    commandFamilies: [family],
    ...mountAsHost(family),
    config: { composer: validComposerSection() },
  });
  return { cli, calls: double.calls };
}

function step(label: string, command: string): NextAction {
  return { kind: 'run-command', label, command };
}

function help(path: string): NextAction {
  return step('Read its help', `${BIN} ${path} --help`);
}

interface Expected {
  readonly why: string;
  readonly nextActions: readonly NextAction[];
}

const ENVIRONMENT =
  'environment (a separate local copy of the app: the one named dev unless `--environment` names another)';

const PORTS_WHY =
  `\`dev\` takes no port options. Each ${ENVIRONMENT} gets its own ports for its services, ` +
  'databases and buckets and keeps them between runs. While `dev` runs, `dev url <address>` ' +
  'prints where one service, database or bucket answers; its address is its path from the app ' +
  'name, with dots between names, such as `shop.catalog.database`.';

const PATHS: Readonly<Record<string, Expected>> = {
  'dev ls': {
    why:
      '`emulator list` lists the local emulators on this machine, the programs `dev` starts to ' +
      "run the app's services, databases and buckets, with every instance each one holds.",
    nextActions: [step('Use the replacement', `${BIN} emulator list`), help('emulator list')],
  },
  'dev rm': {
    why:
      "`dev --fresh` deletes this app's local services, databases and buckets, and their data, " +
      `in one ${ENVIRONMENT}, then starts the app again. \`dev stop\` only stops the app's ` +
      'service processes and local database servers, and keeps their data.',
    nextActions: [step('Use the replacement', `${BIN} dev --fresh`), help('dev')],
  },
  'dev start': {
    why:
      '`dev --detach` runs the app locally in the background: it returns once every service ' +
      'answers and leaves the app running, without watching for changes, until `dev stop`.',
    nextActions: [step('Use the replacement', `${BIN} dev --detach`), help('dev')],
  },
};

const FLAGS: Readonly<Record<string, Expected>> = {
  'dev --port': { why: PORTS_WHY, nextActions: [help('dev')] },
  'dev --db-port': { why: PORTS_WHY, nextActions: [help('dev')] },
  'dev --shadow-db-port': { why: PORTS_WHY, nextActions: [help('dev')] },
  'dev --debug': {
    why:
      '`dev` has no debug output option. It shows the output of each service that runs a dev ' +
      "server, such as `next dev`, prefixed with the service's address.",
    nextActions: [help('dev')],
  },
  'dev stop --debug': {
    why: '`dev stop` has no debug output option.',
    nextActions: [help('dev stop')],
  },
};

function prisma7(invocation: string): string {
  return `To keep using Prisma 7, install its CLI with \`npm install --save-dev @prisma/prisma7@7\` and run \`prisma7 ${invocation}\`.`;
}

function humanLines(stderr: string): string[] {
  return stderr.replace(ANSI, '').trimEnd().split('\n');
}

function actionLine(action: NextAction): string {
  return `→ ${action.label}: ${action.command ?? action.url}`;
}

function splitFlagCase(invocation: string): { command: string; flag: string } {
  const at = invocation.indexOf(' --');
  return { command: invocation.slice(0, at), flag: invocation.slice(at + 3) };
}

function failedEnvelope(result: Awaited<ReturnType<TestCli['run']>>) {
  const last = result.json.at(-1);
  if (last?.kind !== 'result' || last.envelope.ok) {
    throw new Error(`expected a failed result frame, got: ${JSON.stringify(last)}`);
  }
  return last.envelope;
}

describe('Prisma 7 dev subcommands', () => {
  test('the family declares exactly the paths this test covers', () => {
    expect(
      createComposerFamily()
        .redirects.filter((redirect) => redirect.code === 'CLI.V7_COMMAND')
        .map((redirect) => redirect.from)
        .sort(),
    ).toEqual(Object.keys(PATHS).sort());
  });

  test.each(Object.entries(PATHS))(
    '`%s` settles as CLI.V7_COMMAND in --json output',
    async (path, { why, nextActions }) => {
      const { cli, calls } = composerCli();

      const result = await cli.run([...path.split(' '), '--json']);

      expect(result.exitCode).toBe(2);
      const envelope = failedEnvelope(result);
      expect(envelope.commandId).toBe(path.replaceAll(' ', '.'));
      expect(envelope.error.code).toBe('CLI.V7_COMMAND');
      expect(envelope.error.summary).toBe(
        `\`${BIN} ${path}\` is a Prisma 7 command and is not available in Prisma 8`,
      );
      expect(envelope.error.why).toBe(`${why} ${prisma7(path)}`);
      expect(envelope.nextActions).toEqual(nextActions);
      expect(envelope.error.nextActions).toEqual(nextActions);
      expect(calls.dev).toEqual([]);
    },
  );

  test.each(Object.entries(PATHS))(
    '`%s` settles as CLI.V7_COMMAND in human output',
    async (path, { why, nextActions }) => {
      const { cli } = composerCli();

      const result = await cli.run(path.split(' '), { isTty: { stdout: true, stderr: true } });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(humanLines(result.stderr)).toEqual([
        `✘ [CLI.V7_COMMAND] \`${BIN} ${path}\` is a Prisma 7 command and is not available in Prisma 8`,
        `  why: ${why} ${prisma7(path)}`,
        ...nextActions.map(actionLine),
      ]);
    },
  );
});

describe('Prisma 7 flags on dev and dev stop', () => {
  test('the family declares exactly the flags this test covers', () => {
    expect(
      createComposerFamily()
        .redirects.filter((redirect) => redirect.code === 'CLI.V7_FLAG')
        .map(
          (redirect) =>
            `${redirect.from} --${redirect.flag?.replace(UPPERCASE_LETTER, (letter) => `-${letter.toLowerCase()}`)}`,
        )
        .sort(),
    ).toEqual(Object.keys(FLAGS).sort());
  });

  test.each(Object.entries(FLAGS))(
    '`%s` settles as CLI.V7_FLAG in --json output',
    async (invocation, { why, nextActions }) => {
      const { cli, calls } = composerCli();
      const { command, flag } = splitFlagCase(invocation);

      const result = await cli.run([...command.split(' '), `--${flag}`, '--json']);

      expect(result.exitCode).toBe(2);
      const envelope = failedEnvelope(result);
      expect(envelope.commandId).toBe(command.replaceAll(' ', '.'));
      expect(envelope.error.code).toBe('CLI.V7_FLAG');
      expect(envelope.error.summary).toBe(
        `\`--${flag}\` on \`${BIN} ${command}\` is a Prisma 7 flag and is not available in Prisma 8`,
      );
      expect(envelope.error.why).toBe(`${why} ${prisma7(invocation)}`);
      expect(envelope.nextActions).toEqual(nextActions);
      expect(envelope.error.nextActions).toEqual(nextActions);
      expect(calls.dev).toEqual([]);
      expect(calls.devStop).toEqual([]);
    },
  );

  test.each(Object.entries(FLAGS))(
    '`%s` settles as CLI.V7_FLAG in human output',
    async (invocation, { why, nextActions }) => {
      const { cli } = composerCli();
      const { command, flag } = splitFlagCase(invocation);

      const result = await cli.run([...command.split(' '), `--${flag}`], {
        isTty: { stdout: true, stderr: true },
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(humanLines(result.stderr)).toEqual([
        `✘ [CLI.V7_FLAG] \`--${flag}\` on \`${BIN} ${command}\` is a Prisma 7 flag and is not available in Prisma 8`,
        `  why: ${why} ${prisma7(invocation)}`,
        ...nextActions.map(actionLine),
      ]);
    },
  );

  test('the Prisma 7 sentence names the flag and never suggests npx', async () => {
    const { cli } = composerCli();

    const result = await cli.run(['dev', 'stop', '--debug', '--json']);

    expect(failedEnvelope(result).error.why).toBe(
      '`dev stop` has no debug output option. To keep using Prisma 7, install its CLI with ' +
        '`npm install --save-dev @prisma/prisma7@7` and run `prisma7 dev stop --debug`.',
    );
    expect(result.stdout).not.toContain('npx');
  });

  test('a v7 flag that takes a value settles the same way when it is given one', async () => {
    const { cli } = composerCli();

    const result = await cli.run(['dev', '--port', '5555', '--json']);

    expect(result.exitCode).toBe(2);
    expect(failedEnvelope(result).error.code).toBe('CLI.V7_FLAG');
  });
});
