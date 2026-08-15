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
twice — `EXPERIMENTAL_SERVER_EXECUTION` OFF (must be byte-identical
to today up to the recorded acceptances — key-vocabulary §5's, and
the verification-coverage register's recorded-acceptance rows (RULED
2026-08-05, widened for stage G's claim-guard delta the same day);
any other OFF-arm diff is a Phase-gate failure by
itself) and
ON. The ON arm is allowed to skip
not-yet-implemented phases via explicit skip lists per phase, never via
silent filtering. (v1's terminal failure mode: the flags-on branch never
went through CI at all.)

*Since the Phase 7 flip (2026-08-15) the arms swap roles by env: the
DEFAULT lanes (flag unset = the first-party default,
`SERVER_EXECUTION_DEFAULT_ENABLED` — ON) ARE the ON arm, in the FULL
posture (the toolshed binary serves and its baked browser shell is ON),
with the skip list printed there; the explicit
`EXPERIMENTAL_SERVER_EXECUTION=false` lanes are the OFF regression
guard, on a binary whose shell was built with the define `false`
(`build-toolshed-off`) so the OFF arm is the pre-flip FULL posture too —
never a mixed one. Both lanes stay until the OFF path is removed (the
post-soak PR). Single-process suites (the unit suites, `cf test`) are
not arms of this contract: they have no serving host and run the
derive-and-commit model by construction (EXPERIMENTAL_OPTIONS.md).*

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
- single-deriver envelope (Phase 2 gate; reworded for the
  transaction identity model — a `derived` commit's envelope carries
  no session, so there is no commit-level session to group by): a
  store query over `derived` commits shows every envelope principal
  == the lease-holding SpaceServer's service identity and NONE from
  a client session; equivalently, zero `derived`-class commits
  admitted from any client connection in the ON arm.

## 5. Phase gates → concrete tests

New tests live in `packages/patterns/integration/` with the prefix
`sx2-` (server execution v2), so the suite filter `sx2` runs the whole
v2 gate set. Existing product tests double as gates where noted.

**Ahead of every gate: the executable spec model**
(`packages/spec-model/server-execution/`) checks the identity/commit
machinery's schedule-dependent properties — inheritance, LT1
carriage, delegated stamping, split repetition, watermark
idempotency, push filtering, the enact/ack window — by exhaustive
small-configuration interleaving with fault injection, unattended
(`deno task test`). It re-verifies each ruling batch mechanically,
carried the FP1 characterization until its 2026-08-03 ruling and
now asserts CLOSURE (durable append rows — no schedule loses an
append), and is the seed the `sx2-` conformance tests grow
from: a stage's semantics get modeled before its implementation
exists, then the properties become the implementation's oracle.

| phase | gate tests |
| --- | --- |
| 1 | stages A–G land dark: OFF arm byte-identical per stage (§2), stage E's instance re-keying included (OFF-arm neutral by construction); ON arm runs in CI with explicit skip lists (no ON gates — the first ON milestone is Phase 2's) |
| 2 | `sx2-serving-loop` (counters, amplification, restart-memo) and `sx2-speculation` (echo latency, overlay retirement; the client-side overlay diagnostic witnesses "commits nothing for derivations" — the zero-client-derived STORE-ATTRIBUTION query needs engine access and is pinned, both halves, in `packages/runner/test/speculation-overlay.test.ts`, not duplicated into the browser gate); existing `counter`, `cfc-group-chat-demo-multi-runtime` in ON arm; byte-identical suite both arms |
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
