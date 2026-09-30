import type { PrismaAppConfig } from '@internal/core/config';

/** A `composer` section that passes validation, for harnesses that seed a config file's sections. Its descriptors carry only the fields the validator checks. */
export function validComposerSection(): PrismaAppConfig {
  return {
    extensions: [{ id: 'ext-a', nodes: {} }],
    state: { extension: 'ext-a', create: () => undefined },
  } as unknown as PrismaAppConfig;
}
