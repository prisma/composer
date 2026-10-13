/**
 * `--fresh` teardown (local-dev spec § 5, ADR-0041 D12, REVISED — operator
 * review of #162): wholesale LOCAL deletion — never an `alchemy destroy`.
 * Deletes the app's emulator instances of every kind through the
 * directory's record (a database's delete removes its data) and the app's
 * entry in it, the app's part of the dev state directory, and the dev
 * stage's `localState()` directory. Other apps run from the directory keep
 * their entries and their buckets' objects. The daemons are never stopped —
 * other directories may be using them. The local directories are removed
 * even when a delete fails, and the failure is then reported.
 *
 * Every actual filesystem operation is delegated to `@internal/local-target`
 * (this extension's own source stays free of `node:`/`bun:` imports —
 * invariant 5); control-plane only, runs in the CLI parent (no CliError
 * import — see container.ts).
 */

import type { TeardownInput } from '@internal/core/config';
import { DEV_DIR } from '@internal/core/config';
import { type DaemonName, ensureDaemon } from '@internal/dev-emulators';
import {
  deleteAppInstances,
  type NodeKind,
  recordedKinds,
  removeAppDevState,
  removeLocalPaths,
} from '@internal/local-target';
import { prismaCloudContainerOf } from '../container.ts';
import { daemonEntry } from './daemon-entry.ts';

const DAEMON_OF: Record<NodeKind, DaemonName> = {
  compute: 'compute',
  database: 'postgres',
  bucket: 'buckets',
};

export async function runDevTeardown(input: TeardownInput): Promise<void> {
  const app = prismaCloudContainerOf(input.container).input.appName;
  const cwd = process.cwd();
  const devDir = `${cwd}/${DEV_DIR}`;
  const scope = { devDir, app };

  try {
    // Every emulator holding one of the app's instances is started so the
    // delete lands: a stopped emulator keeps its instances, their ports and
    // a database's data.
    for (const kind of await recordedKinds(scope)) {
      await ensureDaemon(DAEMON_OF[kind], daemonEntry(DAEMON_OF[kind]));
    }
    await deleteAppInstances(scope);
  } finally {
    removeAppDevState(devDir, app);
    removeLocalPaths([`${cwd}/.alchemy/state/${app}/dev`]);
  }
}
