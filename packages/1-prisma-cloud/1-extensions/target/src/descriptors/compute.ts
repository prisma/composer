/** The `compute` node kind's descriptor: the four service hooks — provision, serialize, package, deploy. */

import { isParamSource, type ServiceNode } from '@internal/core';
import type { NodeDescriptor } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import * as Prisma from '@internal/lowering';
import * as Output from 'alchemy/Output';
import * as Effect from 'effect/Effect';
import { paramBindingFor, paramName } from '../param.ts';
import {
  configKey,
  encode,
  encodeParamPointer,
  paramEntries,
  secretPointerRows,
} from '../serializer.ts';
import { serviceKeyEdges, serviceKeyEnvName } from '../service-keys.ts';
import { streamsApiKeyEdges, streamsApiKeyEnvName } from '../streams-keys.ts';
import { DEFAULT_REGION, projectIdOf, type ResolvedCloudOptions, validateName } from './shared.ts';

export function computeDescriptor(o: ResolvedCloudOptions): NodeDescriptor {
  return {
    kind: 'service' as const,
    // The service as a PLACE inside the application's Project: the App,
    // identity-bearing only, no code runs.
    provision: ({ id, application }) =>
      Effect.gen(function* () {
        validateName(id, 'service name (from provision id)');
        const svc = yield* Prisma.ComputeService(`${id}-svc`, {
          projectId: projectIdOf(application),
          name: id,
          region: o.region ?? DEFAULT_REGION,
          ...(o.branchId !== undefined ? { branchId: o.branchId } : {}),
        });
        return {
          outputs: { serviceId: svc.id, projectId: application.outputs['projectId'] },
        };
      }),

    // Two channels of rows: PARAMS (service-own literals JSON-encoded; dependency
    // provisioning refs passed through, keeping their ordering edge) and SECRETS
    // (a POINTER row per slot holding the bound platform NAME, never a value —
    // ADR-0029). The class/branch scope is identical for both.
    serialize: (ctx, provisioned, config) =>
      Effect.gen(function* () {
        const { address, node, graph } = ctx;
        const cls = o.branchId ? ('preview' as const) : ('production' as const);
        const branch = o.branchId !== undefined ? { branchId: o.branchId } : {};
        const projectId = projectIdOf(provisioned);
        const svc = node as ServiceNode;
        const records = [];

        for (const d of paramEntries(svc)) {
          const value =
            d.owner === 'service' ? config.service[d.name] : config.inputs[d.owner.input]?.[d.name];
          // An unprovisioned optional connection param has no value yet — write
          // no row (boot's coerce() reads a missing var as absent → undefined).
          // Mirrors stash(), keeping writer and reader consistent.
          if (value === undefined) continue;
          const key = configKey(address, d);
          // A service's own param resolved (buildConfig) to an opaque
          // ParamSource — env-sourced (ADR-0029's param sibling) — writes a
          // POINTER row (the bound platform NAME), never a value; everything
          // else (literals; dependency-input provisioning refs) is unchanged.
          const rowValue =
            d.owner === 'service' && isParamSource(value)
              ? encodeParamPointer(paramName(paramBindingFor(graph.params, address, d.name)))
              : encode(d.owner, value);
          records.push(
            yield* Prisma.EnvironmentVariable(`${key}-var`, {
              projectId,
              key,
              value: rowValue,
              class: cls,
              ...branch,
            }),
          );
        }

        for (const { key, name } of secretPointerRows(svc, address, graph.secrets)) {
          records.push(
            yield* Prisma.EnvironmentVariable(`${key}-var`, {
              projectId,
              key,
              // The pointer: the platform env-var NAME the root bound the slot to.
              value: name,
              class: cls,
              ...branch,
            }),
          );
        }

        // ADR-0031: this node's own faceted inputs already got their edge's
        // key above, through the generic param loop — core's buildConfig
        // fills a provisioned param like any other, so there is no
        // consumer-side special case left to write here.

        // Provider side: a service that serves anything gets an accepted-keys
        // var, even with zero wired consumers — otherwise an unprovisioned
        // var reads as "no enforcement" (serve.ts's pass-through state) and a
        // zero-consumer RPC provider would accept every caller. A pure
        // consumer (no `expose`) never serves, so it gets no such var.
        if (svc.expose !== undefined && Object.keys(svc.expose).length > 0) {
          const inbound = serviceKeyEdges(graph).filter((e) => e.providerAddress === address);
          // `ctx.provisioned` is typed `unknown` — core forwards a provisioner's
          // ref without inspecting it. The filter only drops absent edges; the
          // shape of what survives is asserted, not checked.
          const keyOuts = inbound
            .map((e) => ctx.provisioned.get(e.edgeId))
            .filter((value) => value !== undefined)
            .map((value) =>
              blindCast<
                Output.Output<string>,
                "these refs are keyed by an edge serviceKeyEdges matched on RPC_PEER_KEY, and control.ts's serviceKeyProvisioner is the sole registrant of that brand — it returns a ServiceKey resource's `value`, an Output<string>"
              >(value),
            );
          // Zero consumers: no refs to resolve, so write the literal "[]"
          // directly rather than calling Output.all() with no arguments.
          const acceptedJson =
            keyOuts.length > 0
              ? Output.map(Output.all(...keyOuts), (vals) => JSON.stringify(vals))
              : JSON.stringify([]);
          const key = serviceKeyEnvName(address);
          records.push(
            yield* Prisma.EnvironmentVariable(`${key}-var`, {
              projectId,
              key,
              value: acceptedJson,
              class: cls,
              ...branch,
            }),
          );
        }

        // Provider side, streams' need (ADR-0031): its provisioner mints ONE
        // value per provider, so every inbound edge's ref is the same key —
        // land the first under the name the streams entrypoint reads. Unlike
        // RPC's accepted SET, the upstream server authenticates a single
        // API_KEY, which is exactly why the provisioner is per-provider.
        const inboundStreams = streamsApiKeyEdges(graph).filter(
          (e) => e.providerAddress === address,
        );
        const streamsRef = inboundStreams
          .map((e) => ctx.provisioned.get(e.edgeId))
          .find((value) => value !== undefined);
        if (streamsRef !== undefined) {
          const key = streamsApiKeyEnvName(address);
          records.push(
            yield* Prisma.EnvironmentVariable(`${key}-var`, {
              projectId,
              key,
              value: blindCast<
                Output.Output<string>,
                "the ref is keyed by an edge streamsApiKeyEdges matched on STREAMS_API_KEY, and control.ts's streamsApiKeyProvisioner is the sole registrant of that brand — it returns a ServiceKey resource's `value`, an Output<string>"
              >(streamsRef),
              class: cls,
              ...branch,
            }),
          );
        }

        // Carries the resolved port to deploy() via serialize's outputs; falls back to 3000 if unset.
        const port = typeof config.service['port'] === 'number' ? config.service['port'] : 3000;
        return { outputs: { environment: records, port } };
      }),

    // Deterministic tar.gz (fixed mtimes/ordering) so unchanged inputs hash
    // identically; the fs/tar work itself lives in @internal/lowering.
    package: ({ id }, { assembled, address }) =>
      Effect.try(() =>
        Prisma.packageComputeArtifact({
          id,
          bundleDir: assembled.dir,
          appEntry: assembled.entry,
          address,
        }),
      ),

    // The environment prop references serialize's env-var records, so the deploy depends on them.
    deploy: ({ id }, provisioned, artifact, serialized) =>
      Effect.gen(function* () {
        const deployment = yield* Prisma.Deployment(`${id}-deploy`, {
          computeServiceId: provisioned.outputs['serviceId'] as string,
          artifactPath: artifact.path,
          artifactHash: artifact.sha256,
          environment: serialized.outputs['environment'] as readonly Prisma.EnvironmentVariable[],
          // Route to the port the app actually binds (the service's `port`
          // param, resolved by serialize) — not a hardcoded constant.
          port: typeof serialized.outputs['port'] === 'number' ? serialized.outputs['port'] : 3000,
        });
        return {
          outputs: { url: deployment.deployedUrl, projectId: provisioned.outputs['projectId'] },
        };
      }),
  };
}
