// @ts-nocheck -- fixture for the Node resolve-hook test; uses a .mjs
// specifier for a .mts file. The hook in entry-resolution.ts maps it to
// mjs-ext-service.mts at runtime.
export { default } from './mjs-ext-service.mjs';
