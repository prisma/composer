// Duplicated from the prisma/prisma error foundation pending extraction into a shared package — keep byte-close to the donor; recognition is structural, so the copies interoperate.
import { blindCast } from './casts.ts';
import { ifDefined } from './defined.ts';
import type { StructuredError } from './structured-error.ts';

/**
 * CLI error envelope for output formatting.
 * This is the serialized form of a CliStructuredError.
 */
export interface CliErrorEnvelope {
  readonly ok: false;
  readonly code: string;
  readonly severity: 'error' | 'warn' | 'info';
  readonly summary: string;
  readonly why?: string;
  readonly fix?: string;
  readonly where?: { readonly path?: string; readonly line?: number };
  readonly meta?: Record<string, unknown>;
  readonly docsUrl?: string;
}

/**
 * Minimal conflict data structure expected by CLI output.
 */
export interface CliErrorConflict {
  readonly kind: string;
  readonly summary: string;
  readonly why?: string;
}

/**
 * Structured CLI error that contains all information needed for error envelopes.
 * Call sites throw these errors with full context.
 *
 * A `CliStructuredError` is a `StructuredError` (see
 * `./structured-error.ts`): `code` is a dotted
 * `NAMESPACE.SUBCODE` string, and the namespace prefix is the error's
 * category — there is no separate `domain` field. See ADR 239 in
 * prisma/prisma and composer's ADR-0044 for the namespace taxonomy.
 */
export class CliStructuredError extends Error implements StructuredError {
  readonly code: `${string}.${string}`;
  readonly severity: 'error' | 'warn' | 'info';
  declare readonly why?: string;
  declare readonly fix?: string;
  declare readonly where?: { readonly path?: string; readonly line?: number };
  declare readonly meta?: Record<string, unknown>;
  declare readonly docsUrl?: string;

  constructor(
    code: `${string}.${string}`,
    summary: string,
    options?: {
      readonly severity?: 'error' | 'warn' | 'info';
      readonly why?: string;
      readonly fix?: string;
      readonly where?: { readonly path?: string; readonly line?: number };
      readonly meta?: Record<string, unknown>;
      readonly docsUrl?: string;
      readonly cause?: unknown;
    },
  ) {
    super(summary, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CliStructuredError';
    this.code = code;
    this.severity = options?.severity ?? 'error';
    const fix = options?.fix === options?.why ? undefined : options?.fix;
    const where = options?.where
      ? { ...ifDefined('path', options.where.path), ...ifDefined('line', options.where.line) }
      : undefined;
    Object.assign(this, {
      ...ifDefined('why', options?.why),
      ...ifDefined('fix', fix),
      ...ifDefined('where', where),
      ...ifDefined('meta', options?.meta),
      ...ifDefined('docsUrl', options?.docsUrl),
    });
  }

  /**
   * Converts this error to a CLI error envelope for output formatting.
   */
  toEnvelope(): CliErrorEnvelope {
    return {
      ok: false as const,
      code: this.code,
      severity: this.severity,
      summary: this.message,
      ...ifDefined('why', this.why),
      ...ifDefined('fix', this.fix),
      ...ifDefined('where', this.where),
      ...ifDefined('meta', this.meta),
      ...ifDefined('docsUrl', this.docsUrl),
    };
  }

  /**
   * Type guard to check if an error is a CliStructuredError.
   * Uses duck-typing to work across module boundaries where instanceof may fail.
   */
  static is(error: unknown): error is CliStructuredError {
    if (!(error instanceof Error)) {
      return false;
    }
    const candidate = blindCast<
      CliStructuredError,
      'duck-typing probe: the name/code/toEnvelope checks below are the real (runtime) guard on the shape'
    >(error);
    return (
      candidate.name === 'CliStructuredError' &&
      typeof candidate.code === 'string' &&
      typeof candidate.toEnvelope === 'function'
    );
  }
}
