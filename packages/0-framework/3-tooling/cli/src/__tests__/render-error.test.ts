import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import { renderErrorEnvelope } from '../render-error.ts';

describe('renderErrorEnvelope()', () => {
  test('the four-line layout: summary+code, then indented Why/Fix/Where', () => {
    const envelope = new CliStructuredError('CONFIG.FILE_MISSING', 'No config file found', {
      why: 'The deploy needs the app config.',
      fix: 'Create one next to the entry.',
      where: { path: '/repo/app' },
    }).toEnvelope();

    expect(renderErrorEnvelope(envelope)).toBe(
      [
        '✖ No config file found (CONFIG.FILE_MISSING)',
        '  Why: The deploy needs the app config.',
        '  Fix: Create one next to the entry.',
        '  Where: /repo/app',
      ].join('\n'),
    );
  });

  test('a bare summary renders one line', () => {
    const envelope = new CliStructuredError(
      'DEPLOY.ENGINE_FAILED',
      'alchemy deploy exited with status 1.',
    ).toEnvelope();
    expect(renderErrorEnvelope(envelope)).toBe(
      '✖ alchemy deploy exited with status 1. (DEPLOY.ENGINE_FAILED)',
    );
  });

  test('a where with a line renders path:line', () => {
    const envelope = new CliStructuredError('COMPOSE.ENTRY_UNLOADABLE', 'Failed to import', {
      where: { path: '/app/service.ts', line: 3 },
    }).toEnvelope();
    expect(renderErrorEnvelope(envelope)).toBe(
      ['✖ Failed to import (COMPOSE.ENTRY_UNLOADABLE)', '  Where: /app/service.ts:3'].join('\n'),
    );
  });

  test('meta and docsUrl are not rendered', () => {
    const envelope = new CliStructuredError('DEPS.EFFECT_VERSION_CONFLICT', 'Dependency conflict', {
      meta: { found: 'a', required: 'b' },
      docsUrl: 'https://example.com',
    }).toEnvelope();
    const rendered = renderErrorEnvelope(envelope);
    expect(rendered).not.toContain('example.com');
    expect(rendered).not.toContain('required');
  });
});
