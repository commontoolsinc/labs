# Evidence: shared-state writes are silently dropped under concurrency

**Claim.** When multiple runtimes (users) write the same shared state concurrently,
some writes are **silently lost** — and the loss is in **canonical storage**, not a
stale UI. This is a **general runtime behavior, not SQLite-specific**: a plain
keyed *cell* variant drops writes too, just at higher concurrency than SQLite.

How we know it's storage and not a read glitch: the probe opens a **fresh runtime
that never subscribed** to the result graph (`MultiRuntimeHarness.addColdSession`).
Its first read materializes directly from committed storage, bypassing every
`reactOn`/dedup/cross-runtime propagation hop — so the **cold-auditor count is
canonical server truth**. Where cold == live but both are below the attempted
count, the writes are genuinely gone.

## Reproduce

```bash
cd labs-perf   # (this worktree)

# SQLite vote storage, 3 options × 5 concurrent users (15 votes attempted):
deno run -A packages/patterns/lunch-poll/probe-sqlite-landing.ts \
  --program=main-sqlite.tsx --case=3x5 --rounds=3

# Plain keyed CELL storage, 3 options × 10 concurrent users (30 attempted):
deno run -A packages/patterns/lunch-poll/probe-sqlite-landing.ts \
  --program=main-indexed.tsx --case=3x10 --rounds=3
```

`--case=Nx U` = N options × U users; attempted distinct votes = `N_options × U`
(each user votes each option once over the rounds, deduped by `(voter,option)`).

## Captured output (clean `main` base, this machine)

### 1. SQLite storage — 5 concurrent users — **1 of 15 landed**

```
# probe-sqlite-landing program=main-sqlite.tsx case=3x5 rounds=3 (expect 15 votes if all land)
## cold auditor (fresh runtime, first sqliteQuery = server truth):
  cold-auditor voteCount=1 votes.len=1
## live sessions (re-read after cold open + settle):
  user-1..user-5   voteCount=1
## verdict:
  WRITES DROPPED — cold reader sees only 1/15 in canonical storage.
```

`14` `Event handler transaction failed after exhausting all retries` lines in
stderr. Conservation: **1 landed + 14 exhausted = 15 attempted.**

### 2. Plain keyed CELL storage — 10 concurrent users — **18 of 30 landed**

```
# probe-sqlite-landing program=main-indexed.tsx case=3x10 rounds=3 (expect 30 votes if all land)
## cold auditor (fresh runtime, first sqliteQuery = server truth):
  cold-auditor voteCount=18 votes.len=18
## live sessions (re-read after cold open + settle):
  user-1..user-10  voteCount=18
## verdict:
  WRITES DROPPED — cold reader sees only 18/30 in canonical storage.
```

**12 votes lost, but only `6` `exhausting all retries` lines** — i.e. **~half the
dropped writes produce no log line at all.**

## Mechanism (summary)

Concurrent writes to shared state serialize on a shared revision via
optimistic concurrency. Each write retries up to a fixed budget
(`DEFAULT_RETRIES_FOR_EVENTS = 5`, `packages/runner/src/scheduler/constants.ts`).
Past that, the write is **abandoned** — yet `send()` still resolves and the run
completes "successfully," so nothing surfaces the loss
(`packages/runner/src/scheduler/events.ts` takes a log-only branch on exhaustion;
the event commit is fire-and-forget).

The **drop threshold roughly halves with each added/wider contention point**:
plain cell variants tolerate ~10 concurrent writers before dropping; SQLite
(`db.exec` read-modify-writes one shared `handle.rev` per write, plus a wider
commit window) drops by ~5; a variant with a second shared counter
(`main-sqlite-rev.tsx`) by ~2–3.

Full methodology, the concurrency sweep, the rev-funnel-vs-write-window
disambiguation, and the still-open per-row instrumentation are in
[`PERF-SESSION-2026-06-15.md`](./PERF-SESSION-2026-06-15.md) (see "Re-validated on
rebased main" and "Phase 3").

## Open question for discussion

Should a write that exhausts its retry budget **hard-fail / surface an error**
rather than silently dropping (and emit a log line *every* time)? And on the perf
side, keying fixes graph cost but inherits this contention 1:1 — a real fix likely
needs per-row writes that don't funnel through a shared revision.

> Distinct from this issue: the SQL-backed **reactive-read** lag (low live counts
> at low concurrency where storage is actually full) is a separate read-side
> propagation gap; it is *not* the cause of the losses above.
