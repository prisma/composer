import { CliStructuredError } from '@internal/foundation/errors';

/**
 * An emulator admin call right after a converge that just PUT dozens of
 * resources through the same daemon can fail to connect — a brief loopback
 * hiccup under load, not a real failure. Only that is retried: the emulator
 * client reports it as `DEV.EMULATOR_UNREACHABLE`. Anything else is final,
 * including an error response (such as a service that failed to start) and a
 * connection reset while a response body is read. Shared by the dev and log
 * executors, which talk to the same daemons (`startServices`, `endpoints`,
 * `attach`).
 */

const EMULATOR_RETRY_ATTEMPTS = 5;
const EMULATOR_RETRY_DELAY_MS = 500;

function isUnreachable(error: unknown): boolean {
  return CliStructuredError.is(error) && error.code === 'DEV.EMULATOR_UNREACHABLE';
}

export async function withEmulatorRetry<T>(call: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= EMULATOR_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      lastError = error;
      if (attempt < EMULATOR_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, EMULATOR_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
