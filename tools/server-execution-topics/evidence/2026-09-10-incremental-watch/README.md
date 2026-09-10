# Incremental watch maintenance evidence

The mechanism probe runs the real memory server and loopback client against
fresh isolated stores. It compares main
`27f10d2d4f02f125c0492e5d6288acb3f0da148b` with that same head plus
`profile/candidate.patch`. It explicitly sets and checks server-execution
posture before each size. This probe has no serving runtime or baked shell; the
separate integration captures validate those surfaces.

`profile/manifest.json` records exact commands, source hashes, posture, cache,
load, order, and completion. Each arm seeds 100, 1,000, and 10,000 independent
`schema:false` roots, with two sessions. It then adds an already-covered root,
adds one new root, updates one watched document and flushes, and removes two
watch declarations through full replacement (the extra covered-root watch and
the new-root watch), reducing delivered entities by one. Both postures use
identical fixture shape and completion conditions. No topic-size comparison is
inferred from this fixture.

The capture instruments yielded Map/Set/Array entries, actual array callback
invocations, slice results, and loaded manager addresses. `analysis.json`
aggregates them; JSONL retains each site. Loaded-address measurements overlap
underlying map/array work and must not be added to them. Nested traversal counts
measure actual work at each site, not disjoint elapsed time. No timing here
satisfies the quiet-machine latency protocol.

To replay, create two disposable worktrees at the recorded head. Apply
`profile/candidate.patch` only to the candidate. Copy
`profile/watch-probe.ts.txt` to `tools/server-execution-topics/watch-probe.ts`
in each, creating that directory. Use Deno 2.9.4 in a fresh login shell. From
the respective worktree roots, run these commands in this adjacent order, saving
stdout and stderr separately:

```sh
# In the baseline checkout:
env -u EXPERIMENTAL_SERVER_EXECUTION deno run -A tools/server-execution-topics/watch-probe.ts
# In the candidate checkout:
env -u EXPERIMENTAL_SERVER_EXECUTION deno run -A tools/server-execution-topics/watch-probe.ts
# In the candidate checkout:
EXPERIMENTAL_SERVER_EXECUTION=true deno run -A tools/server-execution-topics/watch-probe.ts
# In the baseline checkout:
EXPERIMENTAL_SERVER_EXECUTION=true deno run -A tools/server-execution-topics/watch-probe.ts
```

Every command must produce three JSONL rows and three matching posture records.
The commands create fresh stores themselves. Profiling patches are explicit;
never compare their elapsed time with uninstrumented end-to-end captures.

`controls/candidate.patch` captures the subsequently reviewed source, including
operation-cursor and resumed-session race corrections with their tests. The
graph-only profile does not reach that operation-watch path. Its counts remain
measurements of the profiled patch, not an assertion that a later diff was
remeasured.

To replay the cursor control, create another disposable worktree at the same
base and apply `controls/candidate.patch`. Run:

```sh
deno test -A packages/memory/test/v2-watch-incremental.test.ts
```

It passes. Applying `controls/unpin-cursors.patch` reproduces the cursor race:
an in-flight snapshot for A incorrectly reads B's later cursor after watch
replacement, and the test rejects with
`operation field query cursor is in the
future`. The test gates engine access
with promises, not elapsed time. Restore that ablation before using the worktree
for anything else. Archived red and green logs record the original run; the
green command also covered operation client and refresh-timing suites.

The campaign's external durable archive is identified by `archiveRoot` in
`external-captures.json`. It retains exploratory profiles, rejected posture
captures, full package logs, build manifests, and local integration stores. The
portable files in this folder contain synthetic fixtures and compact results; no
generated binary or store is committed. `SHA256SUMS` identifies the portable
bytes.

`controls/allow-stale-session.patch` removes the final current-session guard.
With that ablation, a pending old addition mutates the resumed session's watch
intent after its catch-up; the snapshot regression fails. The unmodified
candidate rejects the stale request and preserves all resumed delivery, graph,
watch, sequence, and cursor state. Run the same test command, inspect that
specific failure, and restore the ablation afterward. This constant-size guard
postdates the profile capture; profile counters describe the recorded patch.

The archived `.py.txt` controllers preserve the exact local build and
integration commands. Their absolute paths are capture provenance; use the
replay directions above with new disposable paths. `replay/manifest.json` and
its three logs record a fresh-worktree verification of the portable candidate
and both mutations.

`integration-default` and `integration-opposite` contain the fresh baked-server
captures. Both pass seven suites and 27 steps. The parent deliberately supplies
the wrong execution flag; the runner replaces it with the requested lane and
checks server, client, and baked-shell posture. `builds.json` gives both binary
hashes and exact source hashes. The only production-source edit after those runs
is the comment clarification in `comment-after-build.patch`.

`validation.json` separates full package/type runs from later focused controls.
The final session guard is covered by ACL/concurrency/reconnect regressions and
both integration lanes. CI at the PR head remains the final external gate.

The complete end-statistics payloads are retained at the absolute paths in
`external-captures.json`, with byte lengths and SHA-256 hashes. Copy those files
from the durable campaign directory and verify the hashes to retrieve the full
settle/timing series. The checked-in `stats-summary.json` files keep aggregate
counters; they omit those large series without turning them into latency claims.

The raw profile label `remove-one` refers to one delivered entity removed; it
removes two watch declarations. Preserve that label in the captured raw results
and probe when reproducing the original run. This is full replacement, not an
incremental single-watch removal measurement.

The build controllers ending in `.py.txt` are immutable command captures, not
retryable build tools. The captured build controller moved the prior binary
before compiling and would need that binary restored on a failed build. Its
recorded builds succeeded. The current `run-arm.ts` requires a clean committed
checkout and rebuilds before every arm, publishing the replacement binary only
after successful compilation and a second source-state check. It rejects
untracked inputs. Commit an ablation on an isolated branch before using it.

The ON capture passed the test assertions but was not error-free. Its aggregate
logs include 40 `seal-space-commit-failed`, two `schedule-error`, two
`scheduler-non-settling`, three `session-remount`, 40 `foreign-write-refused`,
and two `contribution-dropped` events. These are not asserted to be benign or to
prove successful seals. Failed-add rollback is established by the deterministic
real-memory snapshot tests; the browser suite establishes only its asserted
rendering, interaction, and durability conditions. See the
[review follow-up report](../../../../docs/history/development/performance/2026-09-incremental-watch-review.md)
for the diagnostic characterization and remaining limits.

`profile/manifest.json`, `replay/manifest.json`, and `builds.json` resolve `.`
against the appropriate disposable checkout, as specified above. Original
absolute paths and exact commands are retained under `originalManifests` in
`external-captures.json`, separate from replay inputs. `build-source.patch` is
the exact patch applied at the recorded base when compiling the two binaries.

Run the isolated source/build controls with Python 3 and Deno 2.9.4:

```sh
python3 tools/server-execution-topics/evidence/2026-09-10-incremental-watch/review/verify-runner.py "$PWD" /absolute/new/control-results
```

The script creates and removes disposable Git fixtures; its stub capability
stops after the build boundary, so it launches no server. The separate baked
integration captures establish the real server boundary.
`review/source-controls.json` records the ten passing cases. The seed-posture
expression control is retained as `.ts.txt` capture source and requires the
repository Deno configuration when run from outside the checkout.
