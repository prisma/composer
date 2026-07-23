import type { ContainerInstance } from '@internal/core/config';

function containerNotResolvedError(): Error {
  return new Error(
    "local dev: no container was resolved for this provider — the extension's " +
      '`localTarget.container` descriptor did not run before converge.',
  );
}

/**
 * Every local provider's emulator app namespace is its resolved local
 * container's `input.appName` — a field already on core's generic
 * `ContainerInstance` (no narrowing to a target-specific container class
 * needed for it). Narrowing to e.g. the prisma-cloud target's
 * `PrismaCloudContainer` is not available here: `@internal/local-target`
 * sits below the extensions layer and cannot import it (ADR-0028's layer
 * order).
 */
export function appNameOf(container: ContainerInstance | undefined): string {
  if (container === undefined) throw containerNotResolvedError();
  return container.input.appName;
}
