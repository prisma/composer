/** The block the deploy prints after its preflight step and again at the end of its report. */
import { platformVariableReaderText, type UnsetPlatformVariable } from '@internal/core/config';

const variableLines = (variable: UnsetPlatformVariable): readonly string[] => [
  variable.readers.length === 0
    ? `  - ${variable.name}`
    : `  - ${variable.name}  (${variable.readers.map(platformVariableReaderText).join('; ')})`,
  ...variable.commands.map((command) => `    ${command}`),
];

/** `Platform variables with no value:` and one entry per variable, or `undefined` when there is none. */
export function unsetPlatformVariablesText(
  unset: readonly UnsetPlatformVariable[],
): string | undefined {
  if (unset.length === 0) return undefined;
  return ['Platform variables with no value:', ...unset.flatMap(variableLines)].join('\n');
}
