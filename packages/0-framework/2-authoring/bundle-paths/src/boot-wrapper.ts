import { build, type Plugin } from 'esbuild';

const ORM_STUB_NAMESPACE = 'composer-wrapper-orm-stub';

/**
 * Replaces every `@prisma/orm-*` import in the wrapper with a module whose exports throw when
 * called. The app's runnable carries its own Prisma ORM, and the ORM refuses to run from two
 * copies in one process (`RUNTIME.MULTIPLE_ORM_COPIES`). The wrapper only declares the service's
 * dependencies and never builds a client, so it needs no ORM of its own.
 */
const ormStub: Plugin = {
  name: 'composer-wrapper-orm-stub',
  setup(builder) {
    builder.onResolve({ filter: /^@prisma\/orm-/ }, (args) => ({
      path: args.path,
      namespace: ORM_STUB_NAMESPACE,
    }));
    builder.onLoad({ filter: /.*/, namespace: ORM_STUB_NAMESPACE }, (args) => {
      const message = JSON.stringify(
        `Composer's boot wrapper does not load Prisma ORM, but it called an export of ${args.path}`,
      );
      // esbuild reads a CommonJS module's named exports through its prototype, so every name
      // resolves on a proxy prototype; the module itself is callable for a default import.
      return {
        loader: 'js',
        contents: [
          `const fail = (key) => () => { throw new Error(${message} + ': ' + String(key)); };`,
          "const names = new Proxy({}, { get: (_, key) => typeof key === 'symbol' || key === 'then' || key === '__esModule' ? undefined : fail(key) });",
          "const stub = function () { fail('default')(); };",
          'Object.setPrototypeOf(stub, names);',
          'module.exports = stub;',
        ].join('\n'),
      };
    });
  },
};

/**
 * Bundles the service module into the boot wrapper `<workDir>/main.mjs` (ADR-0008). `@prisma/*`
 * is inlined except Prisma ORM, which the app's runnable brings; `bun` is a Compute built-in.
 */
export async function buildBootWrapper(serviceModule: string, workDir: string): Promise<void> {
  await build({
    entryPoints: { main: serviceModule },
    outdir: workDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['bun', 'bun:*'],
    outExtension: { '.js': '.mjs' },
    plugins: [ormStub],
  });
}
