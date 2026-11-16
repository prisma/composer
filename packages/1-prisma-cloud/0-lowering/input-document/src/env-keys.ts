export const addressKeySegments = (address: string): string[] =>
  address
    .split('.')
    .filter((s) => s.length > 0)
    .map((s) => s.replaceAll('-', '_'));

export const composerKey = (address: string, ...rest: readonly string[]): string =>
  ['COMPOSER', ...addressKeySegments(address), ...rest].join('_').toUpperCase();

export const ownKeyPrefix = (address: string): string => `${composerKey(address)}_`;

export const INPUT_KEY_NAME = 'INPUT';

const PARAM_POINTER_PREFIX = '@composer-param-pointer:';

export const isParamPointerRow = (raw: string): boolean => raw.startsWith(PARAM_POINTER_PREFIX);

export const encodeParamPointer = (name: string): string => `${PARAM_POINTER_PREFIX}${name}`;

export const decodeParamPointer = (raw: string): string => raw.slice(PARAM_POINTER_PREFIX.length);
