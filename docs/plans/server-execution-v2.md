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
carry the certificate/observation surface, and it is BIGGER than an
earlier draft of this paragraph claimed (~10 source files). Measured
2026-08-02: **~25 source files across FIVE packages** —
`ts-transformers` (4: `core/transformers.ts`, `schema-injection.ts`,
`lift-applied-strategy.ts`, `capability-analysis.ts`), `runner` (13),
`memory` (4), `state-inspector` (3), `cli` (1) — plus **~110 golden
fixtures** under `packages/ts-transformers/test/fixtures/`, whose
regeneration is a required step of the change rather than a
follow-up. The surface has TWO identifiers, not one:
`completeSchedulerScopeSummary` and `completeActionScopeSummary`; an
inventory greping only the first undercounts it. Alongside it,
`persistentSchedulerState` (OFF by default) persists full-JSON
`scheduler_observation` payloads. Phase 1 is therefore partly a
REDUCTION OF MAIN — delete that surface, replace the observation
tables with the v2 basis index — and partly a build. The spec §5
deletion list is enforced by deleting on main and *not rebuilding*,
with the survival test as the gate on anything that feels needed.

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
      L10; runtime-mapping.md N56). Q6's non-quota remainder —
      per-run identity for served effects — RULED 2026-08-02, R-Q6b:
      service-identity envelope, attribution within the derived
      commit (protocol.md §1/§7; runtime-mapping.md N57 resolved).
      **In progress 2026-08-02**: the batch-3 rulings are drafted as
      [scopes.md](../specs/server-side-execution/scopes.md) (scope
      keys instances, never authority). Scout complete 2026-08-02:
      scopes.md anchored (§Anchors verified), the five
      main-vs-SpaceServer mismatches M1–M5 recorded (scopes.md §7).
      Batch-4 closures 2026-08-02: watermark × fan-out (composition
      — undemanded instances never hold W back; corrected below),
      `scheduler_context_floor` (deletes with the
      observation machinery), the M3 write path (R-Q6b). Adversary
      round 3, 2026-08-02: the M3 ruling's READ half is now closed
      too — reads may name an explicit `entity_scope_key`,
      admissible only for the space's live lease holder (scopes.md
      §7 M1, protocol.md §2), and run identity for
      non-handler runs is per DEMANDED INSTANCE (scopes.md §5). The
      batch-4 fan-out closure was CORRECTED: the discovering wave
      writes the redirect AND its own run's instance, and W waits on
      demanded siblings (scopes.md §2). The residual open that
      remains is session-data GC — the basis-index DDL is authored
      in serving-loop.md §3b — and that GC must cover non-session
      keys too. **Owner modeling ruling 2026-08-03 — the transaction
      identity model (protocol.md §1) — closed the two remaining
      ledger items:** LD5 (the read row is RATIFIED as the read half
      of the server-driven commit variant — a protocol change, and
      the intended one) and LD3 (the `scope_key` format is PROTOCOL
      vocabulary, defined once in the wire-shape module
      `packages/memory/v2.ts` beside `CellScope`, imported by engine
      and runner alike; the runner constructs keys from demand-/
      `firedAt`-supplied identity and never resolves them from
      ambient state — key-vocabulary.md §3). Phase 1 stage E is
      unblocked.
- [x] Name the single flag — NAMED 2026-08-02:
      `EXPERIMENTAL_SERVER_EXECUTION` (RuntimeOptions key
      `serverExecution`), deliberately distinct from v1's
      `SERVER_PRIMARY_EXECUTION` so archived docs never alias it —
      and register it in `EXPERIMENTAL_OPTIONS.md` with both states
      defined; OFF is today byte-for-byte. REGISTERED 2026-08-04
      (stage A): env → runtime → ambient control point in
      `packages/memory/v2.ts`, both states defined in the registry.
- [x] CI runs a flag-ON arm of the integration suites from the first PR
      that has anything to test (v1 lesson: the flags-on branch never went
      through CI) — STOOD UP 2026-08-04 (stage A): the pattern and package
      integration suites run a second, flag-ON arm with the explicit
      per-phase skip lists in `tasks/server-execution-on-skips.ts` (empty
      as of stage A).
- [x] Stand up the scenario-trace suite
      ([scenario-traces.md](../specs/server-side-execution/scenario-traces.md),
      2026-08-03) — twelve end-to-end journeys, cell-by-cell with
      citations, executed by smaller-model agents under the
      cite-or-GAP / flag-don't-fix protocol with owner-tier
      adjudication. STANDING RULE: re-run affected traces after
      every ruling batch that edits a detail doc; unexplained
      reference-answer drift is a finding. First run's LT1–LT9 all
      RULED 2026-08-03 (scenario-traces.md §6): same-space cascade
      appends are wave-carried write-level entries (unblocks
      Phase 3's spec side); sessions client-global under
      inter-server trust; cross-space navigateTo deferred with the
      client-vended-stream future note; inheritance uniform across
      run kinds; plus the LT4/5/7/8/9 one-liners. Companion
      instrument
      [field-provenance.md](../specs/server-side-execution/field-provenance.md)
      (2026-08-03): per-field producer→carrier→consumer→retirement
      chains closure-checked across six path families — targets
      the destroyed-in-transit defect class the trace run showed
      dominant; same protocol, same re-run cadence.
- [x] Audit what server-execution surface, if any, exists on main
      (executor remnants, stats routes, doc references) and record it in
      this plan — RECORDED: runtime-mapping.md IS that audit (its
      N59–N61 note says so in terms); no executor exists on main,
      and the certificate/observation surface is measured in this
      plan's preamble (~25 files, five packages, ~110 goldens).

Success criteria:

- [x] Flag registered; a no-op ON arm passes CI identically to OFF
      (stage A, 2026-08-04).

## Interim postures — who does what, in the arm you are building

One table, one lookup: per milestone, who runs and who commits each
class of work. Postures BETWEEN the named milestones do not exist as
shipped states (spec §3.4 — no shippable intermediates); Phase 6
hardens without changing the posture, so it adds no row. Three
rulings shape the surprising cells: **L14** — the old Phases 1+2
merged, so "server derives" and "client does not" ship as ONE state
and a two-deriver interim never ships (owner, 2026-08-02; Phase 2
below); **F10** — client HANDLER writes stay authored-class until
Phase 3, a handler interim, never a derivation interim
(protocol.md §1's authored row); **D-v2-1** — events become the
client's only computational commit (spec §3.6).

| milestone | derivations: run by / committed by | handlers: run by / the client commits | effects performed by | scoped state (user/session instances) | client posture |
| --- | --- | --- | --- | --- | --- |
| OFF baseline (the OFF arm of every phase until Phase 7) | every client runtime / the clients | the firing client / the handler's writes, as today | the client running the node (cross-tab mutex arbitrates — runtime-mapping.md N44) | cardinality 1 per runtime: each client derives ONLY its own instance, keyed by scope NAME (scopes.md §7 M2) — sound because the identity is the runtime's own | today, byte-for-byte; any OFF-arm diff is a phase-gate failure (testing.md §2). Commits carry a `class`, and every client commit is `authored` — `derived` is never claimed off the flag (protocol.md §1) |
| Phase 1 stages A–G (flag OFF throughout) | as OFF baseline — the serving loop lands dark | as OFF baseline | as OFF baseline | as OFF baseline; stage E re-keys the vocabulary per instance WITHOUT changing OFF-arm behavior (at cardinality 1 the instance dimension is derivable from the session) | unchanged; a local ON flip CAS-storms against still-deriving clients — expected, local-only, never shipped (L14) |
| Phase 2 ON — server derives, client does not (first ON milestone; L14) | SpaceServer / SpaceServer, derived-class under lease; the client runs the same graph as overlay speculation only | the firing client, authoritatively / its handler writes, still authored-class (F10 — protocol.md §1) | server only (stage G outbox); the client reads effectful nodes through to last committed results | SpaceServer derives EVERY demanded instance: per-instance run identity (M1, stage F), per-instance keys (M2, stage E), per-`scope_key` push filtering (M4, stage F) — all three MUST be in before this gate | loses exactly one right — committing derivations (by construction); still commits UI-binding writes and handler writes; receives only its own applicable `scope_key`s (protocol.md §3) |
| Phase 3 ON — events down (D-v2-1) | unchanged | SpaceServer, reacting to the event commit / ONLY the event append; the local run is speculative echo, and the client handler-write commit path DELETES (events.md §7 — F10's interim ends) | unchanged | handler consequences land in the ACTING principal's instances, resolved from the server-stamped `firedAt` (scopes.md §5, protocol.md §2) | commits nothing but intent: event appends + UI-binding writes; echo via overlay |
| Phase 4 ON — effect channel | unchanged | unchanged | external effects: server only; session effects (navigate): the server COMPUTES the intent, the client ENACTS and acks by nonce (protocol.md §5) | the effects doc is itself a session-scoped instance; the ack is written into the session's own instance (protocol.md §5) | adds the effects-doc subscription and the enact/ack duty (the ack is an authored write) |
| Phase 5 ON — cross-space | home SpaceServer over foreign reads, under the piece's granted authority / commits HOME only — never derived into a foreign space (protocol.md §2b) | unchanged; cross-space mutation leaves ONLY as outbox event appends; `.inSpace` provisioning lands authored-class, foreign-first, under the event's acting principal | unchanged; the outbox also carries the cross-space appends | foreign reads name their instance explicitly, lease-holder-only (protocol.md §2's read row) | unchanged |
| Phase 7 flip | SpaceServer only — the OFF path is removed | SpaceServer / events only | server, plus the client-enacted channel | unchanged from Phase 5; session-data GC is the remaining owed design (scopes.md §8 item 2) | final: speculate freely, commit only intent; flag retired |

A surface a milestone has not yet landed (navigateTo before
Phase 4, cross-space before Phase 5) has no defined interim
posture: the ON arm skips it via explicit per-phase skip lists
(testing.md §2), never silently.

## Phase 1 — The serving loop, landed dark (seven stages, flag OFF)

The executor hosts one committing runtime per space: wake on accepted
commit, run the affected graph to fixpoint, commit derived changes. No
shadow pass, no claims, no evidence log. Placement from input links;
activation resolves demanded values and queued events — there is no
piece-start policy (serving-loop.md §1, RULED 2026-08-02).

The seven-stage cut below lands with the FLAG OFF THROUGHOUT: every
stage merges with the OFF arm byte-identical to today, and no stage
makes the ON arm a shipped state. The first ON-arm milestone is
Phase 2's,
merged from the old Phases 1+2 (owner, 2026-08-02): server derives
AND client does not — a two-deriver interim never ships. A dev may
flip the flag locally mid-Phase-1 and will see CAS storming between
the server and still-deriving clients; expected, local-only, fine.

Stages, one PR each except C, which is a three-PR train (below):

- [x] **A — flag + commit class + CI**: register the single flag
      (Phase 0's naming; `EXPERIMENTAL_OPTIONS.md`, OFF is today
      byte-for-byte); land the `class` commit metadata (protocol.md
      §1, §7); stand up the OFF+ON CI arms with explicit skip lists
      (testing.md §2); disable `stream-data` under the flag (spec
      §3.5). LANDED 2026-08-04: the class rides the commit record
      (`class` column, stamped per admission path — transact
      `authored`, the server's direct writes `system`; `derived`
      tripwired until stage B's lease check), and the ON arms run
      the full suites (skip lists empty).
- [x] **B — lease**: create the `execution_lease` table (engine-v3
      migration — none existed before it; v1-branch shape as prior
      art), the acquire/renew/expire cycle, and the derived-class
      admission equality check (serving-loop.md §2). `holder` is a
      PER-PROCESS identity — service identity + process-instance
      component, minted at process start (DR1, RULED 2026-08-03;
      serving-loop §2) — with the abort-before-reacquire discipline
      enforced in-process. LANDED 2026-08-04: the table is
      `(space, holder, expires_at)` — exactly three fields, the v1
      shape reduced away; acquire/renew/release are direct engine-table
      writes (`packages/memory/v2/execution-lease.ts` — a renewal is
      never a commit), the in-memory tenure counter makes a reacquire
      unreachable without first ending the lapsed tenure, and admission
      enforces the one equality check under the flag, judged by the
      memory server's clock (an expired row matches nobody). Landed
      dark: nothing drives the renew cadence until stage F's
      SpaceServer.
- [x] **C — main reduction** (a THREE-PR TRAIN, not one PR — the
      surface is ~25 source files across five packages plus ~110
      goldens, and the seams below are where it cuts cleanly):
  - [x] **C.1 — emission + consumers + goldens**: delete
        `completeSchedulerScopeSummary` /
        `completeActionScopeSummary` emission (ts-transformers) and
        every consumer (runner), and REGENERATE the ~110 fixtures
        under `packages/ts-transformers/test/fixtures/` in the same
        PR. Deleting at the source collapses the rest (spec §4's
        measured lesson).
  - [x] **C.2 — protocol + engine + client + tools**: replace the
        observation tables with the v2 basis index — standalone
        `(action, entity, seq)` rows keyed per scope INSTANCE
        (scopes.md §8), NOT reshaped from `scheduler_read_index` /
        `scheduler_action_state`, which drop with the rest
        (serving-loop.md §3b). Drive the migration off §3b's
        SEVEN-table list, not off `CORE_SCHEDULER_TABLES`
        (`packages/memory/v2/engine.ts:1275-1282`), which enumerates
        six and omits `scheduler_context_floor`. NO BACKFILL — the
        new table starts empty and opted-in stores lose warm start
        once (§3b). Carry the protocol-layer deletions that fall out
        with it: the `persistentSchedulerState` flag, its
        `serverFlags` hello negotiation, the
        `scheduler.snapshot.list` RPC, and
        `CommitData.schedulerObservation`; old-client compat is the
        existing hello-degrade path
        (`packages/runner/src/storage/v2.ts:2142`). Collateral that
        no byte-identical gate covers: `packages/state-inspector`
        (`scheduler.ts:15-19`, `246-281`), the `cf inspect` surface
        that renders it, and
        `packages/memory/v2/sqlite/guard.ts:16-33` — drop the dead
        names from the `CORE_TABLE_NAMES` blocklist and ADD
        `scheduler_basis`.
  - [x] **C.3 — flag retirement + doc archival**: retire the
        `persistentSchedulerState` entry in
        `EXPERIMENTAL_OPTIONS.md`, and archive
        `docs/specs/persistent-scheduler-state.md` plus
        `docs/specs/scheduler-v2/per-doc-rehydration.md`'s account of
        the persisted form per the documentation lifecycle.
- [ ] **D — seal-into-wave**: action transactions seal into the wave
      accumulator server-side; per-doc CAS with per-write-class
      conflict handling; CFC stays per action RUN — `action ×
      instance`, never per action (serving-loop.md §3c–§3d).
- [ ] **E — instance re-keying (scopes.md §7 M2)**, declared
      **OFF-ARM NEUTRAL**: re-key the scheduler, the dependency
      graph, and the basis index from scope NAME to scope INSTANCE
      at every site in
      [key-vocabulary.md](../specs/server-side-execution/key-vocabulary.md).
      (Scope note, 2026-08-03 dry-run: the basis index's key SHAPE
      is stage C.2's DDL — E feeds it instance VALUES through the
      engine-side writer, an engine identity consumer, not a tenth
      runner-side site; key-vocabulary.md §4's nine-site closure
      stands.)
      Neutrality is structural, not a hope: in the OFF arm scoped
      cardinality is 1 per runtime, so the instance dimension is
      derivable from the authenticated session and the re-keyed form
      computes the same partition today's name-keyed form does.
      This is the single biggest scope cost of the arc (scopes.md §7
      M2) and it is landed DARK, ahead of anything that depends on
      it — which is why it is its own stage rather than a task
      inside F. LD3 is RULED (owner 2026-08-03, key-vocabulary.md
      §3): the `scope_key` format moves to the wire-shape module
      (`packages/memory/v2.ts`) as ONE shared definition imported by
      engine and runner alike; the nine sites construct keys from
      demand-/`firedAt`-supplied identity, never from ambient state
      (OFF arm: the identity is the runtime's own authenticated
      session — key-vocabulary.md §3). The stage LEADS with that
      definition move.
- [ ] **F — host + SpaceServer + watermark + gates**: executor host,
      per-space activation/park with demand-driven value pull — no
      per-piece start/stop (serving-loop.md §1, §3); pure structural
      built-ins served (spec §3.5 row 1); **M1 — per-instance run
      identity**: a derivation runs per DEMANDED instance and the
      demand supplies the identity, handlers take the event's
      server-stamped actor, and reads name their
      `entity_scope_key` explicitly under the lease (scopes.md §5,
      §7 M1; protocol.md §2); narrowing-redirect writes gain the
      EAGER VIA-USER HOP (scopes.md §2's MUST — differs from
      main's one-hop-per-event; assigned here by the 2026-08-03
      dry-run, which found the requirement owner-less), flag-gated
      so the OFF arm keeps today's behavior; **M4 — push keyed by `scope_key`**:
      dirtiness and delivery both key by `scope_key`, and a
      subscriber receives only its applicable set (protocol.md §3);
      pattern-source watcher +
      hot-swap in the SpaceServer — the `systemPatternAutoUpdate`
      posture flips server-side (serving-loop.md §3e;
      `pattern-update-testing.md` scenarios are the acceptance
      surface); the watermark doc + `derivedThrough` +
      `waitForSettled(space, seq)` (protocol.md §4, testing.md §3);
      the §7 counters.
- [ ] **G — effectful + outbox**: serve `fetch*`, `generate*`,
      `sqlite*` behind request-hash memoization; the outbox; egress
      performed only here (effect authority per README §3.8; quota
      attribution deferred); recovery = basis-index re-marking,
      recompute pure nodes, reuse memoized effect results, no replay
      (serving-loop.md §4–§6).

M1, M2 and M4 (scopes.md §7) are therefore all landed BEFORE the
first ON gate, by name: M2 is stage E, M1 and M4 are stage F tasks.
Phase 2 flips ON with the SpaceServer deriving scoped instances on
per-instance machinery — never on scope-NAME-keyed machinery.

Success criteria (flag OFF — the ON gates are Phase 2's):

- [ ] Every stage lands with the OFF arm byte-identical to today
      (testing.md §2); the ON arm runs in CI from stage A with
      explicit skip lists, never silent filtering.
- [x] Stage C leaves no `completeSchedulerScopeSummary` or
      `completeActionScopeSummary` reference on
      main, no full-JSON observation payload tables, and no
      `scheduler_context_floor`; the basis index is the only
      persisted scheduler state besides W and `eventWatermark`
      (landed 2026-08-04 as the C.1–C.3 train).
- [ ] Stage E lands with the OFF arm byte-identical: the re-keyed
      vocabulary partitions state exactly as the scope-NAME form did
      at cardinality 1.

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
