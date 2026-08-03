# v2 detail: testing and measurement

Binding on every v2 phase. The plan's success criteria
([server-execution-v2.md](../../plans/server-execution-v2.md)) are
implemented as the gates below. Method inherited from the v1 learning run
(full record: archived orchestration log §2.4–§2.5).

## 1. Harness rules (non-negotiable)

- Integration runs go through `deno task integration --port-offset=NNN`
  — never a hand-rolled server (`MEMORY_URL` defaults to port 8000; a
  hand-rolled harness on a shared box writes into someone else's
  primary). The task wires both servers and storage correctly.
- **Workloads are uninstrumented and byte-identical across arms.** v1's
  own measurement probes warmed the measured path and understated its
  cost. Measurement reads counters and JUnit timings from outside.
- Arms run adjacent (same load window), ≥3 reps for any latency claim,
  no latency quoted above load ~5. Counters and set relations are
  load-insensitive and always quotable.
- Causation by ablation: a slowdown is "explained" when toggling the
  suspected mechanism moves the number, not when a narrative fits.
- Fresh store per measured run (`rm -rf packages/toolshed/cache` between
  arms); NOTE the store persists across `deno task integration`
  invocations — suite-scale tests (Phase 6) exploit this deliberately,
  latency tests must not inherit it accidentally.
- `deno task test` never RUNS the `.test.tsx` pattern lane or the
  integration lanes — the caveat is lane coverage, not exit codes. CI
  runs them all; so must local verification before any push.

## 2. CI arms

From the first PR with testable behavior: the integration suites run
twice — flag OFF (must be byte-identical to today; any OFF-arm diff is a
Phase-gate failure by itself) and flag ON. The ON arm is allowed to skip
not-yet-implemented phases via explicit skip lists per phase, never via
silent filtering. (v1's terminal failure mode: the flags-on branch never
went through CI at all.)

## 3. The watermark replaces polling

`waitForSettled(space, seq)` — new test helper: resolves when the
space's watermark ≥ seq (protocol.md §4). Integration tests MUST use it
instead of text-polling / `waitForCondition` loops for "server done"
(v1 tests burned 60 s barriers on exactly this). Text assertions remain
for *what* rendered; the watermark answers *when*.

## 4. Counter assertions

`/api/health/stats` → `servingLoop` block (serving-loop.md §7). Gate
tests assert counters, not logs:

- amplification, ONE metric: `derivedCommits / (authoredSeen −
  effectAcks) ≤ 2` on pure workloads (lunch-poll, the first ON-arm
  gate; v1 measured 60×) and `≤ 3` on workloads with effectful nodes
  (their completion commits are derived-class). A logical write is
  one authored commit excluding effect-channel acks. The budget is a
  TRIGGER, not a hard gate (owner, 2026-08-02): exceeding it fails
  the test UNTIL a human inspects the why — a breach is a question to
  answer, not only a number to fix. The inspection either fixes the
  amplification or re-baselines the budget with the reason recorded
  here; it is never silenced in the test.
- single-run: `waves == authored input batches` ballpark;
  `memo.hits/misses` sane on restart tests.
- idempotency: `events.skippedIdempotent` == replayed-event count in the
  kill-restart test, and effect results unduplicated (store query).
- session attribution (Phase 2 gate): a store query grouping commits by
  `class` + session shows zero client `derived` commits in the ON arm.

## 5. Phase gates → concrete tests

New tests live in `packages/patterns/integration/` with the prefix
`sx2-` (server execution v2), so the suite filter `sx2` runs the whole
v2 gate set. Existing product tests double as gates where noted.

| phase | gate tests |
| --- | --- |
| 1 | stages A–F land dark: OFF arm byte-identical per stage (§2); ON arm runs in CI with explicit skip lists (no ON gates — the first ON milestone is Phase 2's) |
| 2 | `sx2-serving-loop` (counters, amplification, restart-memo) and `sx2-speculation` (echo latency, overlay retirement, zero client derived commits); existing `counter`, `cfc-group-chat-demo-multi-runtime` in ON arm; byte-identical suite both arms |
| 3 | `sx2-events` (two-user lunch poll via server handlers; kill-between-event-and-consequence restart; duplicate-submit rejection; rapid-fire coalescing: N events fired faster than wave time yield ≪N derived commits and final-only values); propagation ≤300 ms p50 measured on `lunch-poll-vote` UNMODIFIED |
| 4 | `sx2-effect-channel` (navigate intent/ack; reload between intent and ack; optimistic-enact reconcile); existing `topics-navigation` ON |
| 5 | existing `shared-profile`, `profile-embed`, `sqlite-read-clearance-multi-runtime` green ON — the v1 stragglers are the acceptance tests |
| 6 | `sx2-scale` (cf-checkbox in-suite ≈ isolated; budget: hostile LLM fan-out in space A leaves space B's propagation in budget); no poll-loops left in the suite |
| 7 | full suites ON-only; propagation beats OFF-arm baseline on byte-identical workloads |

## 6. The two standing baselines

Recorded 2026-08-02 (quiet box), the numbers v2 is measured against:

- Cross-user propagation, client-computed (today): 92–294 ms.
- Actor-side interactive latency (today): ~318 ms.
- Amplification (today): ~15× commits per logical write on lunch-poll
  (150 commits / ~10 writes — deploys and bootstrap included); v2's
  budget (≤2 pure / ≤3 effectful, §4's single metric, logical write =
  one authored commit excluding effect-channel acks) is for the
  steady-state interaction window, measured between first and last
  user action.
