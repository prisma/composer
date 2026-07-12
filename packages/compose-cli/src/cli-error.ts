/**
 * A user-facing failure with a message that already names the fix (deploy-cli.md
 * § Error surface). `bin.ts` catches this — and any other Error, including
 * core's LoadError/LowerError — uniformly: print the message, exit nonzero.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
