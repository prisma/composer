import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const pkgDir = path.join(import.meta.dir, "..", "..");
const srcDir = path.join(pkgDir, "src");

// All shipped source files: every .ts under src, excluding __tests__.
function shippedSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push({ file: path.relative(srcDir, full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(srcDir);
  return out;
}

describe("entry map: the pack splits into authoring + target only", () => {
  test("package.json exports exactly '.' and './target' — no runtime entry", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./target"]);
  });
});

describe("invariant 2: authoring imports stay lean (core + pack)", () => {
  test("bundling both authoring entries yields no control/execution-plane tokens", async () => {
    const out = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixtures", "probe-authoring.ts")],
      target: "bun",
    });
    expect(out.success).toBe(true);

    const js = await out.outputs[0].text();
    // Positive marker: the probe genuinely bundled the pack's vocabulary.
    expect(js).toContain("prisma-cloud/postgres");
    for (const token of [
      "alchemy",
      "effect",
      "prisma-alchemy",
      "new SQL(",
      "ProviderCollection",
      'from "bun"',
      '"node:', // a node:-scheme import always appears quoted in a bundle
    ]) {
      expect(js).not.toContain(token);
    }
  });
});

describe("invariant 4: exactly one environment read — inside the ConfigAdapter", () => {
  test("the process-env token appears exactly once in the pack's src, in the adapter", () => {
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(0);

    const token = ["process", "env"].join(".");
    const hits = sources.flatMap(({ file, text }) => {
      const count = text.split(token).length - 1;
      return count > 0 ? [{ file, count }] : [];
    });

    expect(hits).toEqual([{ file: "compute.ts", count: 1 }]);
  });
});

describe("invariant 5: no runtime coupling in shipped surface", () => {
  test("src contains no bun or node imports, type-only included", () => {
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(0);

    const importPattern = /(from\s+|import\s*\(\s*|require\s*\(\s*)["'](bun|bun:[^"']*|node:[^"']*)["']/;
    for (const { file, text } of sources) {
      expect({ file, hasRuntimeImport: importPattern.test(text) }).toEqual({
        file,
        hasRuntimeImport: false,
      });
    }
  });

  test("src uses no ambient runtime globals (Bun./Deno.)", () => {
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(0);

    const globalPattern = /\b(Bun|Deno)\./;
    for (const { file, text } of sources) {
      expect({ file, usesRuntimeGlobal: globalPattern.test(text) }).toEqual({
        file,
        usesRuntimeGlobal: false,
      });
    }
  });

  test("package.json runtime deps name no bun or node package", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const runtimeDeps = Object.keys({
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    });

    for (const dep of runtimeDeps) {
      expect(dep).not.toBe("bun");
      expect(dep).not.toMatch(/^@types\/(bun|node)$/);
      expect(dep).not.toMatch(/^node(-|:)/);
    }
  });
});
