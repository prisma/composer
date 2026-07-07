import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { packageComputeArtifact } from "../compute/artifact.ts";

function makeBundle(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

/** Un-gzips and lists the tar entry names + reads one entry's content, without a tar library. */
function readTar(gz: Buffer): { names: string[]; read: (name: string) => string } {
  const tar = zlib.gunzipSync(gz);
  const names: string[] = [];
  const contents = new Map<string, string>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive block
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const name = rawPrefix.length > 0 ? `${rawPrefix}/${rawName}` : rawName;
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim(), 8);
    offset += 512;
    contents.set(name, tar.subarray(offset, offset + size).toString("utf8"));
    names.push(name);
    offset += Math.ceil(size / 512) * 512;
  }
  return { names, read: (name: string) => contents.get(name) ?? "" };
}

describe("packageComputeArtifact", () => {
  test("prints a bootstrap with zero import statements beyond the bundle entry", () => {
    const bundleDir = makeBundle({ "main.js": "export default { run: async () => {} };" });

    const artifact = packageComputeArtifact({ id: "auth", bundleDir, address: "auth" });
    const { read } = readTar(fs.readFileSync(artifact.path));
    const bootstrap = read("bootstrap.js");

    const importLines = bootstrap.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(importLines).toEqual(['import main from "./main.js";']);
    expect(bootstrap).toContain('await main.run("auth");');
  });

  test("writes compute.manifest.json with entrypoint bootstrap.js", () => {
    const bundleDir = makeBundle({ "main.js": "export default {};" });

    const artifact = packageComputeArtifact({ id: "hello", bundleDir, address: "" });
    const { read } = readTar(fs.readFileSync(artifact.path));

    expect(JSON.parse(read("compute.manifest.json"))).toEqual({
      manifestVersion: "1",
      entrypoint: "bootstrap.js",
    });
  });

  test("auto-detects main.mjs when main.js is absent", () => {
    const bundleDir = makeBundle({ "main.mjs": "export default {};" });

    const artifact = packageComputeArtifact({ id: "storefront", bundleDir, address: "storefront" });
    const { read } = readTar(fs.readFileSync(artifact.path));

    expect(read("bootstrap.js")).toContain('import main from "./main.mjs";');
  });

  test("packaging twice with identical inputs yields an identical sha256 (deterministic bytes)", () => {
    const bundleDir = makeBundle({
      "main.js": "export default { run: async () => {} };",
      "nested/asset.txt": "hello",
    });

    const first = packageComputeArtifact({ id: "auth", bundleDir, address: "auth" });
    const second = packageComputeArtifact({ id: "auth", bundleDir, address: "auth" });

    expect(first.sha256).toBe(second.sha256);
    expect(fs.readFileSync(first.path).equals(fs.readFileSync(second.path))).toBe(true);
  });

  test("a different address changes the hash (the bootstrap is address-specific)", () => {
    const bundleDir = makeBundle({ "main.js": "export default {};" });

    const a = packageComputeArtifact({ id: "auth", bundleDir, address: "auth" });
    const b = packageComputeArtifact({ id: "auth", bundleDir, address: "storefront" });

    expect(a.sha256).not.toBe(b.sha256);
  });

  test("packages every bundle file, sorted, alongside the bootstrap and manifest", () => {
    const bundleDir = makeBundle({ "main.js": "export default {};", "b.txt": "b", "a.txt": "a" });

    const artifact = packageComputeArtifact({ id: "auth", bundleDir, address: "auth" });
    const { names } = readTar(fs.readFileSync(artifact.path));

    expect(names).toEqual(["a.txt", "b.txt", "bootstrap.js", "compute.manifest.json", "main.js"]);
  });

  test("a missing bundle dir (destroy before any build) returns a placeholder instead of throwing", () => {
    const artifact = packageComputeArtifact({
      id: "auth",
      bundleDir: path.join(os.tmpdir(), "makerkit-artifact-test-does-not-exist"),
      address: "auth",
    });

    expect(artifact).toEqual({ path: "", sha256: "absent" });
  });
});
