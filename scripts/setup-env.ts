#!/usr/bin/env bun
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
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = path.join(root, ".env");
const EXAMPLE = path.join(root, ".env.example");

// Override with e.g. PRISMA_CLI="prisma" if you have the CLI installed globally.
const CLI = (process.env.PRISMA_CLI ?? "bunx @prisma/cli@latest").split(" ");

function cli(args: string[], capture = false) {
  const [cmd, ...base] = CLI;
  return spawnSync(cmd, [...base, ...args], {
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
}

function ask(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (a) => (rl.close(), resolve(a.trim()))));
}

/** Read a secret without echoing it to the terminal. */
function askSecret(query: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(query);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question("", (a) => (rl.close(), process.stdout.write("\n"), resolve(a.trim())));
  });
}

async function getEnv(key: string): Promise<string> {
  const m = (await readFile(ENV, "utf8")).match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

async function setEnv(key: string, value: string): Promise<void> {
  const content = await readFile(ENV, "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  await writeFile(ENV, re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`);
}

/** Pull `[{ id, name }]` out of `auth workspace list --json`, tolerating shape drift. */
function parseWorkspaces(stdout: string): { id: string; name?: string }[] {
  const start = stdout.search(/[[{]/);
  if (start < 0) return [];
  let parsed: unknown;
  for (let end = stdout.length; end > start; end--) {
    try {
      parsed = JSON.parse(stdout.slice(start, end));
      break;
    } catch {}
  }
  const arr: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.workspaces)
      ? (parsed as any).workspaces
      : Array.isArray((parsed as any)?.data)
        ? (parsed as any).data
        : [];
  return arr
    .map((w) => ({
      id: w.id ?? w.workspaceId ?? w.workspace?.id,
      name: w.name ?? w.displayName ?? w.slug ?? w.workspace?.name,
    }))
    .filter((w): w is { id: string; name?: string } => typeof w.id === "string");
}

// --- 1. .env exists -----------------------------------------------------------
if (!existsSync(EXAMPLE)) {
  console.error(`Missing ${EXAMPLE}`);
  process.exit(1);
}
if (existsSync(ENV)) {
  console.log("• .env exists — filling in any missing values (existing ones are kept)");
} else {
  await copyFile(EXAMPLE, ENV);
  console.log("• Created .env from .env.example");
}

// --- 2. Authenticate the CLI --------------------------------------------------
if (cli(["auth", "whoami", "--json"], true).status === 0) {
  console.log("• Prisma CLI already authenticated");
} else {
  console.log("\n• Not logged in — running `auth login` (opens your browser)…");
  if (cli(["auth", "login"]).status !== 0) {
    console.error("auth login failed — re-run once you're logged in.");
    process.exit(1);
  }
}

// --- 3. Pick a workspace ------------------------------------------------------
console.log("\n• Fetching your workspaces…");
const list = cli(["auth", "workspace", "list", "--json"], true);
const workspaces = parseWorkspaces(list.stdout ?? "");
let workspaceId: string;
if (workspaces.length === 0) {
  console.log("  Couldn't parse the workspace list. Raw output:\n");
  console.log((list.stdout ?? "") + (list.stderr ?? ""));
  workspaceId = await ask("  Enter the workspace id (wksp_…): ");
} else {
  workspaces.forEach((w, i) => console.log(`  [${i + 1}] ${w.name ?? "(unnamed)"} — ${w.id}`));
  const pick = await ask(`  Which workspace? [1-${workspaces.length}] `);
  workspaceId = workspaces[Number(pick) - 1]?.id ?? workspaces[0].id;
}
if (!workspaceId) {
  console.error("No workspace selected.");
  process.exit(1);
}
await setEnv("PRISMA_WORKSPACE_ID", workspaceId);
console.log(`• PRISMA_WORKSPACE_ID = ${workspaceId}`);

// --- 4. Service token (Console-only) -----------------------------------------
const existingToken = await getEnv("PRISMA_SERVICE_TOKEN");
const replaceToken =
  !existingToken || (await ask("• PRISMA_SERVICE_TOKEN is already set — replace it? [y/N] ")).toLowerCase() === "y";
if (replaceToken) {
  console.log(
    `\n  Create a service token in the Prisma Console (there is no CLI/API for this):\n` +
      `    https://console.prisma.io  →  your workspace (${workspaceId})  →  Settings → Service Tokens\n` +
      `    → New Service Token, then copy it (it's shown only once).`,
  );
  const token = await askSecret("  Paste PRISMA_SERVICE_TOKEN (input hidden): ");
  if (token) {
    await setEnv("PRISMA_SERVICE_TOKEN", token);
    console.log("• PRISMA_SERVICE_TOKEN set");
  } else {
    console.log("• No token entered — leaving PRISMA_SERVICE_TOKEN blank; set it before deploying.");
  }
} else {
  console.log("• Keeping existing PRISMA_SERVICE_TOKEN");
}

// --- 5. ALCHEMY_PASSWORD ------------------------------------------------------
if (await getEnv("ALCHEMY_PASSWORD")) {
  console.log("• ALCHEMY_PASSWORD already set — leaving it (must stay constant)");
} else {
  await setEnv("ALCHEMY_PASSWORD", randomBytes(24).toString("hex"));
  console.log("• Generated ALCHEMY_PASSWORD");
}

console.log(
  `\n.env is ready. Deploy the example (source .env — the CLI's --env-file doesn't populate process.env):\n` +
    `  cd examples/storefront-auth && ( set -a; . ../../.env; set +a; pnpm exec alchemy deploy --yes )`,
);
