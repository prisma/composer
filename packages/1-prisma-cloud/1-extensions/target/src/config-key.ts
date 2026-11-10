import { composerKey } from '@internal/input-document';

export const configKey = (
  address: string,
  d: { owner: 'service' | { readonly input: string }; name: string },
): string => composerKey(address, ...(d.owner === 'service' ? [] : [d.owner.input]), d.name);

/** The framework-resolved origin row: COMPOSER_<addr>_ORIGIN. Written per
 *  compute service at serialize — the service's own provisioned endpoint URL,
 *  riding the reserved-provider-param machinery (`origin-key.ts`'s
 *  `ORIGIN_PARAM`); never a declared param, never in config(). A harness with
 *  no deploy behind it supplies it by setting `COMPOSER_ORIGIN` to the
 *  JSON-encoded origin URL — exactly how the existing entrypoint tests supply
 *  their other `COMPOSER_*` rows. */
export const ORIGIN_KEY_NAME = 'ORIGIN';
