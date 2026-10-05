/**
 * Pipeline step 7 (deploy-cli.md § The pipeline; design-notes.md's "Driving
 * Alchemy" call): hand the terminal to the generated stack file.
 *
 * Runs the `alchemy` package Composer itself depends on: its `bin` entry,
 * under Node. Never a `node_modules/.bin` link, which pnpm creates only for an
 * app's direct dependencies. This module is bundled into @prisma/composer and
 * @prisma/composer-cli, and both declare `alchemy`, so pnpm puts it beside
 * either one even with hoisting off.
 *
 * This module composes the invocation; it does not decide how the child is
 * started. Under the CLI the engine starts it (`ctx.spawn`), which is what
 * makes Ctrl-C reach the child natively and keeps signal policy in one place.
 * `spawnAlchemy` is the default for programmatic hosts driving
 * `@prisma/composer/control`, which have no engine to borrow.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliStructuredError } from '@internal/foundation/errors';
import spawn from 'cross-spawn';

/**
 * The directory of the `alchemy` package a module at `fromFile` imports:
 * Node's package lookup, walking up `node_modules` from the module's real
 * location. alchemy's exports map does not export its package.json, so
 * `require.resolve('alchemy/package.json')` cannot be used.
 */
function findAlchemyPackageDir(fromFile: string): string | undefined {
  let realFile: string;
  try {
    realFile = fs.realpathSync(fromFile);
  } catch {
    return undefined;
  }
  let dir = path.dirname(realFile);
  while (true) {
    const candidate = path.join(dir, 'node_modules', 'alchemy');
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readManifest(packageDir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function binEntryOf(packageDir: string): string | undefined {
  const manifest = readManifest(packageDir);
  if (typeof manifest !== 'object' || manifest === null || !('bin' in manifest)) return undefined;
  const bin = manifest.bin;
  const relative =
    typeof bin === 'string'
      ? bin
      : typeof bin === 'object' && bin !== null && 'alchemy' in bin
        ? bin.alchemy
        : undefined;
  return typeof relative === 'string' ? path.join(packageDir, relative) : undefined;
}

/**
 * The JavaScript entry of the `alchemy` package Composer is installed with,
 * resolved from `fromFile` (this module, by default).
 */
export function resolveAlchemyEntry(fromFile: string = fileURLToPath(import.meta.url)): string {
  const packageDir = findAlchemyPackageDir(fromFile);
  const entry = packageDir === undefined ? undefined : binEntryOf(packageDir);
  if (entry === undefined || !fs.existsSync(entry)) {
    throw new CliStructuredError(
      'DEPLOY.ALCHEMY_BIN_MISSING',
      `Could not resolve the \`alchemy\` package from "${path.dirname(fromFile)}", where Composer is installed, or its bin entry.`,
      {
        fix: "Check that `alchemy` is installed beside the Composer package that runs it (@prisma/composer-cli under `prisma`, @prisma/composer from a script), which declares it as a dependency, in a node_modules directory. Layouts without one, such as Yarn Plug'n'Play, are not supported.",
      },
    );
  }
  return entry;
}

/** The runtime facts that decide which Node starts Alchemy; injectable for tests. */
export interface NodeRuntime {
  /** True when this process runs under Bun. */
  readonly bun: boolean;
  readonly execPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly exists: (file: string) => boolean;
}

function currentRuntime(): NodeRuntime {
  return {
    bun: process.versions.bun !== undefined,
    execPath: process.execPath,
    env: process.env,
    platform: process.platform,
    exists: fs.existsSync,
  };
}

function envValue(env: NodeRuntime['env'], name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** The file names `node` may have in a PATH directory: PATHEXT's extensions on Windows. */
function nodeFileNames(runtime: NodeRuntime): readonly string[] {
  if (runtime.platform !== 'win32') return ['node'];
  const extensions = (envValue(runtime.env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension.length > 0);
  return extensions.map((extension) => `node${extension}`);
}

/**
 * The Node that starts Alchemy's launcher: this process's own runtime under
 * Node, and the first `node` on PATH under Bun. Alchemy's launcher may still
 * move itself to Bun when the package-manager environment says Bun invoked
 * it (`bunx`, `bun run`), so the runtime Alchemy ends up on follows how
 * `prisma` was invoked.
 */
export function nodeExecutable(runtime: NodeRuntime = currentRuntime()): string {
  if (!runtime.bun) return runtime.execPath;
  const paths = runtime.platform === 'win32' ? path.win32 : path.posix;
  const names = nodeFileNames(runtime);
  for (const rawDir of (envValue(runtime.env, 'PATH') ?? '').split(paths.delimiter)) {
    const dir = rawDir.replace(/^"(.*)"$/, '$1');
    if (dir.length === 0) continue;
    for (const name of names) {
      const candidate = paths.join(dir, name);
      if (runtime.exists(candidate)) return candidate;
    }
  }
  throw new CliStructuredError(
    'DEPLOY.NODE_MISSING',
    'Composer starts Alchemy with Node, and no `node` was found on PATH.',
    { fix: 'Install Node 22.18 or newer and put it on PATH, or run `prisma` under Node.' },
  );
}

/**
 * WHAT to converge. Deliberately not a command line: which alchemy binary to
 * run is a question about this machine's installed tree, and answering it
 * eagerly would make an injected adapter — a test's fake child — fail in a
 * directory that has no alchemy installed, before the fake ever ran. The
 * adapter resolves the binary, because the adapter is what starts a child.
 *
 * `env` carries only the ADDITIONS to the invoking environment — the container
 * transport vars and the result-file pointer — never a whole environment: the
 * engine merges additions over the invocation environment and applies its own
 * credential vars last.
 */
export interface AlchemyInvocation {
  readonly action: 'deploy' | 'destroy';
  readonly stackFileRelativePath: string;
  readonly cwd: string;
  readonly stage: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The command line an invocation becomes, once a binary has been resolved. */
export interface AlchemyCommandLine {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolves the invocation against this machine — the step every adapter takes
 * and no caller should. Runs alchemy's JavaScript entry with Node, so no shell
 * shim is involved on any platform. Raises DEPLOY.ALCHEMY_BIN_MISSING when
 * Composer's alchemy cannot be resolved, and DEPLOY.NODE_MISSING when no Node
 * can run it.
 */
export function alchemyCommandLine(
  invocation: AlchemyInvocation,
  alchemyEntry: string = resolveAlchemyEntry(),
  node: string = nodeExecutable(),
): AlchemyCommandLine {
  return {
    command: node,
    args: [
      alchemyEntry,
      invocation.action,
      invocation.stackFileRelativePath,
      '--yes',
      '--stage',
      invocation.stage,
    ],
    cwd: invocation.cwd,
    env: invocation.env,
  };
}

/**
 * How the converge child ended, verbatim. A signal-killed child carries
 * `signal` and a null `exitCode`; callers branch on `signal` first, because a
 * signal-killed child is an abort, not a failure. Structurally the engine's
 * `ChildResult`, declared here so the control surface does not depend on the
 * engine.
 */
export interface AlchemyOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** Starts the converge and resolves when it ends. The CLI supplies one backed
 *  by `ctx.spawn`; hosts get `spawnAlchemy`. */
export type RunAlchemy = (invocation: AlchemyInvocation) => Promise<AlchemyOutcome>;

export interface AlchemyInvocationInput {
  readonly command: 'deploy' | 'destroy';
  readonly stackFileRelativePath: string;
  readonly cwd: string;
  readonly stage: string;
  readonly containerEnv: Readonly<Record<string, string>>;
  /** What each extension's deploy preflight handed back, serialized — one env var per extension (core's preflight-transport naming). Absent for destroy, which runs no preflight. Content-blind, like `containerEnv`. */
  readonly preflightEnv?: Readonly<Record<string, string>>;
  /** Extra additions beyond the containers — the deployment-result pointer. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** What becomes `alchemy deploy|destroy <stack file> --yes --stage <stage>`. */
export function alchemyInvocation(input: AlchemyInvocationInput): AlchemyInvocation {
  return {
    action: input.command,
    stackFileRelativePath: input.stackFileRelativePath,
    cwd: input.cwd,
    stage: input.stage,
    env: { ...input.containerEnv, ...input.preflightEnv, ...input.env },
  };
}

/**
 * The default runner for hosts with no engine: inherited stdio, the caller's
 * own process group, and the child's status returned verbatim. It does not
 * collapse a signal into an exit code — that collapse is what made a
 * Ctrl-C'd deploy report itself as a failure.
 */
export const spawnAlchemy: RunAlchemy = async (invocation) =>
  spawnCommandLine(alchemyCommandLine(invocation));

/** Starts a resolved command line with inherited stdio and returns how it ended. */
export function spawnCommandLine(line: AlchemyCommandLine): Promise<AlchemyOutcome> {
  return new Promise<AlchemyOutcome>((resolve, reject) => {
    const child = spawn(line.command, [...line.args], {
      cwd: line.cwd,
      stdio: 'inherit',
      env: { ...process.env, ...line.env },
    });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
}
