/**
 * The process state a converge holds while it runs: the one-converge-per-process
 * flag, the variables Alchemy reads from `process.env`, and the working
 * directory. Shared by the converge on the main thread and by `prisma dev`,
 * which holds it on the main thread for the life of its converge worker.
 */
import { blindCast } from '@internal/foundation/casts';

/** One flag per thread, shared by every copy of this module, so two apps' installs in one host cannot converge at once. */
const RUNNING = Symbol.for('prisma.composer.converge.running');

const flag = blindCast<
  { [RUNNING]?: boolean },
  'globalThis takes any symbol-keyed property; this one is ours alone'
>(globalThis);

/** True while this thread runs a converge. */
export function convergeRunning(): boolean {
  return flag[RUNNING] === true;
}

/**
 * Sets the process state Alchemy reads for the length of `run`, and restores
 * it on every exit path: the variables in `env`, then the working directory.
 * A directory that cannot be restored never leaves a variable behind and
 * never changes what `run` returned.
 */
async function withProcessState<T>(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  run: () => Promise<T>,
): Promise<T> {
  const previousEnv = Object.keys(env).map((name) => [name, process.env[name]] as const);
  const previousCwd = process.cwd();
  let changedDirectory = false;
  try {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (previousCwd !== cwd) {
      process.chdir(cwd);
      changedDirectory = true;
    }
    return await run();
  } finally {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (changedDirectory) {
      try {
        process.chdir(previousCwd);
      } catch {
        // The old directory is gone, so there is nowhere to return to; the outcome stands.
      }
    }
  }
}

/**
 * Runs `run` holding this thread's converge flag, with `env` and `cwd` set as
 * `withProcessState` sets them, and releases all three on every exit path.
 * `held: false` means another converge holds the flag and nothing ran.
 */
export async function holdingConvergeProcess<T>(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  run: () => Promise<T>,
): Promise<{ readonly held: true; readonly value: T } | { readonly held: false }> {
  if (convergeRunning()) return { held: false };
  flag[RUNNING] = true;
  try {
    return { held: true, value: await withProcessState(env, cwd, run) };
  } finally {
    flag[RUNNING] = false;
  }
}
