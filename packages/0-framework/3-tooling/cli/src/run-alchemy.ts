/**
 * Pipeline step 7 (deploy-cli.md § The pipeline; design-notes.md's "Driving
 * Alchemy" call): hand the terminal to the generated stack file.
 *
 * Under Bun, resolves the workspace's own installed `alchemy` bin (walking up
 * `node_modules/.bin` from the generated file's package dir). Alchemy's bin
 * launcher (`alchemy/bin/cli.js`) does its own node/bun dispatch driven by
 * the env it inherits.
 *
 * Under Node, bypasses the alchemy launcher and runs `alchemy.js` directly
 * under tsx (`node <tsx-cli> <alchemy.js> <action> <stack-file> ...`). tsx
 * handles TypeScript resolution for the stack file and the entry graph it
 * imports, which is the same registration `loadEntry` applies in the CLI
 * process itself.
 *
 * This module composes the invocation; it does not decide how the child is
 * started. Under the CLI the engine starts it (`ctx.spawn`), which is what
 * makes Ctrl-C reach the child natively and keeps signal policy in one place.
 * `spawnAlchemy` is the default for programmatic hosts driving
 * `@prisma/composer/control`, which have no engine to borrow.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliStructuredError } from '@internal/foundation/errors';

/** Walks up from `startDir` looking for `node_modules/.bin/alchemy`. */
export function resolveAlchemyBin(startDir: string): string {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'alchemy');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new CliStructuredError(
        'DEPLOY.ALCHEMY_BIN_MISSING',
        `Could not find an installed \`alchemy\` bin above "${startDir}".`,
        { fix: 'Add "alchemy" as a dependency of your app.' },
      );
    }
    dir = parent;
  }
}

/**
 * Walks up from `startDir` looking for `node_modules/alchemy/bin/alchemy.js` —
 * the compiled JS entry that the tsx-based Node invocation runs directly,
 * bypassing the alchemy launcher's node/bun dispatch.
 */
export function resolveAlchemyJs(startDir: string): string {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', 'alchemy', 'bin', 'alchemy.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new CliStructuredError(
        'DEPLOY.ALCHEMY_BIN_MISSING',
        `Could not find an installed \`alchemy\` bin above "${startDir}".`,
        { fix: 'Add "alchemy" as a dependency of your app.' },
      );
    }
    dir = parent;
  }
}

/** Resolves the tsx CLI entry from the installed tsx package. */
export async function resolveTsxCli(): Promise<string> {
  return fileURLToPath(await import.meta.resolve('tsx/cli'));
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

const alchemyArgs = (invocation: AlchemyInvocation): string[] => [
  invocation.action,
  invocation.stackFileRelativePath,
  '--yes',
  '--stage',
  invocation.stage,
];

/**
 * Resolves the invocation against this machine — the step every adapter takes
 * and no caller should. Raises DEPLOY.ALCHEMY_BIN_MISSING when the app has no
 * alchemy installed.
 *
 * Under Bun, runs the alchemy launcher directly (it handles its own dispatch).
 * Under Node, runs `node <tsx-cli> <alchemy.js> <args>` so tsx provides
 * TypeScript resolution for the stack file and the entry graph it imports.
 */
export async function alchemyCommandLine(
  invocation: AlchemyInvocation,
): Promise<AlchemyCommandLine> {
  if (typeof process.versions.bun === 'string') {
    return {
      command: resolveAlchemyBin(invocation.cwd),
      args: alchemyArgs(invocation),
      cwd: invocation.cwd,
      env: invocation.env,
    };
  }

  const [tsxCliPath, alchemyJsPath] = await Promise.all([
    resolveTsxCli(),
    Promise.resolve(resolveAlchemyJs(invocation.cwd)),
  ]);

  return {
    command: process.execPath,
    args: [tsxCliPath, alchemyJsPath, ...alchemyArgs(invocation)],
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
    env: { ...input.containerEnv, ...input.env },
  };
}

/**
 * The default runner for hosts with no engine: inherited stdio, the caller's
 * own process group, and the child's status returned verbatim. It does not
 * collapse a signal into an exit code — that collapse is what made a
 * Ctrl-C'd deploy report itself as a failure.
 */
export const spawnAlchemy: RunAlchemy = async (invocation) => {
  const line = await alchemyCommandLine(invocation);
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
};
