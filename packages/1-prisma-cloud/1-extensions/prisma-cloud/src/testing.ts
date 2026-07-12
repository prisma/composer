/**
 * Prisma Cloud's integration-test seam (testing.md § Integration).
 * `bootstrapService` boots a compute service's real entry in-process against a
 * caller-chosen Config, writing that Config to the environment with the exact
 * `stash` the deploy boot uses — so `load()` reads it identically to a
 * deployed process. Target-specific, and here rather than in core, because
 * writing the environment is this extension's serializer's job; nothing about
 * this reaches the production runtime (`compute()` ships only `run`/`load`).
 */

import type { Config, Deps, Expose, Params, RunnableServiceNode } from '@internal/core';
import { stash } from './serializer.ts';

/** What `bootstrapService` hands back: a live, driveable instance of the booted entry. */
export interface BootstrappedService {
  readonly url: string;
  readonly fetch: typeof fetch;
}

/**
 * Boots `service`'s real entry against `config`, in-process. By default the
 * entry is `service.build.entry` resolved against `service.build.module` —
 * exactly how the printed deploy bootstrap imports it (see `@internal/lowering`'s
 * artifact.ts) — which fits a build adapter whose `entry` is a plain
 * module-relative path (`@prisma/compose/node`'s). A build adapter whose bootable
 * path isn't module-relative (`@prisma/compose/nextjs`'s standalone output)
 * supplies its own `boot` thunk; the target owns that resolution.
 *
 * `config.service.port` must be concrete — the entry self-listens and never
 * reports an OS-assigned port back. No `close()`: teardown rides bun-test's
 * per-file process isolation (H3's resolved decision).
 */
export async function bootstrapService<D extends Deps, P extends Params, E extends Expose>(
  service: RunnableServiceNode<D, P, E>,
  config: Config,
  boot?: () => Promise<void>,
): Promise<BootstrappedService> {
  const port = config.service['port'];
  if (typeof port !== 'number') {
    throw new Error(
      'bootstrapService(): config.service.port must be a concrete port number — the booted entry ' +
        'self-listens with no way to report an OS-assigned one back to the caller.',
    );
  }
  const bootEntry =
    boot ??
    (async () => {
      await import(new URL(service.build.entry, service.build.module).href);
    });

  stash(service, config);
  await bootEntry();
  return { url: `http://localhost:${port}/`, fetch };
}
