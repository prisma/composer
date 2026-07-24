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
  type InputDocumentRow,
  paramEntries,
  serializeInput,
} from '../serializer.ts';
import {
  cloudApplicationOf,
  DEFAULT_REGION,
  projectIdOf,
  type ResolvedCloudOptions,
  validateName,
} from './shared.ts';

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
  /** The platform-assigned public origin domain — resolves to `undefined` only
   *  in the narrow provider-response gap the origin param's deploy-side value
   *  function enforces away (control.ts's `selfOriginValue`): every other
   *  reader may treat it as present. */
  readonly endpointDomain: Output.Output<string | undefined>;
}

/** compute's serialize → deploy handoff: the env-var rows deploy must depend on, the resolved port it routes to, and the serialized input document (when the service declares one) for the deploy report. */
export interface ComputeSerialized {
  readonly environment: readonly Prisma.EnvironmentVariable[];
  readonly port: number;
  readonly input?: InputDocumentRow;
}

/**
 * Returns the PRECISE descriptor type, not the erased `NodeDescriptor`: the
 * registry in control.ts erases it on assignment anyway (method bivariance),
 * but s3-store composes over these hooks and needs their P/S to stay visible.
 * Annotating this `NodeDescriptor` would force s3-store to cast them back.
 */
export function computeDescriptor(
  o: () => ResolvedCloudOptions,
): { readonly kind: 'service' } & ServiceLowering<ComputeProvisioned, ComputeSerialized> {
  return {
    kind: 'service' as const,
    // The service as a PLACE inside the application's Project: the App,
    // identity-bearing only, no code runs.
    provision: ({ id, application }) =>
      Effect.gen(function* () {
        validateName(id, 'service name (from provision id)');
        const projectId = projectIdOf(application);
        const branchId = cloudApplicationOf(application).branchId;
        const svc = yield* Prisma.ComputeService(`${id}-svc`, {
          projectId,
          name: id,
          region: o().region ?? DEFAULT_REGION,
          ...(branchId !== undefined ? { branchId } : {}),
        });
        return { serviceId: svc.id, projectId, endpointDomain: svc.endpointDomain };
      }),

    // Two channels of rows: PARAMS (reserved-param literals JSON-encoded;
    // dependency provisioning refs passed through, keeping their ordering
    // edge) and the INPUT document (one JSON row per service, secret leaves
    // as `$secret` pointers, never a value — ADR-0042). The class/branch
    // scope is identical for both.
    serialize: (ctx, provisioned, config) =>
      Effect.gen(function* () {
        const { address, node, graph } = ctx;
        const branchId = cloudApplicationOf(ctx.application).branchId;
        const cls = branchId ? ('preview' as const) : ('production' as const);
        const branch = branchId !== undefined ? { branchId } : {};
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

        const inputRow = serializeInput(
          svc,
          address,
          graph.inputBindings.find((b) => b.serviceAddress === address)?.binding,
        );
        if (inputRow !== undefined) {
          records.push(
            yield* Prisma.EnvironmentVariable(`${inputRow.key}-var`, {
              projectId,
              key: inputRow.key,
              // The defaults-applied document — secret leaves are `$secret`
              // pointers naming platform vars, never values (ADR-0042).
              value: inputRow.value,
              class: cls,
              ...branch,
            }),
          );
        }

        // ADR-0031: this node's own faceted inputs already got their edge's
        // key above, through the generic param loop — core's buildConfig
        // fills a provisioned param like any other, so there is no
        // consumer-side special case left to write here.

        // Provider side (ADR-0031). Compute never names a brand — it looks
        // one up. Two kinds of registered entries:
        //
        //  · Edge-derived (`value(refs)`) — driven by the PROVIDER, not by
        //    its edges: asked even with no inbound edge for that brand,
        //    because "no edges" and "no var" are not the same thing — an
        //    absent var reads as "never provisioned" (local dev, tests), so
        //    a deployed provider with zero wired consumers must still be
        //    able to emit a deny-everything value. Whether an empty set
        //    means deny-all or emit-nothing is that param's own call, so it
        //    may return undefined to write no row at all. The expose check
        //    is main's and stays for these: a service that exposes nothing
        //    can never be any binding's provider.
        //
        //  · Service-derived (`valueForService(provisioned, address)`) —
        //    derived from this service's OWN provisioned attributes (e.g.
        //    its origin), so EVERY compute service is asked, exposing or
        //    not; the expose check does not apply.
        const exposes = svc.expose !== undefined && Object.keys(svc.expose).length > 0;
        const refsByBrand = new Map<symbol, unknown[]>();
        if (exposes) {
          for (const edge of provisionedEdges(graph)) {
            if (edge.providerAddress !== address) continue;
            const ref = ctx.provisioned.get(edge.edgeId);
            if (ref === undefined) continue;
            const refs = refsByBrand.get(edge.brand) ?? [];
            refs.push(ref);
            refsByBrand.set(edge.brand, refs);
          }
        }
        for (const [brand, entry] of o().providerParams) {
          const raw =
            'valueForService' in entry
              ? entry.valueForService(provisioned, address)
              : exposes
                ? entry.value(refsByBrand.get(brand) ?? [])
                : undefined;
          if (raw === undefined) continue;
          const key = configKey(address, { owner: 'service', name: entry.name });
          // The value may still be an unresolved deploy-time Output (a
          // minted key or the provisioned endpoint domain isn't known until
          // Alchemy applies it) or already a plain value (e.g. a zero-refs
          // deny-all literal) — either way it is JSON-encoded through the
          // same `encode` a declared param's own literal takes, never a
          // brand-invented format.
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

        // Carries the resolved port to deploy(); falls back to 3000 if unset.
        // This is the only place the raw, untyped config is read, so it is the
        // only place the fallback belongs — from here on `port` is a number.
        const port = typeof config.service['port'] === 'number' ? config.service['port'] : 3000;
        return {
          environment: records,
          port,
          ...(inputRow !== undefined ? { input: inputRow } : {}),
        };
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
        //
        // The report's two lines of honesty (ADR-0042): the serialized input
        // document (secret-free by construction — every secret leaf is a
        // `$secret` pointer) and every binding key that resolved absent in
        // the deploy shell (a possible typo'd variable name). Newlines in a
        // detail value render as one line per entry.
        const inputDetails =
          serialized.input !== undefined
            ? {
                details: {
                  input: serialized.input.value,
                  ...(serialized.input.absent.length > 0
                    ? { absent: serialized.input.absent.join('\n') }
                    : {}),
                },
              }
            : {};
        return {
          outputs: { url: deployment.deployedUrl, projectId: provisioned.projectId },
          entities: [
            {
              kind: 'compute-service',
              id: provisioned.serviceId,
              url: deployment.deployedUrl,
              ...inputDetails,
            },
          ],
        };
      }),
  } satisfies { readonly kind: 'service' } & ServiceLowering<ComputeProvisioned, ComputeSerialized>;
}
