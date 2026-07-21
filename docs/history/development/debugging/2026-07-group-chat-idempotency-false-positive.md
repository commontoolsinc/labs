---
status: historical
created: 2026-07-18
archived: 2026-07-18
reason: "Root cause of the July 2026 group-chat idempotency false-positive CI flake and the fix that shipped."
---

# `cfc-group-chat-demo/multi-user.test.tsx` flagged non-idempotent (July 2026)

A flaky failure in the `deno.yml` workflow. It is timing-sensitive and surfaces
only under the parallelism and load of a CI runner; it reproduced at about 1 run
in 150 under artificial load and not at all otherwise on a developer machine. A
sibling flake investigated on the same branch is recorded in
[2026-07-cf-profile-capture-exit-130.md](2026-07-cf-profile-capture-exit-130.md).

## Symptom

In a sharded "Pattern Unit Tests" job the test failed with:

```
✗ 1 non-idempotent computation(s):
  [bob] cf:module/<hash>:__cfLift_9:<instance> (differing writes: <did>/<entity>/value)
```

The `__cfLift_9` in that module is bob's `assert_sees_alice_profile` computed —
`profileNames(chat).includes("Alice")` — a pure boolean read of the shared,
cross-runtime-synced profile roster. A `Can't load profile-create.tsx`
connection-refused line appears nearby in the same job log, but it belongs to a
different pattern (`lot-watch`, which passed) and is unrelated; the group-chat
failure is the non-idempotency flag.

## The idempotency recheck

`cf test` enables an inline idempotency check. After a computation runs, the
scheduler re-runs it once against post-commit state and compares the two runs'
writes; differing writes with unchanged inputs signal non-determinism
(`runIdempotencyRecheck` in `packages/runner/src/scheduler/diagnosis.ts`). A
filter, `readInvariantMovedExternally`, suppresses the flag when an input the
computation read changed between the two runs — which is what a cross-runtime
sync landing between them looks like.

## Root cause

Instrumenting the recheck and reproducing under load (about 1 run in 150) showed,
every time:

- `inputsMoved = false` — the read values were identical across the two runs, so
  the input-moved filter did not apply,
- the original run captured **no** writes, and
- the recheck run captured **one** write, to a cell the computation also reads,
  whose read value is a user-scoped redirect link
  (`{"/":{"link@1":{path:[],scope:"user",overwrite:"redirect"}}}`) and whose
  captured write value is `undefined`.

The `undefined` write value is the tell. `captureTransactionWrites` reads the
transaction journal's novelty; an address that is in the reactivity write log but
has no journal-novelty entry is recorded as `undefined`. So the recheck run's
extra "write" is a **read-triggered materialization touch**: the first time a
transaction reads through the redirect link, the read materializes it into the
replica, and the reactivity log records that as a write even though it commits no
value. The original run had already materialized the cell (no touch); the fresh
recheck transaction had not (a touch). The lift's actual output — the boolean —
is identical in both runs, so the result cell is not among the differing writes;
only the materialization side-effect differs.

This is a false positive. It is not specific to the test pattern: any multi-runtime
pattern whose computation reads a cross-runtime cell reachable through a redirect
link can hit it.

## Fix

`captureTransactionWrites` now records only value-carrying writes — those the
transaction journal has novelty for — and drops write-log addresses with no
novelty (no-op writes and read-triggered materialization touches). A materialization
that happens in one run but not the other no longer registers as a differing
write. Real non-idempotency still writes value novelty (a different result), so it
is unaffected: the accumulator, shuffle, set-to-array, and timestamp
non-idempotent fixtures all still flag, as do the existing inline-idempotency unit
tests.

The regression guard models the write-capture boundary directly: two recheck runs
emit the same value-carrying output, but the fresh run additionally touches a cell
it reads with no journal novelty; the captured writes must compare equal. The test
fails against the pre-fix code (the touch is captured) and passes with the fix.
