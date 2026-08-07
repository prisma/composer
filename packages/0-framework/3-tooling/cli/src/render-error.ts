/**
 * Human rendering of a CliErrorEnvelope (the shared layout from the CLI
 * base-types design): `✖ summary (CODE)` plus indented Why/Fix/Where lines.
 * No color; conflicts/meta/docsUrl are not rendered (composer has no -v).
 */
import type { CliErrorEnvelope } from '@internal/foundation/errors';

export function renderErrorEnvelope(envelope: CliErrorEnvelope): string {
  const lines = [`✖ ${envelope.summary} (${envelope.code})`];
  if (envelope.why !== undefined) lines.push(`  Why: ${envelope.why}`);
  if (envelope.fix !== undefined) lines.push(`  Fix: ${envelope.fix}`);
  if (envelope.where?.path !== undefined) {
    const line = envelope.where.line !== undefined ? `:${String(envelope.where.line)}` : '';
    lines.push(`  Where: ${envelope.where.path}${line}`);
  }
  return lines.join('\n');
}
