/**
 * The family boundary's error translation.
 *
 * The first test is the reason this module exists: composer's error passes the
 * engine's own duck-typed recognition, so an untranslated one is accepted and
 * rendered — and silently loses its `fix`, because the engine has no such
 * field. That failure is invisible from either side on its own, so it is
 * pinned here.
 */
import { describe, expect, test } from 'bun:test';
import { CliStructuredError as ComposerError } from '@internal/foundation/errors';
import { CliStructuredError as EngineError } from '@prisma/cli-engine/protocol';
import { toEngineError } from '../translate-error.ts';

describe('toEngineError()', () => {
  test("composer's error is accepted by the engine untranslated — which is why the fix would vanish", () => {
    const composer = new ComposerError('DEPLOY.STAGE_INVALID', 'Bad stage.', {
      fix: 'Pick a stage name git would accept as a branch name.',
    });
    // The engine would take this error as its own...
    expect(EngineError.is(composer)).toBe(true);
    // ...and find no remediation on it, because composer spells it `fix`.
    expect('nextActions' in composer).toBe(false);
  });

  test('the fix becomes a next action', () => {
    const translated = toEngineError(
      new ComposerError('DEPLOY.STAGE_INVALID', 'Bad stage.', {
        fix: 'Pick a stage name git would accept as a branch name.',
      }),
    );
    expect(translated.nextActions).toEqual([
      { kind: 'user-choice', label: 'Pick a stage name git would accept as a branch name.' },
    ]);
  });

  test('no fix means no next actions — nothing is invented', () => {
    const translated = toEngineError(new ComposerError('DEPLOY.SCOPE_MISSING', 'No stage.'));
    expect(translated.nextActions).toEqual([]);
  });

  test('code, summary, severity, why, where, meta and docsUrl all survive', () => {
    const translated = toEngineError(
      new ComposerError('CONFIG.FIELD_INVALID', '`state` must be a state descriptor.', {
        severity: 'warn',
        why: 'The deploy needs one state store.',
        fix: 'See defineConfig().',
        where: { path: '/app/prisma-composer.config.ts', line: 4 },
        meta: { field: 'state' },
        docsUrl: 'https://example.invalid/errors#CONFIG.FIELD_INVALID',
      }),
    );
    expect(translated.code).toBe('CONFIG.FIELD_INVALID');
    expect(translated.message).toBe('`state` must be a state descriptor.');
    expect(translated.severity).toBe('warn');
    expect(translated.why).toBe('The deploy needs one state store.');
    expect(translated.where).toEqual({ path: '/app/prisma-composer.config.ts', line: 4 });
    expect(translated.meta).toEqual({ field: 'state' });
    expect(translated.docsUrl).toBe('https://example.invalid/errors#CONFIG.FIELD_INVALID');
  });

  test('the original rides along as cause, so nothing about the failure is lost', () => {
    const composer = new ComposerError('DEPS.EXECUTOR_UNLOADABLE', 'Could not load.');
    expect(toEngineError(composer).cause).toBe(composer);
  });

  test('the translated error is an engine error and envelopes as one', () => {
    const envelope = toEngineError(
      new ComposerError('CONFIG.FILE_MISSING', 'No config.', { fix: 'Create one.' }),
    ).toEnvelope();
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('CONFIG.FILE_MISSING');
    expect(envelope.nextActions).toHaveLength(1);
  });
});
