// @ts-nocheck -- fixture for the Node tsx-runner test; uses a .js
// specifier for a .ts file. tsx maps it to js-ext-service.ts at runtime.
// Not typechecked because TypeScript would report the .js file as missing
// (it doesn't exist; only the .ts does).
export { default } from './js-ext-service.js';
