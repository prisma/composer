export const addressKeySegments = (address: string): string[] =>
  address
    .split('.')
    .filter((s) => s.length > 0)
    .map((s) => s.replaceAll('-', '_'));

export const composerKey = (address: string, ...rest: readonly string[]): string =>
  ['COMPOSER', ...addressKeySegments(address), ...rest].join('_').toUpperCase();

export const ownKeyPrefix = (address: string): string => `${composerKey(address)}_`;

export const INPUT_KEY_NAME = 'INPUT';
