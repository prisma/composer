/**
 * Every deploy ships a fresh deployment — the guarantee that a changed
 * environment value always reaches the running app.
 *
 * The platform materializes environment rows into a deployment at create time
 * and never re-reads them (gotchas.md, PRO-211), so a value change reaches the
 * running app only through a NEW deployment. Upstream's `Prisma.Deployment`
 * recreates only when a prop in its replacement block moves, and nothing an
 * `EnvironmentVariable` exposes can ride that block: values are write-only,
 * and the one attribute that moves at all (`updatedAt`) is not in the
 * variable's stables — with the row planned as an update every deploy (it
 * re-applies values to heal drift), a reference to it is an unresolved
 * expression at plan time, which collapses upstream's diff to a plain update
 * and reintroduces the silent artifact skip `appAfterEnvironment` closed.
 *
 * So the deployment is made to replace on EVERY deploy instead, by handing
 * upstream a fresh `artifactPath` each deploy run: the canonical
 * content-addressed artifact is hard-linked into a `deploy-<generation>`
 * directory beside it, where the generation is minted once per process — one
 * deploy run is one process, so every run's path differs from the last and
 * upstream's resolved path comparison plans a replace. Same bytes, new path,
 * no secret material anywhere near state. The cost is deliberate: the reuse
 * upstream's fingerprinting was built to save is given up, and an unchanged
 * service replaces (create, start, promote, delete old) rather than noops.
 *
 * The dev watch loop is untouched in practice: one session is one process, so
 * the path is stable across converges, and the local Deployment provider
 * reconciles unconditionally anyway.
 *
 * THE SEAM: upstream `Prisma.Deployment` gains `redeployOn` (inputs a
 * deployment must be recreated for); when the pinned alchemy version includes
 * it, replace this — pass the canonical `artifact.path` verbatim again and
 * put the environment rows on `redeployOn`. The one call site is
 * `descriptors/compute.ts`'s deploy hook.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Minted once per process: a deploy run is one process. */
const DEPLOY_GENERATION = `${String(Date.now())}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Hard-links `artifactPath` into a sibling `deploy-<generation>` directory and
 * returns the link's path — same bytes, a path no previous deploy run used.
 * The empty path (`packageComputeArtifact`'s destroy-run placeholder) passes
 * through untouched. `generation` is overridable for tests only.
 */
export function alwaysRedeployArtifactPath(
  artifactPath: string,
  generation: string = DEPLOY_GENERATION,
): string {
  if (artifactPath === '') return artifactPath;
  const generationDir = path.join(path.dirname(artifactPath), `deploy-${generation}`);
  fs.mkdirSync(generationDir, { recursive: true });
  const generationPath = path.join(generationDir, path.basename(artifactPath));
  if (!fs.existsSync(generationPath)) {
    try {
      fs.linkSync(artifactPath, generationPath);
    } catch {
      // A filesystem without hard links still gets the fresh path.
      fs.copyFileSync(artifactPath, generationPath);
    }
  }
  return generationPath;
}
