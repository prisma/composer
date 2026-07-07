#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Populate `.env` (from `.env.example`) with the credentials the example apps need
 * to deploy against Prisma Cloud.
 *
 *   bun scripts/setup-env.ts          # or: pnpm setup:env
 *
 * What it does:
 *   1. Copies `.env.example` -> `.env` if `.env` doesn't exist yet.
 *   2. Authenticates the Prisma CLI (browser OAuth) if you aren't already logged in.
 *   3. Lists your workspaces and lets you pick one -> PRISMA_WORKSPACE_ID.
 *   4. Prompts for a service token -> PRISMA_SERVICE_TOKEN. Service tokens can only
 *      be minted in the Prisma Console (there is no CLI/API to create one — verified:
 *      `/v1/service-tokens` 404s), so the script links you there and reads the paste.
 *   5. Generates a stable ALCHEMY_PASSWORD if one isn't set (never overwrites it —
 *      it must stay constant or Alchemy can't decrypt existing local state).
 *
 * Re-runnable: existing values are kept unless you choose to replace them.
 */
import * as p from '@clack/prompts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = process.env.SETUP_ENV_FILE ?? path.join(root, '.env'); // override for tests
const EXAMPLE = path.join(root, '.env.example');

// Override with e.g. PRISMA_CLI="prisma" if you have the CLI installed globally.
const CLI = (process.env.PRISMA_CLI ?? 'bunx @prisma/cli@latest').split(' ');

export interface Workspace {
  id: string;
  name?: string;
  active?: boolean;
}

interface RawList {
  result?: { context?: { activeWorkspaceId?: string }; items?: unknown };
  context?: { activeWorkspaceId?: string };
  items?: unknown;
  workspaces?: unknown;
  data?: unknown;
}

interface RawWorkspace {
  id?: string;
  workspaceId?: string;
  workspace?: { id?: string; name?: string };
  name?: string;
  displayName?: string;
  slug?: string;
  status?: string;
}

/** Pull the workspace list out of `auth workspace list --json`, tolerating shape drift. */
export function parseWorkspaces(stdout: string): Workspace[] {
  const start = stdout.search(/[[{]/);
  if (start < 0) return [];
  let parsed: RawList | RawList[] | undefined;
  for (let end = stdout.length; end > start; end--) {
    try {
      parsed = JSON.parse(stdout.slice(start, end));
      break;
    } catch {}
  }
  if (!parsed) return [];
  const root = Array.isArray(parsed) ? undefined : parsed;
  const activeId = root?.result?.context?.activeWorkspaceId ?? root?.context?.activeWorkspaceId;
  const items: unknown = Array.isArray(parsed)
    ? parsed
    : (root?.result?.items ?? root?.items ?? root?.workspaces ?? root?.data ?? []);
  return (Array.isArray(items) ? (items as RawWorkspace[]) : [])
    .map((w) => {
      const id = w.id ?? w.workspaceId ?? w.workspace?.id;
      return {
        id,
        name: w.name ?? w.displayName ?? w.slug ?? w.workspace?.name,
        active: id === activeId || w.status === 'active',
      } as Workspace;
    })
    .filter((w) => typeof w.id === 'string');
}

/** Set/replace a `KEY=value` line in a .env body, preserving everything else. */
export function upsertEnv(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`;
}

function cli(args: string[], capture = false) {
  const [cmd, ...base] = CLI;
  return spawnSync(cmd, [...base, ...args], {
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
}

async function getEnv(key: string): Promise<string> {
  const m = (await readFile(ENV, 'utf8')).match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

async function setEnv(key: string, value: string): Promise<void> {
  await writeFile(ENV, upsertEnv(await readFile(ENV, 'utf8'), key, value));
}

/** Unwrap a clack prompt result, exiting cleanly if the user cancelled (Ctrl-C). */
function must<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(1);
  }
  return value as T;
}

const required = (v: string) => (v.trim() ? undefined : 'Required');

async function main() {
  p.intro('Set up .env for Prisma Cloud deploys');

  // 1. .env exists ------------------------------------------------------------
  if (!existsSync(EXAMPLE)) {
    p.cancel(`Missing ${EXAMPLE}`);
    process.exit(1);
  }
  if (existsSync(ENV)) {
    p.log.info('.env exists — filling in any missing values (existing ones are kept)');
  } else {
    await copyFile(EXAMPLE, ENV);
    p.log.success('Created .env from .env.example');
  }

  // 2. Authenticate the CLI ---------------------------------------------------
  if (cli(['auth', 'whoami', '--json'], true).status === 0) {
    p.log.success('Prisma CLI already authenticated');
  } else {
    p.log.step('Not logged in — running `auth login` (opens your browser)…');
    if (cli(['auth', 'login']).status !== 0) {
      p.cancel("auth login failed — re-run once you're logged in.");
      process.exit(1);
    }
  }

  // 3. Pick a workspace -------------------------------------------------------
  const spin = p.spinner();
  spin.start('Fetching your workspaces');
  const list = cli(['auth', 'workspace', 'list', '--json'], true);
  const workspaces = parseWorkspaces(list.stdout ?? '');
  spin.stop(`Found ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`);

  let workspaceId: string;
  if (workspaces.length === 0) {
    const raw = ((list.stdout ?? '') + (list.stderr ?? '')).trim();
    if (raw) p.log.warn(`Couldn't parse the workspace list:\n${raw}`);
    workspaceId = must(
      await p.text({
        message: 'Enter the workspace id',
        placeholder: 'wksp_…',
        validate: required,
      }),
    ).trim();
  } else {
    workspaceId = must(
      await p.select({
        message: 'Which workspace should own provisioned projects?',
        initialValue: (workspaces.find((w) => w.active) ?? workspaces[0]).id,
        options: workspaces.map((w) => ({
          value: w.id,
          label: w.name ?? w.id,
          hint: w.active ? 'active' : undefined,
        })),
      }),
    );
  }
  await setEnv('PRISMA_WORKSPACE_ID', workspaceId);
  p.log.success(`PRISMA_WORKSPACE_ID = ${workspaceId}`);

  // 4. Service token (Console-only) -------------------------------------------
  const existing = await getEnv('PRISMA_SERVICE_TOKEN');
  const replace = existing
    ? must(
        await p.confirm({
          message: 'PRISMA_SERVICE_TOKEN is already set — replace it?',
          initialValue: false,
        }),
      )
    : true;
  if (replace) {
    p.note(
      `console.prisma.io  →  workspace ${workspaceId}\n  →  Settings → Service Tokens → New Service Token\n\nIt's shown only once. There is no CLI/API to mint one.`,
      'Create a service token',
    );
    const token = must(
      await p.password({ message: 'Paste PRISMA_SERVICE_TOKEN', validate: required }),
    );
    await setEnv('PRISMA_SERVICE_TOKEN', token.trim());
    p.log.success('PRISMA_SERVICE_TOKEN set');
  } else {
    p.log.info('Keeping existing PRISMA_SERVICE_TOKEN');
  }

  // 5. ALCHEMY_PASSWORD -------------------------------------------------------
  if (await getEnv('ALCHEMY_PASSWORD')) {
    p.log.info('ALCHEMY_PASSWORD already set — leaving it (must stay constant)');
  } else {
    await setEnv('ALCHEMY_PASSWORD', randomBytes(24).toString('hex'));
    p.log.success('Generated ALCHEMY_PASSWORD');
  }

  p.outro(
    '.env is ready. Deploy: cd examples/storefront-auth && ( set -a; . ../../.env; set +a; pnpm exec alchemy deploy --yes )',
  );
}

if (import.meta.main) {
  await main();
}
