/**
 * `--fresh` teardown (local-dev spec § 5, ADR-0041 D12, REVISED — operator
 * review of #162): wholesale LOCAL deletion — never an `alchemy destroy`.
 * Removes this app's records on the three machine-global emulator daemons
 * (never the daemons themselves — other apps may be using them; postgres's
 * `DELETE /apps/<app>` closes its servers and deletes their persisted data),
 * the dev state directory, and the dev stage's `localState()` directory.
 *
 * Every actual filesystem operation is delegated to `@internal/local-target`
 * (this extension's own source stays free of `node:`/`bun:` imports —
 * invariant 5); control-plane only, runs in the CLI parent (no CliError
 * import — see container.ts).
 */

import type { TeardownInput } from '@internal/core/config';
import { DEV_DIR } from '@internal/core/config';
import { bucketsClient, computeClient, postgresClient } from '@internal/dev-emulators';
import { removeLocalPaths, resolvePrismaDevModulePath } from '@internal/local-target';
import { prismaCloudContainerOf } from '../container.ts';

/**
 * The daemon's client, or `undefined` when that daemon is not running — the
 * daemon itself is never stopped by `--fresh` (other apps may be using it),
 * and there is nothing to remove on one that isn't running. (Dev ensures the
 * daemons this app uses before teardown, so this is only the unused ones.)
 * Only that case is tolerated: a running daemon's DELETE failure propagates,
 * rather than `--fresh` reporting success over data it did not wipe.
 */
function ifRunning<C>(client: () => C): C | undefined {
  try {
    return client();
  } catch {
    return undefined;
  }
}

/** Composer's `@prisma/dev`, when it resolves — the postgres daemon needs it to delete persisted data. */
function prismaDevModulePath(): string | undefined {
  try {
    return resolvePrismaDevModulePath();
  } catch {
    return undefined;
  }
}

export async function runDevTeardown(input: TeardownInput): Promise<void> {
  const app = prismaCloudContainerOf(input.container).input.appName;
  const cwd = process.cwd();

  await ifRunning(postgresClient)?.deleteApp(app, prismaDevModulePath());
  await ifRunning(computeClient)?.deleteApp(app);
  await ifRunning(bucketsClient)?.deleteApp(app);

  removeLocalPaths([`${cwd}/${DEV_DIR}`, `${cwd}/.alchemy/state/${app}/dev`]);
}
