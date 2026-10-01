/**
 * The `composer` section of `prisma.config.ts` is Composer's whole configuration.
 * The validator returns it together with the file that declared it, which the generated stack file imports.
 */
import type { ConfigSection, SectionProvenance, SectionValidation } from '@prisma/cli-engine';
import { defineConfigSection } from '@prisma/cli-engine';
import type { Diagnostic } from '@prisma/cli-engine/protocol';
import {
  type ComposerConfigSource,
  type ConfigFinding,
  checkComposerConfig,
  sectionMissing,
} from '../composer-config.ts';

function diagnostic(finding: ConfigFinding, file: string | undefined): Diagnostic {
  const where = finding.where ?? file;
  return {
    code: finding.code,
    severity: 'error',
    summary: finding.summary,
    ...(finding.why === undefined ? {} : { why: finding.why }),
    nextActions: [{ kind: 'edit-file', label: finding.fix }],
    ...(where === undefined ? {} : { where: { path: where } }),
    ...(finding.field === undefined ? {} : { meta: { field: finding.field } }),
  };
}

function refuse(
  findings: readonly ConfigFinding[],
  file: string | undefined,
): SectionValidation<ComposerConfigSource> {
  return { ok: false, diagnostics: findings.map((finding) => diagnostic(finding, file)) };
}

function validate(
  raw: unknown,
  provenance: SectionProvenance,
): SectionValidation<ComposerConfigSource> {
  const file = provenance.files[0];
  if (raw === undefined || file === undefined) return refuse([sectionMissing], undefined);

  const checked = checkComposerConfig(raw, file);
  if (!checked.ok) return refuse(checked.findings, file);
  return { ok: true, value: { value: checked.value, file }, diagnostics: [] };
}

export const composerSection: ConfigSection<ComposerConfigSource> =
  defineConfigSection<ComposerConfigSource>({
    name: 'composer',
    validate,
    merge: (_parent, child) => child,
  });
