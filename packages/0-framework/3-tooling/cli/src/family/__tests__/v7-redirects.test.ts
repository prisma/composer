/** The Prisma 7 `dev` subcommands and flags, run through the engine with the family mounted as the `prisma` host mounts it. */
import { describe, expect, test } from 'bun:test';
import type { NextAction } from '@prisma/cli-engine/protocol';
import { createTestCli, type TestCli } from '@prisma/cli-engine/testing';
import { createOperationsDouble } from '../../testing/operations-double.ts';
import { createComposerFamily } from '../family.ts';
import { validComposerSection } from './fixtures/composer-section.ts';
import { mountAsHost } from './host-mount.ts';

const BIN = 'prisma-test';
const UPPERCASE_LETTER = /[A-Z]/g;
const WHY_LINE = /^ {2}why: /;
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

const PATHS: Readonly<Record<string, readonly NextAction[]>> = {
  'dev ls': [step('Use the replacement', `${BIN} emulator list`), help('emulator list')],
  'dev rm': [{ kind: 'open-url', label: 'Read the docs', url: 'https://www.prisma.io/docs/cli' }],
  'dev start': [step('Use the replacement', `${BIN} dev --detach`), help('dev')],
};

const FLAGS: Readonly<Record<string, readonly NextAction[]>> = {
  'dev --port': [help('dev')],
  'dev --db-port': [help('dev')],
  'dev --shadow-db-port': [help('dev')],
  'dev --debug': [help('dev')],
  'dev stop --debug': [help('dev stop')],
};

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
    async (path, nextActions) => {
      const { cli, calls } = composerCli();

      const result = await cli.run([...path.split(' '), '--json']);

      expect(result.exitCode).toBe(2);
      const envelope = failedEnvelope(result);
      expect(envelope.commandId).toBe(path.replaceAll(' ', '.'));
      expect(envelope.error.code).toBe('CLI.V7_COMMAND');
      expect(envelope.error.summary).toBe(
        `\`${BIN} ${path}\` is a Prisma 7 command and is not available in Prisma 8`,
      );
      expect(envelope.error.why).toEqual(expect.any(String));
      expect(envelope.nextActions).toEqual(nextActions);
      expect(envelope.error.nextActions).toEqual(nextActions);
      expect(calls.dev).toEqual([]);
    },
  );

  test.each(Object.entries(PATHS))(
    '`%s` settles as CLI.V7_COMMAND in human output',
    async (path, nextActions) => {
      const { cli } = composerCli();

      const result = await cli.run(path.split(' '), { isTty: { stdout: true, stderr: true } });

      expect(result.exitCode).toBe(2);
      const lines = result.stderr.replace(ANSI, '').trimEnd().split('\n');
      expect(lines[0]).toBe(
        `✘ [CLI.V7_COMMAND] \`${BIN} ${path}\` is a Prisma 7 command and is not available in Prisma 8`,
      );
      expect(lines[1]).toMatch(WHY_LINE);
      expect(lines.slice(-nextActions.length)).toEqual(
        nextActions.map((action) => `→ ${action.label}: ${action.command ?? action.url}`),
      );
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
    async (invocation, nextActions) => {
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
      expect(envelope.error.why).toEqual(expect.any(String));
      expect(envelope.nextActions).toEqual(nextActions);
      expect(envelope.error.nextActions).toEqual(nextActions);
      expect(calls.dev).toEqual([]);
      expect(calls.devStop).toEqual([]);
    },
  );

  test('a v7 flag that takes a value settles the same way when it is given one', async () => {
    const { cli } = composerCli();

    const result = await cli.run(['dev', '--port', '5555', '--json']);

    expect(result.exitCode).toBe(2);
    expect(failedEnvelope(result).error.code).toBe('CLI.V7_FLAG');
  });
});
