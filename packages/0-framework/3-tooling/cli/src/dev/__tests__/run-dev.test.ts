import { describe, expect, test } from 'bun:test';
import { renderFrontDoor } from '../run-dev.ts';

describe('renderFrontDoor()', () => {
  test('starts with "[dev] ready:", then orders by address depth (fewest dots first), then lexicographic', () => {
    const lines = renderFrontDoor([
      { address: 'storefront.web', url: 'http://localhost:3002' },
      { address: 'web', url: 'http://localhost:3000' },
      { address: 'api', url: 'http://localhost:3001' },
      { address: 'storefront.admin', url: 'http://localhost:3003' },
    ]);

    expect(lines).toEqual([
      '[dev] ready:',
      '[dev] api  http://localhost:3001',
      '[dev] web  http://localhost:3000',
      '[dev] storefront.admin  http://localhost:3003',
      '[dev] storefront.web  http://localhost:3002',
    ]);
  });

  test('an empty endpoint list still prints the ready line alone', () => {
    expect(renderFrontDoor([])).toEqual(['[dev] ready:']);
  });
});
