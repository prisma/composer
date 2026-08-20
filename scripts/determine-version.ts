#!/usr/bin/env node

/**
 * Composes the version + dist-tag the publish workflow will use.
 *
 * The base version comes from the root `package.json` (the
 * source-of-truth introduced by the package.json-versioning refactor).
 * This script is responsible only for the suffix and dist-tag
 * appropriate to the GitHub event:
 *
 * - `push`              → if the root `version` changed in this push,
 *                          `<base>` (no suffix), dist-tag `latest`. This
 *                          is how a merged `chore(release): ...` PR
 *                          ships a stable release automatically. The
 *                          plan then also carries `devVersion`
 *                          (`<base>-dev.N`) so the workflow can publish
 *                          a dev build of the same commit — the `dev`
 *                          dist-tag must never fall behind `latest`.
 *                         Otherwise, `<base>-dev.N`, dist-tag `dev`
 *                          (N is the next available build number,
 *                          discovered by querying npm).
 * - `workflow_dispatch` → `<base>` (no suffix), dist-tag from
 *                          `INPUT_DIST_TAG` (defaults to `latest`).
 *                          Useful as a manual escape hatch (re-publish
 *                          after a transient failure, cut a beta).
 *
 * Outputs `version`, `tag`, and `devVersion` (empty unless the push is
 * a release bump) to `$GITHUB_OUTPUT` for downstream workflow steps.
 */

import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'pathe';
import type { PreviousVersionLookup } from './determine-version-utils.ts';
import { assertCanonicalBase, planPushPublish } from './determine-version-utils.ts';

const PACKAGE_NAME = process.argv[2] ?? '@prisma/composer';

interface VersionResult {
  version: string;
  tag: string;
  devVersion?: string;
}

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function readRootVersion(): string {
  const pkgPath = join(rootDir, 'package.json');
  const parsed: { version?: unknown } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(
      `Root package.json (${pkgPath}) is missing a \`version\` field. ` +
        'The publish pipeline now reads the version directly from the workspace root; ' +
        'set it (e.g. `pnpm bump-minor`) before publishing.',
    );
  }
  return parsed.version;
}

function run(command: string): string | undefined {
  try {
    return execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return undefined;
  }
}

function getLatestDevVersion(): string | undefined {
  return run(`npm view "${PACKAGE_NAME}" dist-tags.dev`);
}

/**
 * Reads the root `package.json` `version` at `PUSH_BEFORE_SHA` (the ref
 * that `main` pointed at *before* the push). Distinguishes "we
 * successfully read the previous file" (so the comparison is meaningful)
 * from "we couldn't" (shallow clone, missing SHA, etc.) so the caller
 * can fall back to the safe `dev` path on any I/O hiccup.
 */
function readPreviousRootVersion(): PreviousVersionLookup {
  const beforeSha = process.env.PUSH_BEFORE_SHA;
  if (!beforeSha || /^0+$/.test(beforeSha)) {
    return { available: false };
  }
  try {
    const json = execFileSync('git', ['show', `${beforeSha}:package.json`], {
      cwd: rootDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed: { version?: unknown } = JSON.parse(json);
    return {
      available: true,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
    };
  } catch {
    return { available: false };
  }
}

function writeGitHubOutput(result: VersionResult): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `version<<EOF\n${result.version}\nEOF\n`);
    appendFileSync(outputFile, `tag<<EOF\n${result.tag}\nEOF\n`);
    appendFileSync(outputFile, `devVersion<<EOF\n${result.devVersion ?? ''}\nEOF\n`);
  }
}

const eventName = process.env.GITHUB_EVENT_NAME;
const inputDistTag = process.env.INPUT_DIST_TAG;

const baseVersion = readRootVersion();
assertCanonicalBase(baseVersion);

console.log(`Event:                 ${eventName}`);
console.log(`Base version (root):   ${baseVersion}`);

let result: VersionResult;

switch (eventName) {
  case 'workflow_dispatch':
    // `??` is wrong here: an empty INPUT_DIST_TAG would slip through as
    // the dist-tag and cause `pnpm publish --tag ""` to fail downstream.
    // The workflow declares `dist-tag` with a `latest` default, so this
    // fallback is a defensive belt-and-braces.
    result = { version: baseVersion, tag: inputDistTag || 'latest' };
    break;

  case 'push': {
    const previous = readPreviousRootVersion();
    result = planPushPublish(baseVersion, previous, getLatestDevVersion());
    if (result.tag === 'latest') {
      console.log(
        `Previous root version: ${previous.available ? (previous.version ?? '(unset)') : '(unreadable)'} → release bump detected.`,
      );
    }
    break;
  }

  default:
    throw new Error(`don't know how to handle event ${eventName}`);
}

console.log(`Resolved version:      ${result.version}`);
console.log(`Resolved dist-tag:     ${result.tag}`);
if (result.devVersion) {
  console.log(`Dev follow-up version: ${result.devVersion}`);
}
writeGitHubOutput(result);
