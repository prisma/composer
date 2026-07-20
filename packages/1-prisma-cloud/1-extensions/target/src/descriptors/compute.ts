/** The `compute` node kind's descriptor: the four service hooks — provision, serialize, package, deploy. */

import { isParamSource, type ServiceNode } from '@internal/core';
import type { ServiceLowering } from '@internal/core/deploy';
import * as Prisma from '@internal/lowering';
import * as Output from 'alchemy/Output';
import * as Effect from 'effect/Effect';
import { paramBindingFor, paramName } from '../param.ts';
import { provisionedEdges } from '../provisioned-edges.ts';
import {
  configKey,
  encode,
  encodeParamPointer,
  paramEntries,
  secretPointerRows,
} from '../serializer.ts';
import { DEFAULT_REGION, projectIdOf, type ResolvedCloudOptions, validateName } from './shared.ts';

/**
 * compute's provision → serialize/deploy handoff. `serviceId` is an
 * `Output<string>`, not a `string`: the whole stack effect runs before Alchemy
 * applies anything, so a yielded resource's attributes are lazy references
 * that only resolve at apply time. It reaches `Deployment`'s
 * `computeServiceId` unchanged — that prop takes `Input<string>`, which
 * accepts the reference. `projectId` really is a `string`: it comes from the
 * CLI's environment, not from a resource attribute.
 */
export interface ComputeProvisioned {
  readonly serviceId: Output.Output<string>;
  readonly projectId: string;
}

/** compute's serialize → deploy handoff: the env-var rows deploy must depend on, and the resolved port it routes to. */
export interface ComputeSerialized {
  readonly environment: readonly Prisma.EnvironmentVariable[];
  readonly port: number;
}

/**
 * Returns the PRECISE descriptor type, not the erased `NodeDescriptor`: the
 * registry in control.ts erases it on assignment anyway (method bivariance),
 * but s3-store composes over these hooks and needs their P/S to stay visible.
 * Annotating this `NodeDescriptor` would force s3-store to cast them back.
 */
export function computeDescriptor(
  o: ResolvedCloudOptions,
): { readonly kind: 'service' } & ServiceLowering<ComputeProvisioned, ComputeSerialized> {
  return {
    kind: 'service' as const,
    // The service as a PLACE inside the application's Project: the App,
    // identity-bearing only, no code runs.
    provision: ({ id, application }) =>
      Effect.gen(function* () {
        validateName(id, 'service name (from provision id)');
        const projectId = projectIdOf(application);
        const svc = yield* Prisma.ComputeService(`${id}-svc`, {
          projectId,
          name: id,
          region: o.region ?? DEFAULT_REGION,
          ...(o.branchId !== undefined ? { branchId: o.branchId } : {}),
        });
        return { serviceId: svc.id, projectId };
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
        const projectId = provisioned.projectId;
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

        // Provider side (ADR-0031). Driven by the PROVIDER, not by its edges:
        // every registered reserved provider param is asked, even when this
        // service has no inbound edge for that brand, because "no edges" and
        // "no var" are not the same thing — an absent var reads as "never
        // provisioned" (local dev, tests), so a deployed provider with zero
        // wired consumers must still be able to emit a deny-everything value.
        // Whether an empty set means deny-all or emit-nothing is that param's
        // own call, so it decides and may return undefined to write no row at
        // all. Compute never names a brand — it looks one up.
        //
        // The check is main's and stays: a service that exposes nothing can
        // never be any binding's provider, so it gets no provider param rows.
        if (svc.expose !== undefined && Object.keys(svc.expose).length > 0) {
          const refsByBrand = new Map<symbol, unknown[]>();
          for (const edge of provisionedEdges(graph)) {
            if (edge.providerAddress !== address) continue;
            const ref = ctx.provisioned.get(edge.edgeId);
            if (ref === undefined) continue;
            const refs = refsByBrand.get(edge.brand) ?? [];
            refs.push(ref);
            refsByBrand.set(edge.brand, refs);
          }
          for (const [brand, entry] of o.providerParams) {
            const raw = entry.value(refsByBrand.get(brand) ?? []);
            if (raw === undefined) continue;
            const key = configKey(address, { owner: 'service', name: entry.name });
            // The value may still be an unresolved deploy-time Output (a
            // minted key isn't known until Alchemy applies it) or already a
            // plain value (e.g. a zero-refs deny-all literal) — either way it
            // is JSON-encoded through the same `encode` a declared param's
            // own literal takes, never a brand-invented format.
            const value = Output.isOutput(raw)
              ? Output.map(raw, (v) => encode('service', v))
              : encode('service', raw);
            records.push(
              yield* Prisma.EnvironmentVariable(`${key}-var`, {
                projectId,
                key,
                value,
                class: cls,
                ...branch,
              }),
            );
          }
        }

        // Carries the resolved port to deploy(); falls back to 3000 if unset.
        // This is the only place the raw, untyped config is read, so it is the
        // only place the fallback belongs — from here on `port` is a number.
        const port = typeof config.service['port'] === 'number' ? config.service['port'] : 3000;
        return { environment: records, port };
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
          computeServiceId: provisioned.serviceId,
          artifactPath: artifact.path,
          artifactHash: artifact.sha256,
          environment: serialized.environment,
          // Route to the port the app actually binds (the service's `port`
          // param, resolved by serialize) — not a hardcoded constant.
          port: serialized.port,
        });
        // `url` IS published here: a Compute service's deployed URL is a
        // public endpoint, and this descriptor is the only party that knows
        // that. Both fields are still unresolved Output references at this
        // point — apply resolves them before the report's runner sees them.
        return {
          outputs: { url: deployment.deployedUrl, projectId: provisioned.projectId },
          entities: [
            {
              kind: 'compute-service',
              id: provisioned.serviceId,
              url: deployment.deployedUrl,
            },
          ],
        };
      }),
  } satisfies { readonly kind: 'service' } & ServiceLowering<ComputeProvisioned, ComputeSerialized>;
}
