---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Investigation of OW28 landing provenance and suspect coverage-register statuses at 16de7e0c87."
---

# Server-execution coverage status audit

Inspected checkout and freshly fetched `origin/main`:
`16de7e0c871d21023111729b40876497dbaf3e36`. Runtime: Deno 2.9.4. Scope: OW28
first, followed by the suspect OW18, OW30, OW31 remount, OW55, OW56, OW58, OW60,
and rollout-status statements. This is a bounded audit, not a re-enumeration of
all binding rules or all residuals in the register.

## OW28: implementation omitted from the landed stack

The plan's DONE statement is false for the inspected main. The register's
original open OW28 entry still describes the implementation's missing port.

The provenance is directly inspectable:

1. [PR #5968](https://github.com/commontoolsinc/labs/pull/5968) holds the
   implementation at `463ea3887b64459fbf58b5d208764e42198daa25`, based on
   `claude/server-exec-v2-fanout-b`. Its initial implementation commit is
   `eb6d1e4bb4`; the head adds the independent review's fixes. GitHub reports
   CLOSED, with no merge commit and no merge date.
2. Its August 21 closing comment says its content landed through the integration
   PR #6096, squash `71e99fc33`.
3. [PR #6096](https://github.com/commontoolsinc/labs/pull/6096) actually merged
   as `71e99fc33716975ca2c9e6ddfe8bc85a6a97aeef`. That tree retains the pre-port
   compile-and-run implementation. It has no
   `packages/runner/test/executor-compile-and-run.test.ts`.
4. The inspected main likewise has no such test and retains the pre-port
   implementation. The preserved branch still contains both the port and its
   tests. This conclusion rests on file contents, not on commit ancestry: squash
   merging alone would make an ancestry-only test insufficient.

This establishes an omitted sibling's implementation and an incorrect landing
claim. It does not establish which orchestration action omitted the sibling or
why; the historical branch/review records are not a substitute for a record of
that action.

### Current behavior and verification gap

In `packages/runner/src/builtins/compile-and-run.ts`:

- A flag-ON run without a wave context sets `pending=true` and returns before
  launching a fresh compile.
- A wave-stamped run launches the floating compiler promise directly.
- Its error and finalization callbacks call `runtime.editWithRetry` without a
  completion marker. The successful child launch uses `runtime.runSynced`. There
  is no served compile outbox path in this builtin.

The existing `compile-and-run.test.ts` passes all three tests. Its ON gate test
replaces the compiler with a promise that never resolves and counts launches.
Consequently, its green says nothing about completion writeback or a served
child becoming usable.

A separate diagnostic ran the production builtin against a real
`WaveAccumulator` and the emulated storage stack. The compiler promise was
controlled and resolved to `undefined` to isolate the unconditional `finally`
callback from child instantiation. That callback's actual `editWithRetry` result
was:

```text
StorageTransactionAborted
editWithRetry commit rejected: Error: unstamped transaction sealed into a wave
```

The wave held one contribution before and after the refused writeback. A
subsequent correctly stamped control transaction was accepted and increased the
count to two. Thus the diagnostic distinguishes the missing stamp from a
generally broken destination.

Bound: this is a writeback-boundary reproduction, not a fresh browser or
ExecutorHost end-to-end run. The probe's local pending read was `false` after
the refused write; it is not used as evidence of durable completion. The refusal
and unchanged contribution count are the evidence. A restoration must prove the
durable child/result/pending journey through the real host.

### Recoverable work and missing follow-ups

The preserved branch contains a concrete port, not merely a proposal:

- Compile through the outbox; mark completion; re-arm the derivation and
  instantiate the child in that derivation.
- Keep the ON client reading through the served outcome.
- Use a resolution marker for recovery rather than treating `pending=false` as
  proof of a completed compile.
- Complete or release superseded requests, and key effects/completions by the
  demanded instance.
- Cover program replacement, compiler failure, mid-compile park, cache eviction,
  supersession, and two demanders.

Its tests and design are restoration inputs. The old commits also carry changes
to runtime, pattern manager, effect-completion, wave integration, and
specification files that have evolved since August 18; applying them wholesale
would require reconciliation with those current contracts.

Three owed rows were written only on that branch:

| Lost row                   | Finding at the inspected main                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OW28-createRef`           | Reproduced at the cache boundary. Two different program values read from one schema-backed cell were passed to the real `compileOrGetPattern`; its injected compiler was called for A only, and both calls returned A's Pattern object. Plain-object A/B controls invoked the compiler separately and returned distinct objects. The test uses a compiler stub to isolate cache selection, not a real TypeScript compile or rendered piece. |
| `OW28-supersession-family` | Historical report of LLM A→B→A abandonment under in-flight deduplication. Current LLM code retains run-counter cancellation paths; this audit did not reproduce the family and does not declare it confirmed-current.                                                                                                                                                                                                                       |
| `OW28-instance-family`     | Current `effectTargetKey` still takes only a base and target Cell and includes the scope name, not the principal/session instance. OW53 already records related non-SQLite completion and SQLite residuals. Reconcile the two records; the historical family also includes SQLite cases subsequently fixed. No new multi-demander reproduction was run here.                                                                                |

The cache finding matters independently of restoring server execution: the
diagnostic runs with server execution OFF, which is the current first-party
default.

## Other suspect statuses

| Row or statement                                               | Disposition                                              | Evidence and appropriate correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OW18: move client ensurers/updaters to the server              | Superseded direction                                     | The server owes root existence; following source belongs to the opener. This is explicit in `docs/specs/piece-source-lifecycle.md` and server-execution `serving-loop.md` §3e, implemented by #6384 (`c93e810085`). The server's existence ensure remains in `ensure-space-root.ts`. Repoint OW18 to the split ownership instead of implementing its old move-everything instruction.                                                                                                                     |
| OW30: write-destination validation race                        | Split the row; do not declare the whole class closed     | #5889 (`6d5bb60c9b`) prevents Stream sends from staging and validating an unrelated producer root. The current guard is `issue === undefined && !isStream(txCell)`. Its test sends a valid event despite an invalid producer sibling while still rejecting an invalid event payload. Later OW33 evidence lifted the Topics test. No `waitForSettled` pre-validation gate exists in the controller, and this audit did not reproduce or close the original non-Stream counter/array-container observation. |
| OW31 residual (vii): revoked serving session never remounts    | Implementation claim stale; preserve the remaining bound | #6396 (`37e53084e9`) added the ACL-change latch and terminated-session remount. The current implementation retries admission rather than bypassing ACL checks. The six-step remount suite passes, including host glue and refetching a previously watched document. Automatic replay of the entire dead session's watch set remains a distinct follow-up; a refetch on the next read is not that guarantee.                                                                                               |
| OW58: resolved-error consequence notice leaves the guard stuck | Implemented; row needs closure                           | #6402 (`d3b7d22add`) consumes `result.error`, routes it through `#recordEventNoticeFailure`, and deletes the drain guard. The terminal-notice test injects a resolved error before storage, verifies the failed head/barrier remains pending, then verifies ordered recovery. The complete events-down file passes: 35 steps. Preparing ordinary notices in enforce mode is a separately suggested hardening question, not evidence that the guard fix remains unimplemented.                             |
| OW55: serving pattern-source trust                             | Still open, consumer list stale                          | `toolshed/index.ts` passes `new URL(env.API_URL)` to the host; the serving runtime receives that URL, and the default is still `http://localhost:8000`. Root creation resolves its system source from that runtime URL. The old server updater consumer was removed by the source-lifecycle change. That narrows the row but does not establish self-pinning or identity verification against the local route. No new cross-origin experiment was run.                                                    |
| OW56 finding 2: client/server source-update duplication        | Already closed in the row                                | The current row explicitly closes this with opener-owned source following. Do not count it as outstanding server-owned-compilation work. The broader materialization/integrity direction remains separate; this audit does not revalidate its security argument.                                                                                                                                                                                                                                          |
| OW60: unresolved ON speculative echo                           | Still open                                               | #7189 (`c0693b2c24`) retries client/OFF handler-not-run dispatches but explicitly excludes the flag-ON client echo, which continues sealing its skip. The change is not an OW60 closure.                                                                                                                                                                                                                                                                                                                  |
| Register's flip/soak narrative                                 | Historical text presented alongside live status          | The first-party default is `false` at the inspected head. The plan's September 3 rollback delta records #6840 and a paused ON soak. The register's earlier flip block cannot be used as current deployment status. Its old completion claims also need reconciliation with OW28's omitted implementation.                                                                                                                                                                                                 |

## Validation and limits

Executed on the inspected head with Deno 2.9.4:

| Check                                                   | Result                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| Existing runner `compile-and-run.test.ts`               | 3 passed                                                             |
| Diagnostic compile completion against `WaveAccumulator` | 1 passed; missing-stamp refusal observed; stamped control accepted   |
| Diagnostic program-proxy cache selection                | 1 passed; collision observed; plain-object controls distinct         |
| Runner `executor-events-down.test.ts`                   | 35 steps passed, including resolved-error terminal notice            |
| Piece `pull-materialization.test.ts`                    | 142 steps passed, including Stream event vs invalid producer sibling |
| Runner `executor-session-remount.test.ts`               | 6 steps passed                                                       |

Runner commands used the package's clock preload and permission flags with
`--frozen --no-check`; Piece used its plain Deno test permissions with
`--frozen --no-check`. No browser campaign, full repository suite, remote CI
rerun, or mutation test of OW58 was performed. Some existing runner tests logged
shutdown-time storage errors while reporting pass; those are not presented as a
clean-log guarantee.

Scratch diagnostics and raw outputs were retained at `/tmp/ow28-audit-2JYCyC/`
on the investigation machine. They contain absolute imports into this checkout
and are local evidence, not portable regression tests. The final diagnostics use
compiler stubs only at the boundaries described above. The production
implementations were not edited.

## Next work

1. Restore OW28 on current main, using the preserved branch as an input and
   first establishing a failing real-host completion test. Include the branch's
   recovery, supersession, and demanded-instance cases in the port.
2. Restore and reconcile the three missing follow-up rows. The cache-key
   collision warrants its own fix because it is independently reproduced in the
   current OFF path.
3. Correct OW18, OW31's remount residual, OW58, and the stale source/rollout
   descriptions. Narrow OW30 to the still-unresolved observation rather than
   marking the entire row closed from the Stream fix.
4. Reconcile the implementation plan's completion and gate claims before any
   renewed flip-readiness conclusion. Keep historical reports frozen; they
   describe the branch state and knowledge at their creation dates.
