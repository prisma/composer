/**
 * The shared prefix of `deploy`/`destroy`/`dev` (deploy-cli.md § The
 * pipeline; local-dev spec § 6): entry load, Load,
 * registry coverage validation, name resolution, assemble. Deploy and dev
 * diverge after this — deploy resolves containers/preflight/stack file
 * against the hosted providers, dev against the local ones — so everything
 * up to and including assemble lives here once, consumed verbatim by both
 * `run()` (main.ts) and `runDev()` (dev/run-dev.ts), so the two pipelines
 * cannot drift.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type AssembledServices,
  type AssembleEvent,
  assembleServices,
  type RunAssembler,
} from '@internal/assemble';
import type { Graph } from '@internal/core';
import { assertAppName, Load } from '@internal/core';
import type { PrismaAppConfig } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import {
  type ComposerConfigSource,
  type ConfigFinding,
  checkComposerConfig,
  configFileMissing,
  entryMissing,
} from './composer-config.ts';
import { type LoadedEntry, loadEntry } from './load-entry.ts';
import { validateRegistryCoverage } from './validate-coverage.ts';

/** The app is loaded and checked, and assemble is about to start; then one assemble event per service. */
export type PipelineEvent = { readonly kind: 'loaded' } | AssembleEvent;

/** Injectable seams so tests can drive the pipeline without a real wrapper build. */
export interface PipelineDeps {
  readonly runAssembler?: RunAssembler | undefined;
  /** Progress, for a caller that reports each step. */
  readonly onEvent?: ((event: PipelineEvent) => void) | undefined;
}

export interface PipelineResult {
  /** The checked config, with `file` absolute. */
  readonly configSource: ComposerConfigSource;
  readonly entryModule: LoadedEntry;
  readonly graph: Graph;
  readonly name: string;
  readonly assembled: AssembledServices;
}

export interface AppIdentity {
  readonly config: PrismaAppConfig;
  readonly name: string;
}

function configError(
  findings: readonly [ConfigFinding, ...ConfigFinding[]],
  file: string,
): CliStructuredError {
  const [first] = findings;
  return new CliStructuredError(first.code, first.summary, {
    ...(first.why === undefined ? {} : { why: first.why }),
    fix: first.fix,
    where: { path: first.where ?? file },
    meta: {
      ...(first.field === undefined ? {} : { field: first.field }),
      findings,
    },
  });
}

/**
 * Refuses a caller's config with the same findings, in the same order, as the CLI's section validator.
 * The error is the first finding and carries all of them in `meta.findings`. Returns the config with `file` resolved against `cwd`.
 */
export function checkConfigSource(source: ComposerConfigSource, cwd: string): ComposerConfigSource {
  const file = path.resolve(cwd, source.file);
  if (!fs.existsSync(file)) throw configError([configFileMissing(file)], file);
  const checked = checkComposerConfig(source.value, file);
  if (!checked.ok) throw configError(checked.findings, file);
  return { value: checked.value, file };
}

/** The entry module's absolute path, and what to check when it cannot be loaded. */
export interface ResolvedEntry {
  readonly path: string;
  readonly fix: string;
}

/**
 * Resolves the entry module. An override (`--entry`, or an operation's `entry` input) resolves
 * against `cwd`; the section's `entry` resolves against the directory of the file that declares it,
 * as the CLI engine resolves path fields in prisma.config.ts.
 */
export function resolveEntryPath(
  override: string | undefined,
  source: ComposerConfigSource,
  cwd: string,
): ResolvedEntry {
  if (override !== undefined) {
    return {
      path: path.resolve(cwd, override),
      fix:
        `Check the \`--entry\` path (the \`entry\` input when calling @prisma/composer/control) "${override}". ` +
        `It is relative to the current directory, ${cwd}.`,
    };
  }
  const configured = source.value.entry;
  if (configured === undefined) throw configError([entryMissing], source.file);
  return {
    path: path.resolve(path.dirname(source.file), configured),
    fix: `Check \`entry: "${configured}"\` in ${source.file}. It is relative to that file's directory.`,
  };
}

/**
 * The pipeline's front — entry load and name resolution —
 * WITHOUT Load, coverage, or assemble. `log` needs only who the app is (its
 * config and resolved name) to reach the already-running local instance; it
 * neither builds nor provisions, so it must not require the user's built
 * output the way the full pipeline does.
 */
export async function resolveAppIdentity(
  entry: string | undefined,
  overrideName: string | undefined,
  cwd: string,
  config: ComposerConfigSource,
): Promise<AppIdentity> {
  const checked = checkConfigSource(config, cwd);
  const { value } = checked;
  const resolved = resolveEntryPath(entry, checked, cwd);
  const entryModule = await loadEntry(resolved.path, cwd, resolved.fix);
  const name = overrideName ?? entryModule.root.name;
  if (name.length === 0) {
    throw new CliStructuredError('COMPOSE.NAME_MISSING', 'The root node has no name.', {
      fix: 'Name it at authoring, or pass --name.',
    });
  }
  assertAppName(name);
  return { config: value, name };
}

/**
 * Runs entry load, name resolution, Load, registry coverage, and assemble — steps 1–5 of `run()`. `onAssembleError`, when
 * given, lets a caller decorate an assemble failure with command-specific
 * guidance (destroy's "build first" hint) without this shared step knowing
 * about any one command.
 */
export async function runPipeline(
  entry: string | undefined,
  overrideName: string | undefined,
  cwd: string,
  source: ComposerConfigSource,
  deps: PipelineDeps = {},
  onAssembleError?: (error: Error) => Error,
): Promise<PipelineResult> {
  const configSource = checkConfigSource(source, cwd);
  const config = configSource.value;

  // 1. Import the entry module; its default export must be a node.
  const resolved = resolveEntryPath(entry, configSource, cwd);
  const entryModule = await loadEntry(resolved.path, cwd, resolved.fix);

  // 2. Resolve the name. It is the root's address, so Load needs it (ADR-0057).
  const name = overrideName ?? entryModule.root.name;
  if (name.length === 0) {
    throw new CliStructuredError('COMPOSE.NAME_MISSING', 'The root node has no name.', {
      fix: 'Name it at authoring, or pass --name.',
    });
  }

  // 3. Load — core's LoadError (unwired connection input, etc.) surfaces as-is.
  const graph = Load(entryModule.root, { id: name });
  if (graph.root.node.kind !== 'module') {
    throw new CliStructuredError('COMPOSE.ROOT_NOT_MODULE', 'The deploy root must be a module.', {
      fix:
        'Wrap your service, e.g. ' +
        "export default module('name', ({ provision }) => { provision(service); }).",
    });
  }

  // 4. Registry coverage: every node/build in the graph has a matching descriptor in the config.
  validateRegistryCoverage(graph, config);

  // 5. Assemble each service through the config's registries.
  deps.onEvent?.({ kind: 'loaded' });
  let assembled: AssembledServices;
  try {
    assembled = await assembleServices(graph, config, cwd, deps.runAssembler, deps.onEvent);
  } catch (error) {
    if (onAssembleError !== undefined && error instanceof Error) {
      throw onAssembleError(error);
    }
    throw error;
  }

  return { configSource, entryModule, graph, name, assembled };
}
