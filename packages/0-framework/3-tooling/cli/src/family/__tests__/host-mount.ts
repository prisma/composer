import type { CommandFamily } from '@prisma/cli-engine';

/** The family's commands and the `dev` group, mounted as the `prisma` host mounts them. */
export function mountAsHost(family: CommandFamily) {
  return {
    commands: family.commands,
    groups: { dev: { brief: 'Run the app on this machine.' } },
  };
}
