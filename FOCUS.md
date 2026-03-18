# Current Focus

Convert the settle-wave investigation into a reusable debugging guide, then use
this worktree to add better worker-side settle instrumentation and keep pushing
the investigation forward.

## Current State

- Worktree: `/Users/berni/labs-perf-settle-wave-debugging`
- Branch: `perf/settle-wave-debugging`
- Local traces already captured for reload-after-register and create-note.
- Current evidence points to worker-side scheduler settle and resubscribe churn
  rather than main-thread rendering or worker reconciler flushing.
- Worker settle stats are now exposed over IPC and console helpers.
- Timed diagnosis now goes through `runDiagnosis(durationMs)` and returns real
  `duration` and `busyTime`.
- Settle history is now exposed over IPC, so note-creation waves can be read
  back without polling.
- Trigger trace is now exposed over IPC with compact change summaries and
  per-action scheduling decisions.
- A focused `scheduler.trigger-flow` logger now isolates change-trigger logs
  from the rest of scheduler debug output.
- The default-app integration flow can now print grouped trigger-trace summaries
  under `CT_CAPTURE_TRIGGER_TRACE=1`.
- The next instrumentation gap is semantic grouping, not raw capture.

## Immediate Next Steps

1. Use raw trigger traces to collapse sink-heavy output into a smaller set of
   semantic writes that actually matter for one new note.
2. Narrow the worst subscriptions or recomputation paths in `note.tsx`,
   `default-app.tsx`, `piece-grid.tsx`, `summary-index.tsx`, and
   `backlinks-index.tsx`.
3. Re-run the note flow after any reduction in repeated scheduling and compare
   trigger-trace counts, settle history lengths, and total settle time.

## Handoff Notes

- The main debugging guide is
  `docs/development/debugging/settle-wave-investigation.md`.
- The trace artifacts are in `/tmp/ct-perf-traces/`.
- Keep the guide current as the instrumentation changes so the directory stays
  instruction-first, not just a log of one session.
