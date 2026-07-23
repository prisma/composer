import { describe, expect, test } from 'bun:test';
import { UsageError } from 'clipanion';
import { parseArgs } from '../main.ts';

describe('parseArgs() (clipanion-backed)', () => {
  test('parses a bare deploy invocation', () => {
    expect(parseArgs(['deploy', 'src/service.ts'])).toEqual({
      command: 'deploy',
      entry: 'src/service.ts',
      name: undefined,
      stage: undefined,
      production: false,
      fresh: false,
    });
  });

  test('parses --name and --stage in either order', () => {
    expect(parseArgs(['destroy', 'src/service.ts', '--name', 'ci-run', '--stage', 'prod'])).toEqual(
      {
        command: 'destroy',
        entry: 'src/service.ts',
        name: 'ci-run',
        stage: 'prod',
        production: false,
        fresh: false,
      },
    );
    expect(parseArgs(['deploy', '--stage', 'prod', 'src/service.ts', '--name', 'ci-run'])).toEqual({
      command: 'deploy',
      entry: 'src/service.ts',
      name: 'ci-run',
      stage: 'prod',
      production: false,
      fresh: false,
    });
  });

  test('parses --production', () => {
    expect(parseArgs(['destroy', 'src/service.ts', '--production'])).toEqual({
      command: 'destroy',
      entry: 'src/service.ts',
      name: undefined,
      stage: undefined,
      production: true,
      fresh: false,
    });
  });

  test('throws UsageError on a bare invocation (no command)', () => {
    expect(() => parseArgs([])).toThrow(UsageError);
  });

  test('throws UsageError when the command is neither deploy nor destroy', () => {
    expect(() => parseArgs(['build', 'src/service.ts'])).toThrow(UsageError);
  });

  test('throws UsageError when the entry is missing', () => {
    expect(() => parseArgs(['deploy'])).toThrow(UsageError);
    expect(() => parseArgs(['deploy', '--name', 'x'])).toThrow(UsageError);
  });

  // F02: a trailing --name/--stage with no value used to be silently
  // accepted by the handrolled parser (name/stage ended up undefined, no
  // error) — clipanion's own arity checking now catches it as a usage error.
  test('throws UsageError on a trailing --name with no value (F02)', () => {
    expect(() => parseArgs(['deploy', 'src/service.ts', '--name'])).toThrow(UsageError);
  });

  test('throws UsageError on a trailing --stage with no value (F02)', () => {
    expect(() => parseArgs(['deploy', 'src/service.ts', '--stage'])).toThrow(UsageError);
  });

  test('throws UsageError on an unknown flag', () => {
    expect(() => parseArgs(['deploy', 'src/service.ts', '--bogus'])).toThrow(UsageError);
  });

  test('an empty --name value parses through (validated downstream by run(), not by parsing)', () => {
    expect(parseArgs(['deploy', 'src/service.ts', '--name', ''])).toEqual({
      command: 'deploy',
      entry: 'src/service.ts',
      name: '',
      stage: undefined,
      production: false,
      fresh: false,
    });
  });

  test('parses a bare dev invocation', () => {
    expect(parseArgs(['dev', 'src/service.ts'])).toEqual({
      command: 'dev',
      entry: 'src/service.ts',
      name: undefined,
      stage: undefined,
      production: false,
      fresh: false,
    });
  });

  test('parses dev --name and --fresh', () => {
    expect(parseArgs(['dev', 'src/service.ts', '--name', 'ci-run', '--fresh'])).toEqual({
      command: 'dev',
      entry: 'src/service.ts',
      name: 'ci-run',
      stage: undefined,
      production: false,
      fresh: true,
    });
  });

  test('throws UsageError when dev is passed --stage', () => {
    expect(() => parseArgs(['dev', 'src/service.ts', '--stage', 'prod'])).toThrow(UsageError);
  });

  test('throws UsageError when dev is passed --production', () => {
    expect(() => parseArgs(['dev', 'src/service.ts', '--production'])).toThrow(UsageError);
  });
});
