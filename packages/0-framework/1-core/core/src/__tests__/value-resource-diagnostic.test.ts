import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';

const fixture = `
import type { Pointer } from '@internal/foundation/pointer';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ServiceNode } from '../exports/index.ts';
import { appRoot, module, paramSource, valueResource } from '../exports/index.ts';

const plain = valueResource({
  name: 'greeting',
  extension: 'test/pack',
  type: 'test-value',
  value: paramSource<{ readonly name: string }, Pointer<string>>({ name: 'GREETING' }),
});
declare const greetingSchema: StandardSchemaV1<{ greeting: string }>;
declare const web: ServiceNode<Record<never, never>, Record<never, never>, Record<never, never>, typeof greetingSchema>;

export const nested = module('nested', ({ provision }) => {
  provision(plain); // module-bare
  provision(plain, { id: 'x' }); // module-id
  provision(web, { input: { greeting: 5 } }); // module-service
});

export const root = appRoot('shop', ({ provision }) => {
  provision(plain, { id: 'x', input: {} }); // root-bad-option
  provision(web, { input: { greeting: 5 } }); // root-service
});
`;

const ONLY_IN_APP_ROOT =
  "Only appRoot() can provision a resource that is a value. Provision it in the app root and pass its value down through this module's input.";

function diagnosticsByMarker(): ReadonlyMap<string, string> {
  const fileName = join(import.meta.dir, 'value-resource-fixture.ts');
  const config = ts.getParsedCommandLineOfConfigFile(
    join(import.meta.dir, '..', '..', 'tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (config === undefined) throw new Error('the package tsconfig.json could not be read');
  const options = { ...config.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === fileName
      ? ts.createSourceFile(name, fixture, languageVersion)
      : getSourceFile(name, languageVersion, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const program = ts.createProgram([fileName], options, host);
  const source = program.getSourceFile(fileName);
  if (source === undefined) throw new Error('the fixture was not compiled');
  const lines = fixture.split('\n');
  const byMarker = new Map<string, string>();
  for (const diagnostic of ts.getPreEmitDiagnostics(program, source)) {
    if (diagnostic.start === undefined) continue;
    const { line } = source.getLineAndCharacterOfPosition(diagnostic.start);
    const marker = /\/\/ (\S+)$/.exec(lines[line] ?? '')?.[1];
    if (marker === undefined) {
      throw new Error(`unexpected diagnostic on line ${line + 1}: ${diagnostic.messageText}`);
    }
    byMarker.set(marker, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
  return byMarker;
}

describe('the compile error for a value resource', () => {
  const diagnostics = diagnosticsByMarker();

  test('in a module() body, provision(value) shows that only appRoot() can provision it', () => {
    expect(diagnostics.get('module-bare')).toContain(ONLY_IN_APP_ROOT);
  });

  test('in a module() body, provision(value, { id }) shows that only appRoot() can provision it', () => {
    expect(diagnostics.get('module-id')).toContain(ONLY_IN_APP_ROOT);
  });

  test('in an appRoot() body, a bad option names the option and not appRoot()', () => {
    const message = diagnostics.get('root-bad-option');
    expect(message).toContain("'input'");
    expect(message).not.toContain('appRoot()');
  });

  test('a bad service call reports the binding that does not fit, in both bodies, and not appRoot()', () => {
    for (const marker of ['module-service', 'root-service']) {
      expect(diagnostics.get(marker)).toBe(
        "No overload matches this call.\n  The last overload gave the following error.\n    Type 'number' is not assignable to type 'InputBinding<string>'.",
      );
    }
  });
});
