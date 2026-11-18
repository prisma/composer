import { platformVariableReaderText, type UnsetPlatformVariable } from '@internal/core/config';

const variableLines = (variable: UnsetPlatformVariable): readonly string[] => [
  variable.readers.length === 0
    ? `  - ${variable.name}`
    : `  - ${variable.name}  (${variable.readers.map(platformVariableReaderText).join('; ')})`,
  ...variable.commands.map((command) => `    ${command}`),
];

export function unsetPlatformVariablesText(
  unset: readonly UnsetPlatformVariable[],
): string | undefined {
  if (unset.length === 0) return undefined;
  return ['Platform variables with no value:', ...unset.flatMap(variableLines)].join('\n');
}
