/**
 * `--fresh` teardown (local-dev spec § 5, ADR-0041 D12): wholesale LOCAL
 * deletion — never an `alchemy destroy`. Removes this app's `prisma dev`
 * instances, its records on the two machine-global emulator daemons (never
 * the daemons themselves — other apps may be using them), the dev state
 * directory, and the dev stage's `localState()` directory.
 *
 * Every actual filesystem/child-process operation is delegated to
 * `@internal/lowering/dev` (this extension's own source stays free of
 * `node:`/`bun:` imports — invariant 5); control-plane only, runs in the CLI
 * parent (no CliError import — see container.ts).
 */

import type { TeardownInput } from '@internal/core/config';
import { DEV_DIR } from '@internal/core/config';
import { bucketsClient, computeClient } from '@internal/dev-emulators';
import { removeLocalPaths, removeLocalPostgresInstances } from '@internal/lowering/dev';
import { prismaCloudContainerOf } from '../container.ts';

async function tolerateUnreachable(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Unreachable or absent daemon — the daemon itself is never stopped by
    // `--fresh` (other apps may be using it), and there is nothing left to
    // remove on it if it isn't running at all.
  }
}

export async function runDevTeardown(input: TeardownInput): Promise<void> {
  const app = prismaCloudContainerOf(input.container).input.appName;
  const cwd = process.cwd();

  removeLocalPostgresInstances(cwd, app);

  await tolerateUnreachable(() => computeClient().deleteApp(app));
  await tolerateUnreachable(() => bucketsClient().deleteApp(app));

  removeLocalPaths([`${cwd}/${DEV_DIR}`, `${cwd}/.alchemy/state/${app}/dev`]);
}
