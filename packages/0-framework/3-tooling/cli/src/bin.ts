#!/usr/bin/env node
import { checkEffectResolution } from './check-effect-resolution.ts';
import { CliError } from './cli-error.ts';

// The effect preflight (TML-3158) must run BEFORE the rest of the CLI loads:
// the command modules transitively import alchemy's provider tree, which
// crashes at import time when the installed tree resolves a mismatched
// `effect` — exactly the break the check exists to explain. Hence the argv
// sniff here (only the alchemy-driving commands need a healthy tree; help and
// `log` must keep working in a broken one) and the dynamic import below,
// which keeps that import graph out of this module's static graph.
const command = process.argv[2];
if (command === 'deploy' || command === 'destroy' || command === 'dev') {
  try {
    checkEffectResolution(process.cwd());
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

const { cli } = await import('./cli.ts');
void cli();
