/**
 * Human rendering of a CliErrorEnvelope (the shared layout from the CLI
 * base-types design): `✖ summary (CODE)` plus indented Why/Fix/Where lines
 * and, when `meta.issues` carries a diagnostics list (prisma/prisma's shared
 * envelope idiom), one `- [kind] message` line per issue — all of them,
 * composer has no -v to gate a longer view behind. Other meta and docsUrl
 * are not rendered.
 */
import type { CliErrorEnvelope, CliStructuredError } from '@internal/foundation/errors';
import { executionDiagnostics } from './operations/shared.ts';

/** The `meta.issues` entries that are renderable; anything else in the array is skipped rather than crashing the renderer. */
function renderableIssues(
  issues: unknown,
): readonly { readonly kind: string; readonly message: string }[] {
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null) return [];
    const kind = 'kind' in issue ? issue.kind : undefined;
    const message = 'message' in issue ? issue.message : undefined;
    if (typeof kind !== 'string' || typeof message !== 'string') return [];
    return [{ kind, message }];
  });
}

export function renderErrorEnvelope(envelope: CliErrorEnvelope): string {
  const lines = [`✖ ${envelope.summary} (${envelope.code})`];
  if (envelope.why !== undefined) lines.push(`  Why: ${envelope.why}`);
  if (envelope.fix !== undefined) lines.push(`  Fix: ${envelope.fix}`);
  if (envelope.where?.path !== undefined) {
    const line = envelope.where.line !== undefined ? `:${String(envelope.where.line)}` : '';
    lines.push(`  Where: ${envelope.where.path}${line}`);
  }
  const issues = renderableIssues(envelope.meta?.['issues']);
  if (issues.length > 0) {
    lines.push('  Issues:');
    for (const issue of issues) {
      lines.push(`    - [${issue.kind}] ${issue.message}`);
    }
  }
  return lines.join('\n');
}

/**
 * The documented ADR-0044 child-status exception, rendered once for every
 * adapter: when `failure` carries execution diagnostics with a child exit
 * status, print the two reproduce-hint lines and return that status for the
 * caller to pass through; undefined otherwise (the caller rethrows the
 * failure for the normal envelope rendering).
 */
export function renderChildStatusHints(failure: CliStructuredError): number | undefined {
  const diagnostics = executionDiagnostics(failure);
  if (diagnostics === undefined || diagnostics.exitCode === undefined) return undefined;
  console.error(`\nGenerated stack file: ${diagnostics.stackFilePath}`);
  // --stage is part of the repro: without it, alchemy falls back to its
  // machine-dependent dev_$USER default and reads DIFFERENT deploy state.
  console.error(
    `Run \`${diagnostics.reproduceCommand}\` from ${diagnostics.cwd} to reproduce this directly.`,
  );
  return diagnostics.exitCode;
}
