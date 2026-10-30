/** The `bucket` node kind's descriptor: one Prisma Object Store Bucket (plus its BucketAccessKey), provisioned before any consumer deploys. */

import * as Prisma from '@alchemy.run/prisma';
import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Output from 'alchemy/Output';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { fromLegacyId, legacyNodeResourceId } from '../legacy-resource-ids.ts';
import { resourceId } from '../resource-ids.ts';
import {
  asOwnRow,
  cloudApplicationOf,
  logicalIdProp,
  projectIdOf,
  type ResolvedCloudOptions,
  validatePlatformName,
} from './shared.ts';

/**
 * One Bucket per module-provisioned bucket resource — `id` is the module
 * provision id, so a resource shared by several consumers is created exactly
 * once. A BucketAccessKey is minted for the bucket: it is the reveal-once
 * credential carrier, and its attributes (endpoint, bucketName, accessKeyId,
 * secretAccessKey) become the four S3Config outputs consumers resolve by name.
 */
export function bucketDescriptor(_o: () => ResolvedCloudOptions): NodeDescriptor {
  const lowering: Lowering = ({ address, application, graph }) =>
    Effect.gen(function* () {
      const app = graph.root.id;
      validatePlatformName('Bucket', address);
      const { branchId } = cloudApplicationOf(application);
      const bkt = yield* Prisma.Bucket(resourceId(address), {
        project: projectIdOf(application),
        name: address,
        ...(branchId !== undefined ? { branchId } : {}),
        ...logicalIdProp(application, address),
      }).pipe(asOwnRow, fromLegacyId(legacyNodeResourceId(app, address, 'bucket')));
      const key = yield* Prisma.BucketAccessKey(resourceId(address, 'accesskey'), {
        bucket: bkt.bucketId,
        name: address,
        role: 'read_write',
      }).pipe(fromLegacyId(legacyNodeResourceId(app, address, 'key')));
      const secretAccessKey = Output.map(key.secretAccessKey, (v) => Redacted.value(v));
      // No credentials on the entity: secret material must never reach an entity
      // (entities are rendered to a terminal). The outputs carry the full S3Config
      // so consumers' s3() dependency slots resolve by name.
      return {
        outputs: {
          url: key.endpoint,
          bucket: key.bucketName,
          accessKeyId: key.accessKeyId,
          secretAccessKey,
        },
        entities: [{ kind: 'bucket', id: bkt.bucketId }],
      };
    });
  return Object.assign(lowering, { kind: 'resource' as const });
}
