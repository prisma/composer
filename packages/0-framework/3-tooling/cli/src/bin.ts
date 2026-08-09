#!/usr/bin/env node
// The CLI's static import graph is import-light (no alchemy, no effect, no
// executors — pinned by exports/__tests__/cli-import.test.ts), so commands
// that never load the deploy executor (--help included) work even in a tree
// whose installed `effect` mismatches. The executor-loading operations run
// the effect preflight (TML-3158) at dispatch, before importing anything
// that would crash — see operations/shared.ts.
import { cli } from './cli.ts';

void cli();
