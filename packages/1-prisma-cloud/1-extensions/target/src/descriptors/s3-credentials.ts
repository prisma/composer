/** The `credentials` node kind's descriptor: mint one stable SigV4 key pair per module-provisioned s3-credentials resource. */

import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Effect from 'effect/Effect';
import { S3Credentials } from '../s3-credentials-resource.ts';
import type { ResolvedCloudOptions } from './shared.ts';

/**
 * One `S3Credentials` resource per provisioned credentials node — `id` is the
 * module provision id, so a pair shared by the storage service is minted once
 * and kept stable across deploys (the resource's provider preserves it).
 * `_o` is unused today (the mint needs no region/project) but kept for symmetry
 * with the other descriptors' signature.
 */
export function s3CredentialsDescriptor(_o: ResolvedCloudOptions): NodeDescriptor {
  const lowering: Lowering = ({ id }) =>
    Effect.gen(function* () {
      const creds = yield* S3Credentials(`${id}-creds`, {});
      return {
        outputs: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      };
    });
  return Object.assign(lowering, { kind: 'resource' as const });
}
