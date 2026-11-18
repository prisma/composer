/**
 * One `prisma dev` converge as plain data, and the steps that run it: Load,
 * `lower()` against the local target, then Alchemy's plan and apply. The
 * default runs it in a new worker thread (`dev-converge-in-worker.ts`), so each
 * converge imports the app's definition files as they are on disk.
 */
import { type AppConfigurationRead, type AppRootNode, Load, type ModuleNode } from '@internal/core';
import type { ContainerInstance, PrismaAppConfig } from '@internal/core/config';
import { resolveLocalTargets } from '@internal/core/local-target';
import { type CliErrorEnvelope, CliStructuredError } from '@internal/foundation/errors';
import type { AppConvergeEntry } from '../app-converge.ts';
import {
  type ConvergeEvent,
  type ConvergeOutcome,
  failureReasonOf,
} from '../converge-in-process.ts';
import {
  type ValueReadsChange,
  type ValueReadsSnapshot,
  valueReadsChange,
  valueReadsSnapshot,
} from '../dev/value-reads-change.ts';

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
  /** Each service's assembled bundle: only the fields lowering reads. */
  readonly bundles: Readonly<Record<string, { readonly dir: string; readonly entry: string }>>;
  readonly unassembled: readonly string[];
  /** Each extension's local container, as its `serialize()` text, by extension id. */
  readonly containers: Readonly<Record<string, string>>;
  readonly preflightPayloads: Readonly<Record<string, string>>;
  readonly devDir: string;
  readonly plainVariableText: Readonly<Record<string, string>>;
  readonly namedSecrets: Readonly<Record<string, string>>;
  /** The node addresses of the graph the session started with. */
  readonly nodeAddresses: readonly string[];
  /** The value reads of the graph the session started with. */
  readonly valueReads: ValueReadsSnapshot;
}

/** Where a dev converge reports what happens while it runs. */
export interface DevConvergeReport {
  readonly onEvent: (event: ConvergeEvent) => void;
  /** Text written to the terminal while it runs: Alchemy's own, and anything the app's code prints. */
  readonly output: (text: string) => void;
}

/**
 * What one dev converge came to; each variant lists the app files the converge's import loaded.
 * `outcome`: the converge ran, or the runner refused or ended it, to this outcome.
 * `error`: a structured error stopped it before it began, as its envelope.
 * `value-reads-changed`: the app now reads other platform variables than the session prepared
 * for, so nothing was converged.
 */
export type DevConvergeResult =
  | {
      readonly kind: 'outcome';
      readonly outcome: ConvergeOutcome;
      readonly appFiles: readonly string[];
    }
  | {
      readonly kind: 'error';
      readonly error: CliErrorEnvelope;
      /** Set when the runtime keeps the failed lookup of a directory import that would now succeed, so only a new process loads it. */
      readonly lookupKept?: true;
      readonly appFiles: readonly string[];
    }
  | {
      readonly kind: 'value-reads-changed';
      readonly change: ValueReadsChange;
      readonly appFiles: readonly string[];
    };

/** Runs one dev converge and reports its events. Never rejects: every failure is a result. */
export type RunDevConverge = (
  job: DevConvergeJob,
  report: DevConvergeReport,
  signal?: AbortSignal,
) => Promise<DevConvergeResult>;

/** What a dev converge imported: the config, the app root, the app's converge entry, and the app files the import loaded. */
export interface LoadedDevApp {
  readonly config: PrismaAppConfig;
  readonly root: ModuleNode | AppRootNode;
  readonly entry: AppConvergeEntry;
  readonly appFiles: readonly string[];
}

function cloneable(envelope: CliErrorEnvelope): CliErrorEnvelope {
  try {
    return structuredClone(envelope);
  } catch {
    const { meta: _meta, ...rest } = envelope;
    return rest;
  }
}

/** `error` as a result: a structured error as its envelope, any other as a failed outcome. */
export function thrownResult(error: unknown, appFiles: readonly string[] = []): DevConvergeResult {
  return CliStructuredError.is(error)
    ? { kind: 'error', error: cloneable(error.toEnvelope()), appFiles }
    : { kind: 'outcome', outcome: { kind: 'failed', reasons: [failureReasonOf(error)] }, appFiles };
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

/**
 * Lowers `app` against the local target and plans and applies it, as `job` describes. First it
 * Loads the app as `lower()` will, and refuses to converge when its value reads differ from the
 * ones the session started with.
 */
export async function convergeDevJob(
  job: DevConvergeJob,
  app: LoadedDevApp,
  report: DevConvergeReport,
  signal: AbortSignal | undefined,
): Promise<DevConvergeResult> {
  try {
    const graph = Load(app.root, {
      id: job.name,
      environment: { name: job.environment },
      appConfigurationRead: job.appConfigurationRead,
    });
    const change = valueReadsChange(job.valueReads, valueReadsSnapshot(graph));
    if (change !== undefined) {
      return { kind: 'value-reads-changed', change, appFiles: app.appFiles };
    }
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
    const outcome = await app.entry.converge({
      operation: 'deploy',
      stack,
      stage: job.environment,
      cwd: job.cwd,
      env: {},
      signal,
      onEvent: report.onEvent,
      output: report.output,
    });
    return { kind: 'outcome', outcome, appFiles: app.appFiles };
  } catch (error) {
    return thrownResult(error, app.appFiles);
  }
}
