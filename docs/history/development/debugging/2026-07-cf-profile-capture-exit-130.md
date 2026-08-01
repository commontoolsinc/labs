---
status: historical
created: 2026-07-18
archived: 2026-07-18
reason: "Root cause of the July 2026 cf-profile capture exit-130 CI flake and the fix that shipped."
---

# `cf-profile.test.ts` "captures a CPU profile for CLI help" exits 130 (July 2026)

A flaky failure in the `deno.yml` workflow. It is timing-sensitive and surfaces
only under the parallelism and load of a CI runner; it did not reproduce on an
unloaded developer machine at anything above a fraction of a percent. A sibling
flake investigated on the same branch is recorded in
[2026-07-group-chat-idempotency-false-positive.md](2026-07-group-chat-idempotency-false-positive.md).

## Symptom

In a sharded "Test" job the test failed with:

```
error: AssertionError: Values are not equal: cf-profile: writing CPU profile to /tmp/cf-profile-test-<hash>/profile.cpuprofile
...
    [Diff] Actual / Expected
-   130
+   0
```

The CPU profile was written successfully (`profile: profile stop matched`, the
metadata file, and the three `cf-profile:` summary lines all appear in the
captured output). Only the process exit code was wrong: `assertEquals(result.code, 0)`
saw `130`, which is `128 + 2`, a termination by SIGINT.

## The three processes

`cf-profile` (`packages/cli/support/profiling/cf-profile.ts`) drives two child
processes:

- the profiled CLI, run with `--inspect-wait` so it pauses until a debugger
  connects, and
- a one-shot capture process (`capture-deno-inspector-profile.ts`) that connects
  to the CLI's inspector, starts the CPU profiler, watches the CLI's console
  output for a stop pattern, then stops the profiler and writes the profile.

When the profiled CLI finishes, it prints `Waiting for the debugger to
disconnect...`. `cf-profile` watches for that line and sends a stop signal to the
capture process to tell it to wrap up. That stop signal is essential for commands
that never emit a stop pattern; it is the only signal that the CLI is done.

## Root cause

The 130 is the **capture** process being killed by that stop signal (SIGINT at
the time of the failure).

`captureDenoInspectorProfile` installs its own SIGINT/SIGTERM handlers so a
signal drives a graceful stop, and it removes those handlers in its outer
`finally` as it returns — the library is also called in-process by unit tests,
which assert the handlers are unregistered, so it must clean them up. The
entry point then calls `Deno.exit(exitCode)`.

That leaves a small window: after the handlers are removed and before
`Deno.exit` runs, the default signal disposition (terminate) is back in force.
Under load, the CLI's `Waiting for the debugger to disconnect...` line can reach
`cf-profile` late — after the capture has already matched the stop pattern via
the inspector channel, written the profile, closed the inspector socket, and
removed its handlers. The stop signal then lands in that window and terminates
the capture with 130. `cf-profile` propagates a non-zero capture status as its
own exit code, so a successful profiling run reports failure.

This was confirmed by isolating the pieces: a Deno process under `--inspect-wait`
exits 0 on both a clean and an abrupt inspector disconnect, and exits 130 only
when it receives SIGINT directly; `ChildProcess.kill(pid, signal)` targets a
single process, so the profiled CLI never receives the capture's signal.
Two earlier commits (#4524, #4526) narrowed this same window; this residual
window is the part they did not close.

## Fix

The capture handles SIGINT and SIGTERM identically, so cf-profile's stop signal
was moved to SIGTERM (`CAPTURE_STOP_SIGNAL`), and `guardCaptureStopSignal`
installs a no-op listener for that one signal in the capture entry point that
stays for the whole process lifetime. A signal fires every registered listener,
so the capture's own graceful-stop handler is unaffected while installed; once it
is removed, the entry-point guard keeps the default terminate disposition
disabled for SIGTERM, so a late stop signal cannot turn a written profile into a
128+signal exit. The process always exits with the code the capture logic chose.

SIGINT is deliberately left unguarded. Guarding it would swallow an interactive
Ctrl-C for the whole run, so a user could not force-kill the process if it hung
after the capture removed its own handlers. Sending the programmatic stop as
SIGTERM keeps Ctrl-C as a manual escape hatch while still closing the flake's
window.

The exit window is between the library returning and `Deno.exit`, outside any
seam the library exposes, so it cannot be driven deterministically from a test
the way the earlier close-window race could. The regression guard is therefore a
deterministic unit test of `guardCaptureStopSignal` (it registers a benign
handler for the stop signal only — not SIGINT — and tolerates a platform without
signal support), matching the earlier fixes' pattern of testing the mechanism
rather than racing the window.
