/**
 * Pipeline step 7 (deploy-cli.md § The pipeline; design-notes.md's "Driving
 * Alchemy" call): hand the terminal to the generated stack file.
 *
 * Runs the `alchemy` package Composer itself depends on: its `bin` entry,
 * under Node. Never a `node_modules/.bin` link, which pnpm creates only for an
 * app's direct dependencies.
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
  let dir = path.dirname(fs.realpathSync(fromFile));
  while (true) {
    const candidate = path.join(dir, 'node_modules', 'alchemy');
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function binEntryOf(packageDir: string): string | undefined {
  const manifest: unknown = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
  );
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
        fix: 'Reinstall your dependencies: @prisma/composer depends on alchemy and installs it with itself.',
      },
    );
  }
  return entry;
}

/** The runtime facts that decide which Node runs Alchemy; injectable for tests. */
export interface NodeRuntime {
  /** True when this process runs under Bun. */
  readonly bun: boolean;
  readonly execPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

function currentRuntime(): NodeRuntime {
  return {
    bun: process.versions.bun !== undefined,
    execPath: process.execPath,
    env: process.env,
    platform: process.platform,
  };
}

/**
 * The Node that runs Alchemy. Under Node it is this process's own runtime.
 * Under Bun (the examples run `bun …/prisma`) it is the first `node` on PATH:
 * Alchemy runs under Node whatever the host runs under, as its `node` shebang
 * always made it.
 */
export function nodeExecutable(runtime: NodeRuntime = currentRuntime()): string {
  if (!runtime.bun) return runtime.execPath;
  const pathValue =
    Object.entries(runtime.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const name = runtime.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new CliStructuredError(
    'DEPLOY.NODE_MISSING',
    'Alchemy runs under Node, and no `node` was found on PATH.',
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
