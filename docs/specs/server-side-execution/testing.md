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

*Phase 7 FLIPPED (the flip PR, 2026-08-28, after the plan's ordered
gates: `SERVER_EXECUTION_DEFAULT_ENABLED = true`; landed FLIP-READY DARK
2026-08-16 by owner ruling, roles inverted until the flip). The arms
since the flip: the DEFAULT lanes (flag unset = the first-party default,
ON) ARE the ON arm in the FULL posture — the toolshed serves, the test
processes RESOLVE the posture env-else-default (the runner integration
tests that talk to the lane's toolshed; the runtime-client worker host —
never a bare/ambient client, the mixed posture the Phase-7 review found,
which under default-ON a raw env read would resurrect), and the
default-built browser shell's define fallback is the same constant. TWO
files on the default pattern lane deliberately read the RAW env instead,
and are exceptions rather than drift:
`packages/patterns/integration/topic-board-child-contract.test.ts` and
`packages/patterns/integration/convergence-storm.test.ts` key their
ON-arm STEP-skip guard (`onArmStepSkip`) off it. Neither takes a RUNTIME
posture from that read — the runtimes there adopt the lane toolshed's
published posture (and the storm harness resolves env-else-default) — so
the raw key decides only whether a listed step is skipped. With the
skip registry EMPTY the guards are inert everywhere; the raw key leaves
them undefined on the default (ON) lane, so a future entry for either
file fails LOUD there (the step runs and reds, never a silent skip),
which is the trigger to convert the key. Each file's own comment carries
this. A posture PROBE before each suite pins serving-loop PRESENT
(`/api/health/stats.servingLoop`) and shell define UNSET (`/api/meta`'s
`shellServerExecutionDefine` null), so a silent un-flip of the default
cannot move the REQUIRED lanes off ON. The explicit
`EXPERIMENTAL_SERVER_EXECUTION=false` lanes are the OFF regression
guard — the rollback lever kept honest through the soak — on an
OFF-built binary (`build-toolshed-off`, the define `"false"`), VERIFIED
by the same probe (`shellServerExecutionDefine === "false"`,
`servingLoop` absent) before the suite runs; they retire with the OFF
path in the post-soak removal PR. Skips only via
`tasks/server-execution-on-skips.ts` (file entries; STEP entries for a
one-file suite, guarded in-file and bound to the register), printed
loudly, riding the DEFAULT lanes (the ON arm — the OFF guard never
skips), EMPTY at the flip (its stated precondition) — and, since
2026-08-16, actually EFFECTIVE: `deno test --ignore` binds only to
files deno discovers itself, so the package `integration` tasks hand
deno a quoted glob and the pattern shards filter their file list
through the script (`--filter`); until then every listed skip ran. The
deployed-topology binaries the presets flip carry their own gates since
the flip PR (its recorded obligation; P7 review finding 8): the
`deployed-topology-gate` job runs the real `bg-piece-service` binary
and cf-harness's fabric-session factory against the default (ON)
toolshed, posture-asserted; the CLI lanes are `cf`'s gate (it adopts
the server's published posture; the lane probes the server half); and
`PiecesController` hosts ride the default package/pattern lanes
(sx2-scale's controllers, the pieces-controller helper). Single-process
suites (the unit suites, `cf test`, the runner integration files that
serve toolshed's `app.ts` in-process — the serving loop starts in the
binary's `index.ts`, not in `app.ts`) are not arms of this contract:
they have no serving host and run the derive-and-commit model (the
ambient baseline, OFF) by construction (EXPERIMENTAL_OPTIONS.md) — the
flip does not reach them.*

Test-record identity follows the [test-run record
contract](../test-records.md). The current default arm (ON since the flip)
leaves the shipping action's `variant` input unset, continuing the existing
unmarked history. The explicit OFF package and pattern jobs set it to
`server-execution-off`, so the regression guard keeps its own history; the
pre-flip explicit-ON arm's `server-execution` marker retired with the flip
(its history stays queryable under that variant). Any additional
non-default arm uses its own stable variant. The workflow tests assert both
that non-default arms carry their exact marker and that the default arm
remains unmarked.

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
| 3 | `sx2-events` (two-user lunch poll via server handlers; kill-between-event-and-consequence restart; duplicate-submit rejection; rapid-fire final-only values with every event processed); rapid-fire COALESCING is discriminated by the CONSTRUCTED-queue-depth pin in the runner suite (`executor-events-down.test.ts`: K entries queued ahead of one drain → K completed runs, each consequenced exactly once, in EXACTLY ONE consequence-carrying derived commit) — the live surface LOGS its derived-commit ratio as a load observation, never a gate, because its append queue serializes one commit round trip per event and the ratio has no test lever (RULED 2026-08-21 — owner: “i like (3) as well”, on the ow-sx2-coalescing-gate dispositions; the census flake this retires was the ratio assert reading a fast drain as a failure); propagation ≤300 ms p50 measured on `lunch-poll-vote` UNMODIFIED |
| 4 | `sx2-effect-channel` (navigate intent/ack; reload between intent and ack; optimistic-enact reconcile); existing `topics-navigation` ON — ON-SKIP-LISTED since Phase 4 (red under the full ON posture: OW30's controller write-destination class; not ON coverage until it lifts) |
| 5 | existing `shared-profile`, `profile-embed`, `sqlite-read-clearance-multi-runtime` green ON — the v1 stragglers are the acceptance tests |
| 6 | `sx2-scale` (cf-checkbox in-suite ≈ isolated; budget: hostile LLM fan-out in space A leaves space B's propagation in budget); no poll-loops left in the suite |
| 7 | full suites ON-only; propagation beats OFF-arm baseline on byte-identical workloads — NEITHER met at the flip-ready landing (2026-08-16): the ON lanes are green only with six `phase-7` skip entries (verification-coverage OW30/OW32/OW33) and the benchmark is unmeasured (its harness is the two-browsers gate, red on OW32) |

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
