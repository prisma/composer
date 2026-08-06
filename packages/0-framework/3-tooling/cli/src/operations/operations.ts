/**
 * The programmatic control surface over the deploy pipeline — @internal/assemble's
 * second consumer (deploy-cli.md § Contracts). Typed inputs, structured results,
 * no argv, no console, no process.exit. The prisma-composer CLI (main.ts) is a
 * thin renderer over these operations.
 *
 * Crash safety (TML-3158, mirrors bin.ts): this module's STATIC graph must stay
 * free of the alchemy-touching tree — a mismatched `effect` crashes that tree at
 * import time. Each operation runs checkEffectResolution() first and only then
 * dynamically imports its executor.
 */
import { checkEffectResolution } from '../check-effect-resolution.ts';
import { CliError } from '../cli-error.ts';
import type {
  DeployInput,
  DeployResult,
  DestroyInput,
  DestroyResult,
  OperationFailure,
} from './results.ts';

/** Structured form of bin.ts's preflight: a mismatched tree is a result, not a crash. */
function runEffectPreflight(cwd: string): OperationFailure | undefined {
  try {
    checkEffectResolution(cwd);
    return undefined;
  } catch (error) {
    if (error instanceof CliError) {
      return { kind: 'effect-resolution', message: error.message, cause: error };
    }
    throw error; // a bug in the check itself, not a user-tree condition
  }
}

export async function deploy(input: DeployInput): Promise<DeployResult> {
  const cwd = input.cwd ?? process.cwd();
  const preflight = runEffectPreflight(cwd);
  if (preflight !== undefined) return { outcome: 'failed', failure: preflight };
  const { executeDeploy } = await import('./execute-deploy-destroy.ts');
  return executeDeploy(input, cwd);
}

export async function destroy(input: DestroyInput): Promise<DestroyResult> {
  const cwd = input.cwd ?? process.cwd();
  const preflight = runEffectPreflight(cwd);
  if (preflight !== undefined) return { outcome: 'failed', failure: preflight };
  const { executeDestroy } = await import('./execute-deploy-destroy.ts');
  return executeDestroy(input, cwd);
}
