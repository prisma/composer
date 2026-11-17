import { format } from 'node:util';

const METHODS = ['log', 'info', 'debug', 'dir', 'table', 'warn', 'error'] as const;

/**
 * Runs `run` with every `console` method writing to stderr through `redact`,
 * and restores them after: stdout carries the command's data lines and JSON
 * frames, so a provider's `console.log` during the apply must not land among
 * them.
 */
export async function withConsoleOnStderr<T>(
  redact: (text: string) => string,
  run: () => Promise<T>,
): Promise<T> {
  const saved = METHODS.map((method) => [method, console[method]] as const);
  const error = console.error;
  try {
    for (const method of METHODS) {
      console[method] = (...args: unknown[]) => error.call(console, redact(format(...args)));
    }
    return await run();
  } finally {
    for (const [method, original] of saved) {
      Object.assign(console, { [method]: original });
    }
  }
}
