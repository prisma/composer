import type { CommandFamily } from '@prisma/cli-engine';

export function mountAsHost(family: CommandFamily) {
  return {
    commands: family.commands,
    groups: { dev: { brief: 'Run the app on this machine.' } },
  };
}
