# ADR-0067: `prisma dev` converges in a new worker thread of the `prisma` process

## Decision

Each converge of `prisma dev`, the first one and every rebuild, runs in a new worker thread (`node:worker_threads`) of the process that runs `dev`. `dev` writes no `.prisma-composer/dev/<environment>/alchemy.run.ts`, writes no app configuration file, and starts no Alchemy child.

```ts
// main thread, once per converge: holds the one-converge flag and the working directory while the worker runs
const result = await runDevConvergeInWorker(job, { onEvent, output }, signal);

// the worker: it imports the app as it is on disk now
const config = (await import(job.configFile)).default.composer;
const { root } = await loadEntry(job.entry);
const { lower, converge, localTargetProviders, devState } = await loadAppConvergeEntry(job.appDir);
// stops here, without converging, when the app's reads of platform variables differ from those at start
const stack = lower(root, config, {
  name, environment, appConfigurationRead, bundles, unassembled, firstProcessNodeAddresses,
  containers, preflightPayloads,                  // decoded from the job
  providers: localTargetProviders(resolved, containers, devDir, plainVariableText, namedSecrets),
  state: devState(),
});
const outcome = await converge({ operation: 'deploy', stack, stage: environment, cwd, signal });
postMessage({ kind: 'result', result: { /* the outcome, and the app files the import loaded */ } });
```

This extends [ADR-0066](ADR-0066-deploy-runs-alchemy-in-process.md) to `prisma dev`, and supersedes [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) for it. `destroy` keeps the generated stack file and the Alchemy child until it moves.

- **The worker loads everything that is made of code.** It imports the `composer` section of `prisma.config.ts`, the app entry and the app's converge entry, resolves the local targets, calls `lower()`, and plans and applies. It ends when the converge ends. This is what the generated dev stack file did in the Alchemy child.
- **The main thread sends only plain data.** The job holds file paths, the name and environment, what Load read from the app configuration, the bundles, the list of services that run a dev server, each container in the text form its descriptor serializes, the preflight payloads, the dev environment directory, the text of each plain platform variable, the named secrets, the first Load's node addresses, and the reads of platform variables in the graph `dev` started with. It crosses as the worker's `workerData`, in memory. No file and no environment variable carries a value or a secret. A root input value must therefore be one the structured clone algorithm can copy.
- **Three kinds of message come back.** The worker posts each converge event, each piece of Alchemy's terminal text, and last one result: the converge's outcome, or the error that stopped it, or the changed reads of platform variables, each with the app files its import loaded. The main thread reports them exactly as it reports a deploy's ([ADR-0066](ADR-0066-deploy-runs-alchemy-in-process.md)): events become steps, text becomes redacted messages, and a failed converge is `DEV.CONVERGE_FAILED`, which carries the tag and message of each error the engine failed with. A structured error raised before the converge, such as an entry that does not load, keeps its own code, reason and fix: it fails the first converge under that code, and a rebuild reports it and keeps watching.
- **What the app prints in the worker is redacted.** Every `console` method that can print, and every write to `process.stdout` and `process.stderr` in the worker, becomes a message to the main thread, which reports it redacted. That includes a method a runtime adds later and a method imported by name from `node:console`. The inspector's methods that print nothing to a terminal (`context`, `createTask`, `profile`, `profileEnd`, `record`, `recordEnd`, `screenshot`, `timeStamp`) keep their own behaviour. Under Node the worker's standard streams are also piped to the main thread. Code that writes straight to a file descriptor, such as `fs.writeSync(1, …)` or a logger with its own destination, is out of reach, as a provider that writes to `process.stdout` directly is for `deploy` (ADR-0066).
- **The main thread holds the process for the worker.** A worker cannot change the working directory, and the one-converge flag of ADR-0066 lives on each thread's own `globalThis`. So for the worker's lifetime the main thread holds the flag and changes the process's working directory to the directory `dev` runs in, and restores both on every exit path. A deploy and a dev converge in one process therefore still refuse each other: the second one fails with `DEPLOY.CONVERGE_RUNNING` or `DEV.CONVERGE_RUNNING`. The check inside the converge that refuses a worker whose working directory is not the process's is unchanged.
- **Ctrl-C asks the worker to stop.** A caller's abort signal does the same during the first converge; after the session has started, it stops the session as `stop()` does. The main thread posts an abort message; the worker aborts its converge and posts the outcome `interrupted`. If the worker does not answer within 30 seconds, the main thread ends it and reports a failure that says the converge did not stop. `dev` keeps its state in a local file store and holds no lease, so nothing stays locked; what a worker ended that way can leave is local state that does not record everything it changed. A worker that exits or fails without an outcome is a failed converge that names what happened.
- **An edit to an app definition file rebuilds and converges.** `dev` watches the entry and every file of the app the entry loaded; the worker reports the files its import loaded, so a file that an edit newly imports is watched from then on, also when that import fails because the file is missing or does not parse. For a missing file, `dev` watches every file the entry resolve hook would try for that import, so `./helpers` and `./helpers.js` watch `helpers.ts` too, also when the file's directory does not exist yet. For an import that names a directory it watches the directory's `index.ts`, never the directory. One case still needs a restart under Bun: Bun keeps a failed lookup of a directory import, such as `./lib`, for as long as the process runs, so creating `lib/index.ts` afterwards does not help a later worker, and the rebuild says to restart `prisma dev`. The next converge runs in a new worker, which has its own module cache, so it imports the edited files. This amends [ADR-0056](ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md): an edit that keeps the app's nodes and its reads of platform variables needs no restart. The next two points are the edits that still do.
- **The main thread's own graph is still the one it started with.** The main thread imports the app once, so the session's view of the app (which services exist and which run a dev server) does not change after an edit; only the set of watched app files grows, as the point above says. An edit that keeps the set of nodes and the platform variables the app reads applies in full. An edit that adds or removes a node fails the rebuild, because `lower()` in the worker refuses a graph whose node addresses differ from the first Load's, and `dev` says to restart. So does an edit that makes the root pass on an input field it did not pass on at start, because the main thread read the app configuration only for the fields the first Load asked for; core refuses the field when the worker loads the app. `main` had the same limit before this decision.
- **The worker checks the platform variables the app reads.** A rebuild runs no dev preflight, so a read that an edit adds would have no value ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)). The job carries the reads of the graph `dev` started with. Before it converges, the worker compares them with the reads of the graph it just loaded, and on a difference it does not converge: `dev` emits `value-reads-changed` and pauses rebuilds until it is restarted. Before this decision the comparison ran in the first process, which held the modules loaded at start and so never saw such an edit.

## Reasoning

- **Node and Bun cache imported modules.** In one thread, importing an edited definition file again returns the code loaded at start. The Alchemy child hid this, because every converge was a new process. A converge on the main thread would re-apply the graph loaded at start.
- **The graph cannot be handed between threads or processes.** A loaded app is made of functions: module bodies, `resolve()` callbacks, Standard Schemas, contract checks, and nodes recognised by symbols. None of that survives a copy. And `lower()` takes the root module and runs Load on it again, so whatever runs the converge needs the imported code itself. The fresh import and the converge must run in the same place.
- **A new worker thread has its own module cache,** under Node 24 and Bun 1.3 alike. It imports the app as it is on disk and shares nothing with the main thread but the process.
- **`dev` needs no credentials.** The local target talks to local emulators, so the caller's API client of ADR-0066, which cannot be copied to a worker, does not have to cross. `deploy` stays on the main thread, where that client lives.

## Consequences

- `dev` and `deploy` run the same converge code in different places: `deploy` on the main thread, `dev` in a worker.
- While a dev converge runs, the process's working directory is the directory `dev` runs in. A host that calls the `dev` operation with another `cwd` sees its own working directory change for the length of each converge, the first and every rebuild, and restored after it.
- The worker is a file of its own in the built packages (`dev-converge-worker`), found beside the code that starts it.
- `PRISMA_COMPOSER_NAMED_SECRETS` and the dev app configuration file are gone. This amends [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md), [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) and [ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md): under `prisma dev` the named secrets and the text of each plain platform variable reach the local target as values in memory.
- `dev` still refuses a root input field or a plain platform variable that holds a known secret (`CONFIG.SECRET_AS_PLAIN_VALUE`), before each converge, because the local target gives those values to the services as plain configuration.
- Warnings the runtime prints while the worker imports the app now appear as `dev` messages.
- Core's two refusals of a graph that differs from the first Load's each have a name a caller can test, exported from `@prisma/composer/deploy`: `GRAPH_CHANGED_ERROR` for a node added or removed, and `ROOT_INPUT_UNREAD_ERROR` for a root input field the first Load did not read. `prisma dev` recognises both on a rebuild and says to restart; for the second it adds core's sentence, which names the field. Under `deploy` each is one reason of the engine's failure, tagged with its name; the second was tagged `COMPOSE.GRAPH_INVALID` before.
- The reads of platform variables are compared through core's `comparableProps`, exported from `@prisma/composer/deploy`, which turns a node's props into plain data that keeps what distinguishes two values, so the comparison gives the same answer on both sides of the thread boundary.
- Only `destroy` still uses the app configuration file and the generated stack file.

## Alternatives considered

- **Load the app in a short-lived child or worker that hands the graph back, and converge on the main thread.** The graph is not data and `lower()` needs the code, as above.
- **A child process per converge.** It works, and it is what `dev` did before. It adds a spawn, a protocol between processes and exit codes, for nothing the worker lacks.
- **Tell the user to restart `dev` after a definition edit.** `dev` keeps emulators and services running, possibly detached, and a wiring edit applied live before; a restart for every such edit is a step back.
- **Import the edited files again on the main thread with a changed URL or a loader hook.** Node has such hooks and Bun does not, and every reload would leave the earlier copy of each module in memory.

## Related

- [ADR-0066](ADR-0066-deploy-runs-alchemy-in-process.md): `deploy` runs Alchemy in the `prisma` process.
- [ADR-0056](ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md): what `dev` runs and what it watches.
- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md): local dev runs the deploy pipeline against local providers.
- [Local dev](../10-domains/local-dev.md).
