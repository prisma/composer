import { describe, expect, test } from 'bun:test';
import { CliError } from '../cli-error.ts';
import { validateStageName } from '../validate-stage.ts';

describe('validateStageName()', () => {
  test.each(['staging', 'pr-42', 'feat/x'])('accepts %s', (stage) => {
    expect(() => validateStageName(stage)).not.toThrow();
  });

  test.each(['foo..bar', 'foo bar', 'foo~1'])('rejects %s', (stage) => {
    expect(() => validateStageName(stage)).toThrow(CliError);
  });
});
