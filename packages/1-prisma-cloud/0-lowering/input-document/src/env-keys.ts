/** An address's segments as they appear in a `COMPOSER_` key: the app name may hold `-`, which no POSIX variable name may, so it becomes `_` (ADR-0057). */
export const addressKeySegments = (address: string): string[] =>
  address
    .split('.')
    .filter((s) => s.length > 0)
    .map((s) => s.replaceAll('-', '_'));

/** `COMPOSER_<address segments>_<rest>`, upper-cased: the key of a row Composer writes for a service. */
export const composerKey = (address: string, ...rest: readonly string[]): string =>
  ['COMPOSER', ...addressKeySegments(address), ...rest].join('_').toUpperCase();

/** The prefix every row a service owns carries: `COMPOSER_<address segments>_`. */
export const ownKeyPrefix = (address: string): string => `${composerKey(address)}_`;

/** The input document's own row name; its full key is `COMPOSER_<address>_INPUT`. */
export const INPUT_KEY_NAME = 'INPUT';

const PARAM_POINTER_PREFIX = '@composer-param-pointer:';

/** True when a per-key param row points at a platform variable instead of holding a JSON literal. No JSON text starts with `@`. */
export const isParamPointerRow = (raw: string): boolean => raw.startsWith(PARAM_POINTER_PREFIX);

/** The row a per-key `envParam()` param is written as: a pointer to the platform variable `name`. */
export const encodeParamPointer = (name: string): string => `${PARAM_POINTER_PREFIX}${name}`;

/** The platform variable a param pointer row points at. */
export const decodeParamPointer = (raw: string): string => raw.slice(PARAM_POINTER_PREFIX.length);
