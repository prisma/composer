import { CliStructuredError, notOk, ok, type Result } from '@prisma/cli-engine/protocol';
import type { DestroyTarget } from '../operations/destroy.ts';

/**
 * `destroy`'s target, from its two mutually exclusive flags. Kept out of the
 * grammar because the engine's flag layer has no "exactly one of these"
 * construct — and because both wrong shapes need their own remedy, which a
 * generic arity error could not give.
 */
export function targetOf(
  stage: string | undefined,
  production: boolean,
): Result<DestroyTarget, CliStructuredError> {
  if (stage !== undefined && production) {
    return notOk(
      new CliStructuredError(
        'DEPLOY.TARGET_CONFLICT',
        'Pass either --stage <name> or --production to `destroy`, not both.',
      ),
    );
  }
  if (stage === undefined && !production) {
    return notOk(
      new CliStructuredError('DEPLOY.TARGET_MISSING', '`destroy` requires an explicit target.', {
        nextActions: [
          {
            kind: 'user-choice',
            label:
              'Pass --stage <name> to tear down a branch environment, or --production to tear ' +
              'down the production environment.',
          },
        ],
      }),
    );
  }
  return ok(stage !== undefined ? { kind: 'stage', stage } : { kind: 'production' });
}
