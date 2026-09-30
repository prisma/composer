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
import * as path from 'node:path';
import { type AssembledServices, assembleServices, type RunAssembler } from '@internal/assemble';
import type { Graph } from '@internal/core';
import { Load } from '@internal/core';
import type { PrismaAppConfig } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import { type LoadedEntry, loadEntry } from './load-entry.ts';
import { validateRegistryCoverage } from './validate-coverage.ts';

/** Injectable seams so tests can drive the pipeline without a real wrapper build. */
export interface PipelineDeps {
  readonly runAssembler?: RunAssembler | undefined;
}

/** Composer's configuration: the `composer` section of the `prisma.config.ts` that declared it. */
export interface ComposerConfig {
  readonly value: PrismaAppConfig;
  /** The declaring `prisma.config.ts`; relative paths resolve against the operation's cwd. The generated stack file imports it. */
  readonly path: string;
}

export interface PipelineResult {
  /** The declaring `prisma.config.ts`, absolute. */
  readonly configFile: string;
  readonly config: PrismaAppConfig;
  readonly entryModule: LoadedEntry;
  readonly graph: Graph;
  readonly name: string;
  readonly assembled: AssembledServices;
}

export interface AppIdentity {
  readonly config: PrismaAppConfig;
  readonly name: string;
}

/**
 * The pipeline's front — entry load and name resolution —
 * WITHOUT Load, coverage, or assemble. `log` needs only who the app is (its
 * config and resolved name) to reach the already-running local instance; it
 * neither builds nor provisions, so it must not require the user's built
 * output the way the full pipeline does.
 */
export async function resolveAppIdentity(
  entry: string,
  overrideName: string | undefined,
  cwd: string,
  config: ComposerConfig,
): Promise<AppIdentity> {
  const entryModule = await loadEntry(entry, cwd);
  const name = overrideName ?? entryModule.root.name;
  if (name.length === 0) {
    throw new CliStructuredError('COMPOSE.NAME_MISSING', 'The root node has no name.', {
      fix: 'Name it at authoring, or pass --name.',
    });
  }
  return { config: config.value, name };
}

/**
 * Runs entry load, Load, registry coverage, name resolution, and assemble — steps 1–5 of `run()`. `onAssembleError`, when
 * given, lets a caller decorate an assemble failure with command-specific
 * guidance (destroy's "build first" hint) without this shared step knowing
 * about any one command.
 */
export async function runPipeline(
  entry: string,
  overrideName: string | undefined,
  cwd: string,
  composerConfig: ComposerConfig,
  deps: PipelineDeps = {},
  onAssembleError?: (error: Error) => Error,
): Promise<PipelineResult> {
  const config = composerConfig.value;
  const configFile = path.resolve(cwd, composerConfig.path);

  // 1. Import the entry module; its default export must be a node.
  const entryModule = await loadEntry(entry, cwd);

  // 2. Load — core's LoadError (unwired connection input, etc.) surfaces as-is.
  const graph = Load(entryModule.root);
  if (graph.root.node.kind !== 'module') {
    throw new CliStructuredError('COMPOSE.ROOT_NOT_MODULE', 'The deploy root must be a module.', {
      fix:
        'Wrap your service, e.g. ' +
        "export default module('name', ({ provision }) => { provision(service); }).",
    });
  }

  // 3. Registry coverage: every node/build in the graph has a matching descriptor in the config.
  validateRegistryCoverage(graph, config);

  // 4. Resolve the name.
  const name = overrideName ?? entryModule.root.name;
  if (name.length === 0) {
    throw new CliStructuredError('COMPOSE.NAME_MISSING', 'The root node has no name.', {
      fix: 'Name it at authoring, or pass --name.',
    });
  }

  // 5. Assemble each service through the config's registries.
  let assembled: AssembledServices;
  try {
    assembled = await assembleServices(graph, config, cwd, deps.runAssembler);
  } catch (error) {
    if (onAssembleError !== undefined && error instanceof Error) {
      throw onAssembleError(error);
    }
    throw error;
  }

  return { configFile, config, entryModule, graph, name, assembled };
}
