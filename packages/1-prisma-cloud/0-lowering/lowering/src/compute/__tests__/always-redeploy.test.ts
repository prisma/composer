/**
 * The per-deploy artifact generation: same bytes, a fresh path per deploy run
 * — what makes upstream's `Prisma.Deployment` replace on every deploy so a
 * changed environment value always reaches the running app. Which plan action
 * the fresh path produces is proven against upstream's real diff in
 * `deployment-edge.test.ts`; this file pins the path mechanics.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { alwaysRedeployArtifactPath } from '../always-redeploy.ts';

const digestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'always-redeploy-'));
const canonicalPath = path.join(digestDir, 'auth.tar.gz');
fs.writeFileSync(canonicalPath, 'artifact-bytes');

afterAll(() => {
  fs.rmSync(digestDir, { recursive: true, force: true });
});

describe('alwaysRedeployArtifactPath', () => {
  test('two deploy runs (two generations) get two distinct paths to the same bytes', () => {
    const first = alwaysRedeployArtifactPath(canonicalPath, 'run-1');
    const second = alwaysRedeployArtifactPath(canonicalPath, 'run-2');

    expect(first).not.toBe(second);
    expect(first).not.toBe(canonicalPath);
    expect(fs.readFileSync(first, 'utf8')).toBe('artifact-bytes');
    expect(fs.readFileSync(second, 'utf8')).toBe('artifact-bytes');
  });

  test('within one run the path is stable — the dev watch loop converges without churn', () => {
    expect(alwaysRedeployArtifactPath(canonicalPath, 'run-1')).toBe(
      alwaysRedeployArtifactPath(canonicalPath, 'run-1'),
    );
    // The default generation is minted once per process: same property.
    expect(alwaysRedeployArtifactPath(canonicalPath)).toBe(
      alwaysRedeployArtifactPath(canonicalPath),
    );
  });

  test('the generation lives beside the canonical artifact, keyed by the run', () => {
    const generationPath = alwaysRedeployArtifactPath(canonicalPath, 'run-3');
    expect(path.dirname(path.dirname(generationPath))).toBe(digestDir);
    expect(path.basename(path.dirname(generationPath))).toBe('deploy-run-3');
    expect(path.basename(generationPath)).toBe('auth.tar.gz');
  });

  test("the destroy-run placeholder ('' — no build) passes through untouched", () => {
    expect(alwaysRedeployArtifactPath('', 'run-1')).toBe('');
  });
});
