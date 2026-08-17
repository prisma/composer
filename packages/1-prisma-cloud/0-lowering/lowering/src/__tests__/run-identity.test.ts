import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRunIdentity } from '../builds/run-identity.ts';

/** A directory outside any checkout, so the git fallback genuinely finds nothing. */
const dirs: string[] = [];
function nonRepoDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-identity-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const actions = {
  GITHUB_ACTIONS: 'true',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF_NAME: 'main',
  GITHUB_REPOSITORY: 'prisma/composer',
  GITHUB_REPOSITORY_ID: '12345',
  GITHUB_RUN_ID: '99',
  GITHUB_RUN_ATTEMPT: '2',
};

describe('resolveRunIdentity', () => {
  test('a GitHub Actions run is named, so its build dedupes and links to the repository', () => {
    const identity = resolveRunIdentity(nonRepoDir(), actions);

    expect(identity).toEqual({
      source: 'ci',
      commitSha: 'a'.repeat(40),
      branchName: 'main',
      runIdentity: { provider: 'github', repositoryId: '12345', runId: '99', runAttempt: 2 },
      externalLogUrl: 'https://github.com/prisma/composer/actions/runs/99/attempts/2',
    });
  });

  test('a pull-request run reports the head branch, not the synthetic merge ref', () => {
    const identity = resolveRunIdentity(nonRepoDir(), {
      ...actions,
      GITHUB_REF_NAME: '123/merge',
      GITHUB_HEAD_REF: 'feat/build-reporting',
    });

    expect(identity?.branchName).toBe('feat/build-reporting');
  });

  test('a run whose identity is not all digits is reported as cli, never with a half identity', () => {
    for (const broken of [
      { GITHUB_REPOSITORY_ID: 'prisma:composer' },
      { GITHUB_RUN_ID: 'abc' },
      { GITHUB_RUN_ATTEMPT: 'first' },
      { GITHUB_REPOSITORY_ID: '' },
    ]) {
      const identity = resolveRunIdentity(nonRepoDir(), { ...actions, ...broken });
      expect(identity?.source).toBe('cli');
      expect(identity?.runIdentity).toBeUndefined();
      expect(identity?.externalLogUrl).toBeUndefined();
    }
  });

  test('a run attempt defaults to the first when the variable is absent', () => {
    const { GITHUB_RUN_ATTEMPT: _omitted, ...rest } = actions;
    expect(resolveRunIdentity(nonRepoDir(), rest)?.runIdentity?.runAttempt).toBe(1);
  });

  test('outside GitHub Actions the run is cli, even with the other variables set', () => {
    const identity = resolveRunIdentity(nonRepoDir(), { ...actions, GITHUB_ACTIONS: undefined });

    expect(identity?.source).toBe('cli');
    expect(identity?.runIdentity).toBeUndefined();
  });

  test('no commit and no branch means no identity — nothing is invented to fill a required field', () => {
    expect(resolveRunIdentity(nonRepoDir(), {})).toBeUndefined();
  });

  test('a commit with no branch is still not enough', () => {
    expect(resolveRunIdentity(nonRepoDir(), { GITHUB_SHA: 'a'.repeat(40) })).toBeUndefined();
  });

  test('a git checkout resolves its commit and branch through git', () => {
    // A purpose-built repo, not the host checkout: CI checks out pull
    // requests at a detached HEAD, where "no branch" is the correct answer.
    const dir = nonRepoDir();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '--initial-branch=trunk');
    git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '--no-gpg-sign',
      '-m',
      'x',
    );

    const identity = resolveRunIdentity(dir, {});

    expect(identity?.source).toBe('cli');
    expect(identity?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(identity?.branchName).toBe('trunk');
  });

  test('a detached HEAD has no branch to report, so there is no identity', () => {
    const dir = nonRepoDir();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '--initial-branch=trunk');
    git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '--no-gpg-sign',
      '-m',
      'x',
    );
    git('checkout', '--detach', 'HEAD');

    expect(resolveRunIdentity(dir, {})).toBeUndefined();
  });
});
