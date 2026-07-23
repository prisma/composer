/**
 * The shared prefix of `deploy`/`destroy`/`dev` (deploy-cli.md § The
 * pipeline; local-dev spec § 6): config discovery/load, entry load, Load,
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
import { CliError } from './cli-error.ts';
import { findConfigPathForEntry, loadAppConfig, missingConfigError } from './load-config.ts';
import { type LoadedEntry, loadEntry } from './load-entry.ts';
import { validateRegistryCoverage } from './validate-coverage.ts';

/** Injectable seams so tests can drive the pipeline without a real wrapper build or config evaluation. */
export interface PipelineDeps {
  readonly runAssembler?: RunAssembler | undefined;
  /** Substituted for the c12 evaluation of the discovered config file (discovery itself still runs). */
  readonly config?: PrismaAppConfig | undefined;
}

export interface PipelineResult {
  readonly configPath: string;
  readonly config: PrismaAppConfig;
  readonly entryModule: LoadedEntry;
  readonly graph: Graph;
  readonly name: string;
  readonly assembled: AssembledServices;
}

/**
 * Runs config discovery/load, entry load, Load, registry coverage, name
 * resolution, and assemble — steps 1–6 of `run()`. `onAssembleError`, when
 * given, lets a caller decorate an assemble failure with command-specific
 * guidance (destroy's "build first" hint) without this shared step knowing
 * about any one command.
 */
export async function runPipeline(
  entry: string,
  overrideName: string | undefined,
  cwd: string,
  deps: PipelineDeps = {},
  onAssembleError?: (error: Error) => Error,
): Promise<PipelineResult> {
  // 1. Find + load prisma-composer.config.ts — runs extension env validation before the entry import.
  const resolvedEntryPath = path.resolve(cwd, entry);
  const configPath = findConfigPathForEntry(resolvedEntryPath);
  if (configPath === undefined) {
    throw missingConfigError(resolvedEntryPath);
  }
  const config = deps.config ?? (await loadAppConfig(configPath)).config;

  // 2. Import the entry module; its default export must be a node.
  const entryModule = await loadEntry(entry, cwd);

  // 3. Load — core's LoadError (unwired connection input, etc.) surfaces as-is.
  const graph = Load(entryModule.root);
  if (graph.root.node.kind !== 'module') {
    throw new CliError(
      'The deploy root must be a module — wrap your service, e.g. ' +
        "export default module('name', ({ provision }) => { provision(service); }).",
    );
  }

  // 4. Registry coverage: every node/build in the graph has a matching descriptor in the config.
  validateRegistryCoverage(graph, config);

  // 5. Resolve the name.
  const name = overrideName ?? entryModule.root.name;
  if (name.length === 0) {
    throw new CliError('The root node has no name — name it at authoring, or pass --name.');
  }

  // 6. Assemble each service through the config's registries.
  let assembled: AssembledServices;
  try {
    assembled = await assembleServices(graph, config, cwd, deps.runAssembler);
  } catch (error) {
    if (onAssembleError !== undefined && error instanceof Error) {
      throw onAssembleError(error);
    }
    throw error;
  }

  return { configPath, config, entryModule, graph, name, assembled };
}
