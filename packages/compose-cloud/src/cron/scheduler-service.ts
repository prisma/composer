// The scheduler's own service.ts: `cronScheduler`'s `build.module` points
// here, and the deploy bootstrap does `import main from <build.module>;
// main.run(address, boot)` — same as an app's own service.ts, whose default
// export is the runnable node an entrypoint drives. A factory barrel with only
// named exports would leave `main` undefined and `main.run()` throw at boot.
// An empty schedule is fine: run() reads the real jobs from the stashed env,
// never from this default.
import { cronScheduler } from './scheduler.ts';

export default cronScheduler<string>({ jobs: [] });
