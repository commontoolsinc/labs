# Server-primary execution, v2

Status: **live spec** — governs the rebuild. The first implementation
(2026-07-07 → 2026-08-02) was concluded as a learning run; its design
documents and the full lesson log are archived under
[`docs/history/specs/server-side-execution/`](../../history/specs/server-side-execution/README.md),
with the standing-knowledge record in
[`passivity-arc-orchestration.md`](../../history/specs/server-side-execution/passivity-arc-orchestration.md).
This document states what we now know we are building and the lessons that
constrain how. It replaces the archived design and implementation plan.

## 1. The goal

**Servers do all the compute that is stored. Clients may compute anything,
and commit nothing.**

- The server runs **every reactive computation whose result is durable**:
  derived cells, `computed`/`lift`, `map`, `generateText`/`generateObject`,
  `fetchData`, sqlite queries — everything downstream of committed state.
- The client runs **rendering effects** (invisible to the server anyway),
  **handlers** (which capture user intent and submit it), and **any amount
  of speculative execution it likes** — the same derived computations,
  run locally for latency, with results that are never committed.
- External side effects (webhooks, outbound fetch-as-effect, LLM calls that
  bill) are performed **only** by the server executor.

The boundary is **commit authority, not compute location**. The prior arc's
"client passivity / no dual execution" framing was wrong in a way that
generated machinery: dual *execution* is fine and deliberate (that is what
speculation is); dual *commitment* is what must never happen. One committer
per space. The client's speculative run needs no claim, no certificate, no
admission — because it never produces a commit.

The egress rule falls out of the same line: **speculate on anything you can
throw away; never on anything you can't take back.** A derived value is
discarded for free, so clients may speculate it. A webhook cannot be
un-sent, so only the committing side may perform it.

### Why this is also the *fast* design for multiplayer

With client-side execution, N clients race to recompute and commit the same
derived state, and the merge machinery digests the conflict storm. With one
committing runtime per space there is exactly one authoritative run and one
commit per change. Server-primary execution should therefore be *faster*
than today for multi-user spaces, not tolerably slower. The v1 measurements
(§4) showed slower — and the slowdown was traced to v1's own scaffolding,
not to the architecture. Fast is the requirement, not the hope.

## 2. The central lesson of v1

> The recurring problem in this arc is that we tried to partially move to
> the server and invented all kinds of things to support that, when the
> easier solution would have been to move all at once. All the rank stuff
> is to a large degree that. — owner, 2026-08-01

Partial migration means the server must **accept work it did not do**, and
that single obligation generated the bulk of v1's complexity:

- **Claims / candidates / settlements / fences** — arbitration over who may
  commit an action, meaningful only while two parties might.
- **The rank ladder and context-lattice negotiation** — which subset of
  actions the server had authority over, meaningful only mid-migration.
- **`completeSchedulerScopeSummary` certificates** — compiler-issued
  evidence bounding a computation's writes so a commit produced elsewhere
  could be admitted. 13 source files, 214 golden fixtures, reaching from
  ts-transformers through the runner into the memory protocol.
- **Shadow/authoritative double execution** — every served action ran
  twice: once privately to prove a candidate, once for real after the claim
  round trip.
- **The observation evidence log** — every server-side run durably
  persisted its full read/write link sets plus a copy of the certificate
  (42–158 KB per record) as admission evidence.

**The survival test** for any mechanism in the rebuild: *ask what it
decides, not where it lives.* If what it decides is only meaningful while
clients can also commit, it is scaffolding — do not build it. If a v1
mechanism seems needed, the first question is what deletes it, never how to
make it more correct.

Corollaries already ruled:

- Write bounding is done by **capability handles + CFC checks at write
  time**, by whoever holds the handle. Untrusted pattern code only gets
  handles to what it may write. No commit-time certificates (D-2026-08-02).
- Placement is determined **from input links**, as the pre-arc runner
  already does. No static scope discovery before first run; scope is
  discovered *by running* (D11).
- Crash recovery is **recomputation from current state** — reactive
  computations are deterministic functions of cells — not replay of
  persisted run logs. Handler *events* remain durable (they are intent, not
  derivation); `persistentSchedulerState` returns to that modest pre-arc
  role.
- Toolshed routes its own pattern needs through the executor;
  `background-piece-service` stays sunset (D12).

## 3. Architecture

### 3.1 Server

One committing runtime per space, hosted by the executor pool.

- Subscribes to its space; on any accepted commit, runs the affected
  reactive graph to fixpoint and commits the derived changes. One
  authoritative run per change; no shadow pass, no claim round trip.
- Performs all external effects (`"server-executor"` remains the one
  declaration of `externalSinkDisposition: "allow"`).
- Runs `generate*` / `fetch*` / sqlite as ordinary served computations —
  they are just reactive nodes whose evaluation happens to reach out.
- Recovery: on restart, re-derive from current cell state. No observation
  replay.

### 3.2 Client

A full runtime that has lost exactly one right: committing derived state.

- **Handlers** run locally and commit their writes as *events/intent* —
  this is the one client-originated commit class, and it is what the server
  reacts to.
- **Speculation**: after firing a handler (or on any local input), the
  client may run the same derived graph locally and render the result
  immediately. Speculative results are overlay-only; when the
  authoritative value arrives it replaces the overlay. Keep v1's one
  surviving insight here: *drop only the authority of a local run, never
  the ability to run* (the "speculation for rendering, not rerun for
  authority" rule from the claim-deletion scoping).
- **Rendering effects** stay client-side; the server never sees them.

### 3.3 The push path is THE hot path

The user-visible cost of this architecture is a single number: **how fast
an observing client sees another user's committed change.** The actor hides
behind local echo; every other participant waits on
commit → serve → derived commit → push. v1 measured 500–1800 ms for this
hop and the rebuild must design it deliberately:

- **Budget: ≤ 300 ms p50 LAN** for handler-commit → observing client's
  derived update (v1's residual after removing its self-inflicted storm was
  306–453 ms with double execution still on; mainbase's client-computed
  equivalent is 92–294 ms; beating mainbase is the eventual bar, per §1).
- **Priority**: user-facing derived values before any bookkeeping on the
  subscription channel.
- **Commit amplification budget: ~1 protocol commit per logical write.**
  v1 hit ~60× (595 notifications for ~10 writes) and buried the hot path
  under its own bookkeeping. Every proposed durable record must answer
  "who reads this, and what do they decide with it?"

### 3.4 Configuration

Exactly two states, one flag. OFF is today's behaviour byte-for-byte; ON is
the full v2 posture. **No shippable intermediate states** — partial flag
combinations exist only as debugging affordances during bring-up, and the
v1 dial set (eight interlocking dials) is the cautionary tale. Both halves
of any coupled behaviour (e.g. "client suppresses egress" and "server
performs egress") move on the same flag — v1 shipped one half unconditional
and silently dropped side effects in the OFF arm.

## 4. Measured constraints (what the learning run bought)

All measurements 2026-08-02, quiet box, `deno task integration`
harness, byte-identical workloads across arms unless noted. Full detail in
the archived
[orchestration log §2.5c](../../history/specs/server-side-execution/passivity-arc-orchestration.md).

| fact | number | consequence for v2 |
| --- | --- | --- |
| Single-user interactive latency, v1 flags-on vs off | 292 ms vs 318 ms (parity) | the architecture is not inherently slow for the actor |
| Cross-user propagation, v1 | 92–294 ms → 767–1821 ms (4–6×) | the push path was drowned by v1's own evidence log |
| — after ablating the evidence log only | 306–453 ms | remaining cost is the extra hop + double execution; the ≤300 ms budget is reachable |
| Commit amplification, v1 | ~60× (595 notifications / ~10 writes) | bookkeeping must never ride the commit stream |
| Store growth, v1 | ~80 MB per space per test run; 72% observation evidence | durable records need a reader and a decision |
| One `map` run's evidence record | 158 KB (130 KB serialized read links + certificate copy) | never persist per-run provenance for recovery a recompute can do |
| Teardown, v1 | 2.9 s → 8.1 s (drains the storm) | session close must be O(1), not O(traffic) |
| ts-transformers certificate surface | 13 src files, 214 goldens, 321 marker sites | deleting at the source (don't emit) collapses all of it |
| Suite-context degradation | same test 4 s isolated, 138 s in-suite (34×) | open question §6; server must stay flat as spaces accumulate |

Also bought, as method: compare arms only on byte-identical workloads;
measurement instrumentation must not touch the measured path (v1's own
probes *warmed* the flags-on arm and understated its cost); prove causation
by ablation, not correlation; counters are load-insensitive, latencies
above load ~5 are not quotable.

## 5. What v2 explicitly deletes from v1

The rebuild starts from `main`, not from the v1 branches
(`codex/server-execution-w1-2-shared-pool` and
`codex/server-execution-flags-on` are archives — do not merge). In a world
where only servers commit derived state, the following have no decision
left to make:

- the claim lifecycle (candidates, issuance, revocation, settlement,
  fences, incarnations) and its storage tables
- rank ladder, context-lattice claim negotiation, per-rank candidate dials
- `completeSchedulerScopeSummary` emission and every consumer, through to
  the memory protocol's claimed-commit admission
- shadow/authoritative action-transaction routing
- the observation evidence log (observation / snapshot / replay tables at
  derived-run frequency)
- unserved markers, demand-shrink compensation, the legacy-background
  exclusion protocol
- the arc's write-firewall-as-admission (write bounding moves to handle
  grant time)

Anything on this list that seems needed during the rebuild triggers the
survival test before it triggers implementation.

## 6. Open questions (owner rulings or experiments required)

1. **Offline / disconnected clients.** If only the server commits derived
   state, what does a client do offline? Presumably: handlers queue as
   pending intent, speculation renders freely, reconciliation happens on
   reconnect — but this needs its own design pass.
2. **The 34× suite-context degradation.** Mechanism has a strong candidate
   (stores persist and grow; every commit fans out against every active
   lane) but the discriminating experiment (mainbase full suite, compare
   in-suite `cf-checkbox`) has not run. v2's requirement stands regardless:
   flat performance as spaces accumulate.
3. **Cross-space reads and read-time clearance.** The v1 product failures
   (`shared-profile`, `profile-embed`, `sqlite read-time clearance`) were
   deferred as straggler bugs. v2 must make these work *by construction*:
   the server-side runtime reads foreign spaces with the piece's authority,
   and per-reader clearance is enforced where the read is served.
4. **Handler event schema.** Handlers commit intent; the server derives
   consequences. Does the existing scheduler-v2 durable-event shape
   (#4288) carry over unchanged, or slim down once observations go?
5. **Speculation reconciliation UX.** When an authoritative value differs
   from the speculation it replaces, what does the user see? (v1 never got
   far enough to measure divergence rates; the divergence harness sketch is
   in the session record.)

## 7. Relationship to prior documents

- The eight v1 design documents, including the orchestration log with the
  complete environment-trap and measurement-discipline record, are frozen
  under
  [`docs/history/specs/server-side-execution/`](../../history/specs/server-side-execution/).
  Cite them as history, not as descriptions of the system.
- [`docs/development/EXPERIMENTAL_OPTIONS.md`](../../development/EXPERIMENTAL_OPTIONS.md)
  still documents the v1 dials as they exist on the archived branches; the
  entries retire when v2 lands its single flag.
- The pre-arc, still-live behaviour specs this document leans on:
  [`persistent-scheduler-state.md`](../persistent-scheduler-state.md)
  (returns to its pre-arc scope),
  [`scheduler-v2/`](../scheduler-v2/), [`memory-v2/`](../memory-v2/).
