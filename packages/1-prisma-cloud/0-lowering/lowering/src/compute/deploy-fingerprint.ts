/**
 * The environment fingerprint that decides whether a deploy ships a NEW
 * deployment — the guarantee that a changed environment value reaches the
 * running app, without giving up reuse when nothing changed.
 *
 * The platform materializes environment rows into a deployment at create time
 * and never re-reads them (gotchas.md, PRO-211), so a changed value reaches the
 * running app only through a NEW deployment. Upstream's `Prisma.Deployment`
 * recreates only when a prop in its replacement block moves, and nothing an
 * `EnvironmentVariable` exposes can ride that block: values are write-only, and
 * the one attribute that moves at all (`updatedAt`) is not in the variable's
 * stables — with the row planned as an update every deploy (it re-applies
 * values to heal drift), a reference to it is an unresolved expression at plan
 * time, which collapses upstream's diff to a plain update and reintroduces the
 * silent artifact skip `appAfterEnvironment` closed.
 *
 * So the environment is folded into `artifactPath` instead: the canonical
 * content-addressed artifact is hard-linked into a sibling directory NAMED BY
 * A HASH OF THE ENVIRONMENT. Same environment and same artifact produce the
 * same path, so upstream reuses the deployment (noop/update); a changed value,
 * a rotated platform variable, or changed code produces a different path, and
 * upstream's resolved path comparison plans a replace.
 *
 * WHAT GOES INTO THE HASH — and what deliberately does not. Composer's env
 * rows carry secret POINTERS, not secret values (ADR-0042), so hashing a
 * row's stored text is leak-free for every row whose text is secret-free BY
 * CONSTRUCTION. The rows that are not — a minted generated value, a dependency
 * connection string, a minted service key — hand over no text at all: the
 * `withheld` entry variant has nowhere to put one. It contributes the row's
 * key and a description of what PRODUCES the row (its upstream resources), so
 * rewiring still moves the fingerprint while no secret byte, and no hash of
 * one, is ever computed. See `EnvFingerprintEntry`.
 *
 * Platform variables a row POINTS at are the operator's, not Composer's:
 * Composer never writes them, so an out-of-band rotation is invisible in the
 * row text. Each pointer therefore contributes the pointed variable's
 * `updatedAt` TIMESTAMP — metadata, never a value. A variable Composer itself
 * writes must never contribute its `updatedAt`: alchemy re-applies those rows
 * on every deploy, so their timestamp moves every deploy and would make the
 * fingerprint churn forever.
 *
 * WHAT A WITHHELD ROW CANNOT SEE — an accepted limit, not an oversight. A
 * withheld row's whole change signal is the set of upstream resources its
 * value is built from, so it moves when the row is wired to different
 * resources and stands still when the SAME resources hand back a DIFFERENT
 * value. Three flows can do that:
 *
 *   · a dependency connection rotated in place — the same Postgres resource
 *     issues new credentials, so the connection string changes under a stable
 *     resource name;
 *   · a provider param's key re-minted in place — a `ServiceKey`-backed value
 *     (rpc peer keys, streams API keys) re-issued for the same resource;
 *   · a generated param re-minted in place — `GeneratedParam` persists its
 *     value precisely so this does not normally happen, but a deliberate
 *     rotation of the stored value would not move the fingerprint either.
 *
 * In each case the new value is written to the env row, but the running
 * deployment keeps the value it materialized at create time until something
 * else moves the fingerprint (a code change, a rewiring, a config change) or
 * the deployment is replaced by hand.
 *
 * There is no cheap leak-free signal to close this with. The one thing that
 * always tracks such a change is the resolved VALUE, and hashing possibly-
 * secret resolved values into deploy state is forbidden here — salted or not.
 * The obvious non-secret stand-ins are not available either: the value is an
 * unresolved alchemy `Output` when this hash is computed (the path handed to
 * `Prisma.Deployment` must be a plain resolved string, or upstream's diff
 * collapses to a plain update — the same trap the top of this file describes),
 * so no attribute of the producing resource, including its own last-changed
 * time, can be read at this point. Closing it properly is upstream's
 * `redeployOn` seam below: alchemy resolves those inputs itself and diffs them
 * inside its own state, where a value that must not enter Composer's deploy
 * state is not Composer's to hold.
 *
 * `prisma-composer dev` has no platform behind it, so no pointer timestamp is
 * available; the lookup returns undefined for every name and that part of the
 * material is a constant. Nothing is lost: the local Deployment provider
 * reconciles unconditionally, so a dev converge restarts the app regardless.
 *
 * THE SEAM: upstream `Prisma.Deployment` gains `redeployOn` (inputs a
 * deployment must be recreated for); when the pinned alchemy version includes
 * it, replace this — pass the canonical `artifact.path` verbatim again and put
 * this fingerprint on `redeployOn`. The one call site is
 * `descriptors/compute.ts`'s deploy hook.
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
    .map((entry) => [
      entry.key,
      entry.value !== undefined ? ['value', entry.value] : ['withheld', entry.withheld],
      [...(entry.pointers ?? [])].sort().map((name) => [name, pointerUpdatedAt(name) ?? '?']),
    ])
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
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
    } catch {
      // A filesystem without hard links still gets the fingerprinted path.
      fs.copyFileSync(artifactPath, linked);
    }
  }
  return linked;
}
