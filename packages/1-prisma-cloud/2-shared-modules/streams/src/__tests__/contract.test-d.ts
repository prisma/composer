import type { DependencyEnd } from '@internal/core';
import { describe, expectTypeOf, test } from 'vitest';
import type { StreamsConfig, streamsContract } from '../contract.ts';
import { durableStreams } from '../contract.ts';

describe('durableStreams()', () => {
  test('is a DependencyEnd binding StreamsConfig against streamsContract', () => {
    expectTypeOf(durableStreams()).toEqualTypeOf<
      DependencyEnd<StreamsConfig, typeof streamsContract>
    >();
  });

  test('the binding carries the endpoint url and the minted bearer key', () => {
    expectTypeOf<StreamsConfig>().toEqualTypeOf<{
      readonly url: string;
      readonly apiKey: string;
    }>();
  });
});
