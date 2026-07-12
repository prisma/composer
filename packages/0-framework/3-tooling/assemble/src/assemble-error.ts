/**
 * A user-facing assembly failure with a message that already names the fix
 * (mirrors @internal/cli's CliError contract). This package must not import
 * CliError — its second consumer is the future programmatic deploy API, not
 * just the CLI — so it throws its own typed error; the CLI maps it (or lets
 * it propagate, since bin.ts already treats every Error uniformly: print the
 * message, exit nonzero).
 */
export class AssembleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssembleError';
  }
}
