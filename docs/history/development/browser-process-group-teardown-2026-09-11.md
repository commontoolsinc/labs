---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Follow-up capture of orphan renderer pipe retention and process-group cleanup validation."
---

# Browser process-group teardown follow-up, 2026-09-11

A follow-up to the [initial investigation](browser-teardown-investigation-2026-09-11.md)
found an additional reason root-only termination is insufficient. This work is
part of [PR 7342](https://github.com/commontoolsinc/labs/pull/7342), based on
`be73306e5ee16d0e5a26fd8c6c9d1e29c6c5c19d`. The initial investigation's base and
failed attempts remain in its frozen report.

## Renderer retention after root exit

The uninstrumented `full-on-clean-02` run used commit
`18ddc617d7d894c0cf9504e30d6427e5e9f18192`, which suppressed Chrome's updater
scheduler and killed the browser root with `SIGKILL`. Its voting assertion
passed, but lunch-poll teardown remained pending. The root Chrome had exited.
At the September 11, 17:44:50 UTC capture:

- Deno PID 74564 still held stdout and stderr read ends.
- Orphan renderer PIDs 83859 and 85470, both reparented to PID 1, retained both
  write ends. Both were in the investigation test's process group 74564 and
  named its private `integration-browser-64b0a27b514abba4` profile.
- Chrome Crashpad PID 83801 retained the same stderr write end.
- The stdout pair was `0x911612f9c213bdd6` / `0xcb0a8cf60333a5ad`; the stderr
  pair was `0x10a5463b40b14ef` / `0xa1bf753e98f6310d`.

The helpers subsequently exited without intervention. Sampling raced that exit
and provides no explanation of their internal delay. The suite then completed
naturally: six tests and 25 steps, including group-chat. No process was signaled
and no test was interrupted in this run. This proves a remaining dependency on
surviving renderers, not an infinite native deadlock or a measured latency
regression. Machine load was high and variable; no benchmark claim is made.

## Process ownership and correction

Each browser now launches with Deno's `detached: true`, creating a separate Unix
process group on the supported macOS and Linux platforms. Cleanup sends
`SIGKILL` to that owned group, including surviving renderers, while keeping the
test runner and other browsers outside the target group. It still awaits the
root status and both output streams. Detached crash handlers remain covered by
the EOF wait. Updater scheduling remains disabled for ephemeral Chrome launches.

Deno reports an absent group as `Deno.errors.NotFound` (`ESRCH`), rather than
the terminated-child `TypeError` from `ChildProcess.kill()`. Cleanup recognizes
only that absent-group case and propagates other signal failures. An output
reader failure still waits for root reaping before it propagates.

The regression suite establishes a distinct browser group, terminates a child
that survives root exit, and separately verifies that an inherited stderr held
outside the group keeps cleanup pending until stdin EOF releases the holder.
The detached helper uses the current Deno binary with `--no-config --no-lock`
and no imports. A suspended-root case guards against cooperative termination.
An actual installed-Chrome diagnostic suspended the entire owned group and
then completed browser close, output cleanup, and profile removal.

## Validation and evidence

The integration package passed 61 tests and 79 steps; deno-web-test passed 38
tests and 20 steps. The focused browser-process suite passed 23 steps. Repository
formatting, lint, type checks, and all 599 checked documentation examples passed.

Current Chrome remained 153.0.8010.36, selected normally with `ASTRAL_BIN_PATH`
unset. Deno remained 2.9.4. The fresh ON integration run of the full affected
five-file workload completed naturally with six tests and 25 steps. The matching
OFF run also completed naturally with six tests and 25 steps. Per-arm
servers used fresh stores and matching server, client, and baked-shell execution
posture. The server binaries retained the same underlying runtime code as the
PR base; the process-group change is in the test launcher.

Evidence is retained under
`/Users/berni/.codex/artifacts/browser-teardown-pr-2026-09-11`: exact run commands,
manifests, output logs, patches, process snapshots, load, server posture, binary
hashes, `metadata/renderer-retention.json`, and both capture directories named
there. The initial failed group prototype exposed the distinct ESRCH error and
is retained alongside the corrected run. A diagnostic invocation missing its
workspace config failed before launching Chrome and is retained separately.
The original investigation and supplied prior reports were not edited.

The correction does not supervise arbitrary processes that create independent
groups and redirect their output. It preserves the output barrier for detached
helpers, and the native reason the observed renderers delayed exit remains
unresolved. Chrome and its updater should also isolate descriptors belonging to
detached maintenance services, as described in the initial investigation.
