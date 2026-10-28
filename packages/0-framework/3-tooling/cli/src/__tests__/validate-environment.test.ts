import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { CliStructuredError } from '@internal/foundation/errors';
import { validateEnvironmentName } from '../validate-environment.ts';

function recordingSpawn() {
  const calls: (readonly string[])[] = [];
  const spawn: Parameters<typeof validateEnvironmentName>[1] = (command, args, options) => {
    calls.push([command, ...args]);
    return spawnSync(command, [...args], options);
  };
  return { calls, spawn };
}

describe('validateEnvironmentName()', () => {
  test.each(['production', 'dev', 'staging', 'pr-42', 'feat/x'])('accepts %s', (environment) => {
    expect(() => validateEnvironmentName(environment)).not.toThrow();
  });

  test.each(['foo..bar', 'foo bar', 'foo~1', ''])('rejects %p', (environment) => {
    expect(() => validateEnvironmentName(environment)).toThrow(
      expect.objectContaining({ code: 'DEPLOY.ENVIRONMENT_INVALID' }),
    );
    expect(() => validateEnvironmentName(environment)).toThrow(CliStructuredError);
  });

  test.each(['production', 'staging', 'pr-42'])('accepts %s without running git', (environment) => {
    const { calls, spawn } = recordingSpawn();
    validateEnvironmentName(environment, spawn);
    expect(calls).toEqual([]);
  });

  test('a name with a slash is checked by git', () => {
    const { calls, spawn } = recordingSpawn();
    validateEnvironmentName('feat/x', spawn);
    expect(calls).toEqual([['git', 'check-ref-format', 'refs/heads/feat/x']]);
  });
});
