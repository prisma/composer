/**
 * `loadEntry` imports a user's topology with the host runtime's own module
 * loader — under node (the CLI's shebang runtime), that loader strips
 * TypeScript types but has no JSX transform (ADR-0005: the framework
 * doesn't bundle or transform the app's code; deploy loading is no
 * exception). A `.tsx`/`.jsx` file anywhere in the topology's import graph
 * dies with node's raw `ERR_UNKNOWN_FILE_EXTENSION`, which names the file
 * but not the cause or the fix. This turns that one case into structured
 * error parts (summary/why/fix) that do — every other load failure (syntax
 * errors, missing files, non-JSX unknown extensions) is untouched.
 */

const UNKNOWN_EXTENSION_CODE = 'ERR_UNKNOWN_FILE_EXTENSION';
const JSX_EXTENSIONS = ['.tsx', '.jsx'];

function errorCode(error: Error): string | undefined {
  return 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function unknownExtensionPath(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (errorCode(error) !== UNKNOWN_EXTENSION_CODE) return undefined;
  // node's message shape: `Unknown file extension ".tsx" for /abs/path.tsx`
  // — no structured field carries the path, so extract it here rather than
  // re-deriving it (node already resolved it; don't second-guess that).
  const match = /Unknown file extension "\.\w+" for (.+)$/.exec(error.message);
  return match?.[1];
}

export interface JsxLoadErrorParts {
  readonly summary: string;
  readonly why: string;
  readonly fix: string;
}

/**
 * Returns structured error parts when `error` is node's
 * `ERR_UNKNOWN_FILE_EXTENSION` for a `.tsx`/`.jsx` file — `undefined` for
 * every other error (including unknown-extension failures for some other
 * extension), so the caller can fall through to its normal rethrow.
 */
export function explainJsxLoadError(
  error: unknown,
  entryPath: string,
): JsxLoadErrorParts | undefined {
  const offendingPath = unknownExtensionPath(error);
  if (offendingPath === undefined) return undefined;
  if (!JSX_EXTENSIONS.some((ext) => offendingPath.endsWith(ext))) return undefined;

  return {
    summary: `"${offendingPath}" can't be loaded.`,
    why:
      `deploy loads "${entryPath}"'s topology with node's own module loader, which strips ` +
      "TypeScript types but has no JSX transform — so a .tsx/.jsx file can't sit anywhere " +
      'in that import graph.',
    fix:
      'Precompile that file in your own build (transform the JSX away, keep the real npm ' +
      'packages external) and import the compiled output instead of the raw .tsx/.jsx — see ' +
      'examples/email/scripts/build.ts in the prisma/composer repo for a worked example.',
  };
}
