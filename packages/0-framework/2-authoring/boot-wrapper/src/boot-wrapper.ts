import * as fs from 'node:fs';
import * as path from 'node:path';
import { build, type Plugin } from 'esbuild';

const prismaOrmSpecifier = /^@prisma\/orm-/;
const prismaOrmNamespace = 'prisma-orm-left-to-the-app';

/**
 * Prisma ORM refuses to run when a process has loaded it twice, and the app's
 * own build always carries it, so the wrapper must not. Each ORM import
 * becomes a module that throws, naming the export, the moment the wrapper
 * touches it — never a silent `undefined` (ADR-0064).
 */
const leavePrismaOrmToTheApp: Plugin = {
  name: 'leave-prisma-orm-to-the-app',
  setup(wrapperBuild) {
    wrapperBuild.onResolve({ filter: prismaOrmSpecifier }, ({ path: specifier }) => ({
      path: specifier,
      namespace: prismaOrmNamespace,
    }));
    wrapperBuild.onLoad({ filter: /.*/, namespace: prismaOrmNamespace }, ({ path: specifier }) => ({
      contents: refusingModuleSource(specifier),
      loader: 'js',
    }));
  },
};

function refusingModuleSource(specifier: string): string {
  return `
const refuse = (name) => {
  throw new Error(
    'The boot wrapper used "' + String(name) + '" from ${JSON.stringify(specifier)}, but the wrapper does not carry Prisma ORM. ' +
      'A deployed process loads Prisma ORM once, from the app\\'s own build, so only code that runs in the app may use it. ' +
      'Move this use out of the service module\\'s top level, into code the app runs (ADR-0064).',
  );
};
const missingExport = new Proxy({}, {
  get: (_target, name) => (typeof name === 'symbol' ? undefined : refuse(name)),
});
module.exports = new Proxy(function prismaOrmLeftToTheApp() {}, {
  get: (_target, name) => (typeof name === 'symbol' || name === '__esModule' ? undefined : refuse(name)),
  getPrototypeOf: () => missingExport,
  apply: () => refuse('default'),
  construct: () => refuse('default'),
});
`;
}

/**
 * Builds `<outdir>/main.mjs` from the service module: every import inlined
 * except the runtime's own modules (ADR-0008) and Prisma ORM (ADR-0064).
 */
export async function buildBootWrapper(serviceModule: string, outdir: string): Promise<void> {
  await build({
    entryPoints: { main: serviceModule },
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['bun', 'bun:*'],
    outExtension: { '.js': '.mjs' },
    plugins: [leavePrismaOrmToTheApp],
  });
  if (!fs.existsSync(path.join(outdir, 'main.mjs'))) {
    throw new Error(`esbuild produced no main.mjs in ${outdir}`);
  }
}
