/**
 * One `prisma dev` converge as plain data, and the steps that run it: Load,
 * `lower()` against the local target, then Alchemy's plan and apply. The
 * default runs it in a new worker thread (`converge-in-worker.ts`), so each
 * converge imports the app's definition files as they are on disk.
 */
import type { AppConfigurationRead, AppRootNode, ModuleNode } from '@internal/core';
import type { ContainerInstance, PrismaAppConfig } from '@internal/core/config';
import type { Bundle } from '@internal/core/deploy';
import { resolveLocalTargets } from '@internal/core/local-target';
import type { AppConvergeEntry } from '../app-converge.ts';
import type { ConvergeEvent, ConvergeOutcome } from '../converge-in-process.ts';

/** Everything a dev converge needs from the session, as data a worker thread can receive. */
export interface DevConvergeJob {
  /** The `prisma.config.ts` that declares the `composer` section. Absolute. */
  readonly configFile: string;
  /** The entry module. Absolute. */
  readonly entry: string;
  /** Where the app's own `@prisma/composer` resolves from. */
  readonly appDir: string;
  readonly cwd: string;
  readonly name: string;
  readonly environment: string;
  readonly appConfigurationRead: AppConfigurationRead;
  readonly bundles: Readonly<Record<string, Bundle>>;
  readonly unassembled: readonly string[];
  /** Each extension's local container, as its `serialize()` text, by extension id. */
  readonly containers: Readonly<Record<string, string>>;
  readonly preflightPayloads: Readonly<Record<string, string>>;
  readonly devDir: string;
  readonly plainVariableText: Readonly<Record<string, string>>;
  readonly namedSecrets: Readonly<Record<string, string>>;
  /** The node addresses of the graph the session started with. */
  readonly nodeAddresses: readonly string[];
}

/** Where a dev converge reports what happens while it runs. */
export interface DevConvergeReport {
  readonly onEvent: (event: ConvergeEvent) => void;
  /** Text written to the terminal while it runs: Alchemy's own, and anything the app's code prints. */
  readonly output: (text: string) => void;
}

/** Runs one dev converge and reports its events. Never throws: a failure is an outcome. */
export type RunDevConverge = (
  job: DevConvergeJob,
  report: DevConvergeReport,
  signal?: AbortSignal,
) => Promise<ConvergeOutcome>;

/** What a dev converge imported: the config, the app root and the app's converge entry. */
export interface LoadedDevApp {
  readonly config: PrismaAppConfig;
  readonly root: ModuleNode | AppRootNode;
  readonly entry: AppConvergeEntry;
}

export function thrownOutcome(error: unknown): ConvergeOutcome {
  return {
    kind: 'failed',
    reasons: [
      {
        tag: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

function containersOf(
  job: DevConvergeJob,
  resolved: Awaited<ReturnType<typeof resolveLocalTargets>>,
): ReadonlyMap<string, ContainerInstance> {
  const containers = new Map<string, ContainerInstance>();
  for (const [id, text] of Object.entries(job.containers)) {
    const descriptor = resolved.get(id);
    if (descriptor !== undefined) containers.set(id, descriptor.container.deserialize(text));
  }
  return containers;
}

/** Lowers `app` against the local target and plans and applies it, as `job` describes. */
export async function convergeDevJob(
  job: DevConvergeJob,
  app: LoadedDevApp,
  report: DevConvergeReport,
  signal: AbortSignal | undefined,
): Promise<ConvergeOutcome> {
  try {
    const resolved = await resolveLocalTargets(app.config);
    const containers = containersOf(job, resolved);
    const stack = app.entry.lower(app.root, app.config, {
      name: job.name,
      environment: job.environment,
      appConfigurationRead: job.appConfigurationRead,
      firstProcessNodeAddresses: job.nodeAddresses,
      bundles: { ...job.bundles },
      unassembled: job.unassembled,
      containers,
      preflightPayloads: new Map(Object.entries(job.preflightPayloads)),
      providers: app.entry.localTargetProviders(
        resolved,
        containers,
        job.devDir,
        job.plainVariableText,
        job.namedSecrets,
      ),
      state: app.entry.devState(),
    });
    return await app.entry.converge({
      operation: 'deploy',
      stack,
      stage: job.environment,
      cwd: job.cwd,
      env: {},
      signal,
      onEvent: report.onEvent,
      output: report.output,
    });
  } catch (error) {
    return thrownOutcome(error);
  }
}
