# Server-primary execution v2 — implementation plan

Executes the [v2 spec](../specs/server-side-execution/README.md). The spec
is the authority on *what*; this plan sequences *when* and carries the
progress state. Tick a box in the PR that lands the item. Success criteria
are measurable gates — a phase is done when its criteria are ticked, not
when its tasks are.

Conventions inherited from the v1 learning run (details in the
[archived orchestration log](../history/specs/server-side-execution/passivity-arc-orchestration.md)):
measure through `deno task integration --port-offset=NNN`, uninstrumented
workloads, byte-identical across arms, adjacent runs, counters over
latencies, no latency quoted above load ~5, causation by ablation.

Main carries no executor (no `packages/runner/src/executor/`, no
`serverPrimaryExecution` in `packages/memory/v2.ts`) — but it DOES
carry the certificate/observation surface:
`completeSchedulerScopeSummary` is emitted and consumed across ~10
source files (ts-transformers `core/transformers.ts`,
`schema-injection.ts`, `lift-applied-strategy.ts`,
`capability-analysis.ts`, plus runner consumers), and
`persistentSchedulerState` (OFF by default) persists full-JSON
`scheduler_observation` payloads. Phase 1 is therefore partly a
REDUCTION OF MAIN — delete that surface, reduce the observation tables
to the v2 basis index — and partly a build. The spec §5 deletion list
is enforced by deleting on main and *not rebuilding*, with the survival
test as the gate on anything that feels needed.

## Phase 0 — Rulings and guardrails

Tasks:

- [x] Owner confirms or amends **D-v2-1** (events are the client's only
      computational commit) on PR #5269 — **RULED YES 2026-08-02:
      events-down from day one.**
- [x] Owner rules Q1 (offline event queueing) and Q6 (effect authority
      for multi-user triggers) far enough to unblock Phases 3 and 1
      respectively — **RULED 2026-08-02**: offline events discharge on
      reconnect and a conflicting discharge is dropped with a client
      notice (events.md §5, speculation.md §5); effect run cardinality
      follows cell scopes, quota attribution deferred (README §3.8,
      §6).
- [ ] Owner + spec review of cell SCOPES (`user`/`session`) end to
      end — v1's scope confusion must not carry into v2; blocks the
      user/session-derived-state question (README §6 Q7, was ledger
      L10; runtime-mapping.md N56). Inherits Q6's non-quota remainder:
      per-run identity for served effects (runtime-mapping.md N57).
      **In progress 2026-08-02**: the batch-3 rulings are drafted as
      [scopes.md](../specs/server-side-execution/scopes.md) (scope
      keys instances, never authority). Scout complete 2026-08-02:
      scopes.md anchored (§Anchors verified), the five
      main-vs-SpaceServer mismatches M1–M5 recorded (scopes.md §7);
      scopes.md §8 carries the residual opens (basis-index keying,
      watermark × fan-out, context-floor fate, session-data GC, the
      M3 write path).
- [ ] Name the single flag, register it in `EXPERIMENTAL_OPTIONS.md` with
      both states defined; OFF is today byte-for-byte.
- [ ] CI runs a flag-ON arm of the integration suites from the first PR
      that has anything to test (v1 lesson: the flags-on branch never went
      through CI).
- [ ] Audit what server-execution surface, if any, exists on main
      (executor remnants, stats routes, doc references) and record it in
      this plan.

Success criteria:

- [ ] Flag registered; a no-op ON arm passes CI identically to OFF.

## Phase 1 — The serving loop, landed dark (six stages, flag OFF)

The executor hosts one committing runtime per space: wake on accepted
commit, run the affected graph to fixpoint, commit derived changes. No
shadow pass, no claims, no evidence log. Placement from input links;
activation resolves demanded values and queued events — there is no
piece-start policy (serving-loop.md §1, RULED 2026-08-02).

The six-PR cut below lands with the FLAG OFF THROUGHOUT: every stage
merges with the OFF arm byte-identical to today, and no stage makes
the ON arm a shipped state. The first ON-arm milestone is Phase 2's,
merged from the old Phases 1+2 (owner, 2026-08-02): server derives
AND client does not — a two-deriver interim never ships. A dev may
flip the flag locally mid-Phase-1 and will see CAS storming between
the server and still-deriving clients; expected, local-only, fine.

Stages, one PR each:

- [ ] **A — flag + commit class + CI**: register the single flag
      (Phase 0's naming; `EXPERIMENTAL_OPTIONS.md`, OFF is today
      byte-for-byte); land the `class` commit metadata (protocol.md
      §1, §7); stand up the OFF+ON CI arms with explicit skip lists
      (testing.md §2); disable `stream-data` under the flag (spec
      §3.5).
- [ ] **B — lease**: create the `execution_lease` table (engine-v3
      migration — none exists on main; v1-branch shape as prior art),
      the acquire/renew/expire cycle, and the derived-class admission
      equality check (serving-loop.md §2).
- [ ] **C — main reduction**: delete main's certificate surface —
      `completeSchedulerScopeSummary` emission (ts-transformers) and
      every consumer (runner); reduce the observation tables to the
      v2 basis index — standalone `(action, entity, seq)` rows
      replacing the full-JSON payload form (serving-loop.md §3b).
- [ ] **D — seal-into-wave**: action transactions seal into the wave
      accumulator server-side; per-doc CAS with per-write-class
      conflict handling; CFC stays per action run
      (serving-loop.md §3c–§3d).
- [ ] **E — host + SpaceServer + watermark + gates**: executor host,
      per-space activation/park with demand-driven value pull — no
      per-piece start/stop (serving-loop.md §1, §3); pure structural
      built-ins served (spec §3.5 row 1); pattern-source watcher +
      hot-swap in the SpaceServer — the `systemPatternAutoUpdate`
      posture flips server-side (serving-loop.md §3e;
      `pattern-update-testing.md` scenarios are the acceptance
      surface); the watermark doc + `derivedThrough` +
      `waitForSettled(space, seq)` (protocol.md §4, testing.md §3);
      the §7 counters.
- [ ] **F — effectful + outbox**: serve `fetch*`, `generate*`,
      `sqlite*` behind request-hash memoization; the outbox; egress
      performed only here (effect authority per README §3.8; quota
      attribution deferred); recovery = basis-index re-marking,
      recompute pure nodes, reuse memoized effect results, no replay
      (serving-loop.md §4–§6).

Success criteria (flag OFF — the ON gates are Phase 2's):

- [ ] Every stage lands with the OFF arm byte-identical to today
      (testing.md §2); the ON arm runs in CI from stage A with
      explicit skip lists, never silent filtering.
- [ ] Stage C leaves no `completeSchedulerScopeSummary` reference on
      main and no full-JSON observation payload tables; the basis
      index is the only persisted scheduler state besides W and
      `eventWatermark`.

## Phase 2 — Flag ON: server derives and the client does not

The first ON-arm milestone, MERGED from the old Phases 1+2 (owner,
2026-08-02): the SpaceServer committing derivations and the client
losing its derivation-commit path ship as ONE state — a two-deriver
interim never ships (local bring-up runs of it are fine, per
Phase 1's note). Client HANDLER writes still commit authored-class
until Phase 3 lands events — that interim is Phase-3-related, not a
derivation interim, and stays (protocol.md §1).

Tasks:

- [ ] Remove the client's derivation-commit path under the flag (by
      construction, not firewall).
- [ ] Speculation overlay: run the derived graph locally, render
      immediately, replace on authoritative arrival (drop authority,
      never the ability to run).
- [ ] Effectful nodes read through to last committed results — never
      speculated. Result-as-pattern children may instantiate
      overlay-locally, converging by cause-derived identity
      (speculation.md §2, owner 2026-08-02).
- [ ] UI bindings untouched: authored writes under existing ACL + CAS.

Success criteria (the old Phase-1 ON gates land here, merged):

- [ ] `counter` and `cfc-group-chat-demo-multi-runtime` green in the
      ON arm (client handler writes still authored-class until
      Phase 3).
- [ ] Byte-identical workload tests pass in both arms.
- [ ] `sx2-` gate tests settle on `waitForSettled`, no text-polling
      (testing.md §3).
- [ ] One authoritative run per upstream change (scheduler-run and
      commit counters, not logs).
- [ ] **~1 protocol commit per logical write** on the lunch-poll
      workload (v1 measured 60×; the counters exist — use them; the
      gate metric is testing.md §4's single ratio, ≤ 2 on pure
      workloads — a trigger, not a hard gate: a breach fails until a
      human inspects the why).
- [ ] Server restart mid-test: derived state reconverges, effectful
      nodes do not re-fire (store shows no duplicate effect results).
- [ ] Actor-side interactive latency at parity (v1 measured 292 vs
      318 ms).
- [ ] Client derivation commits gone: the store session-attribution
      query shows zero client-committed derived writes in the ON arm.

## Phase 3 — Events-down handlers (D-v2-1)

Tasks:

- [ ] Handler fire commits the event only (payload + target stream);
      admission = append authority + CAS.
- [ ] Server processes events — client-committed and server-originated
      (`stream.send()`) through the same path.
- [ ] Client handler run demoted to speculative echo.
- [ ] Idempotent processing on durable event IDs: consequence committed ⇒
      event not re-run across restarts.
- [ ] Ephemeral-value rule: values captured into the payload at fire time
      (transformer lint can trail as a follow-up).

Success criteria:

- [ ] Two-user lunch poll green with server-processed handlers; both
      votes survive, tallies correct.
- [ ] **Event commit → observing client's derived update ≤ 300 ms p50**
      on a quiet box (v1 baseline: 92–294 ms client-computed;
      306–453 ms was v1's residual with scaffolding half-off).
- [ ] Kill the server between event commit and consequence commit: on
      restart, exactly-once consequences, no lost events.

## Phase 4 — Client-effect channel

Tasks:

- [ ] Session-scoped effect cells with ack/nonce retirement (spec §3.7).
- [ ] `navigateTo` served: computes the target, writes navigation intent;
      client enacts and acks; optimistic enactment allowed.

Success criteria:

- [ ] `topics-navigation` and the navigateTo paths green in the ON arm.
- [ ] An intent is enacted exactly once per nonce, including across a
      client reload between intent and ack.

## Phase 5 — Cross-space and clearance by construction

Tasks:

- [ ] Home-space runtime reads foreign spaces with the piece's granted
      authority; foreign commits wake the home runtime (server-internal
      subscription).
- [ ] Per-reader clearance enforced where the read is served (sqlite row
      admissibility, CFC labels).
- [ ] `.inSpace()` provisioning server-side: foreign-first split at the
      wave commit step, event-derived deterministic DIDs (CT-1650),
      replay-idempotent (protocol.md §2b).

Success criteria:

- [ ] The three v1 stragglers are the acceptance tests, green in the ON
      arm: `shared-profile`, `profile-embed`,
      `sqlite-read-clearance-multi-runtime`.
- [ ] Profile creation (the `.inSpace()` flow: `profile-create`,
      `home-profile`) green in the ON arm, including a kill between the
      foreign and home commits — replay converges on the same DIDs, no
      orphans, no duplicates.

## Phase 6 — Push priority, budgets, scale

The watermark and `waitForSettled` land in Phase 1; this phase keeps
only push priority and the budget/backpressure hardening.

Tasks:

- [ ] Push priority on the subscription channel: subscribed-doc
      `derived` commits flush first (protocol.md §3).
- [ ] Per-space budgets in the executor (CPU per wave, outstanding LLM
      calls, egress rate); a runaway pattern degrades only its own space.
- [ ] Event/binding backpressure shaping ahead of the commit stream.

Success criteria:

- [ ] No integration test needs a poll-loop for "is the server done."
- [ ] `cf-checkbox` in-suite ≈ isolated (v1 measured 4 s vs 138 s; flat
      accumulation is the requirement, whatever the v1 mechanism was).
- [ ] A deliberate LLM fan-out loop in one space leaves a second space's
      propagation latency inside budget.

## Phase 7 — Flip and retire

Tasks:

- [ ] Default ON after Phases 1–6 gate green in CI for a soak period.
- [ ] Retire the flag; OFF path removed; `EXPERIMENTAL_OPTIONS.md` entry
      closed out.
- [ ] Archive this plan to `docs/history/plans/` per the lifecycle.

Success criteria:

- [ ] The integration suites run ON-only and green.
- [ ] Cross-user propagation beats the client-computed baseline on the
      byte-identical workloads (the §1 "faster, not tolerably slower"
      requirement).
