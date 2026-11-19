// This module is intentionally pure. All npm/dist-tag I/O and filesystem
// reads live in the callers (`scripts/determine-version.ts`,
// `scripts/bump-minor.ts`); this file is reserved for deterministic
// helpers exercised under `node --test` from `pnpm test:scripts`.

const CANONICAL_BASE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parses a semver-shaped version string into its numeric components.
 * Tolerant of pre-release suffixes (`0.7.0-foo` parses the same as
 * `0.7.0`); strict on the leading `major.minor.patch` shape — anything
 * else returns NaN-bearing components.
 */
export function parseVersion(version: string): ParsedVersion {
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
  return { major, minor, patch };
}

/**
 * Given the current version, computes the next minor's zero-patch
 * form: `0.7.0` -> `0.8.0`, `1.2.5` -> `1.3.0`. Pure / deterministic.
 * Pre-release suffixes on the input are ignored (`0.7.0-foo` -> `0.8.0`).
 */
export function computeNextMinor(current: string): string {
  const { major, minor } = parseVersion(current);
  return `${major}.${minor + 1}.0`;
}

/**
 * Asserts that a base version is canonical (`major.minor.patch`, no
 * suffix). Used to fail-fast in the publish workflow if root
 * `package.json` was edited to something other than a clean release
 * shape — without this guard, a malformed root would compose nonsense
 * publish versions like `0.7.0-foo-dev.1`.
 */
export function assertCanonicalBase(base: string): void {
  if (!CANONICAL_BASE_PATTERN.test(base)) {
    throw new Error(
      `Base version "${base}" is not canonical major.minor.patch. ` +
        'The root package.json `version` must be a clean release shape (e.g. "0.7.0"); ' +
        'no pre-release suffixes are permitted on `main`.',
    );
  }
}

const DEV_VERSION_PATTERN = /^(\d+\.\d+\.\d+)-dev\.(\d+)$/;

/**
 * The next `<base>-dev.N` version: continues the counter when the
 * registry's `dev` tag is on the same base, otherwise starts at dev.1.
 */
export function nextDevVersion(base: string, latestDevTag: string | undefined): string {
  const match = latestDevTag?.match(DEV_VERSION_PATTERN);
  const buildNumber = match && match[1] === base ? Number.parseInt(match[2] as string, 10) + 1 : 1;
  return `${base}-dev.${buildNumber}`;
}

export type PreviousVersionLookup =
  | { available: true; version: string | undefined }
  | { available: false };

export interface PushPublishPlan {
  version: string;
  tag: 'latest' | 'dev';
  devVersion?: string;
}

/**
 * The publish plan for a push to `main`. A changed root version means
 * the push is a release bump: publish `<base>` under `latest`, plus a
 * `<base>-dev.N` follow-up so the `dev` dist-tag never falls behind
 * `latest`. An unchanged (or unreadable — a transient git error must
 * never silently promote to `latest`) previous version means the usual
 * dev-only publish.
 */
export function planPushPublish(
  base: string,
  previous: PreviousVersionLookup,
  latestDevTag: string | undefined,
): PushPublishPlan {
  const isReleaseBump = previous.available && previous.version !== base;
  if (isReleaseBump) {
    return { version: base, tag: 'latest', devVersion: nextDevVersion(base, latestDevTag) };
  }
  return { version: nextDevVersion(base, latestDevTag), tag: 'dev' };
}

const RELEASE_BRANCH_PATTERN = /^release\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.x$/;

/** The `major.minor` line a `release/<major>.<minor>.x` branch maintains, or `undefined` for any other branch. */
export function releaseLineOf(branch: string): string | undefined {
  const match = branch.match(RELEASE_BRANCH_PATTERN);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

export interface ReleaseLinePublishPlan {
  /** `false` when the push did not change the root version: nothing is published. */
  publish: boolean;
  version: string;
  /** `latest` when the patch supersedes the version `latest` is on; otherwise `release-<major>.<minor>`. */
  tag: string;
}

/**
 * The publish plan for a push to a `release/<major>.<minor>.x` branch,
 * which carries patch releases for an older line. Only a push that
 * changes the root version publishes, and it publishes that version as
 * is: release lines have no dev builds.
 *
 * A patch must never move `latest` backwards, so it publishes under the
 * line's own dist-tag, `release-<major>.<minor>`. The one exception is a
 * patch to the line `latest` is on (`0.39.1` while `latest` is `0.39.0`):
 * that patch becomes `latest`. A caret range (`^0.38.0`) picks the patch
 * up whatever its tag.
 */
export function planReleaseLinePublish(
  branch: string,
  base: string,
  previous: PreviousVersionLookup,
  latestTag: string | undefined,
): ReleaseLinePublishPlan {
  const line = releaseLineOf(branch);
  if (line === undefined) {
    throw new Error(
      `Branch "${branch}" is not a release branch. Release branches are named release/<major>.<minor>.x.`,
    );
  }
  const { major, minor, patch } = parseVersion(base);
  if (`${major}.${minor}` !== line) {
    throw new Error(
      `Root version ${base} is not on the ${line} line that ${branch} maintains. ` +
        `Set the root package.json version to ${line}.<patch>.`,
    );
  }
  const lineTag = `release-${line}`;
  const isReleaseBump = previous.available && previous.version !== base;
  if (!isReleaseBump) return { publish: false, version: base, tag: lineTag };

  const latest = latestTag === undefined ? undefined : parseVersion(latestTag);
  const supersedesLatest =
    latest !== undefined &&
    latest.major === major &&
    latest.minor === minor &&
    patch > latest.patch;
  return { publish: true, version: base, tag: supersedesLatest ? 'latest' : lineTag };
}
