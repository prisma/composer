/**
 * The env-row key convention the serializer writes and the boot reads,
 * kept in a module that imports nothing so the reserved provider params
 * (`origin-key.ts`, `streams-keys.ts`) can derive their keys from it at
 * module load while `serializer.ts` imports their list
 * (`provider-params.ts`) for `stashRows` — without an import cycle.
 * `serializer.ts` re-exports both names; import them from there.
 */

/**
 * `COMPOSER_<address segments>_<owner input>_<name>`, uppercased. Every
 * generated key lives in the framework's reserved COMPOSER_ namespace
 * (ADR-0029), so it can never collide with — and silently overwrite — a
 * user-provisioned platform var (e.g. a secret's external name). Composer
 * writes no unprefixed variable at all: DATABASE_URL(_POOLED) are the
 * platform's own names, banned in param.ts/secret.ts and owned by the
 * platform (control/extension.ts).
 */
/**
 * An address's segments as they appear in a `COMPOSER_` key. The app name may
 * contain `-`, which no POSIX variable name may, so it becomes `_` (ADR-0057).
 */
export const addressKeySegments = (address: string): string[] =>
  address
    .split('.')
    .filter((s) => s.length > 0)
    .map((s) => s.replaceAll('-', '_'));

export const configKey = (
  address: string,
  d: { owner: 'service' | { readonly input: string }; name: string },
): string => {
  const segments = addressKeySegments(address);
  const owner = d.owner === 'service' ? [] : [d.owner.input];
  return ['COMPOSER', ...segments, ...owner, d.name].join('_').toUpperCase();
};

/** The framework-resolved origin row: COMPOSER_<addr>_ORIGIN. Written per
 *  compute service at serialize — the service's own provisioned endpoint URL,
 *  riding the reserved-provider-param machinery (`origin-key.ts`'s
 *  `ORIGIN_PARAM`); never a declared param, never in config(). A harness with
 *  no deploy behind it supplies it by setting `COMPOSER_ORIGIN` to the
 *  JSON-encoded origin URL — exactly how the existing entrypoint tests supply
 *  their other `COMPOSER_*` rows. */
export const ORIGIN_KEY_NAME = 'ORIGIN';
