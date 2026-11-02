// Side finding: an ArkType schema with a morph clones its input, which breaks the service serializer's
// identity map from sentinel boxes back to envSecret pointers. Run: bun serializer-morph.ts
// Not type-checked with the probe: the serializer types its node against the built @internal/core, not core's source.
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { secretString } from '../../../../../../packages/0-framework/0-foundation/foundation/src/arktype.ts';
import { service } from '../../../../../../packages/0-framework/1-core/core/src/node.ts';
import { envSecret } from '../../../../../../packages/1-prisma-cloud/1-extensions/target/src/secret.ts';
import { serializeInput } from '../../../../../../packages/1-prisma-cloud/1-extensions/target/src/serializer.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///x.ts',
  entry: 'server.js',
};
const mk = (input: StandardSchemaV1) =>
  service({ name: 'svc', extension: 'p', type: 't', inputs: {}, params: {}, input, build });
for (const [label, schema, binding] of [
  ['no morph', type({ key: secretString() }), { key: envSecret('KEY') }],
  [
    'with morph',
    type({ key: secretString(), n: 'string.integer.parse' }),
    { key: envSecret('KEY'), n: '4' },
  ],
] as const) {
  try {
    console.log(label, '->', serializeInput(mk(schema), 'shop.svc', binding)?.value);
  } catch (e) {
    console.log(label, '-> throws:', (e as Error).message.split('\n')[0]);
  }
}
