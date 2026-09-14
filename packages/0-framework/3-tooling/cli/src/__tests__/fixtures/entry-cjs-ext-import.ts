// @ts-nocheck -- fixture for the Node resolve-hook test; uses a .cjs
// specifier for a .cts file. The hook in entry-resolution.ts maps it to
// cjs-ext-service.cts at runtime.
export { default } from './cjs-ext-service.cjs';
