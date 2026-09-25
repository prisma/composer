/**
 * `@prisma/composer/frameworks/control` stages framework output through
 * alchemy's `alchemy/Prisma/Website/Artifact` subpath, a deep import rather
 * than one of alchemy's headline entries. Typecheck already pins its types;
 * this loads the BUILT control entry for real, so an upstream export-map
 * change surfaces here instead of at a user's first framework deploy.
 */
import { describe, expect, test } from 'bun:test';

describe('@prisma/composer/frameworks/control', () => {
  test('loads against the pinned alchemy, resolving its website-artifact subpath', async () => {
    const { frameworkBuild } = await import('@prisma/composer/frameworks/control');
    const descriptor = frameworkBuild();

    expect(descriptor.id).toBe('@prisma/composer/frameworks');
    expect(descriptor.nodes['framework']?.kind).toBe('build');
  });
});
