#!/usr/bin/env bun
/**
 * Tears down an app deployed from the current directory, for the examples'
 * `destroy` scripts and CI cleanup. The `prisma` CLI has no destroy command,
 * so this calls the programmatic `destroy` from `@prisma/composer/control`,
 * resolved from the app's own dependencies, with the `composer` section of
 * the app's `prisma.config.ts`.
 *
 * Credentials come from PRISMA_SERVICE_TOKEN and PRISMA_WORKSPACE_ID.
 * Exits 1 with the structured failure on stderr when destroy fails, and 2 on
 * bad arguments.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = 'Usage: composer-destroy.ts <entry> (--production | --stage <name>) [--name <name>]';

type DestroyTarget =
  | { readonly kind: 'production' }
  | { readonly kind: 'stage'; readonly stage: string };

interface DestroyRequest {
  readonly entry: string;
  readonly target: DestroyTarget;
  readonly name: string | undefined;
}

interface DestroyFailure {
  readonly message: string;
  readonly cause?: unknown;
  toEnvelope?(): unknown;
}

type DestroyEvent = { readonly kind: string; readonly cwd?: string };

interface ControlModule {
  destroy(input: {
    readonly config: { readonly value: unknown; readonly file: string };
    readonly entry: string;
    readonly name: string | undefined;
    readonly target: DestroyTarget;
    readonly cwd: string;
    readonly onEvent: (event: DestroyEvent) => void;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: DestroyFailure }>;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null;
}

function isControlModule(value: unknown): value is ControlModule {
  return isRecord(value) && typeof value['destroy'] === 'function';
}

function parseRequest(argv: readonly string[]): DestroyRequest | string {
  let parsed: ReturnType<typeof parseDestroyArgs>;
  try {
    parsed = parseDestroyArgs(argv);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const { positionals, values } = parsed;
  const [entry, ...extra] = positionals;
  if (entry === undefined || extra.length > 0) return 'Pass exactly one entry file.';
  const { stage, production, name } = values;
  if (stage !== undefined && production === true)
    return 'Pass either --stage <name> or --production, not both.';
  if (stage !== undefined) return { entry, target: { kind: 'stage', stage }, name };
  if (production === true) return { entry, target: { kind: 'production' }, name };
  return 'destroy requires an explicit target: --stage <name> or --production.';
}

function parseDestroyArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      stage: { type: 'string' },
      production: { type: 'boolean' },
      name: { type: 'string' },
    },
  });
}

async function loadControl(cwd: string): Promise<ControlModule> {
  const resolved = createRequire(join(cwd, 'package.json')).resolve('@prisma/composer/control');
  const control: unknown = await import(pathToFileURL(resolved).href);
  if (!isControlModule(control)) throw new Error(`${resolved} does not export destroy.`);
  return control;
}

async function loadComposerSection(configFile: string): Promise<unknown> {
  const config: unknown = await import(pathToFileURL(configFile).href);
  if (!isRecord(config) || !isRecord(config['default'])) return undefined;
  return config['default']['composer'];
}

function printFailure(failure: DestroyFailure): void {
  const envelope =
    typeof failure.toEnvelope === 'function' ? failure.toEnvelope() : { summary: failure.message };
  console.error(JSON.stringify(envelope, null, 2));
  if (failure.cause instanceof Error && failure.cause.message !== failure.message)
    console.error(`Caused by: ${failure.cause.message}`);
}

async function main(): Promise<number> {
  const request = parseRequest(process.argv.slice(2));
  if (typeof request === 'string') {
    console.error(`${request}\n${USAGE}`);
    return 2;
  }

  const cwd = process.cwd();
  const file = join(cwd, 'prisma.config.ts');
  const control = await loadControl(cwd);
  const result = await control.destroy({
    config: { value: await loadComposerSection(file), file },
    entry: request.entry,
    name: request.name,
    target: request.target,
    cwd,
    onEvent: (event) => {
      if (event.kind !== 'no-local-deploy-state') return;
      console.error(
        `No prior deploy state under ${event.cwd ?? cwd}. If you deployed from a different directory, run destroy from there; otherwise this is a no-op.`,
      );
    },
  });

  if (!result.ok) {
    printFailure(result.failure);
    return 1;
  }
  console.log('Destroyed.');
  return 0;
}

process.exitCode = await main();
