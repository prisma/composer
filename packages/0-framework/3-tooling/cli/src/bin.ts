#!/usr/bin/env node
import { cli } from './cli.ts';

// Assigned, not `process.exit()`: the streams the engine wrote to must drain
// before the process ends.
process.exitCode = await cli();
