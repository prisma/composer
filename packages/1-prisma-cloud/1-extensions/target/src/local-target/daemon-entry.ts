import type { DaemonName } from '@internal/dev-emulators';
import { resolvePackageEntry } from '@internal/local-target';

/** The resolved absolute path to this daemon's published entrypoint. */
export function daemonEntry(name: DaemonName): string {
  return resolvePackageEntry(`@prisma/composer-prisma-cloud/local-target/${name}-main`);
}
