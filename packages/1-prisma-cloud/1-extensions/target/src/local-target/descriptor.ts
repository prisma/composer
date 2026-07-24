/**
 * Assembles the extension's local-target descriptor (local-dev spec § 5;
 * naming, operator 2026-07-23 — "dev" names the user-facing feature only)
 * — the implementation behind `src/exports/local-target.ts`'s public
 * `localTargetDescriptor()`. Every `src/local-target/*` implementation file, plus
 * `@internal/local-target`, feeds ONLY this entry — never `./control`
 * (ADR-0041, operator directive): the production control entry carries
 * just the lazy
 * `localTarget: () => import('@prisma/composer-prisma-cloud/local-target').then(...)`
 * reference, so no local-target implementation code is bundled into, or
 * loaded by, any deploy path.
 */
import type { LocalTargetDescriptor } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import { localTargetProviders } from '@internal/local-target';
import * as Prisma from '@internal/lowering';
import * as Layer from 'effect/Layer';
import { PgWarmProvider } from '../pg-warm-resource.ts';
import { PnMigrationProvider } from '../pn-migration-resource.ts';
import { S3CredentialsProvider } from '../s3-credentials-resource.ts';
import { devAttach } from './attach.ts';
import { devContainerDescriptor } from './container.ts';
import { runDevEmulators } from './emulators.ts';
import { runDevPreflight } from './preflight.ts';
import { runDevTeardown } from './teardown.ts';

/** `localTargetProviders()`'s `ProviderCollection` doesn't structurally unify with Alchemy's inferred providers Layer (a @internal/lowering typings gap); it satisfies it at runtime — mirrors `control/extension.ts`'s own `asProvidersLayer`, duplicated rather than shared so this module imports nothing from `./control`. */
function asProvidersLayer<A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<never> {
  return blindCast<
    Layer.Layer<never>,
    "the merged local providers layer satisfies Alchemy's ProviderCollection shape at runtime; only the structural type doesn't unify, mirroring control/extension.ts's own asProvidersLayer"
  >(layer);
}

/**
 * The extension's local-target descriptor — self-contained, no
 * deploy-factory options: it is credential-free by design, so this takes
 * nothing and reads no environment.
 */
export function localTargetDescriptor(): LocalTargetDescriptor {
  return {
    container: devContainerDescriptor(),
    providers: (input) =>
      asProvidersLayer(
        Layer.mergeAll(
          localTargetProviders(input),
          PgWarmProvider(),
          PnMigrationProvider(),
          S3CredentialsProvider(),
          Prisma.ServiceKeyProvider(),
        ),
      ),
    preflight: (input) => runDevPreflight(input),
    emulators: (input) => runDevEmulators(input),
    attach: (input) => devAttach(input),
    teardown: (input) => runDevTeardown(input),
  };
}
