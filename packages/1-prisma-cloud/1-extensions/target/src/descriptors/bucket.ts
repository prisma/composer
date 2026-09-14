/** The `bucket` node kind's descriptor: one Prisma Object Store Bucket (plus its BucketAccessKey), provisioned before any consumer deploys. */

import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Output from 'alchemy/Output';
import * as Prisma from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import {
  cloudApplicationOf,
  projectIdOf,
  type ResolvedCloudOptions,
  validateName,
} from './shared.ts';

/**
 * One Bucket per module-provisioned bucket resource — `id` is the module
 * provision id, so a resource shared by several consumers is created exactly
 * once. A BucketAccessKey is minted for the bucket: it is the reveal-once
 * credential carrier, and its attributes (endpoint, bucketName, accessKeyId,
 * secretAccessKey) become the four S3Config outputs consumers resolve by name.
 */
export function bucketDescriptor(_o: () => ResolvedCloudOptions): NodeDescriptor {
  const lowering: Lowering = ({ id, application }) =>
    Effect.gen(function* () {
      validateName(id, 'resource name (from provision id)');
      const branchId = cloudApplicationOf(application).branchId;
      const bkt = yield* Prisma.Bucket(`${id}-bucket`, {
        project: projectIdOf(application),
        name: id,
        ...(branchId !== undefined ? { branchId } : {}),
      });
      // `name: id` matches what Composer's own resource always created, so a
      // migrated legacy row diffs clean instead of replacing the key (a
      // replacement would mint fresh credentials).
      const key = yield* Prisma.BucketAccessKey(`${id}-key`, {
        bucket: bkt.bucketId,
        name: id,
        role: 'read_write',
      });
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
