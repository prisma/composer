import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import { withEmulatorRetry } from '../emulator-retry.ts';

function unreachable(): CliStructuredError {
  return new CliStructuredError('DEV.EMULATOR_UNREACHABLE', 'could not reach the emulator');
}

describe('withEmulatorRetry', () => {
  test('retries while the emulator cannot be reached, then returns the result', async () => {
    let calls = 0;
    const result = await withEmulatorRetry(async () => {
      calls += 1;
      if (calls < 3) throw unreachable();
      return 'answered';
    });

    expect(result).toBe('answered');
    expect(calls).toBe(3);
  });

  test('gives up after five attempts when the emulator stays unreachable', async () => {
    let calls = 0;
    const attempt = withEmulatorRetry(async () => {
      calls += 1;
      throw unreachable();
    });

    await expect(attempt).rejects.toMatchObject({ code: 'DEV.EMULATOR_UNREACHABLE' });
    expect(calls).toBe(5);
  });

  test('does not retry an error response from the emulator', async () => {
    let calls = 0;
    const attempt = withEmulatorRetry(async () => {
      calls += 1;
      throw new Error(
        'request to the local dev emulator failed (500): service "quotes" did not accept connections',
      );
    });

    await expect(attempt).rejects.toThrow('did not accept connections');
    expect(calls).toBe(1);
  });

  test('does not retry a structured error with another code', async () => {
    let calls = 0;
    const attempt = withEmulatorRetry(async () => {
      calls += 1;
      throw new CliStructuredError('DEV.EMULATORS_DIR_INVALID', 'relative path');
    });

    await expect(attempt).rejects.toMatchObject({ code: 'DEV.EMULATORS_DIR_INVALID' });
    expect(calls).toBe(1);
  });
});
