#!/usr/bin/env bun
/**
 * Tears down an app deployed from the current directory, for the examples'
 * `destroy` scripts and CI cleanup. The `prisma` CLI has no destroy command,
 * so this calls the programmatic `destroy` from `@prisma/composer/control`,
 * resolved from the app's own dependencies, with the `composer` section of
 * the app's `prisma.config.ts`: the one in the current directory, or the file
 * `--config` names. It does not look in parent directories.
 *
 * `--production` and `--stage <name>` are the operation's two targets,
 * `{ kind: 'production' }` and `{ kind: 'stage', stage }`, spelled as flags
 * for the examples' package scripts only; no `prisma` command takes them.
 *
 * Credentials come from PRISMA_SERVICE_TOKEN and PRISMA_WORKSPACE_ID.
 * Exits 2 on bad arguments. Exits 1 with the structured failure on stderr
 * when destroy fails, and with one line when the control entry or the config
 * cannot be loaded or destroy throws.
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type {
  CliStructuredError,
  ComposerConfigSource,
  destroy as Destroy,
  DestroyEvent,
  DestroyTarget,
} from '@prisma/composer/control';

const USAGE =
  'Usage: composer-destroy.ts <entry> (--production | --stage <name>) [--name <name>] [--config <file>]';

interface DestroyRequest {
  readonly entry: string;
  readonly target: DestroyTarget;
  readonly name: string | undefined;
  readonly config: string;
}

/** A failure this script reports on one line, before or around the operation. */
class ScriptFailure extends Error {}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null;
}

function hasDestroy(value: unknown): value is { readonly destroy: typeof Destroy } {
  return isRecord(value) && typeof value['destroy'] === 'function';
}

/** An object is all this script checks; the operation checks the section's fields and refuses a bad one. */
function isSectionObject(value: unknown): value is ComposerConfigSource['value'] {
  return isRecord(value);
}

/** The error's first line: Node appends a require stack to module-not-found messages. */
function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
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
      config: { type: 'string' },
    },
  });
}

function parseRequest(argv: readonly string[]): DestroyRequest | string {
  let parsed: ReturnType<typeof parseDestroyArgs>;
  try {
    parsed = parseDestroyArgs(argv);
  } catch (error) {
    return messageOf(error);
  }
  const { positionals, values } = parsed;
  const [entry, ...extra] = positionals;
  if (entry === undefined || extra.length > 0) return 'Pass exactly one entry file.';
  const { stage, production, name } = values;
  const config = values.config ?? 'prisma.config.ts';
  if (stage !== undefined && production === true) {
    return 'Pass either --stage <name> or --production, not both.';
  }
  if (stage !== undefined) return { entry, target: { kind: 'stage', stage }, name, config };
  if (production === true) return { entry, target: { kind: 'production' }, name, config };
  return 'destroy requires an explicit target: --stage <name> or --production.';
}

async function loadDestroy(cwd: string): Promise<typeof Destroy> {
  let control: unknown;
  try {
    const resolved = createRequire(join(cwd, 'package.json')).resolve('@prisma/composer/control');
    control = await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new ScriptFailure(
      `Could not load @prisma/composer/control from ${cwd}: ${messageOf(error)}`,
    );
  }
  if (!hasDestroy(control)) {
    throw new ScriptFailure(`@prisma/composer/control in ${cwd} does not export destroy.`);
  }
  return control.destroy;
}

async function loadComposerSection(configFile: string): Promise<ComposerConfigSource['value']> {
  let config: unknown;
  try {
    config = await import(pathToFileURL(configFile).href);
  } catch (error) {
    throw new ScriptFailure(`Could not import ${configFile}: ${messageOf(error)}`);
  }
  const section =
    isRecord(config) && isRecord(config['default']) ? config['default']['composer'] : undefined;
  if (!isSectionObject(section)) {
    throw new ScriptFailure(`${configFile} declares no \`composer\` section.`);
  }
  return section;
}

function printFailure(failure: CliStructuredError): void {
  const envelope =
    typeof failure.toEnvelope === 'function' ? failure.toEnvelope() : { summary: failure.message };
  console.error(JSON.stringify(envelope, null, 2));
  if (failure.cause instanceof Error && failure.cause.message !== failure.message) {
    console.error(`Caused by: ${failure.cause.message}`);
  }
}

function warnOnEvent(cwd: string) {
  return (event: DestroyEvent): void => {
    if (event.kind !== 'no-local-deploy-state') return;
    console.error(
      `No prior deploy state under ${event.cwd ?? cwd}. If you deployed from a different directory, run destroy from there; otherwise this is a no-op.`,
    );
  };
}

async function run(request: DestroyRequest, cwd: string): Promise<number> {
  const destroy = await loadDestroy(cwd);
  const file = resolve(cwd, request.config);
  const value = await loadComposerSection(file);
  let result: Awaited<ReturnType<typeof Destroy>>;
  try {
    result = await destroy({
      config: { value, file },
      entry: request.entry,
      name: request.name,
      target: request.target,
      cwd,
      onEvent: warnOnEvent(cwd),
    });
  } catch (error) {
    throw new ScriptFailure(`destroy threw: ${messageOf(error)}`);
  }
  if (!result.ok) {
    printFailure(result.failure);
    return 1;
  }
  console.log('Destroyed.');
  return 0;
}

async function main(): Promise<number> {
  const request = parseRequest(process.argv.slice(2));
  if (typeof request === 'string') {
    console.error(`${request}\n${USAGE}`);
    return 2;
  }
  try {
    return await run(request, process.cwd());
  } catch (error) {
    if (!(error instanceof ScriptFailure)) throw error;
    console.error(error.message);
    return 1;
  }
}

process.exitCode = await main();
