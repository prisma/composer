import type { PlatformVariableReader } from '@internal/core/config';
import { platformVariableReaderText } from '@internal/core/config';
import type { MissingVariables } from './required-variables.ts';

export function addReader(
  readers: Map<string, PlatformVariableReader[]>,
  name: string,
  reader: PlatformVariableReader,
): void {
  const list = readers.get(name);
  if (list === undefined) readers.set(name, [reader]);
  else list.push(reader);
}

export const missingVariableNames = (required: readonly MissingVariables[]): string[] => [
  ...new Set(required.flatMap((entry) => entry.names)),
];

const readersText = (readers: readonly PlatformVariableReader[]): string =>
  readers.length === 0 ? '' : `  (${readers.map(platformVariableReaderText).join('; ')})`;

export function missingVariablesText(
  required: readonly MissingVariables[],
  readers: ReadonlyMap<string, readonly PlatformVariableReader[]>,
): string {
  const count = missingVariableNames(required).length;
  const reasons = new Map<string, string[]>();
  const groups: MissingVariables[] = [];
  for (const entry of required) {
    const [only] = entry.names;
    if (entry.names.length !== 1 || only === undefined) {
      groups.push(entry);
      continue;
    }
    const why = reasons.get(only) ?? [];
    if (entry.decidedBy === 'rule') {
      why.push(`      required by service "${entry.serviceAddress}": ${entry.message}`);
    }
    reasons.set(only, why);
  }
  const lines = [
    ...[...reasons].map(([name, why]) =>
      [`  - ${name}${readersText(readers.get(name) ?? [])}`, ...why].join('\n'),
    ),
    ...groups.map(
      (entry) =>
        `  - at least one of ${entry.names.join(', ')}  (service "${entry.serviceAddress}" needs at least one of them: ${entry.message})`,
    ),
  ];
  const countLine =
    count === 1
      ? '1 platform variable a service needs has no value:'
      : `${count} platform variables a service needs have no value:`;
  return `${countLine}\n${lines.join('\n')}`;
}
