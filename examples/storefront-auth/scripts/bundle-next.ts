/**
 * Packages a Next.js `output: "standalone"` build into a Prisma Compute artifact.
 *
 * Run `next build` first (the `build:compute` script does). Next's standalone
 * tree omits the static assets and `public/`, so this copies them in, writes a
 * `compute.manifest.json` at the tree root pointing at the standalone
 * `server.js`, and tars it — the format our `Deployment` resource consumes.
 *
 * Requires a hoisted node_modules (see the repo `.npmrc`): pnpm's default
 * isolated layout hides Next's peers (e.g. styled-jsx) under `.pnpm`, and the
 * flattened standalone `next` copy can't resolve them at boot.
 *
 * Counterpart to `bundle.ts`, which does the same for a Bun entrypoint.
 */
import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";

const MANIFEST_VERSION = "1";

export interface BundleNextResult {
  outFile: string;
  sha256: string;
  entrypoint: string;
}

export async function bundleNextComputeArtifact(
  appDir: string,
  outFile: string,
): Promise<BundleNextResult> {
  const resolvedApp = path.resolve(appDir);
  const resolvedOut = path.resolve(outFile);

  // next.config.ts pins outputFileTracingRoot to the monorepo root, so the
  // standalone nests the app (and server.js) under its path below that root.
  const workspaceRoot = path.resolve(resolvedApp, "../../../..");
  const rel = path.relative(workspaceRoot, resolvedApp);

  const standalone = path.join(resolvedApp, ".next", "standalone");
  const appOut = path.join(standalone, rel);
  if (!fs.existsSync(path.join(appOut, "server.js"))) {
    throw new Error(
      `no standalone server.js at ${appOut} — run \`next build\` with output: "standalone" first`,
    );
  }

  // The standalone build ships server.js + traced node_modules but not the
  // client assets; copy them where server.js serves them from.
  await fs.promises.cp(
    path.join(resolvedApp, ".next", "static"),
    path.join(appOut, ".next", "static"),
    { recursive: true },
  );
  const publicDir = path.join(resolvedApp, "public");
  if (fs.existsSync(publicDir)) {
    await fs.promises.cp(publicDir, path.join(appOut, "public"), { recursive: true });
  }

  const entrypoint = path.join(rel, "server.js");
  await fs.promises.writeFile(
    path.join(standalone, "compute.manifest.json"),
    JSON.stringify({ manifestVersion: MANIFEST_VERSION, entrypoint }, null, 2),
  );

  await fs.promises.mkdir(path.dirname(resolvedOut), { recursive: true });
  await $`tar -czf ${resolvedOut} -C ${standalone} .`;

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(resolvedOut).arrayBuffer());
  return { outFile: resolvedOut, sha256: hasher.digest("hex"), entrypoint };
}

if (import.meta.main) {
  const appDir = process.argv[2];
  const outFile = process.argv[3];
  if (!appDir || !outFile) {
    console.error("Usage: bun scripts/bundle-next.ts <appDir> <outFile>");
    process.exit(1);
  }
  const result = await bundleNextComputeArtifact(appDir, outFile);
  console.log(`Built ${result.outFile}`);
  console.log(`entrypoint: ${result.entrypoint}`);
  console.log(`sha256: ${result.sha256}`);
}
