# navigateTo server-side — design

**Live design doc.** Wave G of the passivity arc: making `navigateTo`
runnable server-side. Siblings:
[`client-passivity.md`](client-passivity.md) (§6b is the D11 ruling this
serves), [`passivity-arc-orchestration.md`](passivity-arc-orchestration.md)
(wave G's worklist), [`README.md`](README.md),
[`implementation-plan.md`](implementation-plan.md). Archive to
`docs/history/` per [`docs/README.md`](../../README.md) when built.

**Status: RATIFIED** (2026-07-29). §7's gates 1 and 2 are ruled by the
owner; 3 and 4 are orchestrator sequencing. The design's core call —
`navigateTo` splits at a seam, decision server-side and actuation
client-side, with the server→client message as the seam — is confirmed.
Build order: §7 gate 4's measurement first (against
`group-chat-lobby.tsx`, **not** the flagship — see gate 4), then §6
item 2's rank-containment invariant red-first, then the seam.

**Scope note — RETRACTED 2026-07-29.** An earlier revision of this header
folded `compileAndRun` into this design on the grounds that both builtins
need a client callback. **The owner pushed back ("compileAndRun feels
quite different from navigateTo?") and was right.** The two callbacks are
different in kind, visible one after the other in the same client file:

- `navigateCallback` does
  `self.postMessage({ type: NotificationType.NavigateRequest, … })`
  (`packages/runtime-client/backends/runtime-processor.ts:596`) —
  **ephemeral**, UI-directed, no durable state, and semantically about
  *one* client.
- `pieceCreatedCallback` does `manager.add([piece])` (same file, `:602`) —
  a **durable write to the space's piece list**.

So `compileAndRun` needs no server→client channel at all — and per the
owner's follow-up ruling the same day, it needs no server-side replacement
either:

> Remove the `manager.add([piece])` part, it doesn't belong in there
> anymore.

Registering a piece in a list is an `addPiece` handler's job
(`docs/common/conventions/adding-pieces.md`), not a side effect of a compile
builtin. So `pieceCreatedCallback` is **deleted**, not relocated. That
removes `compileAndRun`'s only client-directed coupling and leaves it
ordinary server-side work. It is tracked as its own wave-G row.

`compileAndRun`'s blocker is also NOT the "unbounded async writes" recorded
before that: `llm` is async and now runs server-side, and `sqliteQuery`
writes post-commit through a suppression gate.

**Provenance.** Drafted by a subagent; the orchestrator verified the two
claims the design turns on. Verified: `laneAdmitsScope`
(`scheduler/servability.ts:857-865`) ends `declared === "session" &&
laneRank === "session"`, so a session-declared write is admitted ONLY at
session lane rank — which is what makes a space- or principal-wide
navigation broadcast structurally unreachable rather than merely
undesirable; and `#sessionAcceptsClaim` (`packages/memory/v2/server.ts:4341-4349`)
requires an exact principal AND session-id match, never a sibling. Other
citations were spot-checked, not exhaustively re-derived.

---


**Draft, design-only.** Written against worktree
`.agents/worktrees/server-execution-w1-2-shared-pool`, branch
`codex/server-execution-w1-2-shared-pool` at `b72f70729`. Serves wave G
of `passivity-arc-orchestration.md` §1 (close the serving gap) under
owner ruling **D11** (`client-passivity.md` §6b). No source changed.

Every claim about current behavior carries a `file:line`. Where a
comment or test in the tree asserts something, it is treated as a
hypothesis and checked — per the standing prior in §6b. Two more
stale self-descriptions turned up; they are in §1d.

---

## 0. Verdicts up front

1. **The owner's hypothesis HOLDS.** Nothing in `navigateTo` targets a
   client. `NavigateCallback` is `(target: Cell<any>) => void |
   Promise<void>` (`packages/runner/src/runtime.ts:204`) — no session,
   no connection, no principal. The single-machine property comes
   entirely from *where the node is instantiated*, which is the machine
   that ran the handler.
2. **But the owner's model of the interim is wrong in a way that
   matters.** "Move it to the server and it runs for everyone" is not
   what the current machinery produces. Server execution is
   **demand-scoped and lane-scoped**, and `navigateTo`'s own write
   surface is `session`-scoped, so it can *only* be served in a session
   lane whose demand slice covers its piece. The realistic first
   failure is **nobody navigates**, not everybody. See §1c and §4.
3. **The server→client message is 90% built.** `SessionSync.execution`
   (`packages/memory/v2.ts:822`) is an ordered, reconnectable
   server→client envelope delivered per session as
   `session/effect` (`packages/memory/v2.ts:1393-1398`,
   `packages/memory/v2/server.ts:1250-1263`). Recommend a fourth
   `ExecutionControlEvent` variant on that feed. §2.
4. **Per-session targeting for iteration 2 is ALREADY EXACT on the
   wire**, and more available than the owner guessed — but it solves a
   different problem than the one that actually blocks us.
   `#sessionAcceptsClaim` already narrows a `session:<did>:<sid>` claim
   to exactly the named session and never a sibling
   (`packages/memory/v2/server.ts:4341-4349`). What is missing is not
   addressing; it is **issuance attribution** — knowing which session's
   press caused the node to exist. That is P5's problem, not
   navigateTo's. §3.
5. **The interim regression is acceptable, but it should be scoped
   tighter than "all clients" because the tighter scope is free.**
   "Every live session of the issuing principal with a lane covering
   the piece" is what the machinery gives, is strictly better than
   "all clients", and costs nothing extra. §4.

---

## 1. Today's behavior — verifying the owner's hypothesis

### 1a. What `navigateTo` actually does

`packages/runner/src/builtins/navigate-to.ts` is one reactive action:

- On first run it mints a result doc and re-keys it to **session
  scope**: `createCell(runtime, { ...baseResultCell
  .getAsNormalizedFullLink(), scope: "session" }, tx)` (`:41-48`,
  scope at `:46`). This scope arrived with `6b2a72e74`
  ("feat(scopes): implement scoped cell instances (#3500)"), i.e. as
  part of a general scoping migration, not as a navigation-targeting
  decision.
- `:58` short-circuits when that session-scoped result is already
  `true` — the "already navigated" guard.
- `:68-70` **throws** `navigateCallback is not set` when the runtime
  has no callback.
- `:88-113` enqueues a post-commit effect (`kind: "navigateTo"`,
  deduped by the normalized target link) whose `flush` calls
  `navigateCallback(resolvedTarget)` (`:104`).
- `:114` sets the session-scoped result to `true`.
- `:121` returns `isEffect: true` — so it is an **effect** node at
  runtime regardless of registration (`runner.ts:5304`; standing
  knowledge §2.7 item 6).

The client actuation chain, for reference — this is what the server
must eventually reach:

```
navigate-to.ts:104  navigateCallback(resolvedTarget)
  → runtime-processor.ts:594-601   postMessage NotificationType
                                    .NavigateRequest { targetCellRef }
  → lib-shell/src/runtime.ts:335   "navigaterequest"
  → lib-shell/src/runtime.ts:586-615  registerNavigatedPiece(cell),
                                    #waitForNavigationConvergence(space),
                                    callbacks.navigate({spaceDid, pieceId})
  → lib-shell/src/runtime.ts:184   "cf-navigate" DOM event
```

### 1b. Where the single-machine property comes from

There is **no addressing anywhere on that path**. The evidence:

- `NavigateCallback = (target: Cell<any>) => void | Promise<void>`
  (`packages/runner/src/runtime.ts:204`). It takes a target and
  nothing else.
- It is a Runtime-lifetime option (`runtime.ts:429`), stored as a
  plain field (`runtime.ts:688`, assigned `runtime.ts:1145`). One
  Runtime, one callback, no per-session dispatch.
- The post-commit effect's dedupe id (`navigate-to.ts:92-99`) keys on
  the **target link**, deliberately so distinct targets stay distinct.
  It does not key on, and cannot express, a recipient.

So the reason only the issuing machine navigates is upstream of
`navigateTo` entirely: **the node only exists on that machine.**
`navigateTo` is called inside a handler and returned from it
(`packages/runner/test/navigate-handler.test.ts:85-88` is the canonical
shape; 63 call sites across 33 non-deprecated pattern files match it).
The runner detects that shape (`handlerResultPatternHasNavigateTo`,
`packages/runner/src/runner.ts:3755-3760`), builds a deferred result
pattern (`setupDeferredHandlerResultPattern`, `:3762-3790`) and starts
it **locally** after the handler's transaction commits (`:3634-3652`,
`runPatternAfterSuccessfulCommit`). Handlers are event-driven and
events are local — `event-handler` is categorically unservable
(`packages/runner/src/scheduler/servability.ts:352-353`).

The one place the tree does something session-shaped — the
`scope: "session"` result cell — cuts **against** targeting, not for
it. Because the guard at `:58` reads a per-session instance, a second
session that ran the same node would see `false` and navigate too. The
session scope makes the node *re-fire per session*; it does not
suppress siblings.

### 1c. Verdict, with one refinement the owner did not have

**Hypothesis confirmed: it is incidental.** Single-machine navigation
is a consequence of local handler execution, not of anything that
targets a client.

The refinement — and it changes the interim plan — is that
"now we move that to the server, so it runs it for everyone" does not
follow from the current machinery. Server execution is gated three
ways, and `navigateTo` fails the third and probably the second:

1. **Kind.** `navigateTo` is an effect (`navigate-to.ts:121`) and is
   absent from `SERVER_EXECUTABLE_BUILTIN_IDS`
   (`packages/runner/src/builtins/server-execution.ts:9-30`; that file
   is being edited concurrently by the `llmDialog` work item, so cite
   it by symbol — the surrounding line numbers move). It
   therefore gets `builtinImplementationHash` (`:v1`) rather than
   `:server-v1` (`packages/runner/src/runner.ts:5131-5148`) and, as an
   effect with no assembled summary, classifies **`unknown-effect-
   surface`** — not `incomplete-static-surface`
   (`servability.ts:382-388`; the orchestration plan's §2.7 item 2
   names the computation code, which is the wrong arm for this row).
2. **Rank.** Its write surface includes the `session`-scoped result
   cell. `laneAdmitsScope` (`servability.ts:857-865`) admits a
   `session`-declared write **only at session lane rank**; anything
   else rejects `non-space-write-scope` (`servability.ts:494-500`).
   `noteScopedSurface` then pins `contextRank: "session"`
   (`servability.ts:344-350`, returned at `:526-541`).
   **So `navigateTo` is structurally unservable at space rank and at
   user rank.** A space-wide or principal-wide navigation broadcast is
   not merely undesirable — as long as that result cell stays
   session-scoped and stays in the declared surface, it is
   unreachable. This is the single most valuable invariant in the
   design and §5 pins it.
3. **Demand.** A session-rank action's candidate lanes are
   `candidateLaneKeys(options, pieceId, "session")`, which returns the
   **open session lanes whose demand slice covers the piece**, and
   returns `[]` when there is none — session rank has no fallback and
   the router refuses to fabricate one (`packages/runner/src/executor/
   action-transaction-router.ts:693-718`). Session lanes are one per
   demanding session (`shared-execution-pool.ts:1068-1107`,
   `#reconcileSessionLanes` `:1209-1274`).
   The `piece` for a builtin action is its containing pattern's result
   cell (`runner.ts:5257`) — here, the deferred handler-result cell.
   And demand is published **per started root** by the runtime that
   starts it (`runner.ts:1272-1291`, `addExecutionDemand` at `:1286`;
   `:2196-2216`).

Chain (3) is the one that bites. The only runtime that starts the
deferred navigate result pattern is the machine that ran the handler
(`runner.ts:3634-3652`), so it is the only one that publishes demand
for that piece, so it is the only session with a lane that can claim
the node. **Under today's plumbing, moving `navigateTo` server-side
does not fan out to every client. It fans out to at most the issuer —
and under a genuinely passive client, to nobody, because a client that
never starts the root never demands it.**

That is a better problem to have than the one the owner expected, and
it means the interim work is not "accept a broadcast"; it is "arrange
for the server to learn the result root exists". §4 prices this.

### 1d. Two stale self-descriptions found on the way

Per the standing prior (`client-passivity.md` §6b), both were checked
rather than believed. Both are wrong today.

**(i) `packages/runner/test/builtin-effect-registry.test.ts:193-200`**
— the allowlist entry exempting `navigate-to.ts` from the
sink-request suppression gate says:

> navigateTo's post-commit effect is the LOCAL shell navigation
> callback (`runtime.navigateCallback`), not an external sink: there is
> no second issuer to double-fire, and the executor Worker installs no
> navigate callback at all, so the effect is inert server-side.

Two defects. First, "there is no second issuer to double-fire" is
*exactly* the incidental property this document exists to remove; it
is a statement about today's node placement recorded as a property of
the builtin. It must be rewritten in the same change that lands any
server-side execution, or the arc acquires a third green test
asserting a false thing.

Second, "the effect is inert server-side" is **not accurate even
today**. The executor Worker does install no callback — confirmed:
`executor-worker.ts:1533` builds its Runtime from
`runtimePresets.productionServer`, which does not pass
`navigateCallback` (`runtime-presets.ts:389-407`; the params interface
`ProductionServerPresetParams` has no such field, `:320-333`; the
option matrix records it as a delta of patternTest / remoteClient /
browserWorker only, `:75`). But the consequence is not inertness — it
is `navigate-to.ts:68-70` **throwing** before the post-commit effect is
ever enqueued. "Inert" and "throws" are different acceptance criteria.

**(ii) `packages/memory/v2/server.ts:5380-5382`**, on
`openSessionLaneGrant` (`:5384`):

> Host-internal: nothing wires session-lane demand to this until C2.7 —
> in production the registry stays empty and every path guarding on it
> is dormant.

C2.7 has landed. Production wires it: `packages/toolshed/routes/
storage/memory.ts:266-280` constructs the `SharedExecutionPool` with
`sessionLaneCandidates: runtime.experimental
.serverPrimaryExecutionSessionRankCandidates === true`, and the pool
opens grants at `shared-execution-pool.ts:1249`. It is dial-gated
(`#sessionLanesEnabled`, `:1014-1030`: the session runner dial AND the
user runner dial AND the host's `executionSessionLanesEnabled`), but
"dial-gated" is not "dormant". `packages/patterns/integration/
server-execution-session-lane-gate.test.ts:41-44` states plainly that
"C2.7 landed the mechanism" and the Worker really opens, hydrates and
serves session lanes.

This is the fifth and sixth instance of the pattern §6b flags. Worth
one line in the arc log.

---

## 2. The server→client message

### 2a. What already exists (look here before inventing anything)

There is a **per-session, ordered, reconnectable server→client control
channel**, and it is already used for exactly this class of thing:

| Piece | Where |
| --- | --- |
| Wire frame | `SessionEffectMessage { type: "session/effect", space, sessionId, effect: SessionSync }` — `packages/memory/v2.ts:1393-1398` |
| Send | `Connection.sendExecutionEffect(space, sessionId, sync)` — `packages/memory/v2/server.ts:1250-1263` |
| Envelope | `SessionSync.execution?: ExecutionFeedBatch` — `packages/memory/v2.ts:822`; batch shape at `:776-781` |
| Event union | `ExecutionControlEvent = ClaimSet \| ClaimRevoke \| Settlement` — `packages/memory/v2.ts:680-684` |
| Fan-out | `#publishExecutionControl(event)` — `packages/memory/v2/server.ts:4910-4923` |
| Delivery predicate | `#sessionAcceptsClaim(session, claim)` — `packages/memory/v2/server.ts:4321-4362`, documented `:4296-4318` |
| Event → claim | `#eventClaim(event)` — `packages/memory/v2/server.ts:4367-4383` |
| Reconnect replay | `attachExecutionFeed` — `packages/memory/v2/server.ts:4924+` |
| Client apply | `applyExecutionFeedBatch` / `applyExecutionControlEvent` — `packages/runner/src/storage/v2.ts:6116-6183` |

And the delivery predicate is already *exactly* per-session for
`session:` context keys (`server.ts:4341-4349`):

```ts
const sessionIdentity = Engine.parseSessionExecutionContextKey(
  claim.contextKey,
);
if (sessionIdentity !== undefined) {
  if (
    sessionIdentity.principal !== session.principal ||
    sessionIdentity.sessionId !== session.id
  ) {
    return false;
  }
}
```

Its docblock (`server.ts:4304-4313`) explains why sibling delivery was
deliberately eliminated under C2.6/CA4. **This is the "clever way" the
owner intuited, and it is already built.**

### 2b. What is actually missing

Only two links:

1. **No event variant carries a navigation.** `ExecutionControlEvent`
   has three members and all three are *state reconciliation*
   (`v2.ts:680-684`). A navigation is a one-shot command.
2. **No sink on the executor side.** The executor's Runtime has no
   `navigateCallback` (§1d(ii)); the effect must be redirected from
   an in-process callback to the control channel.

### 2c. Recommended shape

**Reframe first.** Under D11 §6b the owner draws the line: *client
effects are rendering effects, known only to the client; pattern
effects run only on the server*. `navigateTo` straddles it. The
**decision** to navigate is derived from pattern state (the target
cell) and therefore belongs on the server. The **actuation** is a
shell view change and is by that same definition a client rendering
effect. So the design is not "move navigateTo"; it is **split it at
the seam, and the message is the seam.**

Recommended: a fourth `ExecutionControlEvent` variant.

```ts
export interface ExecutionNavigateEvent {
  type: "session.execution.navigate";
  /** The navigateTo action's claim — carries space + contextKey, so
   *  the existing delivery predicate narrows it for free. */
  claim: ExecutionClaim;
  /** The resolved target, as the client's navigateCallback needs it. */
  target: {
    space: string;
    id: string;
    path: readonly string[];
    scope?: CellScope;
  };
}
```

Why this shape:

- **It reuses the delivery predicate unchanged.** `#eventClaim`
  (`server.ts:4356-4372`) gains one arm returning `event.claim`;
  `#publishExecutionControl` (`:4910-4923`) then narrows the event to
  exactly the sessions that accept that claim. Because §1c(2) forces
  `contextRank: "session"`, that is exactly one session per event.
  **Per-session targeting requires no new addressing scheme at all.**
- **The payload is the link the client already consumes.**
  `runtime-processor.ts:594-601` posts a `NormalizedFullLink`
  (`targetCellRef`); the shell then uses `cell.id()` and
  `cell.space()` (`lib-shell/src/runtime.ts:588-591`). Sending the
  four link fields lets the client reconstitute the Cell and enter
  the existing chain at `navigateCallback` with no shell change.
- **Idempotence already has a receipt.** `navigate-to.ts:58/114` —
  the session-scoped result cell set to `true` — is precisely a
  per-session "this session has navigated" flag. Keep it as the
  client-side gate so a duplicate event is a no-op.

**The one discipline this shape imposes: navigate events MUST NOT be
retained or replayed.** `attachExecutionFeed` (`server.ts:4924+`)
replays retained events on reconnect, and coalesces successful
settlements into frontiers precisely because replaying them would
reconcile twice. Claim set/revoke are idempotent state; a navigation
is not. A replayed navigate yanks the user's view on every reconnect.
Exclude the variant from `session.executionEvents` retention and from
the snapshot path, and pin that with a test (§5.4).

**Alternative considered and rejected: a durable session-scoped
"navigation intent" doc** that the client sinks, needing no protocol
change at all. Tempting — it is state, so it is reconnect-safe by
construction, and the scope key does the addressing. Rejected because
it moves the replay hazard rather than removing it: a client attaching
fresh reads the last intent and navigates on boot. It also introduces
durable state whose only correct lifetime is "until read once", which
the storage layer has no notion of.

---

## 3. Iteration 2 — per-session targeting

**Verdict: the addressing is free; the attribution is not, and it is
not navigateTo's to solve.**

The session lattice the owner points at is real and complete:

- Canonical key helpers `sessionExecutionContextKey` /
  `parseSessionExecutionContextKey` (`packages/memory/v2.ts:1227`,
  `:1244`).
- The client's own accept set `{space, user:<p>, session:<p>:<sid>}`
  (`servability.ts:262-275`, `ownChainContextKeys`), with chain
  identity deliberately excluding `contextKey`
  (`servability.ts:231-256`).
- Exact-session delivery, sibling delivery eliminated
  (`server.ts:4341-4350`, rationale `:4304-4313`).
- One session lane per demanding session, keyed by the authenticated
  row's sessionId with an explicit "never fabricate a context key"
  rule (`shared-execution-pool.ts:1068-1107`).
- No cohort gate at session rank — a session lane rides its own
  session's negotiation (`server.ts:5373-5379`), unlike user lanes
  (`principalCohortNegotiatesContextLatticeClaims`, `server.ts:5122-
  5131`).

So: **if the navigateTo node runs in session S's lane, only session S
receives the navigation.** That is already true and needs no work.

**What has to be true for the issuing session to be identifiable at
the point navigateTo runs on the server?** Exactly one thing, and it
is upstream:

> The handler that produced the navigateTo node must have run — or at
> minimum been *attributed* — in the issuing session's lane.

Today it cannot be. The handler runs on the client
(`servability.ts:352-353`), the deferred result pattern is instantiated
client-side (`runner.ts:3634-3652`, `:3762-3790`), and the durable
artifact it commits — a result cell caused by `{ resultFor: cause }`
— carries no session stamp. The server *does* know which session sent
the commit (every transact carries `space` + `sessionId`; e.g.
`server.ts:3948`, `:7628`, `:7760`), but nothing writes that identity
into anything the executor later reads when deciding which lane owns
the node.

Two routes, and they are not equally good:

**(a) Wait for P5 (recommended).** D11 §6b item 3: the client sends
the **event** instead of the commit. Then the server runs the handler
on behalf of session S, instantiates the result pattern in S's lane,
`navigateTo`'s session-scoped writes resolve to S, its claim's
contextKey is `session:<did>:<S>`, and §2's message delivers to S and
only S. **Per-client targeting falls out with zero navigateTo-specific
work.** Iteration 2 is therefore not a navigateTo work item at all —
it is a line in P5's acceptance criteria. That is the right place for
it and the doc should say so rather than inventing a parallel
mechanism that P5 will delete.

**(b) Durable issuance attribution before P5.** Stamp the deferred
handler-result cell with the committing session at accept time, and
have `#desiredSessionLanes` / `candidateLaneKeys` honor that stamp
instead of (or in addition to) demand. This is a genuinely new
mechanism: a new durable field, a new trust question (the session id
must enter from the authenticated connection, never from client
payload — CA9's rule, `action-transaction-router.ts:667-678`), and a
new lane-selection input. It buys targeting a few months earlier and
is machinery D11 says we will delete. **Do not build it unless P5
slips badly.**

---

## 4. What the interim costs

The task says to price this honestly rather than assume it, so:

### 4a. Who is actually affected

Not "all clients". The set is bounded three times over:

1. **Never cross-principal.** §1c(2): the session-scoped result cell
   forces `contextRank: "session"`, so no space-rank claim is
   reachable. This matters because space-rank delivery has **no
   principal filter** — the principal comparison in
   `#sessionAcceptsClaim` sits *inside* the `contextKey !== "space"`
   branch (`server.ts:4339-4357`). A space-rank navigate would drag
   every user in a shared space (group chat, lunch poll) to a piece
   one of them opened. That is not an acceptable interim under any
   framing, and the good news is that it is structurally unreachable
   — provided the invariant holds. Pin it (§5.2).
2. **Only sessions with an open session lane.** Session lanes are
   triple-dial-gated (`shared-execution-pool.ts:1014-1030`) and off by
   default in production (`toolshed/routes/storage/memory.ts:274-280`).
3. **Only sessions whose demand slice covers the node's piece**
   (`action-transaction-router.ts:693-718`;
   `shared-execution-pool.ts:1086-1104`) — and that piece is the
   deferred handler-result cell (`runner.ts:5257`), demanded only by
   the runtime that *starts* it (`runner.ts:1286`).

Bound (3) is the interesting one. It means the interim's realistic
shape is **not** "your other laptop jumps to a new piece". It is
**"nothing happens at all"**, because under a passive client no
runtime starts the deferred root and no lane covers it.

### 4b. So what is the actual interim cost?

Two distinct costs, and the plan should not conflate them:

- **Cost A — the regression the owner named** (every device of the
  issuing user navigates). Real but bounded to one principal, and
  reachable only once §4a(3) is solved in a way that puts the piece in
  more than one session's demand slice. Blast radius: 63 `navigateTo(`
  call sites across 33 non-deprecated pattern files, all of the
  "handler returns navigateTo(NewThing({}))" shape. Every one of them
  creates a piece; on a second device the user lands on a piece they
  did not ask for. It is **non-destructive and recoverable** — no data
  loss, no writes on the second device, back-navigation restores the
  prior view.
  One under-appreciated sharp edge: a non-issuing device has probably
  never synced the target piece, so
  `#waitForNavigationConvergence(cell.space())`
  (`lib-shell/src/runtime.ts:595`) does a **cold load**, not a view
  switch. The second device shows a spinner on content it never asked
  for. Worse than a view change, still not destructive.

- **Cost B — the one that is actually in front of us**: solving
  §4a(3) at all. This is the design's real content and it is not a
  UX question. It is "how does the server learn that a handler-created
  result root exists and should be run", which is the same question
  `compileAndRun` raises in the wave G table
  (`passivity-arc-orchestration.md` §1) and which P5 answers by
  sending the event.

### 4c. Verdict on acceptability

**Acceptable as an interim — with one amendment to the goal
statement.** Do not adopt "ALL clients get the navigateTo" as the
target, because the machinery makes a strictly better target free.
Adopt instead:

> **Interim goal (amended):** every live session **of the issuing
> principal** whose lane covers the piece receives the navigation.
> Cross-principal navigation is out of scope and structurally
> prevented, not merely avoided.

Rationale: the amended goal is what §2's message shape produces with
no extra work, it removes the only genuinely unacceptable outcome
(dragging a co-tenant of a shared space), and it keeps the honest
residual — issuance attribution — clearly labelled as iteration 2 /
P5 rather than smuggled into "we'll fix targeting later".

Ship it behind the session-lane dial ladder that already exists
(`serverPrimaryExecutionSessionRankCandidates`,
`shared-execution-pool.ts:1015-1022`), so it is off by default,
per-deployment, and measurable — and register it in
`docs/development/EXPERIMENTAL_OPTIONS.md` if a new dial is added.

---

## 5. Red-first gate shape

Each item names the file to model on. Every one should be red before
the corresponding behavior lands.

1. **Kind + identity pin.** `navigateTo` joins
   `SERVER_EXECUTABLE_BUILTIN_IDS`
   (`builtins/server-execution.ts:9-30`) and earns `:server-v1`
   (`runner.ts:5138-5140`). Model:
   `packages/runner/test/builtin-implementation-hash.test.ts`.
   **In the same commit**, rewrite the stale allowlist comment at
   `packages/runner/test/builtin-effect-registry.test.ts:193-200`
   (§1d(i)) — "there is no second issuer to double-fire" becomes false
   the moment this lands.

2. **THE invariant — rank containment.** Assert that navigateTo's
   assembled surface declares a `session`-scoped write and therefore:
   classifies `broker-required` with `contextRank: "session"` under a
   session lane; and classifies **`non-space-write-scope`** under a
   user lane and under no lane. Model:
   `packages/runner/test/scheduler-servability.test.ts` (the
   `unknown-effect-surface` cases at `:122` / `:201` are the shape).
   This is the test that keeps cross-principal navigation
   unreachable. If it is not red first, nothing else in this design is
   safe.

3. **Exact-session delivery.** A navigate event published for a
   `session:<did>:<sid>` claim reaches that session and **no sibling
   session of the same principal**. Model:
   `packages/memory/test/v2-execution-session-lane-grant-test.ts:655`
   (which already asserts sibling non-observation) and
   `v2-execution-session-context-delivery-test.ts`.

4. **No replay.** Reconnect with `snapshotFromFeedSeq` does not
   redeliver a navigate event; it is absent from retention and from
   the snapshot. Model:
   `packages/memory/test/v2-execution-feed-reconnect-test.ts`.

5. **End to end, real Worker.** The executor serves the navigateTo
   node and the client's `navigateCallback` fires exactly once with
   the right target. Model:
   `packages/patterns/integration/server-execution-session-lane-gate
   .test.ts` (+ its harness `server-execution-session-lane-harness.ts`).
   Heed standing knowledge §2.1: drive the Worker's
   `settle()`/`wake()`/`settle()` fixpoint explicitly, and wrap in
   `withExecutorTeardownBarrier` (§2.3).

6. **The interim's own acceptance criterion, stated as a test.** Two
   sessions of one principal, both with lanes covering the piece:
   **both** navigate. Written now, it documents the accepted
   regression; iteration 2 flips it red-first when targeting lands.
   Also assert the negative: a session of a *different* principal in
   the same space does **not** navigate.

7. **Measurement before build (cheapest, do it first).** Instrument
   whether the navigateTo node's piece appears in any session's demand
   slice at all in the flagship fixture. If the answer is "never",
   items 1-6 build a road to nowhere and the real work is §4b Cost B.
   This is a counter, not an argument — and per the wave-B lesson in
   `passivity-arc-orchestration.md` §6 ("check that the measurement
   instrument can see the thing being built BEFORE promising a buy"),
   confirm the chosen fixture actually exercises `navigateTo`.

---

## 6. What would falsify this design

Listed so someone can disagree with evidence rather than taste.

1. **The demand falsifier (most likely).** If the deferred
   handler-result piece is never in any session lane's demand slice
   (§1c(3)), the entire message design is unreachable and the work
   item is really "server-side handler result roots", i.e. P5. Gate
   §5.7 answers this in an afternoon. **If it fires, stop and
   re-scope; do not build §2.**
2. **The rank falsifier.** If the generically-minted descriptor
   (`runner.ts:5254-5266`; note `serverBuiltinRuntimeWrites` is read
   at `:5165-5167` and `navigateTo` currently populates **no** such
   array — only `fetch-program.ts` and `llm.ts` do) omits the
   session-scoped result cell from the declared write surface, then
   `noteScopedSurface` never fires, `contextRank` stays absent, and
   the action becomes space-rank — at which point delivery has no
   principal filter and cross-principal navigation becomes reachable.
   **This is the design's safety hinge.** Gate §5.2 must be red
   first.
3. **The reconstitution falsifier.** If the shell needs more than a
   `NormalizedFullLink` to navigate — it calls
   `registerNavigatedPiece(cell)` with a real Cell
   (`lib-shell/src/runtime.ts:593`) — the payload in §2c is
   insufficient and the client needs a resolution step that may itself
   require sync. Cheap to check against
   `runtime-processor.ts:594-601`, which already round-trips a bare
   link through `postMessage`.
4. **The piggyback falsifier.** If a fourth variant cannot be added
   to `ExecutionControlEvent` without perturbing the existing three
   (`#eventClaim` `server.ts:4356-4372`, retention, frontier
   coalescing, the client's `applyExecutionControlEvent`
   `storage/v2.ts:6183`), the "reuse the existing channel" claim is
   wrong and a separate one-shot message type is cheaper.
5. **The classification falsifier.** If the owner rules that
   `navigateTo` is a *rendering* effect under D11 §6b's own
   definition and therefore stays client-side entirely, this design is
   moot — the server would serve the target computation and the client
   would keep the actuation with no new message. §2c argues against
   (the *decision* is derived from pattern state, which a passive
   client does not compute), but it is an owner call, not a technical
   one.

---

## 7. Owner gates — RULED 2026-07-29

**Gate 1 — interim goal: RULED YES.** The interim target is "all
sessions of the **issuing principal**", not "all clients". Free,
strictly better, and it makes cross-principal navigation structurally
impossible rather than merely unintended (§4c).

**Gate 2 — pattern effect or rendering effect: RULED — the split is
correct.** (This gate previously pointed at a nonexistent "§6.5"; the
argument is in **§2c**, and the reference is corrected here.) The owner
confirmed the reframing: `navigateTo` is not one or the other, it is
**both, split at a seam**. The *decision* to navigate derives from
pattern state and belongs on the server; the *actuation* is a shell view
change and is by D11's own definition a client rendering effect. **The
server→client message is that seam.** So the work is not "move
navigateTo" — it is split it, and build the seam.

**Gate 3 — iteration 2 is a P5 line item.** Confirmed and sequenced by
the orchestrator. The blocker for per-client targeting is not addressing
(already exact on the wire — `#sessionAcceptsClaim` matches principal
AND session id, never a sibling) but **issuance attribution**: knowing
which session's press created the node. §3b's fallback is not to be
built — it is scaffolding D11 says we will delete.

**Gate 4 — measure first, and the fixture is NOT the flagship.**
Sequenced by the orchestrator, with a correction that matters:

> The falsification measurement (§6 item 7) was written against "the
> flagship fixture". **`cfc-group-chat-demo` does not use `navigateTo`
> at all** — verified by grep before running. Instrumenting it would
> have measured zero demand-slice appearances and invited the reading
> "the navigateTo node is never demanded", when the truth is only that
> the fixture never exercises it. **That is the wave-B mistake in a new
> costume** (`passivity-arc-orchestration.md` §6, 2026-07-28: check the
> instrument can see the thing before promising a buy), caught this time
> before the run rather than after.

The correct measurement target is **`packages/patterns/group-chat-lobby.tsx`**,
which does `return navigateTo(roomInstance)` from inside a handler at
`:154` — the exact shape D11 describes, and in the flagship's own
family. Other candidates if a second is wanted: `shopping-list.tsx`,
`calendar/calendar.tsx`, `compiler.tsx`, `record-backup.tsx`.

**Still owner-facing:** nothing. Gates 1 and 2 are ruled; 3 and 4 are
orchestrator sequencing.

---

## 8. Gate 4 RAN, and it fired — read this before building

Run by the orchestrator 2026-07-29. It did not need a fixture; the
answer is structural and cost a handful of greps.

**Finding: the deferred navigate result root never publishes execution
demand.**

- `addExecutionDemand` has **exactly one call site** in the entire
  runner: `packages/runner/src/runner.ts:1286`, inside `start()`, reached
  only when `doStart` reports `started && attempt.startedRoot !==
  undefined`.
- `navigateTo`'s result pattern is **commit-gated**: `deferForNavigate`
  routes it through `runPatternAfterSuccessfulCommit`
  (`runner.ts:3637-3646`) → `runWithStartOwnership` (`:1885`, defined
  `:1998`) → `startWithTx` (`:~2039`). **That path does not call
  `start()`, so it never reaches `addExecutionDemand`.**

Why that matters: session-rank candidate lanes are exactly "the open
session lanes whose demand slice covers the piece", returning `[]` when
none, with no fallback (§1c chain 3). A piece that is never demanded can
never be claimed at session rank. And `navigateTo` is structurally
confined to session rank, because `laneAdmitsScope` admits its
`session`-scoped write only at session lane rank (§1c chain 2, verified).

**So as things stand, `navigateTo` cannot be served at all** — not
"served to the wrong set of clients", but never claimed. Items 1-6 of §6
would be building on a node no lane can claim. This is exactly the
failure gate 4 was written to catch, and it caught it for the price of
greps rather than a fixture.

### 8b. The closure-growth question: ANSWERED **NO** — and the question was built on a misreading

An earlier revision of §8 offered closure growth as the one thing that
could rescue the design, citing the live probe's
`executor cold refresh: demand closure-growth replica:…`. **That was the
orchestrator misreading a log line from a different subsystem**, and it
is worth recording as such because it looked like a real lead.

That string is emitted by `packages/runner/src/storage/v2-host-provider.ts:1966-1972`,
where `trigger` is a `GraphQueryTrigger` and `"demand"` means "new data
demanded (first-demand cold pull, new-doc closure growth)" — the
accounting for a **storage replica's document-set watch**
(`storage/v2-watch.ts:87` supplies the `replica:…` watchId). It has
nothing to do with `ExecutionDemandSnapshot`. Verified: `closure-growth`
appears only under `packages/runner/src/storage/`, and **nowhere in
`packages/runner/src/executor/` or `packages/runner/src/scheduler/`**.
**There is no closure-growth mechanism in the execution-demand plane at
all.**

**The demand plane is 1:1 end to end**, with no roll-up anywhere:
publish (`runner.ts:1286`) → host store (`memory/v2/server.ts:4016`) →
pool union (`shared-execution-pool.ts:390-392`) → session slice
(`:1085-1107`) → Worker (`executor-worker.ts:1143-1161`) →
`schedulerPieces` as a 1:1 `.map()` (`:555-561`) → `has(pieceId)`
(`:1275`) → `candidateLaneKeys` returns `[]` at session rank
(`executor/action-transaction-router.ts:703-719`). Nested pieces get
their own `pieceId` (`runner.ts:2284`), so identity never rolls up to the
demanded root.

**And it is worse than "no lane covers the piece."** The executor cannot
publish demand at all — `executor-worker.ts:1378-1385` omits
`supportsExecutionDemand`, which defaults `false`
(`v2-host-provider.ts:2440`), so `addExecutionDemand` early-returns
(`runner.ts:2201`, verified). The executor never instantiates the piece,
so there is no action, no observation, no candidate, no template.

**Confirmed empirically, not only by reading** —
`packages/runner/test/navigate-demand-closure-probe.test.ts` measured
`startedRoots: 3, demandedEver: 1, demandPublications: 1,
startedButNeverDemanded: 2, navigatedTargetDemanded: false`, with a
positive leg (the lobby root IS published) proving the instrument is not
blind. Reproduced at loads 69 and 44.

**Minimal change:** publish demand on the success branch of the two
commit-gated deferred-root seams — `runner.ts:1832-1844`
(`startAfterSuccessfulCommit`, `resultLink` at `:1804`) and
`runner.ts:1902-1913` (`runPatternAfterSuccessfulCommit`, `resultLink` at
`:1871`) — and **not** `startWithTx`, which is also the child path.
Removal is already symmetric (`stop()` → `removeExecutionDemand`,
`runner.ts:2770`), it is already dial-gated, and the deferred root is
already durable on the handler's commit (`runner.ts:3767-3778`).

**A design consequence that improves on gate 1.** Only the ISSUING
runtime publishes that demand, so §4c's accepted interim regression does
not arise at all — it collapses to "the issuing session only", which is
stricter than the "all sessions of the issuing principal" the owner
approved. Nothing extra is needed to get it. Consequently §5.6's
two-sessions-both-navigate test is unreachable without a synthetic second
publisher and should be rewritten rather than made to pass.

**Revised build order:** the demand publication above, then §6 item 2's
rank-containment invariant red-first, then the seam.
