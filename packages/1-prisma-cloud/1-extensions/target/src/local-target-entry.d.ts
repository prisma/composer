// `control/extension.ts`'s lazy `localTarget` thunk (ADR-0041's lazy
// local-target reference) names its own published subpath by bare
// specifier — at runtime this resolves against a CONSUMING app's own
// node_modules (this package is only ever inlined into
// @prisma/composer-prisma-cloud, never installed standalone), so it is
// deliberately NOT a real package.json dependency here (that would be a
// genuine build-order cycle: composer-prisma-cloud already depends on this
// package's dist). This shadow exists solely so `tsc` can typecheck the
// dynamic import within this package's own build — the bundler ignores it
// and, finding no real dependency to resolve the specifier against,
// correctly leaves the dynamic import as a genuine external reference
// rather than inlining anything.
declare module '@prisma/composer-prisma-cloud/local-target' {
  import type { LocalTargetDescriptor } from '@internal/core/config';

  export function localTargetDescriptor(): LocalTargetDescriptor;
}
