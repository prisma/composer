import type { CommandFamily } from '@prisma/cli-engine';

/** The family's command at `key`; a test that names a command the family lacks fails here. */
export function commandAt(
  family: CommandFamily,
  key: string,
): CommandFamily['commands'][string] & {} {
  const command = family.commands[key];
  if (command === undefined) throw new Error(`the family has no "${key}" command`);
  return command;
}
