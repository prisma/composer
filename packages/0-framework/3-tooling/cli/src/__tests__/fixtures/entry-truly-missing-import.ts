// @ts-nocheck -- fixture for the resolve-hook negative test. Neither
// truly-missing.js nor truly-missing.ts (nor any other TS variant) exists,
// so the hook exhausts all candidates and re-throws the original
// ERR_MODULE_NOT_FOUND error.
export { default } from './truly-missing.js';
