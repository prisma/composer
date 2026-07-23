/**
 * Every local provider's emulator app namespace is its resolved dev
 * container's `input.appName` — a field already on core's generic
 * `ContainerInstance` (no narrowing to a target-specific container class
 * needed for it). Narrowing to e.g. the prisma-cloud target's
 * `PrismaCloudContainer` is not available here: `@internal/lowering` sits
 * below the extensions layer and cannot import it (ADR-0028's layer order).
 */
import type { ContainerInstance } from '@internal/core/config';

function containerNotResolvedError(): Error {
  return new Error(
    "local dev: no container was resolved for this provider — the extension's `dev.container` " +
      'descriptor did not run before converge.',
  );
}

export function appNameOf(container: ContainerInstance | undefined): string {
  if (container === undefined) throw containerNotResolvedError();
  return container.input.appName;
}
