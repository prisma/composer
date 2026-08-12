/**
 * Who is deploying, and from what commit — the identity a build is reported
 * under.
 *
 * `commitSha` and `branchName` are required by the platform, and Composer has
 * no other reason to read git, so this is the only place it does. A deploy
 * from a directory that is not a git checkout has neither, and is reported
 * not at all rather than reported with placeholder values: the Console keeps
 * whatever it is told, and "unknown" would sit in a workspace's deploy
 * history permanently.
 */
import { execFileSync } from 'node:child_process';
import type { BuildRunIdentity, BuildSource } from './api.ts';

export interface RunIdentity {
  readonly source: BuildSource;
  readonly commitSha: string;
  readonly branchName: string;
  /** Present only in a CI run this can name; what makes creation idempotent and links the build to its repository. */
  readonly runIdentity: BuildRunIdentity | undefined;
  /** Where the run's own logs live, in the system that ran it. */
  readonly externalLogUrl: string | undefined;
}

/** Environment this reads, narrowed to what it uses. */
export type RunEnvironment = Readonly<Record<string, string | undefined>>;

const DIGITS = /^[0-9]+$/;

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

function git(args: readonly string[], cwd: string): string | undefined {
  try {
    const out = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return nonEmpty(out.trim());
  } catch {
    // Not a checkout, no git on PATH, or a repository with no commits yet.
    return undefined;
  }
}

/**
 * The GitHub Actions run this is executing inside, when all three parts are
 * present and are the digits the platform's dedup key requires. Partial or
 * malformed input yields nothing rather than half an identity: the key joins
 * its parts with `:`, so a part that is not digits could let two different
 * runs spell the same key.
 */
function githubRunIdentity(env: RunEnvironment): BuildRunIdentity | undefined {
  if (env['GITHUB_ACTIONS'] !== 'true') return undefined;

  const repositoryId = nonEmpty(env['GITHUB_REPOSITORY_ID']);
  const runId = nonEmpty(env['GITHUB_RUN_ID']);
  const attempt = nonEmpty(env['GITHUB_RUN_ATTEMPT']) ?? '1';

  if (repositoryId === undefined || !DIGITS.test(repositoryId)) return undefined;
  if (runId === undefined || !DIGITS.test(runId)) return undefined;
  if (!DIGITS.test(attempt)) return undefined;

  const runAttempt = Number.parseInt(attempt, 10);
  if (!Number.isInteger(runAttempt) || runAttempt < 1) return undefined;

  return { provider: 'github', repositoryId, runId, runAttempt };
}

function githubRunUrl(env: RunEnvironment): string | undefined {
  const server = nonEmpty(env['GITHUB_SERVER_URL']) ?? 'https://github.com';
  const repository = nonEmpty(env['GITHUB_REPOSITORY']);
  const runId = nonEmpty(env['GITHUB_RUN_ID']);
  if (repository === undefined || runId === undefined) return undefined;
  const attempt = nonEmpty(env['GITHUB_RUN_ATTEMPT']) ?? '1';
  return `${server}/${repository}/actions/runs/${runId}/attempts/${attempt}`;
}

/**
 * The branch this ran on. Inside a pull-request workflow `GITHUB_REF_NAME` is
 * the synthetic merge ref (`123/merge`), so the head branch is preferred —
 * it is the name a person would recognise in the Console.
 */
function branchName(env: RunEnvironment, cwd: string): string | undefined {
  const fromEnv = nonEmpty(env['GITHUB_HEAD_REF']) ?? nonEmpty(env['GITHUB_REF_NAME']);
  if (fromEnv !== undefined) return fromEnv;
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  // A detached HEAD reports "HEAD", which names no branch.
  return head === 'HEAD' ? undefined : head;
}

/**
 * The identity to report this run under, or `undefined` when there is not
 * enough to report one honestly.
 */
export function resolveRunIdentity(cwd: string, env: RunEnvironment): RunIdentity | undefined {
  const commitSha = nonEmpty(env['GITHUB_SHA']) ?? git(['rev-parse', 'HEAD'], cwd);
  const branch = branchName(env, cwd);
  if (commitSha === undefined || branch === undefined) return undefined;

  const runIdentity = githubRunIdentity(env);
  return {
    // `ci` whenever the run can be named, `cli` otherwise. A named run is
    // what buys idempotency across retries and links the build to its
    // repository, so claiming `ci` without one would describe the run less
    // accurately, not more.
    source: runIdentity === undefined ? 'cli' : 'ci',
    commitSha,
    branchName: branch,
    runIdentity,
    externalLogUrl: runIdentity === undefined ? undefined : githubRunUrl(env),
  };
}
