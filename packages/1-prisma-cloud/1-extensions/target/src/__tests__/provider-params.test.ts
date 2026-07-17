import { describe, expect, test } from 'bun:test';
import { PROVIDER_PARAMS } from '../control.ts';
import { RESERVED_PROVIDER_PARAMS } from '../provider-params.ts';

describe('the deploy-side registry (control.ts) and the boot-side list (provider-params.ts) name the same params', () => {
  test('every param control.ts registers for deploy is also in the boot-side list, and nothing else is', () => {
    // If a brand is registered for deploy but missing here, deploy writes its
    // row and boot never stashes it: the runtime reader that owns that slot
    // silently sees nothing, which for rpc's accepted keys means fail-open.
    const deploySide = [...PROVIDER_PARAMS.values()].map((entry) => entry.name).sort();
    const bootSide = RESERVED_PROVIDER_PARAMS.map((entry) => entry.name).sort();
    expect(bootSide).toEqual(deploySide);
  });
});
