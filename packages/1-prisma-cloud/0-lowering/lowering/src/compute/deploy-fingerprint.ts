/**
 * The environment is folded into `artifactPath`: the artifact is hard-linked
 * into a sibling directory named by a hash of the environment. The platform
 * materializes env rows into a deployment at create time and never re-reads
 * them (PRO-211), and nothing an `EnvironmentVariable` exposes can ride
 * upstream `Prisma.Deployment`'s replacement block — so a changed environment
 * must move `artifactPath` to ship a new deployment, and an unchanged one
 * must not, so the deployment is reused.
 *
 * No secret ever enters the hash: rows that are secret-free by construction
 * (ADR-0042 literals and pointers) contribute their text; every other row is
 * `withheld` and contributes only its key and what produces its value.
 * Platform variables a row points at (and Composer never writes) contribute
 * their `updatedAt`, so an out-of-band rotation redeploys. Accepted blind
 * spot: a value re-minted in place by the SAME resources does not move the
 * fingerprint — there is no leak-free signal for it at plan time.
 *
 * Replace this with upstream `Prisma.Deployment`'s `redeployOn` once the
 * pinned alchemy has it; the one call site is `descriptors/compute.ts`.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * One environment row's contribution to the fingerprint.
 *
 * `value` is the row's stored text, for rows that are secret-free by
 * construction (a JSON config literal, a pointer row naming a platform
 * variable, the input document — whose secret and generated leaves are
 * pointers). `withheld` is for every other row: it names what produces the
 * value (e.g. the upstream resources of an unresolved reference) and there is
 * no field a secret could be passed in, which is the point.
 *
 * `pointers` lists platform variables the row POINTS at and Composer never
 * writes — each contributes its `updatedAt` timestamp so an out-of-band
 * rotation forces a redeploy.
 */
export type EnvFingerprintEntry = {
  readonly key: string;
  readonly pointers?: readonly string[];
} & (
  | { readonly value: string; readonly withheld?: never }
  | { readonly withheld: string; readonly value?: never }
);

/** The pointed platform variable's `updatedAt`, or undefined when it is unknown (dev, or a name the deploy just provisioned). */
export type PointerUpdatedAt = (name: string) => string | undefined;

/**
 * The exact text the fingerprint hashes — exported so a test can assert what
 * is, and is not, in it. Entries are sorted by key so the row order the
 * serializer happens to produce cannot move the fingerprint.
 */
export function deployEnvFingerprintMaterial(
  entries: readonly EnvFingerprintEntry[],
  pointerUpdatedAt: PointerUpdatedAt,
): string {
  const rows = entries
    .map((entry) => ({
      key: entry.key,
      row: [
        entry.key,
        entry.value !== undefined ? ['value', entry.value] : ['withheld', entry.withheld],
        [...(entry.pointers ?? [])].sort().map((name) => [name, pointerUpdatedAt(name) ?? '?']),
      ],
    }))
    // Keys are unique per row (one env var each), so they are the whole order.
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((r) => r.row);
  return JSON.stringify(rows);
}

/** The environment fingerprint: a sha256 hex digest of `deployEnvFingerprintMaterial`. */
export function deployEnvFingerprint(
  entries: readonly EnvFingerprintEntry[],
  pointerUpdatedAt: PointerUpdatedAt,
): string {
  return crypto
    .createHash('sha256')
    .update(deployEnvFingerprintMaterial(entries, pointerUpdatedAt))
    .digest('hex');
}

/** How much of the digest names the directory — enough that two environments never collide in practice, short enough to read in a log line. */
const FINGERPRINT_PATH_LENGTH = 12;

/**
 * Hard-links `artifactPath` into a sibling `deploy-env-<fingerprint>`
 * directory and returns the link's path: same bytes, a path that moves if and
 * only if the environment moved. The canonical path is already
 * content-addressed, so a code change moves the parent directory and a
 * fingerprint change moves the child — either one is a new path, which is what
 * upstream plans a replace on. The empty path
 * (`packageComputeArtifact`'s destroy-run placeholder) passes through untouched.
 */
export function fingerprintedArtifactPath(artifactPath: string, fingerprint: string): string {
  if (artifactPath === '') return artifactPath;
  const dir = path.join(
    path.dirname(artifactPath),
    `deploy-env-${fingerprint.slice(0, FINGERPRINT_PATH_LENGTH)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  const linked = path.join(dir, path.basename(artifactPath));
  if (!fs.existsSync(linked)) {
    try {
      fs.linkSync(artifactPath, linked);
    } catch (error) {
      // A concurrent run linked it between the existsSync and here — same
      // bytes, nothing to do.
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        // A filesystem without hard links still gets the fingerprinted path.
        // Copy through a temp file and rename (same pattern as
        // packageComputeArtifact) so no reader ever sees a partial artifact.
        const tmp = `${linked}.tmp-${String(process.pid)}`;
        fs.copyFileSync(artifactPath, tmp);
        fs.renameSync(tmp, linked);
      }
    }
  }
  return linked;
}
