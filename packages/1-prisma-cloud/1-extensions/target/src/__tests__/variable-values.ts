import { appRoot, Load } from '@internal/core';
import {
  type PlainVariableValue,
  type SecretVariableValue,
  variable,
} from '../platform-variable.ts';

export function plainVariable(name: string): PlainVariableValue {
  let value: PlainVariableValue | undefined;
  Load(
    appRoot('values', ({ provision }) => {
      value = provision(variable({ name }));
    }),
  );
  if (value === undefined) throw new Error(`the root did not provision ${name}`);
  return value;
}

export function secretVariable(name: string): SecretVariableValue {
  let value: SecretVariableValue | undefined;
  Load(
    appRoot('values', ({ provision }) => {
      value = provision(variable.secret({ name }));
    }),
  );
  if (value === undefined) throw new Error(`the root did not provision ${name}`);
  return value;
}
