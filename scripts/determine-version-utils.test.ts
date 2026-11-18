import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertCanonicalBase,
  computeNextMinor,
  nextDevVersion,
  parseVersion,
  planPushPublish,
  planReleaseLinePublish,
  releaseLineOf,
} from './determine-version-utils.ts';

describe('parseVersion', () => {
  it('parses a clean release', () => {
    assert.deepEqual(parseVersion('0.7.0'), { major: 0, minor: 7, patch: 0 });
  });

  it('parses a multi-digit version', () => {
    assert.deepEqual(parseVersion('12.34.567'), { major: 12, minor: 34, patch: 567 });
  });

  it('tolerates a pre-release suffix', () => {
    assert.deepEqual(parseVersion('0.7.0-dev.5'), { major: 0, minor: 7, patch: 0 });
    assert.deepEqual(parseVersion('1.2.3-foo'), { major: 1, minor: 2, patch: 3 });
  });
});

describe('computeNextMinor', () => {
  it('advances 0.7.0 to 0.8.0', () => {
    assert.equal(computeNextMinor('0.7.0'), '0.8.0');
  });

  it('zeros the patch component', () => {
    assert.equal(computeNextMinor('1.2.5'), '1.3.0');
  });

  it('ignores pre-release suffixes on the input', () => {
    assert.equal(computeNextMinor('0.7.0-dev.5'), '0.8.0');
  });
});

describe('assertCanonicalBase', () => {
  it('accepts a clean release', () => {
    assert.doesNotThrow(() => assertCanonicalBase('0.7.0'));
    assert.doesNotThrow(() => assertCanonicalBase('1.2.3'));
  });

  it('rejects a pre-release suffix', () => {
    assert.throws(() => assertCanonicalBase('0.7.0-dev.1'), /not canonical/);
  });

  it('rejects a missing component', () => {
    assert.throws(() => assertCanonicalBase('0.7'), /not canonical/);
  });

  it('rejects an empty string', () => {
    assert.throws(() => assertCanonicalBase(''), /not canonical/);
  });

  it('rejects components with leading zeros', () => {
    assert.throws(() => assertCanonicalBase('01.2.3'), /not canonical/);
    assert.throws(() => assertCanonicalBase('1.02.3'), /not canonical/);
    assert.throws(() => assertCanonicalBase('1.2.03'), /not canonical/);
  });
});

describe('nextDevVersion', () => {
  it('continues the counter when the dev tag is on the same base', () => {
    assert.equal(nextDevVersion('0.8.0', '0.8.0-dev.4'), '0.8.0-dev.5');
  });

  it('restarts at dev.1 when the dev tag is on an older base', () => {
    assert.equal(nextDevVersion('0.8.0', '0.6.0-dev.23'), '0.8.0-dev.1');
  });

  it('starts at dev.1 when there is no dev tag at all', () => {
    assert.equal(nextDevVersion('0.8.0', undefined), '0.8.0-dev.1');
  });

  it('starts at dev.1 when the dev tag is not a dev shape', () => {
    assert.equal(nextDevVersion('0.8.0', '0.8.0'), '0.8.0-dev.1');
  });
});

describe('planPushPublish', () => {
  it('publishes a dev build when the root version is unchanged', () => {
    assert.deepEqual(
      planPushPublish('0.8.0', { available: true, version: '0.8.0' }, '0.8.0-dev.4'),
      { version: '0.8.0-dev.5', tag: 'dev' },
    );
  });

  it('publishes a release plus a dev follow-up when the root version changed', () => {
    assert.deepEqual(
      planPushPublish('0.9.0', { available: true, version: '0.8.0' }, '0.8.0-dev.7'),
      { version: '0.9.0', tag: 'latest', devVersion: '0.9.0-dev.1' },
    );
  });

  it('continues the dev counter on a release rerun whose dev build already landed', () => {
    assert.deepEqual(
      planPushPublish('0.9.0', { available: true, version: '0.8.0' }, '0.9.0-dev.1'),
      { version: '0.9.0', tag: 'latest', devVersion: '0.9.0-dev.2' },
    );
  });

  it('falls back to a dev build when the previous version could not be read', () => {
    assert.deepEqual(planPushPublish('0.9.0', { available: false }, '0.8.0-dev.7'), {
      version: '0.9.0-dev.1',
      tag: 'dev',
    });
  });

  it('treats a previous package.json without a version as a release bump', () => {
    assert.deepEqual(planPushPublish('0.9.0', { available: true, version: undefined }, undefined), {
      version: '0.9.0',
      tag: 'latest',
      devVersion: '0.9.0-dev.1',
    });
  });
});

describe('releaseLineOf', () => {
  it('reads the line from a release branch', () => {
    assert.equal(releaseLineOf('release/0.38.x'), '0.38');
    assert.equal(releaseLineOf('release/1.12.x'), '1.12');
  });

  it('is undefined for any other branch', () => {
    for (const branch of [
      'main',
      'release/0.38',
      'release/0.38.1',
      'release/v0.38.x',
      'x/release/0.38.x',
    ]) {
      assert.equal(releaseLineOf(branch), undefined);
    }
  });
});

describe('planReleaseLinePublish', () => {
  const bumpedFrom = (version: string) => ({ available: true as const, version });

  it('publishes a patch to an older line under the line tag, never latest', () => {
    assert.deepEqual(
      planReleaseLinePublish('release/0.38.x', '0.38.1', bumpedFrom('0.38.0'), '0.39.0'),
      {
        publish: true,
        version: '0.38.1',
        tag: 'release-0.38',
      },
    );
  });

  it('makes a patch to the line latest is on the new latest', () => {
    assert.deepEqual(
      planReleaseLinePublish('release/0.39.x', '0.39.1', bumpedFrom('0.39.0'), '0.39.0'),
      {
        publish: true,
        version: '0.39.1',
        tag: 'latest',
      },
    );
  });

  it('does not move latest to an older patch of its own line', () => {
    assert.equal(
      planReleaseLinePublish('release/0.39.x', '0.39.1', bumpedFrom('0.39.0'), '0.39.2').tag,
      'release-0.39',
    );
  });

  it('publishes nothing when the push leaves the version unchanged', () => {
    assert.equal(
      planReleaseLinePublish('release/0.38.x', '0.38.1', bumpedFrom('0.38.1'), '0.39.0').publish,
      false,
    );
  });

  it('publishes nothing when the previous version cannot be read, as on the push that creates the branch', () => {
    assert.equal(
      planReleaseLinePublish('release/0.38.x', '0.38.0', { available: false }, '0.39.0').publish,
      false,
    );
  });

  it('refuses a version that is not on the branch line', () => {
    assert.throws(
      () => planReleaseLinePublish('release/0.38.x', '0.39.1', bumpedFrom('0.39.0'), '0.39.0'),
      /not on the 0\.38 line/,
    );
  });

  it('refuses a branch that is not a release branch', () => {
    assert.throws(
      () => planReleaseLinePublish('main', '0.38.1', bumpedFrom('0.38.0'), '0.39.0'),
      /not a release branch/,
    );
  });
});
