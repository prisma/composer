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
import { type AssembledServices, assembleServices, type RunAssembler } from '@internal/assemble';
import type { Graph } from '@internal/core';
import { Load } from '@internal/core';
import type { PrismaAppConfig } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import {
  type ComposerConfigSource,
  type ConfigFinding,
  checkComposerSection,
  configFileMissing,
  retiredFileFinding,
} from './composer-config.ts';
import { type LoadedEntry, loadEntry } from './load-entry.ts';
import { validateRegistryCoverage } from './validate-coverage.ts';

/** Injectable seams so tests can drive the pipeline without a real wrapper build. */
export interface PipelineDeps {
  readonly runAssembler?: RunAssembler | undefined;
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

function configError(finding: ConfigFinding, file: string): CliStructuredError {
  return new CliStructuredError(finding.code, finding.summary, {
    ...(finding.why === undefined ? {} : { why: finding.why }),
    fix: finding.fix,
    where: { path: finding.where ?? file },
    ...(finding.field === undefined ? {} : { meta: { field: finding.field } }),
  });
}

/**
 * Refuses a caller's config the way the CLI's section validator refuses a section, before any work starts.
 * Returns it with `file` resolved against `cwd`.
 */
export function checkConfigSource(source: ComposerConfigSource, cwd: string): ComposerConfigSource {
  const file = path.resolve(cwd, source.file);
  if (!fs.existsSync(file)) throw configError(configFileMissing(file), file);
  const retired = retiredFileFinding(file);
  if (retired !== undefined) throw configError(retired, file);
  const checked = checkComposerSection(source.value);
  if (!checked.ok) throw configError(checked.findings[0], file);
  return { value: checked.value, file };
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
  config: ComposerConfigSource,
): Promise<AppIdentity> {
  const { value } = checkConfigSource(config, cwd);
  const entryModule = await loadEntry(entry, cwd);
  const name = overrideName ?? entryModule.root.name;
  if (name.length === 0) {
    throw new CliStructuredError('COMPOSE.NAME_MISSING', 'The root node has no name.', {
      fix: 'Name it at authoring, or pass --name.',
    });
  }
  return { config: value, name };
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
  source: ComposerConfigSource,
  deps: PipelineDeps = {},
  onAssembleError?: (error: Error) => Error,
): Promise<PipelineResult> {
  const configSource = checkConfigSource(source, cwd);
  const config = configSource.value;

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

  return { configSource, entryModule, graph, name, assembled };
}
