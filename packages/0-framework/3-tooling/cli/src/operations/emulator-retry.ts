/**
 * An emulator admin call right after a converge that just PUT dozens of
 * resources through the same daemon can hit a transient refused/reset
 * connection — a brief loopback hiccup under load, not a real failure.
 * Retried before giving up. Shared by the dev and log executors, which talk
 * to the same daemons (`startServices`, `endpoints`, `attach`).
 */

const EMULATOR_RETRY_ATTEMPTS = 5;
const EMULATOR_RETRY_DELAY_MS = 500;

export async function withEmulatorRetry<T>(call: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= EMULATOR_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (attempt < EMULATOR_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, EMULATOR_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
