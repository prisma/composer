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
 * Throws `CONFIG.SECRET_AS_PLAIN_VALUE` when a plain value Load read, or a plain platform variable's
 * text, holds a known secret, a number or a boolean compared as its text (`KnownSecrets.nameIn`).
 * The message names where and the secrets key, never the value; `consequence` is the caller's
 * sentence on why a plain value Load read is refused.
 */
export function refuseSecretsIn(
  read: AppConfigurationRead,
  plainVariableText: Readonly<Record<string, string>>,
  knownSecrets: KnownSecrets,
  consequence: string,
): void {
  const readPlaces = read.rootInput.flatMap((field) =>
    textIn(field.value, field.path).map(({ at, text }) => ({
      where: `Root input field input.${at.join('.')}`,
      text,
    })),
  );
  for (const { where, text } of readPlaces) {
    const name = knownSecrets.nameIn(text);
    if (name === undefined) continue;
    throw new CliStructuredError(
      'CONFIG.SECRET_AS_PLAIN_VALUE',
      `${where} holds the value of the secret "${name}", which a platform secret in the graph reads. ${consequence}`,
      {
        fix: `Pass the value of the platform secret "${name}" to where this value is used, or give this plain value text that does not contain the value of "${name}".`,
      },
    );
  }
  for (const [variable, text] of Object.entries(plainVariableText)) {
    const name = knownSecrets.nameIn(text);
    if (name === undefined) continue;
    throw new CliStructuredError(
      'CONFIG.SECRET_AS_PLAIN_VALUE',
      `The platform variable "${variable}", which prisma dev read from the \`config\` adapters, holds the value of the secret "${name}". Composer hands the second process every plain value in a file, and never writes a secret to a file.`,
      {
        fix: `Keep the value of "${name}" out of the platform variable "${variable}", or give "${variable}" a different value.`,
      },
    );
  }
}
