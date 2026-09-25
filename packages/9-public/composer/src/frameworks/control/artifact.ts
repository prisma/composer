import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as NodeServices from '@effect/platform-node/NodeServices';
import {
  assertBundleSymlinksStayInside,
  bundledSourcePaths,
  copyTreeVerbatim,
} from '@internal/bundle-paths';
import type { AssembleInput, Bundle } from '@internal/core/deploy';
import { stageWebsiteArtifact } from 'alchemy/Prisma/Website/Artifact';
import * as Effect from 'effect/Effect';
import { build } from 'esbuild';

export async function assembleFrameworkArtifact(
  input: AssembleInput,
  root: string,
  dist: string,
  serverEntry: string,
  layout: 'next' | 'output',
): Promise<Bundle> {
  const workDir = path.join(input.cwd, '.prisma-composer', 'artifacts', input.address);
  const bundleDir = path.join(workDir, 'bundle');
  await fs.promises.rm(workDir, { recursive: true, force: true });
  await fs.promises.mkdir(bundleDir, { recursive: true });

  const entry = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const staged = yield* stageWebsiteArtifact({
          root,
          distDir: dist,
          serverEntry,
          layout,
        });
        yield* Effect.promise(() => copyTreeVerbatim(staged.directory, bundleDir));
        return staged.entrypoint;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  await assertBundleSymlinksStayInside(bundleDir);

  const wrapper = await build({
    entryPoints: { main: fileURLToPath(input.build.module) },
    outdir: workDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['bun', 'bun:*'],
    outExtension: { '.js': '.mjs' },
    metafile: true,
  });

  return {
    dir: workDir,
    entry: path.posix.join('bundle', entry.replaceAll(path.sep, '/')),
    watch: bundledSourcePaths(wrapper.metafile.inputs, process.cwd()),
  };
}
