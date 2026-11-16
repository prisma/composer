import type { AppConfigurationRead } from '@internal/core';
import { CliStructuredError } from '@internal/foundation/errors';
import type { KnownSecrets } from './redaction.ts';

function textIn(value: unknown, at: readonly string[]): { at: readonly string[]; text: string }[] {
  if (typeof value === 'string') return [{ at, text: value }];
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return [{ at, text: String(value) }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((member, index) => textIn(member, [...at, String(index)]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, member]) => textIn(member, [...at, key]));
  }
  return [];
}

/**
 * Throws `CONFIG.SECRET_AS_PLAIN_VALUE` when a plain value Load read holds a known secret, a
 * number or a boolean compared as its text (`KnownSecrets.nameIn`). The message names where and
 * the secrets key, never the value; `consequence` is the caller's sentence on why that is refused.
 */
export function refuseSecretsIn(
  read: AppConfigurationRead,
  knownSecrets: KnownSecrets,
  consequence: string,
): void {
  const places = [
    ...read.rootInput.flatMap((field) =>
      textIn(field.value, field.path).map(({ at, text }) => ({
        where: `Root input field input.${at.join('.')}`,
        text,
      })),
    ),
    ...Object.entries(read.configurationKeyText).map(([key, text]) => ({
      where: `Configuration key "${key}"`,
      text,
    })),
  ];
  for (const { where, text } of places) {
    const name = knownSecrets.nameIn(text);
    if (name === undefined) continue;
    throw new CliStructuredError(
      'CONFIG.SECRET_AS_PLAIN_VALUE',
      `${where} holds the value of the secret "${name}", which an envSecret() in the graph reads. ${consequence}`,
      {
        fix: `Read the secret with envSecret('${name}') where it is used, or give this plain value text that does not contain the value of "${name}".`,
      },
    );
  }
}
