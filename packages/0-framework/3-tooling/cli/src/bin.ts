#!/usr/bin/env node
import { checkEffectResolution } from './check-effect-resolution.ts';
import { CliError } from './cli-error.ts';

// The effect preflight (TML-3158) must run BEFORE the rest of the CLI loads:
// the command modules transitively import alchemy's provider tree, which
// crashes at import time when the installed tree resolves a mismatched
// `effect` — exactly the break the check exists to explain. The dynamic import
// below keeps that graph out of this module's static graph, so the check gets
// to run first. It guards every command, not just the deploying ones: the
// graph loads whatever the argv says, so `--help` crashes in a broken tree too
// (proved by the adversarial shape in scripts/check-npm-effect-resolution.mjs).
try {
  checkEffectResolution(process.cwd());
} catch (error) {
  if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const { cli } = await import('./cli.ts');
void cli();
