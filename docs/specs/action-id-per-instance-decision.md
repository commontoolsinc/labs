# Decision note — per-instance action id vs per-symbol fingerprint

**Status:** implemented in this PR (content-addressed action identity), pending
author confirmation of the durable-key granularity. Companion to
[`content-addressed-action-identity.md`](./content-addressed-action-identity.md).

## Issue

The content-addressed re-root originally routed **both** the scheduler action id
and the durable implementation fingerprint through the same per-**symbol** key
`cf:module/<hash>:<symbol>` (`getSchedulerActionId` returned
`action.implementationHash`). Only the fingerprint should be per-symbol.

The action id keys two per-instance structures:

- `actionStats` (`scheduler.ts`, `Map<string, ActionStats>`) — drives
  auto-debounce/throttle (`delays.ts`).
- the durable scheduler observation (lookup key in `rehydrateActionFromStorage`
  / `observationMatchesCurrentAction`).

So **N instances of one hoisted op** — one `lift` called twice, a `map` over a
list, a repeated sub-pattern — collide on a single id. Verified empirically:
`da = dbl(a); db = dbl(b)` persisted **one** observation (the second overwrote
the first) where the pre-re-root code persisted **two**. Consequences:

1. **`actionStats` (always-on):** the N instances share one run-count, so
   auto-debounce trips ~N× early and applies to all of them → update latency for
   lists. Heuristic only, not a correctness bug.
2. **Durable observations (`persistentSchedulerState`, off by default):** N
   instances → 1 surviving observation → on reload all N rehydrate from one
   instance's reads/writes surface. Latent **correctness** bug for the persistent
   scheduler-state feature.

No production impact today (the durable path is experimental-off; the stats
effect is heuristic), but it shouldn't ship as-is.

## What we did

The pre-re-root id (`action.src`) was already per-instance — a hash of
`{process, reads, writes}` — but it embedded the source location, which the
cold-load perf work needs off the hot path. We keep the per-instance property
**without** the source-location dependence:

- **Fingerprint stays per-symbol:** `impl:cf:module/<hash>:<symbol>`
  (`schedulerImplementationFingerprint`) — identifies the code, for cache/eviction.
- **Action id becomes per-instance again, source-independent:**
  `cf:module/<hash>:<symbol>:<instanceKey>`, where `instanceKey =
  schedulerActionInstanceKey({process, reads, writes})` — a reload-stable hash of
  the action's links, folding in no source-derived name so it's independent of
  `fn.src`/the debug annotation.

Guarded by a multi-instance regression test in
`test/src-garble-identity-invariant.test.ts` (two instances → distinct ids + two
observations + still byte-identical under `.src` garble).

## For the author (Berni) to confirm / redirect

1. **Is per-instance the intended granularity for the durable observation key?**
   The spec's stated key (`cf:module/<hash>:line:col`) is per-primitive-*site*
   and would also collide across instances of the same site — so it
   under-specifies this. The pre-change code was per-instance (`action.src`),
   which is what made reload rehydration correct for multi-instance patterns.
2. **Confirm the fingerprint(per-symbol) / id(per-instance) split** as the
   intended model.
3. Any planned instance-keying layer above the observation store that would make
   a per-symbol durable key acceptable instead?

If (1)/(2) land differently, the change is localized to
`schedulerActionInstanceKey` + `getSchedulerActionId` + the two setup call sites,
and easy to adjust.
