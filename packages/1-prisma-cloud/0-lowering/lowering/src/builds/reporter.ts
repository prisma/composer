/**
 * Reports a deploy to Prisma Cloud as a `Build`, so the Console can show
 * deploy history for apps the platform never built.
 *
 * The session opens before the CLI resolves containers, which is deliberate:
 * creating them is the step that can leave a Project behind with nothing
 * recording why (composer#103), and a session opened afterwards would miss
 * the one failure it most needs to describe.
 *
 * Nothing here can fail a deploy. Every call goes through `BuildsApi`, which
 * warns and returns rather than throwing, and the two places that could still
 * throw — reading git, installing a signal handler — are wrapped. A deploy
 * that converged is a deploy that succeeded, whatever the Console was told.
 *
 * Lives here rather than beside the extension that registers it because the
 * extension package ships into runtime surfaces and may import no node
 * builtin and read no environment (its invariants 4 and 5). Reading git and
 * the deploy shell is exactly what this does, so it belongs on the lowering
 * side; the extension keeps only the one thing this cannot know, which is how
 * to read its own container.
 */
import type {
  ContainerInstance,
  DeployedEntity,
  ReportAnchorInput,
  ReportBeginInput,
  ReporterDescriptor,
  RunOutcome,
  RunReporter,
} from '@internal/core/config';
import { createManagementApiClient } from '@prisma/management-api-sdk';
import { MANAGEMENT_API_ORIGIN } from '../client.ts';
import { type BuildsApi, buildsApi, type UpdateBuildBody } from './api.ts';
import { BUILD_ID_ENV } from './resources.ts';
import { resolveRunIdentity } from './run-identity.ts';

/** How long a cancelled run waits for its last report before exiting anyway. */
const CANCEL_REPORT_BUDGET_MS = 1_500;

/** Exit status for a run ended by a signal, by the usual shell convention (128 + SIGINT). */
const CANCELLED_EXIT_CODE = 130;

/** The build's query anchors, read out of the reporting extension's own container. */
export interface BuildReportAnchors {
  readonly projectId: string;
  readonly branchId: string | undefined;
}

export interface BuildReporterOptions {
  /** Narrows the extension's container to the anchors this build should carry. */
  readonly anchorsOf: (container: ContainerInstance) => BuildReportAnchors;
  readonly origin?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly warn?: (message: string) => void;
  /** Injected by tests; the real one talks to the Management API. */
  readonly api?: BuildsApi;
}

export function buildReporter(options: BuildReporterOptions): ReporterDescriptor {
  return {
    begin: (input) => beginSession(input, options),
  };
}

async function beginSession(
  input: ReportBeginInput,
  options: BuildReporterOptions,
): Promise<RunReporter | undefined> {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const token = env['PRISMA_SERVICE_TOKEN'];
  if (options.api === undefined && (token === undefined || token.length === 0)) {
    // Not worth a line: a deploy without a token fails immediately afterwards
    // for a reason the operator will see.
    return undefined;
  }

  const identity = resolveRunIdentity(input.cwd, env);
  if (identity === undefined) {
    warn(
      `\nNot recording this deploy in Prisma Cloud: ${input.cwd} has no commit and branch to ` +
        'report it under. Deploy from a git checkout to see it in the Console.',
    );
    return undefined;
  }

  // Its own client rather than the shared `ManagementClient` service: this
  // runs in the CLI process, before any Effect layer is built, and needs
  // nothing from one.
  const api =
    options.api ??
    buildsApi({
      client: createManagementApiClient({
        token: token ?? '',
        baseUrl: options.origin ?? MANAGEMENT_API_ORIGIN,
      }),
      warn,
    });

  // A build id in the environment means something upstream — the Prisma
  // GitHub Action — already created the build and this run is one part of it.
  // Joining means never re-creating it, and never overwriting what the
  // creator knows better: its source, and the link to its own logs.
  const joined = env[BUILD_ID_ENV];
  const buildId =
    joined !== undefined && joined.length > 0
      ? joined
      : await api.create({
          source: identity.source,
          commitSha: identity.commitSha,
          branchName: identity.branchName,
          ...(identity.runIdentity !== undefined ? { runIdentity: identity.runIdentity } : {}),
          ...(identity.externalLogUrl !== undefined
            ? { externalLogUrl: identity.externalLogUrl }
            : {}),
        });

  if (buildId === undefined) return undefined;

  // `deploy`, always. Composer does not build the user's code — ADR-0005
  // leaves that to them — so `build` names a phase this tool never runs.
  // Whoever did build reports that phase itself.
  await api.update(buildId, { phase: 'deploy', state: 'running' });

  return session(api, buildId, options.anchorsOf, warn);
}

/**
 * The app this run deployed and where it can be reached — but only when the
 * run deployed exactly one compute service.
 *
 * `Build.appId` and `Build.deployedUrl` are each one value, and an app with
 * several services has no single answer. Picking the first would put an
 * arbitrary service's address in the Console and quietly imply it was the
 * app's. Single-service apps are the common case and get a working link;
 * multi-service apps get neither, and their services are all reported through
 * the resources endpoint regardless.
 *
 * Both fields are fill-only, so this is safe to send on a build whose creator
 * already set them to the same values, and a genuine disagreement is a 409
 * the caller logs.
 */
function deployedApp(entities: readonly DeployedEntity[]): UpdateBuildBody {
  const services = entities.filter((entity) => entity.kind === 'compute-service');
  const only = services.length === 1 ? services[0] : undefined;
  if (only === undefined) return {};
  return {
    appId: only.id,
    ...(only.url !== undefined ? { deployedUrl: only.url } : {}),
  };
}

function session(
  api: BuildsApi,
  buildId: string,
  anchorsOf: (container: ContainerInstance) => BuildReportAnchors,
  warn: (message: string) => void,
): RunReporter {
  let finished = false;

  /**
   * A run killed by a signal never reports a terminal state, and nothing
   * sweeps a build that stopped reporting — it stays "running" in the Console
   * forever. Ctrl-C and SIGTERM are the two that can be caught, so they are.
   * The budget is what stops a slow platform from making Ctrl-C feel broken;
   * SIGKILL and a torn-down CI runner remain uncoverable by anything here.
   */
  const onSignal = (): void => {
    if (finished) return;
    finished = true;
    const exit = (): never => process.exit(CANCELLED_EXIT_CODE);
    setTimeout(exit, CANCEL_REPORT_BUDGET_MS).unref();
    void api.update(buildId, { state: 'cancelled' }).then(exit, exit);
  };

  try {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  } catch (error) {
    // An environment that refuses signal handlers costs this run its
    // cancellation report and nothing else.
    warn(
      `Could not watch for cancellation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const releaseSignals = (): void => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };

  return {
    childEnv: () => ({ [BUILD_ID_ENV]: buildId }),

    /**
     * Attaches the build to the Project and Branch this deploy resolved.
     *
     * Sent on its own rather than folded into the progress update above:
     * until the amendment requested on pdp-control-plane #4855 lands, the
     * platform accepts these three only at creation, and Composer does not
     * know them until now. Keeping them in their own call means today's
     * rejection costs the anchors alone, and the same code starts working the
     * moment the endpoint does.
     */
    async anchor(input: ReportAnchorInput): Promise<void> {
      if (input.container === undefined) return;
      const { projectId, branchId } = anchorsOf(input.container);
      await api.update(buildId, {
        projectId,
        ...(branchId !== undefined ? { branchId } : {}),
      });
    },

    async finish(outcome: RunOutcome): Promise<void> {
      if (finished) return;
      finished = true;
      releaseSignals();
      await api.update(buildId, {
        state: outcome.ok ? 'succeeded' : 'failed',
        ...(outcome.failingStep !== undefined ? { failingStep: outcome.failingStep } : {}),
        ...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
        ...deployedApp(outcome.entities),
      });
    },
  };
}
