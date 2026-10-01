import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { blamesEffect } from './effect-blame.mjs';

const effect = { Schema: { make: () => undefined }, Layer: {} };

describe('blamesEffect', () => {
  it('blames effect for a missing member of a module effect exports', () => {
    const error = new TypeError('Schema.TaggedError is not a function');
    assert.equal(blamesEffect(error, effect), true);
  });

  it('does not blame effect for a module effect does not export', () => {
    const error = new TypeError('Frobnicate.run is not a function');
    assert.equal(blamesEffect(error, effect), false);
  });

  it('does not blame effect when the member exists', () => {
    const error = new TypeError('Schema.make is not a function');
    assert.equal(blamesEffect(error, effect), false);
  });

  it('blames effect for a missing export of an effect module specifier', () => {
    const error = new SyntaxError(
      "The requested module 'effect/Schema' does not provide an export named 'TaggedError'",
    );
    assert.equal(blamesEffect(error, effect), true);
  });

  it('blames effect when the stack runs through an effect package under node_modules', () => {
    const error = new TypeError('cannot read x');
    error.stack = 'TypeError: cannot read x\n    at /app/node_modules/effect/dist/Schema.js:1:1';
    assert.equal(blamesEffect(error, effect), true);
  });

  it('ignores "effect" in a directory name outside node_modules', () => {
    const error = new TypeError('Alchemy.thing is not a function');
    error.stack = `${error.message}\n    at /tmp/npm-effect-check-1/node_modules/alchemy/lib/a.js:1:1`;
    assert.equal(blamesEffect(error, effect), false);
  });
});
