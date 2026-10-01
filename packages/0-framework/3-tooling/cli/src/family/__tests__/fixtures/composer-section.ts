import type { PrismaAppConfig } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';

/** A `composer` section that passes validation, for harnesses that seed a config file's sections. */
export function validComposerSection(): PrismaAppConfig {
  return blindCast<
    PrismaAppConfig,
    'test fixture: the section validator checks only identifying fields, and no harness using it calls a descriptor'
  >({
    extensions: [{ id: 'ext-a', nodes: {} }],
    state: { extension: 'ext-a', create: () => undefined },
  });
}
