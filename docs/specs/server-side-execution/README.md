# Server-primary execution, v2

Status: **live spec** — governs the rebuild. The first implementation
(2026-07-07 → 2026-08-02) was concluded as a learning run; its design
documents and the full lesson log are archived under
[`docs/history/specs/server-side-execution/`](../../history/specs/server-side-execution/README.md),
with the standing-knowledge record in
[`passivity-arc-orchestration.md`](../../history/specs/server-side-execution/passivity-arc-orchestration.md).
This document states what we now know we are building and the lessons that
constrain how. It replaces the archived design and implementation plan.
(The v1 branches, `codex/server-execution-w1-2-shared-pool` and
`codex/server-execution-flags-on`, are archives — do not merge.)

## 1. The goal

**Servers do all the compute that is stored. Clients may compute anything,
and commit nothing but intent.**

- The server runs **every reactive computation whose result is durable**:
  derived cells, `computed`/`lift`, `map`, `generateText`/`generateObject`,
  `fetchData`, sqlite queries — everything downstream of committed state.
- The client runs **rendering effects** (invisible to the server anyway)
  and **any amount of speculative execution it likes** — the same derived
  graph, run locally for latency, with results that are never committed.
- The client's durable output is **intent**: handler events, plus (for a
  transition period) direct writes from UI bindings (§3.6).
- External side effects (webhooks, outbound fetch, LLM calls that bill)
  are performed **only** by the server executor.

The boundary is **commit authority, not compute location**. The prior arc's
"client passivity / no dual execution" framing was wrong in a way that
generated machinery: dual *execution* is fine and deliberate (that is what
speculation is); dual *commitment* is what must never happen. Stated as the
invariant it actually is:

> **Every cell class has exactly one committer.** Derived cells: the
> space's server runtime. Event streams: whoever holds an append handle.
> UI-binding cells: the client that owns the binding (transitional).
> No cell has two, so no arbitration machinery exists anywhere.

The egress rule falls out of the same line: **speculate on anything you can
throw away; never on anything you can't take back.** A derived value is
discarded for free, so clients may speculate it. A webhook cannot be
un-sent, so only the committing side may perform it. Effectful nodes are
therefore excluded from client speculation entirely (§3.5) — speculation
reads *through* them, reusing their last committed result.

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
clients can also commit derived state, it is scaffolding — do not build it.
If a v1 mechanism seems needed, the first question is what deletes it,
never how to make it more correct.

Corollaries already ruled:

- Write bounding is done by **capability handles + CFC checks at write
  time**, by whoever holds the handle. Untrusted pattern code only gets
  handles to what it may write. No commit-time certificates
  (D-2026-08-02). Under §3.6 the client-side check narrows further: the
  only computational thing a client commits is an event append, so
  admission is "does this principal hold an append handle to this
  stream?" — a capability lookup, not scope reasoning.
- Placement is determined **from input links**, as the pre-arc runner
  already does. No static scope discovery before first run; scope is
  discovered *by running* (D11).
- Crash recovery is **recomputation from current state** for pure nodes —
  reactive computations are deterministic functions of cells — and
  **committed-result reuse** for effectful nodes (§3.5): a
  `fetchData`/`generateObject` node is memoized by request hash, so
  recovery re-derives the hash and reuses the committed result unless the
  inputs actually changed. Never replay of persisted run logs. Handler
  *events* remain durable (they are intent, not derivation) with their
  scheduler-v2 durable IDs (#4288), which is also what makes handler
  processing idempotent across restarts: an event whose consequence commit
  landed is not re-run.
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
- Processes **events** (§3.6): an event appended to a stream — by a
  client, by another piece, or by a server-run computation calling
  `stream.send()` — is handled by the server-side handler run, whose
  writes commit as the event's consequences.
- Runs `generate*` / `fetch*` / sqlite as ordinary served computations —
  reactive nodes whose evaluation reaches out, memoized by request hash.
- **Cross-space**: a piece's graph is run by its home space's runtime.
  Foreign-space reads are server-internal subscriptions: the home runtime
  reads with the piece's granted authority, and a foreign commit wakes the
  home runtime the same way a home commit does. Per-reader clearance
  (sqlite row admissibility, CFC labels) is enforced where the read is
  served. v1's cross-space claims and cohort fences delete; what remains
  is subscription plus an authority check.
- Recovery: on restart, re-derive from current cell state (with
  memoized-effect reuse per §2). No observation replay.

### 3.2 Client

A full runtime that has lost exactly one right: committing computation
results.

- **Handlers** run locally as *speculation* (instant echo) and their
  triggering event is committed as intent; the authoritative handler run
  happens server-side (§3.6).
- **Speculation**: on any local input the client may run the derived graph
  locally and render immediately. Speculative results are overlay-only;
  when the authoritative value arrives it replaces the overlay. Effectful
  nodes are never speculated — the local run reads through them to their
  last committed result. Keep v1's one surviving insight here: *drop only
  the authority of a local run, never the ability to run* (the
  "speculation for rendering, not rerun for authority" rule).
- **UI bindings** (`$value` on `cf-checkbox` and friends) keep committing
  direct cell writes for now — see §3.6 for why this is a benign,
  shrinking exception.
- **Rendering effects** stay client-side; the server never sees them.
- Client-effect enactment: the client subscribes to its session's effect
  cells (§3.7) and enacts what lands there (navigation, etc.).

### 3.3 The push path is THE hot path

The user-visible cost of this architecture is a single number: **how fast
an observing client sees another user's committed change.** The actor hides
behind local echo; every other participant waits on
intent → serve → derived commit → push. v1 measured 500–1800 ms for this
hop and the rebuild must design it deliberately:

- **Budget: ≤ 300 ms p50 LAN** for intent-commit → observing client's
  derived update (v1's residual after removing its self-inflicted storm
  was 306–453 ms with double execution still on; mainbase's
  client-computed equivalent is 92–294 ms; beating mainbase is the
  eventual bar, per §1).
- **Priority**: user-facing derived values before any bookkeeping on the
  subscription channel.
- **Commit amplification budget: ~1 protocol commit per logical write.**
  v1 hit ~60× (595 notifications for ~10 writes) and buried the hot path
  under its own bookkeeping. Every proposed durable record must answer
  "who reads this, and what do they decide with it?"
- **A settled-ness watermark rides the push**: "derived state is current
  through commit seq N." Clients need it for sync indicators, tests need
  it instead of text-polling, and it is one integer. Without it, "is the
  server done reacting?" is unanswerable from the outside — v1's
  integration tests resorted to 60 s condition polls.
- **Streaming results do not ride the commit stream.** `generateText`
  emits partial tokens; committing per token would rebuild the
  amplification storm at the protocol layer. Partials flow on an ephemeral
  session channel (or throttled coarse snapshots); only the settled result
  commits.

### 3.4 Configuration

Exactly two states, one flag. OFF is today's behaviour byte-for-byte; ON is
the full v2 posture. **No shippable intermediate states** — partial flag
combinations exist only as debugging affordances during bring-up, and the
v1 dial set (eight interlocking dials) is the cautionary tale. Both halves
of any coupled behaviour (e.g. "client suppresses egress" and "server
performs egress") move on the same flag — v1 shipped one half unconditional
and silently dropped side effects in the OFF arm.

### 3.5 Built-in coverage — every one, placed

The full inventory (from `packages/runner/src/builtins/`), so nothing is
discovered mid-rebuild. Three placement classes:

| class | built-ins | runs on | client speculation |
| --- | --- | --- | --- |
| **Pure structural** | `map`, `filter`, `flatmap`, `if-else`/`when`/`unless`, `list-element-link`, `list-op-argument-usage`, `list-result-schema`, `op-pattern-ref`, `inspect-conf-label`, `scope-policy`, `stream-data`, `wish` | server | yes — free to discard |
| **Effectful / network** | `fetch` (`fetchData`), `fetch-program`, `llm` (`generateText`/`generateObject`), `llm-dialog`, `sqlite*` | **server only** | **never** — speculation reads through to the last committed result |
| **Compile / instantiate** | `compile-and-run` (charm creation, incl. from handlers) | server (sandboxed worker; toolshed already compiles) | no |
| **Client-enacted effect** | `navigate-to` | server *computes*, client *enacts* (§3.7) | echo allowed (navigate optimistically, reconcile) |

Why effectful nodes are server-only rather than merely server-preferred:
a speculative re-execution would double the side effect (double fetch,
double LLM bill), leak credentials to clients that should never hold them,
and bind results to the wrong network vantage point. The request-hash
memoization these built-ins already carry is what makes reading-through
sound: same inputs → the committed result *is* the value.

`resume-recover` / `resume-republish` are v1-era compensation machinery —
apply the survival test before carrying them over.

### 3.6 Events are the client's computational commit (D-v2-1, proposed)

The end state was always: the client sends the *event* down; the server
processes the handler. v2 builds that **now** rather than after another
partial state, for one decisive reason: **server-side handler execution
must exist in v2 anyway** — an event created server-side
(`stream.send()` from a served computation, or piece-to-piece) has no
client to run its handler. Once the server can run handlers for its own
events, routing client events through the same path is wiring, not
architecture. Building v2 with client-committed handler *writes* instead
would recreate the root-cause pattern: client write admission for
arbitrary cells, CFC-at-client-commit, and conflict handling between
client handler writes and server derivations — all machinery that
dissolves the day handlers move. The survival test fails it.

So in v2:

- A handler firing on the client commits **only the event** (payload +
  target stream). Admission is an append-capability check.
- The client *also* runs the handler + downstream graph locally as
  speculation, for instant echo. The authoritative consequences are the
  server's handler run, reacting to the event commit.
- Events are the *only* computational client commit. **All pattern-bound
  computation thereby moves server-side.**
- Handler determinism caveat: a speculative handler run may diverge from
  the authoritative one (clock, randomness); that is ordinary speculation
  divergence and reconciles the same way. Handlers whose body reaches an
  effectful built-in speculate up to it and read through (§3.5).

**The transitional exception, and why it is benign:** UI components
(bidirectional `$value` bindings) commit direct cell writes and will for a
while. These are *state authorship*, not computation — the user typing
into a cell they own. They never needed claims in v1 and need nothing in
v2: the per-cell single-committer invariant (§1) already covers them,
because a UI-binding cell's committer is the binding's client, and derived
state downstream of it is the server's. The class shrinks as components
migrate to events; nothing waits on it.

### 3.7 The client-effect channel (navigateTo and its future siblings)

`navigateTo` computes *where to go* from committed state — that part runs
on the server like any derived node. But navigation itself is a
session-scoped client act. The wiring:

- The served computation writes a **navigation intent** into a
  session-scoped effect cell (target piece link + a nonce).
- The session's client subscribes to its effect cells, enacts the
  navigation, and acknowledges (writes the nonce back), which retires the
  intent.
- This is not new protocol — it is a cell with a defined consumer. The
  same channel carries any future server-computed, client-enacted effect
  (focus, toast, download). One shape, audited once.
- The client may enact optimistically from its speculative run
  (navigate immediately) and reconcile if the authoritative intent
  differs — navigation is reversible, so the egress rule permits it.

### 3.8 Authority and budgets for server-run effects

- **Effect authority**: a server-run `fetchData`/LLM call executes under
  the authority *bound into the capability handle at wiring time* — the
  granting user's token, not an ambient server credential. Clients never
  hold provider secrets; the executor's broker does. (Which grant flows
  into a piece wired by user A but reacting to user B's data is Q6 —
  default: the wiring user's.)
- **Multi-tenancy**: one executor host serves many spaces. Per-space
  budgets (CPU time per wave, outstanding LLM calls, egress rate) are part
  of the executor contract from day one — a runaway pattern (an LLM
  fan-out loop) must degrade its own space, not the host. v1's pool
  already isolates workers; v2 adds the budgets.
- **Backpressure**: event floods (key-repeat driving `stream.send()`)
  are rate-shaped at the binding layer before they become commits.

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

In a world where only servers commit derived state and clients commit only
intent, the following have no decision left to make:

- the claim lifecycle (candidates, issuance, revocation, settlement,
  fences, incarnations) and its storage tables
- rank ladder, context-lattice claim negotiation, per-rank candidate dials
- `completeSchedulerScopeSummary` emission and every consumer, through to
  the memory protocol's claimed-commit admission
- shadow/authoritative action-transaction routing
- the observation evidence log (observation / snapshot / replay tables at
  derived-run frequency; `persistentSchedulerState` returns to its pre-arc
  scope)
- unserved markers, demand-shrink compensation, the legacy-background
  exclusion protocol, `resume-recover`-style compensations
- the arc's write-firewall-as-admission (write bounding moves to handle
  grant time; client computational commits narrow to event appends)

Anything on this list that seems needed during the rebuild triggers the
survival test before it triggers implementation.

## 6. Open questions (owner rulings or experiments required)

1. **Offline / disconnected clients.** Handlers queue as pending events,
   speculation renders freely, reconciliation on reconnect — needs its own
   design pass (ordering, conflict with events that landed meanwhile).
2. **The 34× suite-context degradation.** Mechanism has a strong candidate
   (stores persist and grow; every commit fans out against every active
   lane) but the discriminating experiment (mainbase full suite, compare
   in-suite `cf-checkbox`) has not run. v2's requirement stands regardless:
   flat performance as spaces accumulate.
3. **Cross-space reads and read-time clearance.** The v1 product failures
   (`shared-profile`, `profile-embed`, `sqlite read-time clearance`) were
   deferred as straggler bugs. v2 must make these work *by construction*
   per §3.1.
4. **Handler event schema.** Events carry payload + target stream +
   durable ID (#4288). What, if anything, of the scheduler-v2 event shape
   slims down once observations go?
5. **Speculation reconciliation UX.** When an authoritative value differs
   from the speculation it replaces, what does the user see? (v1 never got
   far enough to measure divergence rates.)
6. **Effect authority for multi-user triggers** (§3.8): whose grant powers
   a served effect reacting to another user's data — wiring user (default)
   or acting user? CFC implications either way.
7. **Ephemeral client-only state in handlers.** A speculative handler may
   read local UI state the server cannot see. Rule: handler inputs are
   explicit (event payload + cells); anything else is a pattern bug the
   transformer can flag.

## 7. Relationship to prior documents

- The eight v1 design documents, including the orchestration log with the
  complete environment-trap and measurement-discipline record, are frozen
  under
  [`docs/history/specs/server-side-execution/`](../../history/specs/server-side-execution/).
  Cite them as history, not as descriptions of the system.
- [`docs/development/EXPERIMENTAL_OPTIONS.md`](../../development/EXPERIMENTAL_OPTIONS.md)
  documents the v1 dials as they exist on the archived branches; the
  entries retire when v2 lands its single flag.
- The pre-arc, still-live behaviour specs this document leans on:
  [`persistent-scheduler-state.md`](../persistent-scheduler-state.md)
  (returns to its pre-arc scope),
  [`scheduler-v2/`](../scheduler-v2/), [`memory-v2/`](../memory-v2/).
