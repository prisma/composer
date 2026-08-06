/**
 * The programmatic control surface over the deploy pipeline — @internal/assemble's
 * second consumer (deploy-cli.md § Contracts). Typed inputs, structured results,
 * no argv, no console, no process.exit. The prisma-composer CLI (main.ts) is a
 * thin renderer over these operations.
 *
 * The entry stays import-light: executors load lazily, so importing this
 * module is cheap and executes nothing until an operation runs. An executor
 * that fails to load comes back as a structured `pipeline` failure, never a
 * throw out of the host.
 */
import { checkEffectResolution } from '../check-effect-resolution.ts';
import { CliError } from '../cli-error.ts';
import type {
  DeployInput,
  DeployResult,
  DestroyInput,
  DestroyResult,
  DevInput,
  DevStartResult,
  LogInput,
  LogResult,
  OperationFailure,
} from './results.ts';

/** Diagnoses a failed executor import: when the app's tree resolves a
 * mismatched `effect` (the known way that import breaks), the failure carries
 * the fix-naming message from checkEffectResolution; otherwise the original
 * error's own message. */
function executorLoadFailure(error: unknown, cwd: string): OperationFailure {
  try {
    checkEffectResolution(cwd);
  } catch (diagnostic) {
    if (diagnostic instanceof CliError) {
      return { kind: 'pipeline', message: diagnostic.message, cause: error };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'pipeline', message, cause: error };
}

export async function deploy(input: DeployInput): Promise<DeployResult> {
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-deploy-destroy.ts');
  try {
    executor = await import('./execute-deploy-destroy.ts');
  } catch (error) {
    return { outcome: 'failed', failure: executorLoadFailure(error, cwd) };
  }
  return executor.executeDeploy(input, cwd);
}

export async function destroy(input: DestroyInput): Promise<DestroyResult> {
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-deploy-destroy.ts');
  try {
    executor = await import('./execute-deploy-destroy.ts');
  } catch (error) {
    return { outcome: 'failed', failure: executorLoadFailure(error, cwd) };
  }
  return executor.executeDestroy(input, cwd);
}

export async function dev(input: DevInput): Promise<DevStartResult> {
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-dev.ts');
  try {
    executor = await import('./execute-dev.ts');
  } catch (error) {
    return { outcome: 'failed', failure: executorLoadFailure(error, cwd) };
  }
  return executor.executeDev(input, cwd);
}

export async function log(input: LogInput): Promise<LogResult> {
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-log.ts');
  try {
    executor = await import('./execute-log.ts');
  } catch (error) {
    return { outcome: 'failed', failure: executorLoadFailure(error, cwd) };
  }
  return executor.executeLog(input, cwd);
}
