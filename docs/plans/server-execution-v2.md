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
- [ ] Owner rules Q1 (offline event queueing) and Q6 (effect authority for
      multi-user triggers) far enough to unblock Phases 3 and 1
      respectively; the rest of §6 can trail.
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

## Phase 1 — The serving loop (derivations)

The executor hosts one committing runtime per space: wake on accepted
commit, run the affected graph to fixpoint, commit derived changes. No
shadow pass, no claims, no evidence log. Placement from input links.

Interim posture: until Phase 3 lands, client HANDLER writes continue to
ride authored-class commits exactly as today (protocol.md §1); Phase 1
changes who commits derivations, not who commits handler writes, and
the client derivation-commit path is removed in Phase 2.

Tasks:

- [ ] Executor host + per-space runtime lifecycle (start, wake, idle,
      stop); borrow lessons, not code, from the archived pool.
- [ ] Create the `execution_lease` table (engine-v3 migration — none
      exists on main; v1-branch shape as prior art) and the lease
      acquire/renew/expire cycle (serving-loop.md §2).
- [ ] Delete main's certificate surface: `completeSchedulerScopeSummary`
      emission (ts-transformers) and every consumer (runner); reduce the
      observation tables to the v2 basis index — standalone
      `(action, entity, seq)` rows replacing the full-JSON payload form
      (serving-loop.md §3b).
- [ ] Serve pure structural built-ins (spec §3.5 table, row 1).
- [ ] Serve effectful built-ins server-side — `fetch*`, `generate*`,
      `sqlite*` — behind request-hash memoization; egress performed only
      here (effect authority per Q6 ruling).
- [ ] Recovery: restart → basis-index re-marking, recompute pure nodes,
      reuse memoized effect results; no replay (serving-loop.md §6).
- [ ] Settled-ness watermark ("derived current through seq N") rides
      derived commits + the watermark doc; `waitForSettled(space, seq)`
      test helper lands with it (protocol.md §4, testing.md §3).
- [ ] Pattern-source watcher + hot-swap run in the SpaceServer under
      the flag — the `systemPatternAutoUpdate` posture flips
      server-side (serving-loop.md §3e; `pattern-update-testing.md`
      scenarios are the acceptance surface).
- [ ] Disable `stream-data` under the flag (deferred per spec §3.5).

Success criteria:

- [ ] `counter` and `cfc-group-chat-demo-multi-runtime` green in the ON
      arm (client derivation commits stay enabled until Phase 2, client
      handler writes until Phase 3 — the interim posture above).
- [ ] `sx2-` gate tests settle on `waitForSettled`, no text-polling
      (testing.md §3).
- [ ] One authoritative run per upstream change (scheduler-run and commit
      counters, not logs).
- [ ] **~1 protocol commit per logical write** on the lunch-poll workload
      (v1 measured 60×; the counters exist — use them; the gate metric
      is testing.md §4's single ratio, ≤ 2 on pure workloads).
- [ ] Server restart mid-test: derived state reconverges, effectful nodes
      do not re-fire (store shows no duplicate effect results).

## Phase 2 — Client: speculation and authored writes only

Tasks:

- [ ] Remove the client's derivation-commit path under the flag (by
      construction, not firewall).
- [ ] Speculation overlay: run the derived graph locally, render
      immediately, replace on authoritative arrival (drop authority,
      never the ability to run).
- [ ] Effectful nodes read through to last committed results — never
      speculated.
- [ ] UI bindings untouched: authored writes under existing ACL + CAS.

Success criteria:

- [ ] Byte-identical workload tests pass in both arms.
- [ ] Actor-side interactive latency at parity (v1 measured 292 vs 318 ms).
- [ ] Client derivation commits disabled (moved here from Phase 1): the
      store session-attribution query shows zero client-committed
      derived writes in the ON arm.

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
