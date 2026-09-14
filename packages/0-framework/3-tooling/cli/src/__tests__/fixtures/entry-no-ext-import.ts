// @ts-nocheck -- fixture for the Node resolve-hook test; uses an extensionless
// specifier for a .ts file. The hook in entry-resolution.ts maps it to
// no-ext-service.ts at runtime. Not typechecked because TypeScript would
// report the module as missing (only the .ts source exists).
export { default } from './no-ext-service';
