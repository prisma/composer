/**
 * A user-facing assembly failure, structured at origin (base-type rule 6):
 * a `CliStructuredError` whose code names which way assembly went wrong.
 * This package's second consumer is the programmatic deploy API, not just
 * the CLI — hosts branch on `error.code`, the CLI renders the envelope.
 */
import { CliStructuredError } from '@internal/foundation/errors';

/** The closed set of assembly failure codes (ADR-0044's ASSEMBLE namespace). */
export type AssembleCode =
  | 'ASSEMBLE.EXTENSION_MISSING'
  | 'ASSEMBLE.DESCRIPTOR_MISSING'
  | 'ASSEMBLE.DESCRIPTOR_KIND_MISMATCH'
  | 'ASSEMBLE.SERVICE_MISSING'
  | 'ASSEMBLE.BUILD_FAILED';

export class AssembleError extends CliStructuredError {
  constructor(
    code: AssembleCode,
    summary: string,
    options?: {
      readonly why?: string;
      readonly fix?: string;
      readonly meta?: Record<string, unknown>;
      readonly cause?: unknown;
    },
  ) {
    super(code, summary, options);
  }
}
