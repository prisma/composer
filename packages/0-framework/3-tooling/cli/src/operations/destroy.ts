/**
 * The programmatic `destroy` operation (`@prisma/composer/control`): typed
 * input, structured result, no argv, no console, no process.exit. The
 * prisma-composer CLI (main.ts) is a thin renderer over it. The executor
 * loads lazily, so importing this module executes nothing; an executor that
 * fails to load comes back as a structured failure, never a throw out of
 * the host.
 */
import type { CliStructuredError } from '@internal/foundation/errors';
import { notOk, type Result } from '@internal/foundation/result';
import { executorLoadFailure, type OperationDeps } from './shared.ts';

/** Destroy must name its target explicitly — no silent default to production. Encoded, not re-derived from flags. */
export type DestroyTarget =
  | { readonly kind: 'production' }
  | { readonly kind: 'stage'; readonly stage: string };

export type DestroyEvent =
  /** Emitted before the pipeline when `<cwd>/.alchemy` is missing/empty. */
  { readonly kind: 'no-local-deploy-state'; readonly cwd: string };

export interface DestroyInput {
  readonly entry: string;
  readonly name?: string | undefined;
  readonly target: DestroyTarget;
  readonly cwd?: string | undefined;
  /** Mid-operation notifications, in real time. Rendering is the host's. */
  readonly onEvent?: ((event: DestroyEvent) => void) | undefined;
}

export type DestroyResult = Result<void, CliStructuredError>;

export async function destroy(input: DestroyInput): Promise<DestroyResult> {
  return destroyWithDeps(input, {});
}

/** In-package variant threading the injection seam (the CLI's RunDeps, unit
 * tests). Deliberately NOT re-exported through `./control` — the seam mirrors
 * internal types and is not part of the published surface. */
export async function destroyWithDeps(
  input: DestroyInput,
  deps: OperationDeps,
): Promise<DestroyResult> {
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-deploy-destroy.ts');
  try {
    executor = await import('./execute-deploy-destroy.ts');
  } catch (error) {
    return notOk(executorLoadFailure(error, cwd));
  }
  return executor.executeDestroy(input, deps, cwd);
}
