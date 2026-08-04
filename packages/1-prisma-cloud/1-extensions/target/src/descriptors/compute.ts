/** The `compute` node kind's descriptor: the four service hooks — provision, serialize, package, deploy. */

import { isParamSource, type ServiceNode } from '@internal/core';
import type { ServiceLowering } from '@internal/core/deploy';
import {
  appAfterEnvironment,
  deployEnvFingerprint,
  type EnvFingerprintEntry,
  fingerprintedArtifactPath,
  packageComputeArtifact,
} from '@internal/lowering';
import * as Output from 'alchemy/Output';
import * as Prisma from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { GeneratedParam } from '../generated-param-resource.ts';
import { paramBindingFor, paramName } from '../param.ts';
import { provisionedEdges } from '../provisioned-edges.ts';
import {
  configKey,
  decodeParamPointer,
  encode,
  encodeParamPointer,
  type InputDocumentRow,
  isParamPointerRow,
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
 * that only resolve at apply time. It reaches `Deployment`'s `app` prop
 * unchanged — that prop takes `Input<string | App>`, which accepts the
 * reference. `projectId` really is a `string`: it comes from the CLI's
 * environment, not from a resource attribute.
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

/** compute's serialize → deploy handoff: the env-var rows deploy must depend on, one fingerprint entry per row, the resolved port it routes to, and the serialized input document (when the service declares one) for the deploy report. */
export interface ComputeSerialized {
  readonly environment: readonly Prisma.EnvironmentVariable[];
  /** What the deploy hook fingerprints the environment by — one entry per row of `environment`, in the same order. */
  readonly envFingerprint: readonly EnvFingerprintEntry[];
  readonly port: number;
  readonly input?: InputDocumentRow;
}

/**
 * Every env-var value goes to the platform wrapped in `Redacted`: the
 * Management API never reads a value back, so alchemy persists the desired one
 * in state to repair drift, and `Redacted` is what keeps it out of the
 * serialized state row. A value that is still an unresolved deploy-time
 * reference is wrapped inside the map, at the same point it becomes a string.
 */
const envValue = (
  value: string | Output.Output<string>,
): Redacted.Redacted<string> | Output.Output<Redacted.Redacted<string>> =>
  Output.isOutput(value) ? Output.map(value, Redacted.make) : Redacted.make(value);

/**
 * The fingerprint stand-in for a row whose text this descriptor must NOT hash:
 * `kind` says which channel the row came from, and the sorted names of the
 * resources the value is built from say what produces it, so rewiring the row
 * to a different resource moves the fingerprint. `Output.upstreamAny` is the
 * same walker Alchemy builds its dependency graph with, so the names are the
 * planner's own — no guessing at what a reference points to.
 */
const withheldSource = (kind: string, value: unknown): string =>
  `${kind}:${Object.keys(Output.upstreamAny(value)).sort().join(',')}`;

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
        const svc = yield* Prisma.App(`${id}-svc`, {
          project: projectId,
          displayName: id,
          regionId: o().region ?? DEFAULT_REGION,
          ...(branchId !== undefined ? { branchId } : {}),
        });
        return { serviceId: svc.appId, projectId, endpointDomain: svc.appEndpointDomain };
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
        // One entry per row, appended in step with `records`. Every entry that
        // carries text carries text that is secret-free BY CONSTRUCTION; the
        // rest are `withheld` and have nowhere to put a value — see
        // `deploy-fingerprint.ts`.
        const fingerprint: EnvFingerprintEntry[] = [];

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
              project: projectId,
              key,
              value: envValue(rowValue),
              class: cls,
              ...branch,
            }),
          );
          // A service's OWN param is config, never a secret (a secret reaches
          // a service only through the input document, ADR-0042), so its row
          // text is hashed as-is — a literal is JSON, a pointer row is the
          // platform NAME it points at, and that name's rotation timestamp
          // joins the fingerprint through `pointers`. A dependency input's
          // value is a provisioning ref: a connection string or a minted
          // per-binding token, so its text is withheld.
          if (d.owner === 'service') {
            const pointer = isParamPointerRow(rowValue) ? decodeParamPointer(rowValue) : undefined;
            fingerprint.push({
              key,
              value: rowValue,
              ...(pointer !== undefined ? { pointers: [pointer] } : {}),
            });
          } else {
            fingerprint.push({ key, withheld: withheldSource(`input.${d.owner.input}`, value) });
          }
        }

        const inputRow = serializeInput(
          svc,
          address,
          graph.inputBindings.find((b) => b.serviceAddress === address)?.binding,
        );
        if (inputRow !== undefined) {
          records.push(
            yield* Prisma.EnvironmentVariable(`${inputRow.key}-var`, {
              project: projectId,
              key: inputRow.key,
              // The defaults-applied document — secret leaves are `$secret`
              // pointers, generated leaves are `$generated` pointers, naming
              // platform vars, never values (ADR-0042).
              value: envValue(inputRow.value),
              class: cls,
              ...branch,
            }),
          );
          // The document itself is secret-free by construction, so it is
          // hashed verbatim; each `$secret` pointer names an OPERATOR-owned
          // platform variable Composer never writes, so its rotation shows up
          // only as that variable's `updatedAt`.
          fingerprint.push({
            key: inputRow.key,
            value: inputRow.value,
            pointers: inputRow.secrets,
          });
          // Each generated leaf: generate its value ONCE (the resource keeps it
          // stable across redeploys via its persisted output) and provision it
          // under the framework var the document's `$generated` pointer names.
          // The resource id is stable per service+leaf so reconcile finds the
          // existing value instead of regenerating.
          for (const leaf of inputRow.generated) {
            const resource = yield* GeneratedParam(`${inputRow.key}:${leaf.path}-generated`, {
              bytes: leaf.bytes,
            });
            records.push(
              yield* Prisma.EnvironmentVariable(`${leaf.varName}-var`, {
                project: projectId,
                key: leaf.varName,
                value: envValue(resource.value),
                class: cls,
                ...branch,
              }),
            );
            // A minted random value — withheld. Its `updatedAt` is no signal
            // either: Composer writes this row on every deploy, so the
            // timestamp would move every deploy. The value is stable by
            // construction (`GeneratedParam` persists it), and the document's
            // `$generated` pointer — already hashed above — carries the leaf's
            // name and its redacted facet.
            fingerprint.push({
              key: leaf.varName,
              withheld: `generated:${String(leaf.bytes)}:${String(leaf.redacted)}`,
            });
          }
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
              project: projectId,
              key,
              value: envValue(value),
              class: cls,
              ...branch,
            }),
          );
          // A provider param's value may be a minted key (rpc, streams), so
          // every one is withheld regardless of the brand — this descriptor is
          // brand-blind and must not have to know which brands mint secrets.
          // Wiring a consumer in or out changes the resources the value is
          // built from, which is what moves the fingerprint.
          fingerprint.push({ key, withheld: withheldSource(`provider.${entry.name}`, raw) });
        }

        // Carries the resolved port to deploy(); falls back to 3000 if unset.
        // This is the only place the raw, untyped config is read, so it is the
        // only place the fallback belongs — from here on `port` is a number.
        const port = typeof config.service['port'] === 'number' ? config.service['port'] : 3000;
        return {
          environment: records,
          envFingerprint: fingerprint,
          port,
          ...(inputRow !== undefined ? { input: inputRow } : {}),
        };
      }),

    // Deterministic tar.gz (fixed mtimes/ordering) so unchanged inputs hash
    // identically; the fs/tar work itself lives in @internal/lowering.
    package: ({ id }, { assembled, address }) =>
      Effect.try(() =>
        packageComputeArtifact({
          id,
          bundleDir: assembled.dir,
          appEntry: assembled.entry,
          address,
        }),
      ),

    deploy: ({ id }, provisioned, artifact, serialized) =>
      Effect.gen(function* () {
        // Answers "unknown" for every name under `prisma-composer dev`: dev runs
        // no platform preflight, so no rotation timestamps exist. That costs
        // nothing — the local Deployment provider reconciles unconditionally.
        const pointerUpdatedAt = o().pointerUpdatedAt;
        const deployment = yield* Prisma.Deployment(`${id}-deploy`, {
          // `app` carries the ordering edge on serialize's variable writes as
          // well as the app id — see `appAfterEnvironment` for why it is the
          // only prop that can (PRO-211).
          app: appAfterEnvironment(provisioned.serviceId, serialized.environment),
          // The SAME bytes under a path named by a hash of this service's
          // environment, so upstream plans a replace exactly when the
          // environment (or the code) moved and reuses the deployment
          // otherwise — see `deploy-fingerprint.ts` for what the hash covers,
          // why no secret reaches it, and the hand-off to upstream's
          // `redeployOn`.
          artifactPath: fingerprintedArtifactPath(
            artifact.path,
            deployEnvFingerprint(serialized.envFingerprint, pointerUpdatedAt),
          ),
          // The artifact IS a gzipped tar (see @internal/lowering's packager);
          // upstream sends this as the upload's Content-Type and folds it into
          // the fingerprint that decides whether a new deployment is needed.
          artifactContentType: 'application/gzip',
          // Route to the port the app actually binds (the service's `port`
          // param, resolved by serialize) — not a hardcoded constant.
          portMapping: { http: serialized.port },
          // A Composer deploy always ships: upload the artifact, wait for it
          // to run, then move the app's stable endpoint onto it. Neither is
          // configurable — "deployed but not serving" is not a state Composer
          // expresses.
          start: true,
          promote: true,
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
          outputs: { url: deployment.appEndpointDomain, projectId: provisioned.projectId },
          entities: [
            {
              kind: 'compute-service',
              id: provisioned.serviceId,
              url: deployment.appEndpointDomain,
              ...inputDetails,
            },
          ],
        };
      }),
  } satisfies { readonly kind: 'service' } & ServiceLowering<ComputeProvisioned, ComputeSerialized>;
}
