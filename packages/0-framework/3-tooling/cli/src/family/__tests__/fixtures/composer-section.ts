/** A `composer` section that passes validation, for harnesses that seed a config file's sections. */
export function validComposerSection() {
  return {
    extensions: [{ id: 'ext-a', nodes: {} }],
    state: { extension: 'ext-a', create: () => undefined },
  };
}
