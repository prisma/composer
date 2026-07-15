/**
 * The `streams` node kind's descriptor: compute's service lowering with
 * EXTENDED deploy outputs (the s3-store shape). provision/package are
 * compute's unchanged; serialize and deploy delegate to compute's then surface
 * the consumer-visible `apiKey` — from the wired `bearer-key` resource
 * (reachable in the built Config as `inputs.credentials`). A consumer wiring
 * the `streams` port into a `durableStreams()` slot resolves `url` and
 * `apiKey` by NAME from these outputs.
 */

import type { NodeDescriptor } from '@internal/core/config';
import * as Effect from 'effect/Effect';
import { computeDescriptor } from './compute.ts';
import type { ResolvedCloudOptions } from './shared.ts';

export function streamsDescriptor(o: ResolvedCloudOptions): NodeDescriptor {
  const base = computeDescriptor(o);
  if (base.kind !== 'service') {
    throw new Error('computeDescriptor must be a service descriptor');
  }

  return {
    kind: 'service' as const,
    provision: base.provision,
    package: base.package,

    // compute's env-var writes stay unchanged (the streams service reads the
    // store and credentials through them); we additionally surface the apiKey
    // so deploy can hand it to consumers through the binding.
    serialize: (ctx, provisioned, config) =>
      Effect.gen(function* () {
        const serialized = yield* base.serialize(ctx, provisioned, config);
        const credentials = config.inputs['credentials'] ?? {};
        const apiKey = credentials['apiKey'];
        // The naming contract with the streams module: it must wire a
        // `credentials` dependency (the minted bearer key). Missing means a
        // deployed server whose key nobody holds — fail the deploy instead.
        if (apiKey === undefined) {
          throw new Error("streams service must wire a 'credentials' dependency (bearer-key)");
        }
        return { outputs: { ...serialized.outputs, apiKey } };
      }),

    deploy: (ctx, provisioned, artifact, serialized) =>
      Effect.gen(function* () {
        const deployed = yield* base.deploy(ctx, provisioned, artifact, serialized);
        return { outputs: { ...deployed.outputs, apiKey: serialized.outputs['apiKey'] } };
      }),
  };
}
