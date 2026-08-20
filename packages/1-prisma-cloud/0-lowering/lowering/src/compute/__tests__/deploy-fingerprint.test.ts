/**
 * The environment fingerprint: the path a deploy hands upstream moves when the
 * environment moved and stands still when it did not — and no secret byte, and
 * no hash of one, is ever part of it. Which plan action a moved path actually
 * produces is proven against upstream's real diff in `deployment-edge.test.ts`;
 * this file pins what the fingerprint covers and what the path looks like.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deployEnvFingerprint,
  deployEnvFingerprintMaterial,
  type EnvFingerprintEntry,
  fingerprintedArtifactPath,
  type PointerUpdatedAt,
} from '../deploy-fingerprint.ts';

const digestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-fingerprint-'));
const canonicalPath = path.join(digestDir, 'auth.tar.gz');
fs.writeFileSync(canonicalPath, 'artifact-bytes');

const otherDigestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-fingerprint-'));
const otherArtifactPath = path.join(otherDigestDir, 'auth.tar.gz');
fs.writeFileSync(otherArtifactPath, 'other-artifact-bytes');

afterAll(() => {
  fs.rmSync(digestDir, { recursive: true, force: true });
  fs.rmSync(otherDigestDir, { recursive: true, force: true });
});

/** A service's rows: a config literal, a pointer row, the input document, a generated row, a provider param. */
const environment: readonly EnvFingerprintEntry[] = [
  { key: 'COMPOSER_AUTH_PORT', value: '3000' },
  {
    key: 'COMPOSER_AUTH_TIER',
    value: '"@composer-param-pointer:AUTH_TIER"',
    pointers: ['AUTH_TIER'],
  },
  {
    key: 'COMPOSER_AUTH_INPUT',
    value: '{"apiKey":{"$secret":"STRIPE_KEY"}}',
    pointers: ['STRIPE_KEY'],
  },
  { key: 'COMPOSER_AUTH_SESSION_GENERATED', withheld: 'generated:32:true' },
  { key: 'COMPOSER_AUTH_ORIGIN', withheld: 'provider.ORIGIN:auth-svc' },
];

const rotations =
  (entries: Record<string, string>): PointerUpdatedAt =>
  (name) =>
    entries[name];

const platform = rotations({
  AUTH_TIER: '2026-01-01T00:00:00.000Z',
  STRIPE_KEY: '2026-01-02T00:00:00.000Z',
});

const pathFor = (
  entries: readonly EnvFingerprintEntry[],
  updatedAt: PointerUpdatedAt = platform,
  artifactPath: string = canonicalPath,
): string => fingerprintedArtifactPath(artifactPath, deployEnvFingerprint(entries, updatedAt));

/** The rows with one entry swapped for `replacement`, matched by key. */
const withRow = (replacement: EnvFingerprintEntry): readonly EnvFingerprintEntry[] =>
  environment.map((entry) => (entry.key === replacement.key ? replacement : entry));

describe('the fingerprint moves exactly when the environment moved', () => {
  test('the same environment and the same artifact give the same path — the deployment is reused', () => {
    expect(pathFor(environment)).toBe(pathFor(environment));
  });

  test('the row ORDER does not move it — the serializer may emit rows in any order', () => {
    expect(pathFor([...environment].reverse())).toBe(pathFor(environment));
  });

  test('a changed config value gives a new path', () => {
    expect(pathFor(withRow({ key: 'COMPOSER_AUTH_PORT', value: '8080' }))).not.toBe(
      pathFor(environment),
    );
  });

  test('an added row gives a new path', () => {
    expect(pathFor([...environment, { key: 'COMPOSER_AUTH_DEBUG', value: 'true' }])).not.toBe(
      pathFor(environment),
    );
  });

  test('a removed row gives a new path', () => {
    expect(pathFor(environment.slice(1))).not.toBe(pathFor(environment));
  });

  test('a rotated POINTED variable gives a new path, though every row is byte-identical', () => {
    const rotated = rotations({
      AUTH_TIER: '2026-01-01T00:00:00.000Z',
      STRIPE_KEY: '2026-06-30T09:15:00.000Z',
    });
    expect(pathFor(environment, rotated)).not.toBe(pathFor(environment));
  });

  test('a re-pointed row (same value shape, different platform variable) gives a new path', () => {
    expect(
      pathFor(
        withRow({
          key: 'COMPOSER_AUTH_INPUT',
          value: '{"apiKey":{"$secret":"STRIPE_KEY_2"}}',
          pointers: ['STRIPE_KEY_2'],
        }),
      ),
    ).not.toBe(pathFor(environment));
  });

  test('a rewired withheld row (different producing resources) gives a new path', () => {
    expect(
      pathFor(withRow({ key: 'COMPOSER_AUTH_ORIGIN', withheld: 'provider.ORIGIN:billing-svc' })),
    ).not.toBe(pathFor(environment));
  });

  test('a changed artifact gives a new path — the canonical path is already content-addressed', () => {
    expect(pathFor(environment, platform, otherArtifactPath)).not.toBe(pathFor(environment));
  });
});

describe('no secret value can reach the fingerprint', () => {
  // The row set a real service produces for its secret-bearing channels: a
  // minted generated value, a dependency connection string, a minted service
  // key. The sentinel is what each of those values would be.
  const SENTINEL = 'hunter2-correct-horse-battery-staple';

  const secretBearing: readonly EnvFingerprintEntry[] = [
    { key: 'COMPOSER_AUTH_SESSION_GENERATED', withheld: 'generated:32:true' },
    { key: 'COMPOSER_AUTH_DB_URL', withheld: 'input.db:db-postgres' },
    { key: 'COMPOSER_AUTH_STREAMS_API_KEY', withheld: 'provider.STREAMS_API_KEY:streamskey-auth' },
    {
      key: 'COMPOSER_AUTH_INPUT',
      value: '{"apiKey":{"$secret":"STRIPE_KEY"}}',
      pointers: ['STRIPE_KEY'],
    },
  ];

  // The pointed variable HOLDS the sentinel on the platform; what the deploy
  // learns about it is a timestamp, and that is all the lookup can return.
  const platformHoldingTheSentinel = rotations({ STRIPE_KEY: '2026-01-02T00:00:00.000Z' });

  test('the hashed material contains the sentinel nowhere', () => {
    const material = deployEnvFingerprintMaterial(secretBearing, platformHoldingTheSentinel);
    expect(material).not.toContain(SENTINEL);
    // What it DOES contain: the row keys, the pointer NAME, and the timestamp.
    expect(material).toContain('COMPOSER_AUTH_DB_URL');
    expect(material).toContain('STRIPE_KEY');
    expect(material).toContain('2026-01-02T00:00:00.000Z');
  });

  test('the path contains the sentinel nowhere', () => {
    expect(pathFor(secretBearing, platformHoldingTheSentinel)).not.toContain(SENTINEL);
  });

  test('a withheld entry has no field a value could be passed in', () => {
    const entry: EnvFingerprintEntry = {
      key: 'COMPOSER_AUTH_DB_URL',
      withheld: 'input.db:db-postgres',
    };
    // @ts-expect-error a withheld row cannot also carry a value — the union forbids it.
    const rejected: EnvFingerprintEntry = { ...entry, value: SENTINEL };
    expect(rejected.key).toBe('COMPOSER_AUTH_DB_URL');
  });
});

describe('the fingerprinted path', () => {
  test('lives beside the canonical artifact, named by the fingerprint, same bytes', () => {
    const linked = pathFor(environment);
    expect(path.dirname(path.dirname(linked))).toBe(digestDir);
    expect(path.basename(path.dirname(linked))).toMatch(/^deploy-env-[0-9a-f]{12}$/);
    expect(path.basename(linked)).toBe('auth.tar.gz');
    expect(fs.readFileSync(linked, 'utf8')).toBe('artifact-bytes');
  });

  test("is a plain string, never an Output — upstream's replacement block must stay resolved", () => {
    expect(typeof pathFor(environment)).toBe('string');
  });

  test("the destroy-run placeholder ('' — no build) passes through untouched", () => {
    expect(fingerprintedArtifactPath('', deployEnvFingerprint(environment, platform))).toBe('');
  });
});

describe('dev, where no platform timestamps exist', () => {
  const noPlatform: PointerUpdatedAt = () => undefined;

  test('every pointer reads as unknown and the fingerprint is still stable', () => {
    expect(pathFor(environment, noPlatform)).toBe(pathFor(environment, noPlatform));
  });

  test('an unknown timestamp is not the same as a known one — dev never collides with a deploy', () => {
    expect(pathFor(environment, noPlatform)).not.toBe(pathFor(environment, platform));
  });
});
