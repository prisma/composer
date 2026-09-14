/**
 * Reports a deploy to Prisma Cloud as a `Build`, so the Console can show
 * deploy history for apps the platform never built — and, on `attach`,
 * replaces the stage Branch's application topology with what this deploy
 * declares, stamping the build with the topology's content hash so the
 * platform can link the run to the graph it deployed by value.
 *
 * The session opens before the CLI resolves containers, which is deliberate:
 * creating them is the step that can leave a Project behind with nothing
 * recording why (composer#103), and a session opened afterwards would miss
 * the one failure it most needs to describe.
 *
 * Nothing here can fail a deploy. Every call goes through `BuildsApi`, which
 * warns and returns rather than throwing, and the one place that could still
 * throw — reading git — is wrapped. A deploy that converged is a deploy that
 * succeeded, whatever the Console was told.
 *
 * This module installs NO signal handlers: the CLI engine is the sole signal
 * owner (its detector test enforces it). Cancellation reaches this reporter
 * as `RunOutcome.cancelled` on the ordinary `finish` path.
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
  ReportAttachInput,
  ReportBeginInput,
  ReporterDescriptor,
  RunOutcome,
  RunReporter,
} from '@internal/core/config';
import { createManagementApiClient } from '@prisma/management-api-sdk';
import * as Effect from 'effect/Effect';
import type { ManagementApiClient } from '../client.ts';
import { managementApiBaseUrl } from '../credentials.ts';
import { type BuildsApi, buildsApi, type UpdateBuildBody } from './api.ts';
import {
  type ApplicationTopologyApi,
  type ApplicationTopologyBody,
  applicationTopologyApi,
  applicationTopologyContentHash,
  composeApplicationTopology,
} from './application-topology.ts';
import { BUILD_ID_ENV } from './resources.ts';
import { resolveRunIdentity } from './run-identity.ts';

/** An empty string is how a shell spells "unset", so it must not be mistaken for a build id. */
const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

/** The Build row's project and branch references, read out of the reporting extension's own container. */
export interface BuildContainerRefs {
  readonly projectId: string;
  /** The named stage's Branch — absent for the default stage, whose Build carries no branch reference. */
  readonly branchId: string | undefined;
  /** The Branch the deploy actually targets — the named stage's own, or the default Branch. Where the application topology is submitted; absent means no submission. */
  readonly stageBranchId: string | undefined;
}

export interface BuildReporterOptions {
  /** Narrows the extension's container to the project/branch references this build should carry. */
  readonly refsOf: (container: ContainerInstance) => BuildContainerRefs;
  readonly origin?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly warn?: (message: string) => void;
  /** Injected by tests; the real one talks to the Management API. */
  readonly api?: BuildsApi;
  /** Injected by tests; the real one talks to the Management API. */
  readonly topology?: ApplicationTopologyApi;
}

export function buildReporter(options: BuildReporterOptions): ReporterDescriptor {
  return {
    // Typed against this platform's client; assigns into the erased
    // `begin(ReportBeginInput<unknown>)` through method bivariance.
    //
    // `begin` is documented never to throw, and this catch is what makes the
    // claim true of THIS reporter rather than a favour the CLI does it: an
    // injected api that rejects, or any other defect here, costs the session
    // and one warning, never the deploy.
    begin: async (input: ReportBeginInput<ManagementApiClient>) => {
      try {
        return await beginSession(input, options);
      } catch (error) {
        const warn = options.warn ?? ((message: string) => console.warn(message));
        warn(
          `Could not start build reporting: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    },
  };
}

async function beginSession(
  input: ReportBeginInput<ManagementApiClient>,
  options: BuildReporterOptions,
): Promise<RunReporter | undefined> {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  // The caller's already-authenticated client, when the engine supplied one
  // — "present means the extension must not build its own from the
  // environment" (ContainerCredentials). The env token is the standalone
  // fallback, for hosts driving `@prisma/composer/control` without an engine.
  const injected = input.credentials?.client;
  const token = env['PRISMA_SERVICE_TOKEN'];
  if (
    options.api === undefined &&
    options.topology === undefined &&
    injected === undefined &&
    (token === undefined || token.length === 0)
  ) {
    // Not worth a line: a deploy without any credential fails immediately
    // afterwards for a reason the operator will see.
    return undefined;
  }

  // Its own client rather than the shared `ManagementClient` service: this
  // runs in the CLI process, before any Effect layer is built, and needs
  // nothing from one. Built lazily and at most once — both APIs may be
  // injected by tests, and then no client exists to build from.
  let client: ManagementApiClient | undefined;
  const clientOf = (): ManagementApiClient =>
    (client ??=
      injected ??
      createManagementApiClient({
        token: token ?? '',
        baseUrl: options.origin ?? Effect.runSync(managementApiBaseUrl(options.env)),
      }));
  const api = options.api ?? buildsApi({ client: clientOf(), warn });
  const topologyApi = options.topology ?? applicationTopologyApi({ client: clientOf(), warn });

  // The declared graph and its content hash, composed once per deploy. A
  // composition defect costs the submission and a warning, never the rest of
  // the session — the Build keeps being reported, with no hash and no
  // topology, the same way any other single failed report degrades.
  let submission:
    | { readonly body: ApplicationTopologyBody; readonly contentHash: string }
    | undefined;
  try {
    const body = composeApplicationTopology(input.graph);
    submission = { body, contentHash: applicationTopologyContentHash(body) };
  } catch (error) {
    warn(
      `Could not compose this deploy's application topology: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    submission = undefined;
  }

  const identity = resolveRunIdentity(input.cwd, env);
  if (identity === undefined) {
    warn(
      `\nNot recording this deploy in Prisma Cloud: ${input.cwd} has no commit and branch to ` +
        'report it under. Deploy from a git checkout to see it in the Console.',
    );
    // The topology needs no repository — it still records what this deploy declared.
    return sessionWithoutBuild(topologyApi, submission, options.refsOf);
  }

  // A build id from either channel means something upstream — the Prisma
  // GitHub Action, or a workflow driving the CLI directly — already created
  // the build and this run is one part of it. Joining means never re-creating
  // it, and never overwriting what the creator knows better: its source, and
  // the link to its own logs.
  //
  // `--build-id` beats PRISMA_BUILD_ID because it was passed deliberately: a
  // runner that exports the variable for a whole job, then names a different
  // build for one step, means the step.
  const joined = nonEmpty(input.reportId) ?? nonEmpty(env[BUILD_ID_ENV]);
  const buildId =
    joined !== undefined
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

  if (buildId === undefined) return sessionWithoutBuild(topologyApi, submission, options.refsOf);

  // `deploy`, always. Composer does not build the user's code — ADR-0005
  // leaves that to them — so `build` names a phase this tool never runs.
  // Whoever did build reports that phase itself.
  await api.update(buildId, { phase: 'deploy', state: 'running' });

  return session(api, topologyApi, buildId, submission, options.refsOf, warn);
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

/**
 * The topology half of `attach`, shared with build-less sessions: replaces
 * the stage Branch's application topology, once per deploy, after the Branch
 * exists and before any resource is created (attach's position in the
 * pipeline). A container that resolves no stage Branch has nowhere to submit
 * to, and the API's own failure handling already warned — nothing here
 * throws past it.
 */
async function submitTopology(
  topologyApi: ApplicationTopologyApi,
  submission: { readonly body: ApplicationTopologyBody; readonly contentHash: string } | undefined,
  refs: BuildContainerRefs,
): Promise<void> {
  if (submission === undefined || refs.stageBranchId === undefined) return;
  await topologyApi.replace(refs.projectId, refs.stageBranchId, {
    contentHash: submission.contentHash,
    ...submission.body,
  });
}

/**
 * The session for a deploy whose Build never came to be — no repository to
 * report under, or a create the platform refused. The declared topology
 * depends on neither, so `attach` still submits it; everything else is a
 * no-op.
 */
function sessionWithoutBuild(
  topologyApi: ApplicationTopologyApi,
  submission: { readonly body: ApplicationTopologyBody; readonly contentHash: string } | undefined,
  refsOf: (container: ContainerInstance) => BuildContainerRefs,
): RunReporter {
  return {
    childEnv: () => ({}),
    async attach(input: ReportAttachInput): Promise<void> {
      if (input.container === undefined) return;
      await submitTopology(topologyApi, submission, refsOf(input.container));
    },
    // Same contract as the full session: finish never rejects. No build, nothing to close.
    finish: async () => {},
  };
}

function session(
  api: BuildsApi,
  topologyApi: ApplicationTopologyApi,
  buildId: string,
  submission: { readonly body: ApplicationTopologyBody; readonly contentHash: string } | undefined,
  refsOf: (container: ContainerInstance) => BuildContainerRefs,
  warn: (message: string) => void,
): RunReporter {
  let finished = false;

  return {
    childEnv: () => ({ [BUILD_ID_ENV]: buildId }),

    /**
     * Attaches the build to the Project and Branch this deploy resolved,
     * stamping the topology's content hash on the same update, then submits
     * the declared topology to the stage Branch. The hash rides the attach
     * update rather than a call of its own because it must not travel alone
     * yet: until the platform accepts the field, its validator strips it and
     * then rejects the emptied body ("at least one field must be given") —
     * observed live on 2026-08-21. Folded in, the update stays valid today
     * and the hash starts landing the moment the field is accepted. It is
     * sent whether or not the submission lands — the run acted on this graph
     * either way; equal hashes are a value match, not a reference to the
     * stored topology.
     */
    async attach(input: ReportAttachInput): Promise<void> {
      if (input.container === undefined) return;
      const refs = refsOf(input.container);
      const { projectId, branchId } = refs;
      await api.update(buildId, {
        projectId,
        ...(branchId !== undefined ? { branchId } : {}),
        ...(submission !== undefined
          ? { applicationTopologyContentHash: submission.contentHash }
          : {}),
      });
      await submitTopology(topologyApi, submission, refs);
    },

    async finish(outcome: RunOutcome): Promise<void> {
      if (finished) return;
      finished = true;
      // `cancelled` is the user interrupting, not a deploy that went wrong —
      // and a SIGKILLed run reports nothing at all, leaving the build
      // permanently `running` (nothing sweeps builds, by platform design).
      try {
        await api.update(buildId, {
          state: outcome.ok ? 'succeeded' : outcome.cancelled ? 'cancelled' : 'failed',
          ...(outcome.failingStep !== undefined && !outcome.cancelled
            ? { failingStep: outcome.failingStep }
            : {}),
          ...(outcome.errorMessage !== undefined && !outcome.cancelled
            ? { errorMessage: outcome.errorMessage }
            : {}),
          ...deployedApp(outcome.entities),
        });
      } catch (error) {
        // Same contract as begin: finish never rejects, whatever the api does.
        warn(
          `Could not report this deploy's outcome: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
