/**
 * Runs `run` with `console`'s stdout methods writing to stderr, and restores
 * them after. `prisma deploy` wraps its operation in this: stdout carries the
 * command's data lines and JSON frames, and a provider's `console.log`
 * during the apply must not land among them. A host calling the operation
 * directly keeps its own `console`.
 */
const STDOUT_METHODS = ['log', 'info', 'debug', 'dir', 'table'] as const;

export async function withConsoleOnStderr<T>(run: () => Promise<T>): Promise<T> {
  const saved = STDOUT_METHODS.map((method) => [method, console[method]] as const);
  try {
    for (const method of STDOUT_METHODS) {
      console[method] = (...args: unknown[]) => console.error(...args);
    }
    return await run();
  } finally {
    for (const [method, original] of saved) {
      Object.assign(console, { [method]: original });
    }
  }
}
