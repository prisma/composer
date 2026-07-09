import { describe, expect, test } from 'bun:test';
import type { StackServices } from 'alchemy';
import type { State } from 'alchemy/State';
import type * as Layer from 'effect/Layer';
import { prismaState } from '../layer.ts';

describe('prismaState', () => {
  test('its signature satisfies core’s LowerOptions.state contract — typechecked, never run (that would touch the cloud)', () => {
    const typed: (opts: { workspaceId: string }) => Layer.Layer<State, never, StackServices> =
      prismaState;
    expect(typed).toBe(prismaState);
  });
});
