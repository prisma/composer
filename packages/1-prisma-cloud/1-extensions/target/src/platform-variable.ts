import {
  type Graph,
  isParamSource,
  isValueResource,
  type ParamSource,
  type Pointer,
  paramSource,
  type RuntimeValue,
  type SecretSource,
  secretSource,
  type ValueResourceNode,
  valueResource,
} from '@internal/core';
import type { SecretString } from '@internal/foundation/secret';
import { isVariableJsonSchema, type VariableJsonSchema } from '@internal/input-document';
import type { StandardJSONSchemaV1 } from '@standard-schema/spec';
import { PRISMA_CLOUD_EXTENSION_ID } from './extension-id.ts';
import { variableJsonSchema } from './variable-json-schema.ts';
import { assertVariableName } from './variable-name.ts';

const PLATFORM_VARIABLE: unique symbol = Symbol.for('prisma:prisma-cloud-platform-variable');

const PLATFORM_VARIABLE_NODE_TYPE = 'platform-variable';

/** The payload of every platform variable value: the variable's name, whether it is a secret, and the JSON Schema of a plain variable that has one. */
export interface PlatformVariablePayload {
  readonly [PLATFORM_VARIABLE]: true;
  readonly name: string;
  readonly secret: boolean;
  readonly schema?: VariableJsonSchema;
}

export type PlainVariableValue<T = string> = ParamSource<PlatformVariablePayload> & RuntimeValue<T>;
export type SecretVariableValue = SecretSource<PlatformVariablePayload> &
  RuntimeValue<SecretString>;

function isPlatformVariablePayload(payload: unknown): payload is PlatformVariablePayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    PLATFORM_VARIABLE in payload &&
    payload[PLATFORM_VARIABLE] === true
  );
}

export function isPlainVariableSource(
  value: unknown,
): value is ParamSource<PlatformVariablePayload> {
  return isParamSource(value) && isPlatformVariablePayload(value.payload);
}

export const bindingPlace = (path: string, address: string): string =>
  path === '' ? `the input of service "${address}"` : `input key "${path}" of service "${address}"`;

const notAPlatformVariable = (where: string): string =>
  `${where} is bound to a source that is not a platform variable. Provision variable() or variable.secret() from @prisma/composer-prisma-cloud in the app root and pass its value down.`;

export function platformVariableName(source: SecretSource | ParamSource, where: string): string {
  if (!isPlatformVariablePayload(source.payload)) throw new Error(notAPlatformVariable(where));
  return source.payload.name;
}

export function platformVariableSchema(source: ParamSource): VariableJsonSchema | undefined {
  return isPlatformVariablePayload(source.payload) ? source.payload.schema : undefined;
}

export interface PlatformVariableNode {
  readonly address: string;
  readonly name: string;
  readonly secret: boolean;
  readonly schema?: VariableJsonSchema;
}

export function platformVariableNodes(graph: Graph): readonly PlatformVariableNode[] {
  return graph.nodes.flatMap(({ id, node }) => {
    const candidate: unknown = node;
    if (
      !isValueResource(candidate) ||
      candidate.extension !== PRISMA_CLOUD_EXTENSION_ID ||
      candidate.type !== PLATFORM_VARIABLE_NODE_TYPE
    ) {
      return [];
    }
    const { name, secret, schema } = candidate.props;
    if (typeof name !== 'string') {
      throw new Error(
        `The platform variable node "${id}" has no name in its props, so Composer cannot tell which platform variable it declares. Build it with variable() or variable.secret().`,
      );
    }
    const declared = { address: id, name, secret: secret === true };
    return [isVariableJsonSchema(schema) ? { ...declared, schema } : declared];
  });
}

function defaultProvisionId(name: string): string {
  return name
    .split('_')
    .filter((part) => part.length > 0)
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join('');
}

function plainVariable(options: {
  readonly name: string;
}): ValueResourceNode<PlainVariableValue<string>>;
function plainVariable<S extends StandardJSONSchemaV1>(options: {
  readonly name: string;
  readonly schema: S;
}): ValueResourceNode<PlainVariableValue<StandardJSONSchemaV1.InferOutput<S>>>;
function plainVariable(options: {
  readonly name: string;
  readonly schema?: unknown;
}): ValueResourceNode<PlainVariableValue<unknown>> {
  const { name } = options;
  assertVariableName(name, 'variable', "variable({ name: 'API_KEY' })");
  const schema = 'schema' in options ? variableJsonSchema(name, options.schema) : undefined;
  return valueResource({
    name: defaultProvisionId(name),
    extension: PRISMA_CLOUD_EXTENSION_ID,
    type: PLATFORM_VARIABLE_NODE_TYPE,
    props: schema === undefined ? { name, secret: false } : { name, secret: false, schema },
    value: paramSource<PlatformVariablePayload, Pointer<unknown>>(
      schema === undefined
        ? { [PLATFORM_VARIABLE]: true, name, secret: false }
        : { [PLATFORM_VARIABLE]: true, name, secret: false, schema },
      { label: `the platform variable "${name}"` },
    ),
  });
}

function secretVariable(options: {
  readonly name: string;
}): ValueResourceNode<SecretVariableValue> {
  const { name } = options;
  assertVariableName(name, 'variable.secret', "variable.secret({ name: 'API_KEY' })");
  if ('schema' in options) {
    throw new Error(
      `variable.secret({ name: "${name}" }) takes no schema. A platform secret's value is always text; check its content in the service's secret field.`,
    );
  }
  return valueResource({
    name: defaultProvisionId(name),
    extension: PRISMA_CLOUD_EXTENSION_ID,
    type: PLATFORM_VARIABLE_NODE_TYPE,
    props: { name, secret: true },
    value: secretSource<PlatformVariablePayload, Pointer<SecretString>>(
      { [PLATFORM_VARIABLE]: true, name, secret: true },
      { label: `the platform secret "${name}"`, secretsKey: name },
    ),
  });
}

/**
 * Declares a platform variable that services read by name at boot. Provision it in the app root and pass its value down. `schema` says what the variable's text holds; without it the value is the text. `variable.secret()` declares a platform secret.
 */
export const variable: typeof plainVariable & { readonly secret: typeof secretVariable } =
  Object.assign(plainVariable, { secret: secretVariable });
