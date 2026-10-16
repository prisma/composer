/**
 * Public surface (the `./family` subpath): composer's engine `CommandFamily`,
 * for hosts that mount composer's commands into their own CLI — the `prisma`
 * bin does exactly this.
 *
 * Kept apart from `@prisma/composer`'s `./control` on purpose. `./control` is
 * the programmatic deploy pipeline; this is the command surface: grammar, help
 * and arg validation belong to the engine, and the handlers behind them are
 * the same operations `./control` exposes.
 *
 * Its static graph is alchemy-free and effect-free, so importing it costs a
 * host nothing until a composer command actually runs.
 */

import {
  createComposerFamily as createFrameworkFamily,
  type CreateComposerFamilyOptions as FrameworkFamilyOptions,
} from '@internal/cli/family';
import type { CommandFamily } from '@prisma/cli-engine';
import {
  createEmulatorListCommand,
  type ListEmulators,
  listEmulators,
} from '../family/emulator-list.ts';

export * from '@internal/cli/family';
export type { ListEmulators } from '../family/emulator-list.ts';

export interface CreateComposerFamilyOptions extends FrameworkFamilyOptions {
  /** Defaults to the real listing of this machine's emulators. */
  readonly listEmulators?: ListEmulators | undefined;
}

/** Composer's command family: `deploy`, `dev`, `dev url`, `dev stop` and `emulator list`, keyed by the path each is meant to mount at. */
export function createComposerFamily(options: CreateComposerFamilyOptions = {}): CommandFamily {
  return createFrameworkFamily({
    ...options,
    commands: {
      'emulator list': createEmulatorListCommand(options.listEmulators ?? listEmulators),
      ...options.commands,
    },
  });
}
