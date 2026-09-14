/**
 * The family boundary's error translation.
 *
 * Composer and the engine each carry a class called `CliStructuredError`, both
 * descended from the same prisma/prisma foundation, and both recognize errors
 * by duck-typing on `name === 'CliStructuredError'`. That means a composer
 * error handed to the engine untranslated is ACCEPTED — it does not fail
 * loudly, it renders. What it loses is its `fix`: composer's foundation
 * carries remediation as one prose string on that field, the engine carries it
 * as a `nextActions` list and has no `fix` at all, so the fix text is dropped
 * silently and the user is told what broke with no word on what to do about
 * it. Nothing about that failure is visible without a test that looks for the
 * fix on the other side, which is why there is one.
 *
 * Everything else on the envelope survives as-is; only remediation changes
 * representation.
 */
import { CliStructuredError, type NextAction } from '@prisma/cli-engine/protocol';

/**
 * Composer's own class of the same name — referenced through an inline import
 * type rather than an import alias so the two same-named classes cannot be
 * confused at a use site: the bare name is always the engine's.
 */
type ComposerError = import('@internal/foundation/errors').CliStructuredError;

/**
 * Composer's `fix` is free prose — "add this overrides block and reinstall",
 * "run the build, then retry" — with no machine-readable command inside it.
 * `user-choice` is the engine's own kind for exactly that (it is what the
 * engine uses for its own config and prompt failures), so the text carries
 * over verbatim as one action rather than being parsed into a command the
 * author never wrote.
 */
function fixAsNextActions(fix: string | undefined): readonly NextAction[] {
  return fix === undefined ? [] : [{ kind: 'user-choice', label: fix }];
}

/** Translates a composer failure into the engine's error type. Composer-side detail — `meta`, `where`, `docsUrl` — rides along untouched. */
export function toEngineError(error: ComposerError): CliStructuredError {
  return new CliStructuredError(error.code, error.message, {
    severity: error.severity,
    nextActions: fixAsNextActions(error.fix),
    ...(error.why === undefined ? {} : { why: error.why }),
    ...(error.where === undefined ? {} : { where: error.where }),
    ...(error.meta === undefined ? {} : { meta: error.meta }),
    ...(error.docsUrl === undefined ? {} : { docsUrl: error.docsUrl }),
    cause: error,
  });
}
