/** The `compute` node kind's descriptor: the four service hooks — provision, serialize, package, deploy — plus `reserve`, which stands in for the last two when the service runs a dev server (ADR-0056). */

import * as Prisma from '@alchemy.run/prisma';
import type { ServiceLowering } from '@internal/core/deploy';
import { describeDocument, type PlatformMarkerUse } from '@internal/input-document';
import { ARTIFACT_CONTENT_TYPE, appAfter, packageComputeArtifact } from '@internal/lowering';
import * as Output from 'alchemy/Output';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { configKey } from '../config-key.ts';
import { preflightView } from '../control/preflight-payload.ts';
import { GeneratedParam } from '../generated-param-resource.ts';
import {
  fromLegacyId,
  legacyGeneratedParamId,
  legacyNodeResourceId,
} from '../legacy-resource-ids.ts';
import { RESERVED_PROVIDER_PARAMS } from '../provider-params.ts';
import { provisionedEdges } from '../provisioned-edges.ts';
import { resourceId } from '../resource-ids.ts';
import { SentKeys } from '../sent-keys-resource.ts';
import { encode, type InputDocumentRow, paramEntries, serializeInput } from '../serializer.ts';
import {
  asOwnRow,
  cloudApplicationOf,
  logicalIdProp,
  projectIdOf,
  type ResolvedCloudOptions,
  SERVICE_VARIABLE_LIMIT,
  type ServiceProvisionedAttributes,
  validatePlatformName,
  variableClassAndBranch,
} from './shared.ts';

/** `compute({ listens: false })`, read structurally: the node may be a copy made by another bundle of this package, so `instanceof` cannot be relied on. */
function declaresNoListening(node: unknown): boolean {
  return typeof node === 'object' && node !== null && 'listens' in node && node.listens === false;
}

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
  /** The platform-assigned public origin domain. Read it through `endpointDomainOf`, which fails the deploy when the platform reported none. */
  readonly endpointDomain: Output.Output<string | undefined>;
}

/** A service variable's value: `Redacted` keeps it out of logs, though Alchemy writes it to deploy state in plain text. It may still be an unresolved deploy-time reference. */
export type ServiceVariableValue =
  | Redacted.Redacted<string>
  | Output.Output<Redacted.Redacted<string>>;

/** compute's serialize → deploy handoff. */
export interface ComputeSerialized {
  /** Every `COMPOSER_` key the service reads at boot, as its value or `null`. */
  readonly variables: Readonly<Record<string, ServiceVariableValue | null>>;
  /** What the deployment is created with: `variables`, plus `null` for every key an earlier deploy sent and this one does not. */
  readonly deploymentVariables: Output.Output<Record<string, Redacted.Redacted<string> | null>>;
  /** Platform variables the service reads and Composer does not write; each joins the triggers as `<name>:updatedAt`. */
  readonly platformVariables: readonly string[];
  readonly port: number;
  readonly input?: InputDocumentRow;
}

const envValue = (
  value: string | Output.Output<string>,
): Redacted.Redacted<string> | Output.Output<Redacted.Redacted<string>> =>
  Output.isOutput(value) ? Output.map(value, Redacted.make) : Redacted.make(value);

/** The value of a `serviceOrigin(target)` leaf: the target service's endpoint domain. */
function originOf(
  services: ReadonlyMap<string, unknown> | undefined,
  target: string,
  consumer: string,
): Output.Output<string> {
  const provisioned = services?.get(target);
  if (provisioned === undefined || !isComputeProvisioned(provisioned)) {
    const known =
      [...(services ?? [])]
        .filter(([, value]) => isComputeProvisioned(value))
        .map(([id]) => id)
        .join(', ') || '(none)';
    throw new Error(
      `service "${consumer}" binds serviceOrigin("${target}"), but no compute service has that ` +
        `address — known services: ${known}.`,
    );
  }
  return endpointDomainOf(
    provisioned,
    target,
    `cannot resolve serviceOrigin("${target}") for "${consumer}"`,
  );
}

export function endpointDomainOf(
  provisioned: ServiceProvisionedAttributes,
  address: string,
  consequence?: string,
): Output.Output<string> {
  return Output.map(provisioned.endpointDomain, (domain) => {
    if (domain === undefined) {
      throw new Error(
        `the App for "${address}" reported no endpoint domain${consequence === undefined ? '' : `: ${consequence}`}.`,
      );
    }
    return domain;
  });
}

function isComputeProvisioned(value: unknown): value is ComputeProvisioned {
  return typeof value === 'object' && value !== null && 'endpointDomain' in value;
}

function withRetiredKeysDeleted(
  variables: Readonly<Record<string, ServiceVariableValue | null>>,
  sent: Output.Output<readonly string[]>,
): Output.Output<Record<string, Redacted.Redacted<string> | null>> {
  const resolved: Record<string, Redacted.Redacted<string> | null> = {};
  const pending: Output.Output<readonly [string, Redacted.Redacted<string>]>[] = [];
  for (const [key, value] of Object.entries(variables)) {
    if (Output.isOutput(value)) pending.push(Output.map(value, (v) => [key, v] as const));
    else resolved[key] = value;
  }
  return Output.map(Output.all(sent, Output.all(...pending)), ([sentKeys, entries]) => ({
    ...Object.fromEntries(sentKeys.map((key) => [key, null])),
    ...resolved,
    ...Object.fromEntries(entries),
  }));
}

function checkServiceVariableCount(
  address: string,
  variables: Readonly<Record<string, ServiceVariableValue | null>>,
): void {
  const count = Object.values(variables).filter((value) => value !== null).length;
  if (count <= SERVICE_VARIABLE_LIMIT) return;
  throw new Error(
    `prisma-cloud: the service "${address}" needs ${count} variables, but Prisma Cloud stores at ` +
      `most ${SERVICE_VARIABLE_LIMIT} on one service. Split the service, or give it fewer ` +
      'dependencies or generated values.',
  );
}

const sortedMarkerNames = (markers: readonly PlatformMarkerUse[]): string[] =>
  [...new Set(markers.map((marker) => marker.name))].sort();

function inputDetails(serialized: ComputeSerialized): {
  readonly details?: Readonly<Record<string, string>>;
} {
  if (serialized.input === undefined) return {};
  return {
    details: {
      input: describeDocument(JSON.parse(serialized.input.value)),
      ...(serialized.input.absent.length > 0 ? { absent: serialized.input.absent.join('\n') } : {}),
    },
  };
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
    provision: ({ address, application, graph }) =>
      Effect.gen(function* () {
        const app = graph.root.id;
        validatePlatformName('App', address);
        const projectId = projectIdOf(application);
        const { branchId } = cloudApplicationOf(application);
        const svc = yield* Prisma.App(resourceId(address), {
          project: projectId,
          displayName: address,
          ...(o().region !== undefined ? { regionId: o().region } : {}),
          ...(branchId !== undefined ? { branchId } : {}),
          ...logicalIdProp(application, address),
        }).pipe(asOwnRow, fromLegacyId(legacyNodeResourceId(app, address, 'svc')));
        return { serviceId: svc.appId, projectId, endpointDomain: svc.appEndpointDomain };
      }),

    serialize: (ctx, provisioned, config) =>
      Effect.gen(function* () {
        const { address, node, graph } = ctx;
        const app = graph.root.id;
        if (node.kind !== 'service') {
          throw new Error(`prisma-cloud: cannot serialize non-service node "${address}".`);
        }
        const svc = node;
        // A key left out keeps the value an earlier deploy stored on the service, so every key boot reads is sent, as `null` when it has no value.
        const variables: Record<string, ServiceVariableValue | null> = {};

        for (const d of paramEntries(svc)) {
          const value =
            d.owner === 'service' ? config.service[d.name] : config.inputs[d.owner.input]?.[d.name];
          variables[configKey(address, d)] =
            value === undefined ? null : envValue(encode(d.owner, value));
        }

        const inputRow = serializeInput(
          svc,
          address,
          graph.inputBindings.find((b) => b.serviceAddress === address)?.binding,
          { absentVariables: preflightView(ctx.preflight).absentVariables },
        );
        for (const leaf of inputRow?.generated ?? []) {
          // References the target's App, not its Deployment, so its consumers form no cycle.
          const value =
            leaf.origin !== undefined
              ? originOf(ctx.services, leaf.origin, address)
              : (yield* GeneratedParam(resourceId(address, 'generated', leaf.path), {
                  bytes: leaf.bytes,
                }).pipe(fromLegacyId(legacyGeneratedParamId(app, address, leaf.path)))).value;
          variables[leaf.varName] = envValue(value);
        }

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
        //    may return undefined to send `null`. The expose check is
        //    main's and stays for these: a service that exposes nothing
        //    can never be any binding's provider.
        //
        //  · Service-derived (`valueForService(provisioned, address)`) —
        //    derived from this service's OWN provisioned attributes (e.g.
        //    its origin), so EVERY compute service is asked, exposing or
        //    not; the expose check does not apply.
        for (const entry of RESERVED_PROVIDER_PARAMS) {
          variables[configKey(address, { owner: 'service', name: entry.name })] = null;
        }
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
          // JSON-encoded through the same `encode` a declared param's own literal takes, never a brand-invented format.
          const value = Output.isOutput(raw)
            ? Output.map(raw, (v) => encode('service', v))
            : encode('service', raw);
          variables[configKey(address, { owner: 'service', name: entry.name })] = envValue(value);
        }

        checkServiceVariableCount(address, variables);
        const sent = yield* SentKeys(resourceId(address, 'sent-keys'), {
          keys: Object.keys(variables).sort(),
        });

        // Carries the resolved port to deploy(); falls back to 3000 if unset.
        // This is the only place the raw, untyped config is read, so it is the
        // only place the fallback belongs — from here on `port` is a number.
        const port = typeof config.service['port'] === 'number' ? config.service['port'] : 3000;
        return {
          variables,
          deploymentVariables: withRetiredKeysDeleted(variables, sent.keys),
          platformVariables: inputRow !== undefined ? sortedMarkerNames(inputRow.markers) : [],
          port,
          ...(inputRow !== undefined ? { input: inputRow } : {}),
        };
      }),

    // Deterministic tar.gz (fixed mtimes/ordering) so unchanged inputs hash
    // identically; the fs/tar work itself lives in @internal/lowering.
    package: ({ id, node }, { assembled, address }, serialized) =>
      Effect.try(() =>
        packageComputeArtifact({
          id,
          bundleDir: assembled.dir,
          appEntry: assembled.entry,
          address,
          ...(declaresNoListening(node) ? { listens: false } : {}),
          ...(serialized.input !== undefined
            ? { inputDocument: JSON.parse(serialized.input.value) }
            : {}),
        }),
      ),

    deploy: ({ id, address, graph, lowered, preflight }, provisioned, artifact, serialized) =>
      Effect.gen(function* () {
        // Only to order this deployment after its producers are live; their values reach it through `variables`.
        const producerOutputs = graph.edges
          .filter((edge) => edge.kind === 'dependency' && edge.to === id)
          .flatMap((edge) => Object.values(lowered.get(edge.from) ?? {}))
          .filter(Output.isOutput);
        const { platformVariableVersion } = preflightView(preflight);
        // The member name is historical: under `prisma dev` it holds an HMAC
        // of the value, and renaming it would redeploy every hosted
        // deployment once.
        const triggers = Object.fromEntries(
          serialized.platformVariables.map((name) => [
            `${name}:updatedAt`,
            platformVariableVersion(name) ?? '?',
          ]),
        );
        const app = graph.root.id;
        const deployment = yield* Prisma.Deployment(resourceId(address, 'deployment'), {
          // `app` carries the ordering edges as well as the app id — see
          // `appAfter` for why it is the only prop that can.
          app: appAfter(provisioned.serviceId, producerOutputs),
          artifactPath: artifact.path,
          // The artifact IS a gzipped tar (see @internal/lowering's packager);
          // upstream sends this as the upload's Content-Type and folds it into
          // the fingerprint that decides whether a new deployment is needed.
          artifactContentType: ARTIFACT_CONTENT_TYPE,
          // A changed platform variable replaces the deployment: the platform
          // copies variables into a deployment only when it is created.
          triggers,
          variables: serialized.deploymentVariables,
          // Route to the port the app actually binds (the service's `port`
          // param, resolved by serialize) — not a hardcoded constant.
          portMapping: { http: serialized.port },
          // A Composer deploy always ships: upload the artifact, wait for it
          // to run, then move the app's stable endpoint onto it. Neither is
          // configurable — "deployed but not serving" is not a state Composer
          // expresses.
          start: true,
          promote: true,
        }).pipe(fromLegacyId(legacyNodeResourceId(app, address, 'deploy')));
        const url = endpointDomainOf(provisioned, address);
        return {
          outputs: {
            // The App's domain, not the deployment's: the deployment's is unknown while planning, so every consumer of this url would get a new deployment.
            url,
            projectId: provisioned.projectId,
            // From the deployment, so it resolves once this service is live: a custom domain binds to the live version, and its consumers' deployments wait for it.
            serviceId: deployment.appId,
          },
          entities: [
            {
              kind: 'compute-service',
              id: provisioned.serviceId,
              url,
              ...inputDetails(serialized),
            },
          ],
        };
      }),

    // ADR-0056: a service that runs its build adapter's dev server under
    // `prisma dev` has no artifact and no deployment to carry its variables,
    // so its values and its input document are local rows, read by the dev
    // server.
    reserve: ({ address, application }, provisioned, serialized) =>
      Effect.gen(function* () {
        if (!cloudApplicationOf(application).branchless) {
          throw new Error(
            `prisma-cloud: the dev server of "${address}" was reserved outside \`prisma dev\`. ` +
              'Variable rows are written only to the local application; this is a bug in Composer.',
          );
        }
        const rows: Record<string, ServiceVariableValue> = {};
        for (const [key, value] of Object.entries(serialized.variables)) {
          if (value !== null) rows[key] = value;
        }
        if (serialized.input !== undefined) {
          rows[serialized.input.key] = envValue(serialized.input.value);
        }
        for (const [key, value] of Object.entries(rows)) {
          yield* Prisma.EnvironmentVariable(resourceId(address, 'env', key), {
            project: provisioned.projectId,
            key,
            value,
            ...variableClassAndBranch(application),
          });
        }
        const url = endpointDomainOf(provisioned, address);
        return {
          outputs: { url, projectId: provisioned.projectId, serviceId: provisioned.serviceId },
          entities: [
            {
              kind: 'compute-service',
              id: provisioned.serviceId,
              url,
              ...inputDetails(serialized),
            },
          ],
        };
      }),
  } satisfies { readonly kind: 'service' } & ServiceLowering<ComputeProvisioned, ComputeSerialized>;
}
