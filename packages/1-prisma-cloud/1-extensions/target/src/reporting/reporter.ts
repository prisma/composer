/**
 * This extension's deploy-run reporter: the session itself lives in
 * `@internal/lowering/builds`, which may read git and the deploy shell —
 * this package may do neither (invariants 4 and 5). All that is left here is
 * the one thing the lowering side cannot know: how to read this extension's
 * own container.
 */
import type { ReporterDescriptor } from '@internal/core/config';
import * as Builds from '@internal/lowering/builds';
import { prismaCloudContainerOf } from '../container.ts';

export function prismaCloudReporter(): ReporterDescriptor {
  return Builds.buildReporter({
    refsOf: (container) => {
      const { projectId, branchId, defaultBranchId } = prismaCloudContainerOf(container);
      // The Build references only a NAMED stage's Branch; the topology lives
      // on whichever Branch the deploy targets — the default one included.
      return { projectId, branchId, stageBranchId: branchId ?? defaultBranchId };
    },
  });
}
