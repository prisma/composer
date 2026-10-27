import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import { validateEnvironmentName } from '../validate-environment.ts';

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
});
