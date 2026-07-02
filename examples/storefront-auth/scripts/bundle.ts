/**
 * Builds a Prisma Compute deploy artifact from a Bun entrypoint.
 *
 * Reproduces what `prisma compute deploy` does:
 * 1. Bundles the entrypoint for the `bun` target with an external sourcemap.
 * 2. Writes a `compute.manifest.json` next to the bundle.
 * 3. Packs the staging directory into a gzipped tarball.
 *
 * Returns the sha256 of the produced tarball, which the `Deployment` Compute
 * resource in `@makerkit/prisma-alchemy` takes as its `artifactHash` prop.
 */
import { $ } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface BundleComputeArtifactOptions {
  /** Path to the app's entrypoint, e.g. `src/index.ts`. */
  entry: string;
  /** Path the final `.tar.gz` artifact should be written to. */
  outFile: string;
}

export interface BundleComputeArtifactResult {
  outFile: string;
  sha256: string;
}

const MANIFEST_VERSION = "1";
const BUNDLE_BASENAME = "index";

export async function bundleComputeArtifact(
  options: BundleComputeArtifactOptions,
): Promise<BundleComputeArtifactResult> {
  const entry = path.resolve(options.entry);
  const outFile = path.resolve(options.outFile);

  const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), "compute-artifact-"));

  try {
    const build = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      sourcemap: "external",
      outdir: staging,
      naming: `${BUNDLE_BASENAME}.js`,
    });

    if (!build.success) {
      const messages = build.logs.map((log) => log.message).join("\n");
      throw new Error(`Bun.build failed for ${entry}:\n${messages}`);
    }

    const entrypoint = `${BUNDLE_BASENAME}.js`;
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      entrypoint,
    };
    await fs.promises.writeFile(
      path.join(staging, "compute.manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
    await $`tar -czf ${outFile} -C ${staging} .`;

    const sha256 = await hashFile(outFile);
    return { outFile, sha256 };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

async function hashFile(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(file).arrayBuffer());
  return hasher.digest("hex");
}

if (import.meta.main) {
  const entry = process.argv[2];
  const outFile = process.argv[3];

  if (!entry || !outFile) {
    console.error("Usage: bun scripts/bundle.ts <entry> <outFile>");
    process.exit(1);
  }

  const result = await bundleComputeArtifact({ entry, outFile });
  console.log(`Built ${result.outFile}`);
  console.log(`sha256: ${result.sha256}`);
}
