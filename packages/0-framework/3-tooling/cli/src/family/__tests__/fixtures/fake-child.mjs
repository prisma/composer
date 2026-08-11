#!/usr/bin/env node
// The scripted fake child (contract R-S3-5): a real program for spawn tests
// to run instead of alchemy. Its whole behavior is declared on argv, so a
// test states the child it needs and asserts what came back:
//
//   --exit <n>         exit with code n (default 0)
//   --stdout <text>    write text + newline to stdout, unframed
//   --stderr <text>    write text + newline to stderr
//   --report-env <k>   write "env:<k>=set" or "env:<k>=unset" to stdout —
//                      key presence only, never the value (the credential
//                      tests assert env KEYS, never token material)
//   --linger           stay alive until a signal arrives
//   --on-signal <mode> with --linger: "exit" (default) dies by the signal's
//                      default disposition; "ignore" swallows SIGINT/SIGTERM
//                      and keeps lingering (the escalation-ladder case);
//                      "report" writes "signal:<name>" to stdout, then exits 0
//
// Plain JS on purpose: it is spawned as a real operating-system child, so it
// must run with no transpilation under whatever runtime the suite spawns.

const args = process.argv.slice(2);

function argValue(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const stdout = argValue('--stdout');
if (stdout !== undefined) process.stdout.write(`${stdout}\n`);

const stderr = argValue('--stderr');
if (stderr !== undefined) process.stderr.write(`${stderr}\n`);

const envKey = argValue('--report-env');
if (envKey !== undefined) {
  process.stdout.write(`env:${envKey}=${envKey in process.env ? 'set' : 'unset'}\n`);
}

if (args.includes('--linger')) {
  const onSignal = argValue('--on-signal') ?? 'exit';
  if (onSignal === 'ignore') {
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
  } else if (onSignal === 'report') {
    const report = (name) => {
      process.stdout.write(`signal:${name}\n`);
      process.exit(0);
    };
    process.on('SIGINT', () => report('SIGINT'));
    process.on('SIGTERM', () => report('SIGTERM'));
  }
  // With mode "exit" no handler is installed: the signal's default
  // disposition kills the process, which is what a signal-killed child is.
  setInterval(() => {}, 1 << 30);
} else {
  process.exitCode = Number(argValue('--exit') ?? '0');
}
