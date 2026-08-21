---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "OW52 loss-triage: the convergence-storm ON loss (observer landed=23/40 under 2x20 pipelined posts) — full 40-event accounting across append admission, drain, dispatch, and consequence commit; where the 17 die and the fix."
---

# OW52 — the convergence-storm ON loss (landed 23/40): loss triage

Register row: `docs/specs/server-side-execution/verification-coverage.md`
§3 OW52. Evidence base:
`docs/history/plans/server-execution-v2/stage-c/first-on-ci-gate.md`
row 8 and §3 (the harness posture fix that made the red honest — the
pre-fix mixed posture refused all 40 appends, masking a real 17-message
loss).

Surface: `packages/patterns/integration/convergence-storm.test.ts`,
step "a non-writing session sees every concurrently-posted message"
(step-level ON skip; the file's 3 element-schema tests are green ON).
Under the TRUE ON topology (MultiRuntimeHarness targeting the
integration environment's toolshed), 2×20 pipelined `post` events
(`idle:false`) per writer leave the non-writing observer at
landed=23/40.

Question this report answers: WHERE do the 17 die — append admission,
queue, dispatch, or consequence commit under pipelined contention —
and whether the collapse (if any) is CoalescedDocListener-style
coalescing-by-design vs a genuine loss against the test's
every-message-must-land contract.

## 1. Method

- Local toolshed run from this worktree
  (`EXPERIMENTAL_SERVER_EXECUTION=true deno run --no-lock -A index.ts`,
  fresh `MEMORY_DIR` per run, port 8891), serving loop verified present
  via `/api/health/stats`.
- Storm step run against it (`API_URL=http://localhost:8891/`,
  `EXPERIMENTAL_SERVER_EXECUTION=true`), step-skip entry neutered in
  the working tree for triage runs only.
- Accounting instruments: the serving loop's own `events.*` stats
  (appended / processed / coalescedPerWaveMax / skippedIdempotent /
  drainInFlightSkips / lt1LeftoversPurged / lt1LateSealsRefused /
  orphanDeliveriesRefused), plus store-side archaeology (stream sidecar
  entries vs `messages` array) and targeted instrumentation at the seam
  the counters implicate.

## 2. Status

IN PROGRESS — triage running. Sections below fill in as evidence
lands.

## 3. Reproduction runs

(pending)

## 4. The 40-event accounting

(pending)

## 5. Where the 17 die

(pending)

## 6. Fix (or flag)

(pending)
