# Deleting claim arbitration — scope

**Live design doc.** Scopes the work D11 names: replacing per-action claim
arbitration with blanket server ownership of a space's demanded closure.
Siblings: [`client-passivity.md`](client-passivity.md) (§6b is D11, §5h.4
the amended ruling, §5h.5 the corrected gate),
[`passivity-arc-orchestration.md`](passivity-arc-orchestration.md) (the
SURVIVAL TEST and TERMINAL CONDITION at its top govern this work),
[`README.md`](README.md), [`implementation-plan.md`](implementation-plan.md).

**Status: SCOPED; §6c RETIRED, two corrections applied** (2026-07-29).

**Correction 1 — `claim-context-mismatch` is NOT a cross-principal leak
guard, and §5c is wrong to call it one.** §5c warns that a space-rank claim
whose run resolved `user` "would write a per-user result to the shared
instance". Owner, 2026-07-29:

> When a space-rank claim becomes per-user, we write a **redirect link to
> itself at the narrower scope** into the original scope — so the space doc
> points at the user doc. The link does **not contain the user's
> principal**; it just says "if you read this, read your own version".
>
> Could different users reach a different conclusion? **No.** The only way
> you go from space scope to user scope is by finding another such link,
> and by definition all users see the same link — so whatever principal
> this runs under, they all create the identical redirect.

That is the **byte-identity convergence property**, and this is the THIRD
time it has been the answer in this arc: it is why the §4 widening pair is
admissible at all (C1 ruling), why the ×12 fix could accept scoped
auxiliary result-instance links (§5h.1, pinned as "auxiliary links are
byte-identical across two lanes"), and now why a resolved-context commit
leaks nothing. **A redirect is identical for every principal; only a VALUE
differs.** So `claim-context-mismatch` may be deleted outright with slice
1 — no replacement guard is owed, and slice 1 is simpler than §5c states.

**Correction 1b — the one genuinely careful case, recorded as a
FOLLOW-UP, not a slice-1 concern.** Space → **session** *when it passes
through a user scope*: that intermediate user-scoped doc may stay
user-scoped for some principals and narrow to session for others, so the
single redirect is not obviously convergent. The safe form is **two
redirects — space → user → session** — and it is needed only when the path
actually went through a user scope. Owner: follow-up task only.

**Correction 2 — "start the adjacent ones" is NOT a design target.** Owner:
do not build a fan-out scheduler; it may well fall out of a higher-level
invariant — *"maybe all that happens is that the part that sends data to
the client realises that this still needs computing."* So the trigger is
the delivery path finding no value for a principal, not an explicit
enumerate-and-start step. Do not add machinery for it; expect it to emerge
from demand + delivery.

§6c is retired: the owner accepted the cost shift and clarified the
inversion as an algorithm (client-passivity §5h.4).

**Two findings that reframe the arc, both verified by the orchestrator:**

1. **The executor ALREADY runs the whole demanded closure, unconditionally,
   regardless of servability** (§"THE LOAD-BEARING FACT"). `activateDemand`
   does `runtime.start(cell)` plus a permanent sink; classification happens
   on the COMMIT path, after the action has run. **So "coverage" was never
   about whether the server CAN run something** — with two egress exceptions
   it already did. `unservedByCode` counts runs that HAPPENED whose commit
   was then refused. The gap is in admitting results, not in producing them.
2. **No claim ⇒ no provenance ⇒ no firewall** (§2a). The engine's entire
   write-bounding firewall has two call sites, both guarded on
   `provenance !== undefined`, and provenance is minted only when an
   execution claim exists. So every "survivor" — lane scope admission, write
   envelopes, `broad-lane-value-write`, the cross-principal leak guards — is
   today reachable ONLY through a claim. **Deleting claims naively deletes
   the safety column with them.** The fix is available in the code: the
   firewall's only claim-shaped parameter is immediately reduced to a lane
   scope key, so it is an acting lane, not a claim.

**Provenance.** Drafted by a subagent as a paper task; the orchestrator
verified the two findings above directly. Remaining citations were
spot-checked. It also caught a stale fact in the orchestration plan's own
§2.8 (the `llm` broker hole, closed by wave A but recorded as open) — the
eleventh stale self-assertion this arc has found, and the second inside its
own planning docs.

---


Status: COMPLETE.
Worktree: `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`
Branch: `codex/server-execution-w1-2-shared-pool` @ `8a9b798a8`
Paper task. No source changed, no tests added, nothing committed.

## The five things that change the shape of the problem

1. **The server already runs the whole demanded closure.** Servability
   never gated a run — classification happens on the COMMIT path, after
   the action ran. So blanket ownership costs no additional server
   compute, and "coverage" was never about whether the server *can* run
   something. Evidence: THE LOAD-BEARING FACT, below.
2. **The engine's entire write firewall is claim-conditional.** No claim
   ⇒ no provenance ⇒ `assertExecutionActionTransaction` never runs ⇒ no
   lane scope admission, no envelope bounding, no
   `broad-lane-value-write`. The whole right-hand column of the SURVIVAL
   TEST rides on the thing being deleted. This is the substantive design
   work. (§2a)
3. **The read side already has a claim-free acting-context carrier**
   (`#actingReadScopeContext`, validated against the lane grant). The
   write side does not. Restoring that symmetry IS the deletion's
   mechanism, and it is the first slice. (§2b, §5c)
4. **Roughly half of wave G is scaffolding**, and its own docblock says
   so: `SERVER_EXECUTABLE_BUILTIN_IDS` membership buys the `:server-v1`
   fingerprint so a node can be *claimed*; the broker route that makes it
   *runnable* is a different object. Descriptor bodies survive as write
   bounds; the registries and the fingerprint fork do not. (§3b/§3c)
5. **The terminal condition is a PAIRED flip.** The executor's default is
   the exact mirror of the client's. Flip one and effects vanish or
   double. Two egress builtins have no server route (`streamData` is a
   real blocker; `sqliteQuery` only lacks allowlist membership). (§5a/§5b)

Answers: **CP1 dissolves** and leaves one residual that is not client
authority (§4). The **strongest counter-case** is §6c — per-session
closures move the cost model's owner, not its size.

## Plan (executed)

1. Read the top box, §2 traps, `client-passivity.md` §1/§5h.3-5/§6b,
   `wave-d-passivity-mechanism.md`.
2. Trace each named mechanism to its definition and every caller.
3. Split each into DELETE / SURVIVES / SURVIVES-BUT-RIDES-ON-CLAIMS.
4. Answer Q1..Q6 with file:line evidence.

---

## Raw evidence log (appended as read; refined into Q1..Q6 below)

### `packages/runner/src/scheduler/servability.ts` (989 lines) — the split runs
### THROUGH this one file

This file is the crux. It is not "the claim module" and it is not "the
write-bounding module": it is both, interleaved, and the deletion boundary
cuts it in half.

**Claim-identity half (arbitration — goes):**

- `ActionClaimKey` is imported here but DEFINED in `packages/memory/v2.ts:428-437`
  (8 fields: branch, space, contextKey, pieceId, actionId, actionKind,
  implementationFingerprint, runtimeFingerprint).
- `canonicalActionClaimKey` `packages/memory/v2.ts:440-452`,
  `actionClaimMapKey` `:454-455`.
- `actionClaimKeyFromObservation` `servability.ts:174-210` — derives the
  shared client/server identity from an observation.
- `actionClaimKeysEqual` `servability.ts:212-221`.
- `executionClaimMatchesActionKey` `servability.ts:223-228` — a one-line
  wrapper over `actionClaimKeysEqual`. Its ONLY non-test caller is
  `action-transaction-router.ts:469`, whose failure branch emits
  `claim-key-mismatch` (`:475`).
- `actionClaimChainKeysEqual` `servability.ts:236-246` — every field EXCEPT
  contextKey; the docblock says why (A10: "the server's lane choice folds in
  durable context floors the client cannot reproduce").
- `actionClaimChainMapKey` `servability.ts:255-256`.
- `ownChainContextKeys` `servability.ts:268-277`.
- `executionClaimMatchesActionChain` `servability.ts:286-294` — the CLIENT's
  suppression predicate.

**Write-bounding half (survives):**

- `dynamicActionTransactionUnservableReason` `servability.ts:564-724` — the
  per-attempt whole-transaction firewall, explicitly "shared by the server
  executor and cooperative clients".
- `laneAdmitsScope` `servability.ts:885-892`, `laneAdmitsWriteScope`
  `servability.ts:903-909` — reads chain-admit, writes stay exact-lane.
- `laneInstanceScope` `servability.ts:729-735`,
  `laneInstanceAddressesEqual` `:740-751`, `laneInstanceCovers`
  `:684-693` — the §4 widening pair.
- `laneBroadScopeNamingWriteViolation` `servability.ts:771-811`, emitting
  `broad-lane-value-write` at `:779`, `:783`, `:800`, `:802`.
- `declaredWriteIds` `servability.ts:820-841`, `covers` `:884-892`.

**The dependency that matters:** the surviving half is parameterized by
`laneRank`, and `laneRank` arrives from `context.contextRank`
(`servability.ts:578`) — which the router sets from `staticDecision.contextRank`
(`action-transaction-router.ts:422-426`), i.e. FROM THE CLASSIFICATION THAT
EXISTS TO DECIDE CLAIMABILITY. That is the coupling to break. See Q2.

### The candidate→claim pipeline, traced end to end

1. `action-transaction-router.ts:252-262` `options.onCandidate({claimKey,
   builtinId?, crossSpaceReadSpaces?})` — emitted from `emitCandidates`
   (dedupe map `lanes`, `:250`), called either from `afterLocalApply`
   (`:607-616`, the UNCLAIMED shadow run) or `afterRouteSelected`
   (`:637-646`, sibling-lane vouching).
2. `deno-space-executor.ts:714-800` `#handleCandidate` — demand-generation
   revalidation (`:717-720` via `#expectedCandidateGeneration` `:706-713`),
   lane-escape assert (`:721-727`), the §B.5 sponsor-consent gate
   (`:734-746`, emitting `builtin-causal-actor-mismatch`), the routing-flag
   gate (`:747-754`), then
   `#server.trySetExecutionClaim(...)` (`:763-770`) — and the null return
   is where **`claim-authority-lost`** is emitted (`:771-786`).
3. `memory/v2/server.ts:6226` `#assertExecutionClaimContextFloorAdmits(engine,
   claimInput)` inside the issuance path — R7's decline.
4. `memory/v2/server.ts:2696-2701` `recordExecutionCandidateClaimReady` and
   `:2706-2729` `recordExecutionCandidateUnserved`.

**FINDING (Q1, and it is a surprise about the named starting points):**
`recordExecutionCandidateClaimReady` and `recordExecutionCandidateUnserved`
are **pure counters**. The docblock at `:2694-2695` says so outright: "F1
claim-coverage evidence… Counter maintenance only — receiving one never
transfers or implies authority." They increment
`candidateClaimReadyBySpace`, `candidateUnservedByCode`,
`candidateUnservedBySpace`, `candidateUnservedOffendersByCode`. They are
**telemetry, not mechanism** — and they are the arc's own gating metric
(§5h.5). So they are not deletions at all: they are the instrument you keep
until the flip in §5, then delete. Anything in the plan that treats
`recordExecutionCandidate*` as machinery to remove has mis-scoped it.

### Lease fences — 13 causes, and only 5 are arbitration

`ExecutionLeaseFenceError` `engine.ts:947-958`. Causes, from
`grep -a -A1 "new ExecutionLeaseFenceError("`:

| cause | site | class |
| --- | --- | --- |
| `lane-principal-mismatch` | `engine.ts:4056` | authority (survives) |
| `sponsor-authority` | `:4062` | authority (survives) |
| `lease-stale` | `:4077` | ARBITRATION (goes with the lease) |
| `claim-arity` | `:4083` | ARBITRATION |
| `claim-expired` | `:4090` | ARBITRATION |
| `claim-lease-generation` | `:4099` | ARBITRATION |
| `lane-generation-stale` | `:4108`, `:8665` | authority (lane grant) |
| `lane-write-authority` | `:4125` | authority (survives) |
| `foreign-authorization-stale` | `:6776` | authority (survives) |
| `mixed-lane-commit` | `:8616` | ARBITRATION-ish — see note |
| `claim-not-live` | `:8653` | ARBITRATION |
| `claim-observation-mismatch` | `:8659` | ARBITRATION |
| `claim-context-mismatch` | `:9058`, `:10188` | ARBITRATION (the R7 fence) |

All of them live inside `assertExecutionLeaseFenceTransaction`
(`engine.ts:4037-4130`) and `admitExecutionCommitLanes`
(`engine.ts:8602-8674`). The authority-class causes are `fence.authorize`,
`fence.authorizeActingPrincipal`, `fence.laneAuthority` — ACL/WRITE
re-resolution at transaction time. **Those survive verbatim; what goes is
the lease/claim generation plumbing they currently hang off.** Note the
shape: today the acting-principal WRITE re-check at `:4110-4127` is reached
only `for (const claim of options.claims)` and only when
`claim.contextKey !== "space"`. Delete claims naively and **the acting
WRITE re-check disappears with them.** That is survivor #1 that rides on a
claim (see Q2).

### The durable context floor: the GATE goes, the RESOLVER stays

- `schedulerContextFloor` `engine.ts:6999-7025` — the per-key durable read.
- `schedulerClaimContextFloor` `engine.ts:7058-7092` — the R7 **issuance**
  reader; its own docblock (`:7028-7057`) says its only purpose is "lets the
  host decline such a claim at ISSUANCE". Its sole non-test caller is
  `server.ts:2415`.
- `#assertExecutionClaimContextFloorAdmits` `server.ts:2409-2442`, called at
  `server.ts:6226`. Its docblock at `:2396-2398` volunteers that "It is NOT
  a correctness fix — the engine fence already prevented anything wrong from
  committing… What it fixes is liveness."
- `upsertSchedulerContextFloor` `engine.ts:7096-7150` (monotonic:
  `:7132-7136` narrows only).
- `resolveSchedulerExecutionContext` `engine.ts:7266-7388` — computes
  `effectiveFloor = [staticFloor, runtimeFloor, globalFloor,
  principalFloor].reduce(narrowerSchedulerContext)` (`:7372-7378`) and from
  it `executionContextKey` (`:7379-7382`) plus
  `invalidatedExecutionContextKeys` (`:7384-7389`).

**FINDING (Q2/Q3): `resolveSchedulerExecutionContext` is already the
"discover scope by running" mechanism the owner's inversion asks for.** It
takes an observation produced by a run and returns the scope the result
actually landed at, plus which broader contexts that invalidates. It is not
a claim gate — nothing in it mentions a claim. Only two things turn it into
an arbitration surface: `#assertExecutionClaimContextFloorAdmits` (declines
issuance) and the `claim-context-mismatch` fence (`engine.ts:9051-9061` and
`:10176-10191`), which compares the resolved key against
`provenance.claim.contextKey`. **Delete those two and the resolver becomes
exactly §5h.4's step 2 — "observe the scope the result actually lands
at" — with no new machinery.**

### THE LOAD-BEARING FACT everything below rests on

**The executor already runs the entire demanded closure, unconditionally,
regardless of servability.** Evidence:

- `executor-worker.ts:988-1037` `activateDemand`: for each demanded piece
  it `await cell.sync()`, then `prepareExecutorDemandPiece({… instantiate:
  () => runtime.start(cell)})` (`:1007-1012`), then installs a permanent
  consumer `demandSinks.set(pieceId, cell.sink(() => undefined))`
  (`:1023`). `pullDemand` (`:1039-1055`) then `await cell.pull()`.
  `runtime.start` + a live sink = the piece's whole reactive closure is
  instantiated and held live in the Worker.
- Nothing consults servability before this. Classification happens in
  `routeActionTransaction` (`storage/v2.ts:4308-4346`), which is called on
  the **commit** path — after the action has already run.
- The router's own docblock says so: "The first proven run stays in the
  private shadow overlay and reports a CandidateClaim"
  (`action-transaction-router.ts:203-207`). Default route for an unclaimed
  executor run is `local = {disposition:"local", kind:"executor-shadow"}`
  (`:296-299`).
- D2's demand-closure roll-up (`demand-closure.ts`, whole file) exists
  because demand names ROOTS and the server instantiates the descendants
  itself: "The closure is the server's business, so the SERVER rolls up
  instead" (`demand-closure.ts:12-14`).

**Therefore "coverage" has never been about whether the server CAN run an
action.** With two exceptions (below) it already did. The `unservedByCode`
counters count runs that HAPPENED and whose commit was then refused
admission upstream. This reframes Q3 completely.

The two genuine cannot-run classes:

1. `fetch: denyExternalBuiltinFetch` (`executor-worker.ts:206-209`,
   installed at `:1563`) — any builtin reaching `globalThis.fetch` rejects
   inside the Worker. The broker (`runtime.fetchBuiltin`,
   `runtime.ts:2106-2140`) is the only egress path.
2. `llmClientOptions` (`builtins/llm-client-options.ts:25-57`) throws
   `"unsupported LLM builtin has no server broker route"` at `:37` when
   `hasServerBuiltinFetch()` and no `serverBuiltinId`.

**STALE FACT CAUGHT (orchestration §2.8).** §2.8 records "The `llm`
builtin's own call at `llm.ts:810` passes nothing — that is the hole."
At HEAD it passes `serverBuiltinId: "llm"` (`llm.ts:812`), `"llm"` is in
`LLMServerBuiltinId` (`llm-client-options.ts:8-12`) and in
`SERVER_EXECUTABLE_BUILTIN_IDS` (`server-execution.ts:28`). The hole is
CLOSED; §2.8 reads as open. Wave A presumably landed it. Flagging per the
standing prior, not fixing (docs are off-limits for this task).

### The `SERVER_EXECUTABLE_BUILTIN_IDS` docblock says the allowlist is
### classification scaffolding, in its own words

`packages/runner/src/builtins/server-execution.ts:9-18`:

> "'Server-side implementation' is NOT a synonym for 'has a broker fetch
> route'. … What membership actually buys is uniform: the `:server-v1`
> implementation fingerprint, which is the only key
> `supportedBuiltinDescriptor` … accepts, and therefore the only way an
> EFFECT node ever acquires an assembled scope summary instead of
> classifying `unknown-effect-surface`."

And for `navigateTo` (`:47-52`): "Membership is load-bearing for one thing
only: the `:server-v1` fingerprint … without which the node classifies
`unknown-effect-surface` forever and **no lane can ever claim it**."

So the allowlist's job is to make a builtin *claimable*. The thing that
makes it *runnable* is a different object: the broker route
(`llmClientOptions` / `fetchBuiltin`) or, for `navigateTo`, the message
seam. Those two are separable and only one survives the deletion.

### The read side ALREADY has a claim-free acting-context carrier

`memory/v2/server.ts:4489-4536` `#actingReadScopeContext`: a lease-bound
executor session names a per-request `actingContext`; the host validates it
against the LIVE lane grant (`#userLaneGrants` / `#sessionLaneGrants`,
`server.ts:1869-1873`) and resolves the scope context from the GRANT's own
`(principal, sessionId)` — CA8. No claim is consulted anywhere in it. Its
docblock (`:4470-4475`) notes it makes "the same live-registry consult the
commit fence's laneAuthority makes."

The WRITE side does not. There, the acting context is derived from the
claims: `executionClaimsActingContext(claims)` (`server.ts:426-436`), fed
to `Engine.applyCommit` as `actingContext` (`server.ts:8392-8394`), and
`admitExecutionCommitLanes` (`engine.ts:8612-8676`) then re-derives the
lane from `executionClaimAssertion.contextKey`
(`assertedLaneOfObservation`, `engine.ts:8544-8560`) and throws
`ProtocolError` if the two disagree (`:8622-8627`).

**That asymmetry is the whole substantive design work of the deletion**
(see Q2). The commit path must take `actingContext` from the wire and
validate it against the lane grant, exactly as the read path already does.
The plumbing exists on both ends; only the derivation is claim-shaped.

---

# 1. What exactly gets DELETED

Grouped by what the thing's only job is. "Depends on it" answers the
follow-up question per group.

## 1a. The shared action identity (pure arbitration — deletable outright)

| item | site | other dependants |
| --- | --- | --- |
| `ActionClaimKey` | `memory/v2.ts:428-437` | see below |
| `canonicalActionClaimKey` | `memory/v2.ts:440-452` | only claim code |
| `actionClaimMapKey` | `memory/v2.ts:454-455` | client `#executionClaims` map, feed batch |
| `ExecutionClaim` | `memory/v2.ts:457-476` | wire protocol, feed |
| `executionClaimIncarnationKey` | `memory/v2.ts:479-486` | overlay lifecycle (Q2) |
| `actionClaimKeyFromObservation` | `servability.ts:174-210` | both routers only |
| `actionClaimKeysEqual` | `servability.ts:212-221` | `executionClaimMatchesActionKey` only |
| `executionClaimMatchesActionKey` | `servability.ts:223-228` | ONE caller: `action-transaction-router.ts:469` |
| `actionClaimChainKeysEqual` | `servability.ts:236-246` | `executionClaimMatchesActionChain` only |
| `actionClaimChainMapKey` | `servability.ts:255-256` | — |
| `ownChainContextKeys` | `servability.ts:268-277` | client router only |
| `executionClaimMatchesActionChain` | `servability.ts:286-294` | client router only |

`ActionClaimKey` has ONE non-arbitration dependant worth naming:
`schedulerClaimContextFloor`'s key shape (`engine.ts:7059-7066`) is a
subset of it, and that function goes too (1d). Everything else that
consumes an `ActionClaimKey` is claim lifecycle, telemetry, or the client
mirror.

## 1b. The candidate→claim-ready→claim→settle pipeline

| item | site | note |
| --- | --- | --- |
| `CandidateClaim` / `CandidateClaimDiagnostic` | `deno-space-executor.ts:77-120` | wire types |
| `emitCandidates` + the `reported` per-lane dedupe | `action-transaction-router.ts:213-263` | |
| `reportUnservable` + `reportedUnservable` | `:269, 275-295` | |
| `candidateLaneKeys` | `:703-720` | consumes `openUserLaneKeys` |
| `laneKeyRank` | `:690-694` | |
| `invalidateClaim` | `:1157-1174` | |
| `unservedRoute` | `:1176-1201` | with `disposition:"unserved"` |
| `forgetLaneCandidate` | `:56-64, 680-684` | C1.9c dedupe reset |
| `#handleCandidate` | `deno-space-executor.ts:714-800` | incl. `trySetExecutionClaim` |
| `#expectedCandidateGeneration` | `:706-713` | |
| `attachClaimAssertion` | `action-transaction-router.ts:1345-1364` | see Q2 — the contextKey half SURVIVES |
| `openUserLaneKeys` option + its wiring | `:118-128`, `executor-worker.ts:1292-1300` | see Q2 |
| `laneSliceCoversPiece` / `demandClosureChain` | `demand-closure.ts` (whole file) | see Q2 — it is DEMAND, not claims |
| `routeClientActionTransaction` (client mirror) | `client-execution/action-transaction-router.ts` — **whole 157-line file** | |
| `disposition:"unserved"` arm of `ActionTransactionRoute` | `storage/v2.ts:798-803` | |
| `toCanonicalExecutionUnservedCommit` | `storage/v2.ts:815-832` | |
| `DUAL_CHAIN_CLAIM_MATCH_DIAGNOSTIC` | `client-execution/…:26` | |

**`recordExecutionCandidateClaimReady` / `recordExecutionCandidateUnserved`
are NOT in this list.** `memory/v2/server.ts:2696-2701` and `:2706-2729`
are pure counters — their docblock at `:2694-2695` says "Counter
maintenance only — receiving one never transfers or implies authority."
They are the arc's own gate metric (§5h.5). They are the LAST thing to
delete, not the first: they are how you prove the flip in §5 was safe.
Their consumer `toolshed/routes/storage/memory.ts:289-315` has one real
side effect — `claim-authority-lost` drives
`executionPool.noteClaimAuthorityLoss` (`:305-311` →
`shared-execution-pool.ts:737-790`, the sponsor re-anchor). That trigger
needs a new source (Q2).

## 1c. The three diagnostic codes

- `claim-key-mismatch`: emitted at exactly one site,
  `action-transaction-router.ts:471-478`, when
  `executionClaimMatchesActionKey` fails. Deleting the identity deletes
  the code. No consumer outside telemetry and the
  `server-execution-lunch-poll-placement-gate.test.ts` hard-zero set.
- `claim-authority-lost`: `deno-space-executor.ts:771-786`, on a null
  return from `trySetExecutionClaim`. One real dependant: the pool
  re-anchor above.
- `claim-context-mismatch`: TWO engine fence sites, `engine.ts:9051-9061`
  (with-operations commits) and `:10176-10191` (observation-only). Both
  compare `schedulerObservationResult.executionContextKey` against
  `acceptedObservation.provenance.claim.contextKey`. With no claim there is
  no second opinion to disagree with — the resolved context simply IS the
  context. **Deleting this fence is the mechanical content of "a rank
  changing is not a reason to decline."**

## 1d. Lease fences: the claim-generation half

Deletable from `assertExecutionLeaseFenceTransaction`
(`engine.ts:4037-4130`): `lease-stale` (`:4077`), `claim-arity` (`:4083`),
`claim-expired` (`:4090`), `claim-lease-generation` (`:4099`); and from
`admitExecutionCommitLanes` (`engine.ts:8612-8676`): `claim-not-live`
(`:8653`), `claim-observation-mismatch` (`:8659`). Plus `requireExactClaim`
(`:4053`), `options.claims` (`:4054`), `executionClaims` threading through
`applyCommit`.

**NOT deletable, and they currently sit INSIDE the deleted loop:**
`lane-principal-mismatch` (`:4056`), `sponsor-authority` (`:4062`),
`lane-generation-stale` (`:4108`, `:8665`), `lane-write-authority`
(`:4125`), `foreign-authorization-stale` (`:6776`), `mixed-lane-commit`
(`:8616`). See Q2 — `lane-write-authority` in particular is reached only
`for (const claim of options.claims)`.

## 1e. The durable context floor AS A CLAIM GATE

- `schedulerClaimContextFloor` `engine.ts:7058-7092` — delete. Sole
  non-test caller `server.ts:2415`. Its own docblock (`:7028-7057`) states
  its only purpose is declining a claim at issuance.
- `#assertExecutionClaimContextFloorAdmits` `server.ts:2409-2442`, call
  site `server.ts:6226` — delete. Its docblock volunteers "It is NOT a
  correctness fix … What it fixes is liveness" (`:2396-2398`).

**Do not delete** `schedulerContextFloor` (`engine.ts:6999-7025`),
`upsertSchedulerContextFloor` (`:7096-7150`),
`resolveSchedulerExecutionContext` (`:7266-7388`),
`invalidatedSchedulerExecutionContexts` (`:7190-7215`) or the
`scheduler_context_floor` table (`:360-382`). Those are scope discovery
and cache invalidation, not arbitration — see Q2/Q3.

## 1f. The six `dirtyProducer` client-rerun sites

Line numbers have MOVED since §5h.4 recorded them. Current:

| diagnostic | §5h.4 said | actual at HEAD |
| --- | --- | --- |
| `captured-claim-no-longer-live` | :4212 | `storage/v2.ts:4266` |
| `source-basis-rejected` | :6102 | `:6156` |
| `claim-snapshot-replaced` | :6157 | `:6211` |
| `claim-generation-replaced` | :6199 | `:6253` |
| `claim-revoked` | :6280 → | `:6282` |
| `claim-unserved` | :6280 | `:6350` |

All six funnel into `dropClaimedOverlays(predicate, {dirtyProducer, code})`
(`storage/v2.ts:6505-6620`). `dirtyProducer: true` is what emits
`{type: "execution-claim-invalidation"}` on the subscription (`:6612-6621`)
plus, on three of them, `invalidateRegisteredExecutionActions`
(`:6625-6640`). The single consumer is
`scheduler/facade.ts:2184-2194`: `action.prepareClaimedRerun?.()` then
`this.invalidateActionForHostWake(action)`.

**All six delete, and so does `prepareClaimedRerun`** — every one of them
is "a claim I was deferring to went away, run it yourself." Under blanket
ownership the client is never deferring to a claim, so there is nothing to
undo. The seventh call (`:6405`, `dirtyProducer: false`,
`claim-${settlement.outcome}`) is the SUCCESS path — a server value
replacing a local speculation — and that one survives (Q2).

---

# 2. What SURVIVES — and which survivors ride on a claim today

## 2a. The headline: the engine's ENTIRE write-bounding firewall is
## claim-conditional

`assertExecutionActionTransaction` (`engine.ts:6494-6720`) is the engine's
write firewall. It contains:

- `assertLaneScopedAddress` over `schedulerSummaryReadAddresses(summary)`
  (`:6528-6536`), `schedulerSummaryWriteAddresses` (`:6537-6545`),
  `schedulerObservationReadAddresses` (`:6546-6554`),
  `schedulerObservationWriteAddresses` (`:6555-6563`)
- `schedulerRuntimeWritesExceedSummary` → `runtime-exceeds-static-scope`
  (`:6564-6569`)
- the exact-lane write check + `rejectNonLaneScope` (`:6655-6664`)
- `assertLaneBroadScopeNamingWrite` → **`broad-lane-value-write`**
  (`:6665-6678`, definition `:6404-6462`)
- `unobserved-read` (`:6640-6644`), `unobserved-write` (`:6679-6686`)
- `sqlite-operation`, `merge-commit`, precondition scope checks

It has exactly two call sites, `engine.ts:8881-8891` and `:10092-10102`,
and **both are guarded by `acceptedObservation.provenance !== undefined`**
(`:8874`, `:10091`). Provenance is minted by `acceptedSchedulerObservation`
(`:9657-…`), which at `:9691-9704` returns **no provenance at all when
`options.executionClaim === undefined`**.

> **No claim ⇒ no provenance ⇒ no firewall.** Every survivor in the top
> box's right-hand column — lane scope admission, write envelopes,
> `broad-lane-value-write`, the cross-principal leak guards — is today
> reachable ONLY through a claim. Deleting claims naively deletes the
> entire right-hand column with them.

This is the substantive design work, and it is a single question: **what
makes a commit "a bounded reactive action commit" once a claim no longer
does?**

The answer available in the code is: **the trusted scheduler observation
plus an acting context.** `trustedSchedulerScopeSummary(observation)`
(`engine.ts:6175-6194`) already validates `complete === true` and the two
fingerprints against the observation itself — it consults no claim.
`assertExecutionActionTransaction` takes `claimContextKey` as its only
claim-shaped parameter and immediately reduces it to `laneScopeKey` via
`laneScopeKeyForClaimContext` (`:6507`). So the parameter is an **acting
lane**, not a claim. Rename it, source it from the acting context (2b), and
the firewall is claim-free as written.

## 2b. Survivors that ride on a claim today — the new-carrier list

| survivor | current carrier | required new carrier |
| --- | --- | --- |
| the whole write firewall above | `provenance !== undefined`, i.e. a live claim | presence of a trusted `completeActionScopeSummary` on the commit + an acting context; provenance becomes an OUTPUT of admission, not its precondition |
| acting lane for scope resolution / effective-context / CFC labels | `executionClaimAssertion.contextKey` (`engine.ts:8544-8560`) → `admitExecutionCommitLanes`; host side `executionClaimsActingContext(claims)` (`server.ts:426-436`) at `server.ts:8392` | the wire's `message.actingContext`, validated against the live lane grant — **this path already exists for READS**: `#actingReadScopeContext` (`server.ts:4489-4536`). `applyCommit` already accepts `actingContext` (`engine.ts:8608`); today it must merely AGREE with the claim (`:8622-8627`). Make it the sole input. |
| acting-principal WRITE re-resolution (`lane-write-authority`) | reached only inside `for (const claim of options.claims)` and only when `claim.contextKey !== "space"` (`engine.ts:4110-4127`) | the same acting context, once per commit |
| lane-grant liveness (`lane-generation-stale`) | `fence.laneAuthority?.(claim)` (`engine.ts:4106-4109`, `:8663-8668`) | `laneAuthority(actingContext)` — the grant registry is already keyed by contextKey (`laneGrantKey`, `server.ts:1053`), so this is a signature change |
| §4 pair EMISSION on the executor's commit | `widenLaneOutputEnvelopes` called only at `action-transaction-router.ts:487-489`, gated `contextRank !== "space"`, and only in the claimed path | same, gated on the run's acting lane. The pair's own emission in the runtime is already claim-free — C1 verified `pattern-binding.ts:274` "contains no lane, claim, executor or server term" (§5h C1 ruling) |
| the successful overlay drop (server value replaces local speculation) | `dropClaimedOverlays(…, {dirtyProducer:false, diagnosticCode:"claim-committed"/"claim-no-op"})` at `storage/v2.ts:6405`, matched by `executionClaimIncarnationKey` (`:6547-6551`) | match on (action identity, acting lane, seq) instead of claim incarnation. The accepted-data barrier (`retainEarlyExecutionSettlement`, `reconcileExecutionSettlement`, `overlayHasUnresolvedBasis`) is coherence machinery, not arbitration — it survives with a re-keyed index. |
| pool sponsor re-anchor | `claim-authority-lost` diagnostic → `noteClaimAuthorityLoss` (`toolshed/…/memory.ts:305-311`, `shared-execution-pool.ts:737-790`) | lease-level authority loss. The re-anchor's own body only needs `(space, branch)` and `slot.lease` — the claim key is used purely to name them (`:739`). |
| single-executor guarantee | the `ExecutionLease` (`memory/v2.ts:504-516`) sponsors per-action claims | **the lease itself, promoted**: today it authorises claims; under blanket ownership it IS the authority, space-wide. `lease-stale` / `leaseOwnerMatches` / `leaseGeneration` survive; `claim-arity`, `claim-expired`, `claim-lease-generation`, `claim-not-live` go. |

## 2c. Survivors that do NOT ride on a claim (leave alone)

- The §4 widening pair itself, `laneInstanceScope` /
  `laneInstanceAddressesEqual` / `laneInstanceCovers`
  (`servability.ts:729-751`, `:684-693`) and the runtime emission
  (C1 ruling, `pattern-binding.ts:274`).
- `laneAdmitsScope` / `laneAdmitsWriteScope` (`servability.ts:885-909`) —
  pure predicates over `(scope, laneRank)`. They need `laneRank`, which
  today comes from the classification; under 2b it comes from the acting
  context. The predicates are unchanged.
- `scope-naming-link.ts` / `scopeNamingLinkWriteViolation` — a shared wire
  contract, address-keyed only.
- `covers` (`servability.ts:884-892`) and `declaredWriteIds` (`:820-841`) —
  address prefix matching. §5h.2 already established `covers()` compares
  "`space`, `id`, `scopeOf`, and a path prefix. There is no value
  comparison anywhere in it."
- `resolveSchedulerExecutionContext` and the `scheduler_context_floor`
  table (1e).
- `observationMinimumContextRank` (`facade.ts:206-283`, called at `:1014`)
  and `rehydrateActionFromObservation` (`:913-931`) — snapshot
  rehydration, no claim term.
- `schedulerObservationForeignReadSpaces` (`engine.ts:6836-6858`),
  `schedulerStaticContextFloor` (`:6860-6907`),
  `schedulerRuntimeContextFloor` (`:6909-6997`) — scope-lattice
  derivation, consulted at the adoption/attach gate `:2828-2833`.
- The demand plumbing in full: `addExecutionDemand` (`runner.ts:2196-2218`),
  `queueExecutionDemand` (`:2155-2194`), `session.execution.demand.set`
  (`memory/v2/client.ts:880-905`), the host's authz + sweep
  (`server.ts:3944-3975`, `:3902-3942`), `activateDemand` /
  `pullDemand` (`executor-worker.ts:988-1055`), and `demand-closure.ts`.
  **Demand is the carrier of blanket ownership.** It is what tells the
  server which closure it owns, and it contains no claim term.

---

# 3. What "coverage" means afterwards — and yes, a large part of
# wave G is scaffolding

## 3a. The reframe

Today "coverage" reads as *"can the server run this action?"* The code says
that question was already answered yes, for everything in the demanded
closure, before any classifier ran (see THE LOAD-BEARING FACT above). What
classification actually decides is *"may this run's commit be admitted
upstream as authoritative?"*

Under blanket ownership the answer to the second question is **yes by
construction** — there is no other author. So classification loses its
decision function entirely. What is left is the firewall's job: **given
that this commit will be admitted, what may it write?**

That splits the classifier cleanly in two.

## 3b. What becomes unnecessary

**`classifyStaticActionServability` (`servability.ts:303-556`) as a
GATE.** Every one of its 19 `STATIC_ACTION_UNSERVABLE_REASONS`
(`servability.ts:29-61`) exists to answer "decline or not":

- `event-handler`, `ui-binding-transaction`, `source-transaction`,
  `unknown-action-kind` — transaction-class routing. Survives as a
  *dispatch* discriminator (handlers stay client-side per D11), not a
  decline.
- `malformed-candidate`, `malformed-static-surface`,
  `malformed-output-surface`, `incomplete-static-surface`,
  `unknown-effect-surface` — "the certificate is not good enough to
  claim". Under blanket ownership a missing/malformed certificate cannot
  mean "don't serve it" (nothing else would). It must mean **run it under
  the most conservative write bound**, i.e. an empty envelope, and let the
  firewall reject the specific offending write. §5f already found one of
  these classes (`malformed-output-surface`) was a *labeling* defect, not
  a real shape problem.
- `untrusted-implementation` — the `impl:` prefix check
  (`servability.ts:376-378`). Survives: it is what binds a certificate to
  compiled code.
- `foreign-owner-space`, `foreign-piece-space`, `foreign-write-space`,
  `foreign-read-space`, `foreign-read-scope`,
  `foreign-read-access-denied` — cross-space authority. **Survives** as
  read/write authority (the C3.6 preflight binds the acting principal's
  foreign READ).
- `non-space-piece-scope`, `non-space-read-scope`,
  `non-space-write-scope` — **these are the arc's biggest residual (33
  events / 19 offenders in the space arm, §5h.3) and they are pure
  arbitration.** They say "this action's surfaces are scoped and I am
  classifying for a lane that cannot admit them", i.e. "I picked the wrong
  lane". Under "discover scope by running" the correct response is to run
  it and let `resolveSchedulerExecutionContext` report the lane —
  not to decline. **This class DISSOLVES rather than being fixed.**

**`contextRank` on the classification result** (`servability.ts:86-90`,
`:104-108`) — the whole reason it exists is review CA9's rank filter, so
the router can pair a candidate with lanes of matching rank
(`candidateLaneKeys`, `action-transaction-router.ts:703-720`). No
candidates, no rank filter, no `contextRank`. The lane rank the firewall
needs comes from the acting context instead (2b).

**`SERVER_EXECUTABLE_BUILTIN_IDS` as an allowlist.** Its own docblock
(`server-execution.ts:9-18`, quoted above) says membership buys exactly
one thing: the `:server-v1` fingerprint that lets a descriptor be honored
so the node does not classify `unknown-effect-surface` — i.e. so it can be
claimed. `navigateTo`'s entry says it outright: "without which the node
classifies `unknown-effect-surface` forever and **no lane can ever claim
it**" (`:47-52`). With nothing to claim, the allowlist has no gate to
open. What survives is the *broker route* — `llmClientOptions`
(`llm-client-options.ts:25-57`), `runtime.fetchBuiltin`
(`runtime.ts:2106-2140`), `server-builtin-channel.ts` — which is the real
server-side capability and a different object. `SERVER_COMPUTATION_BUILTIN_IDS`
(6 members, `server-execution.ts:224-231`) is in the same position.

`SERVER_MATERIALIZER_BUILTIN_IDS` (`:309-313`: `map`, `filter`,
`flatMap`) is the one that is NOT purely scaffolding: `runner.ts:5365-5383`
attaches the `materializerWriteEnvelopes` annotation, and per the
descriptor inventory that "re-indexes the node as a scheduler materializer
and changes *when* it runs." That is scheduling behaviour, not
classification.

## 3c. What becomes the write-bounding contract under a different name

The nine-field `CompleteActionScopeSummary`
(`persistent-observation.ts:36-46`) splits by role:

| field | role afterwards |
| --- | --- |
| `writes`, `materializerWriteEnvelopes`, `directOutputs` | **THE contract.** Consumed as one union by `servability.ts:639-643`, `engine.ts:6142-6148`, `summaryDeclaredWriteIds` (`:6473-6487`), `declaredWriteIds` (`servability.ts:820-841`) |
| `implementationFingerprint`, `runtimeFingerprint` | bind the contract to the code that authored it; `trustedSchedulerScopeSummary` (`engine.ts:6175-6194`) is the check |
| `piece` | proves pieceId/ownerSpace agreement — survives |
| `complete: true` | changes MEANING: today "safe to claim", afterwards "the write bound is exhaustive". Same bit, different contract. |
| `reads` | **the one field whose only job is claim classification.** The firewall admits dynamic reads outside the envelopes by design (`servability.ts:653-661`: "Reads need no envelope bound because authority follows writes"); `summary.reads` survives only as an input to `schedulerStaticContextFloor` (`engine.ts:6870`) and `schedulerObservationForeignReadSpaces` (`:6847`) — scope discovery, not bounding. Worth re-examining whether it needs to be in the certificate at all. |

So the honest name for what survives is a **write certificate**: "this
implementation, at this runtime version, writes only within this address
set." That is exactly what `scoped-cell-instances.md` already asks for on
the write side, and it is what C1 ruled survives.

**Verdict on wave G, stated plainly as the box asks:** the descriptor
*bodies* survive — `runtimeWrites`, `directOutputs`, `writes`,
`materializerWriteEnvelopes` are the write bound. The descriptor
*registries* (`SERVER_EXECUTABLE_BUILTIN_IDS`,
`SERVER_COMPUTATION_BUILTIN_IDS`) and the `:server-v1` fingerprint
mechanism (`serverBuiltinImplementationHash`, `server-execution.ts:82-86`;
the `runner.ts:5197-5216` stamp fork) are scaffolding: they exist to make
a node claimable. That is roughly half of what wave G shipped. The other
half — every `serverBuiltinRuntimeWrites` declaration in `fetch.ts`,
`fetch-program.ts`, `llm.ts`, `llm-dialog.ts`, `navigate-to.ts` — is the
write bound and is durable.

One caveat the survival test should record: `navigateTo`'s SESSION-scoped
`serverBuiltinRuntimeWrites` declaration is called out as "the design's
safety hinge … a `session`-declared write is admitted ONLY at session lane
rank … which is what makes a space-rank navigate claim … structurally
unreachable" (`server-execution.ts:53-64`). That containment is a
write-bounding property and must keep working when the rank stops coming
from a claim. Its pin is
`packages/runner/test/navigate-to-rank-containment.test.ts`.

---

# 4. What breaks CP1 — CP1 dissolves, and it names one residual that is
# NOT its own

CP1 (`client-passivity.md` §1 point 2): "the dynamic fail-open class —
revoked claims, unserved candidates, firewall discards, de-claimed
actions — is client-authoritative **by design**; its mandated client
rerun-commit IS the canonical value. Passivity must keep that rerun
executable: suppression demotes client machinery, it never deletes it."

Read the four members against the deletion list:

| CP1 member | mechanism | after blanket ownership |
| --- | --- | --- |
| revoked claims | `claim-revoked` (`storage/v2.ts:6282`) | no claim to revoke — GONE |
| de-claimed actions | `claim-generation-replaced` (`:6253`), `claim-snapshot-replaced` (`:6211`), `captured-claim-no-longer-live` (`:4266`) | GONE |
| unserved candidates | `claim-unserved` (`:6350`), plus `disposition:"unserved"` | GONE |
| firewall discards | `source-basis-rejected` (`:6156`), `onFirewallRejected` (`action-transaction-router.ts:648-657`) | **DOES NOT GO** — see below |

So five of the six `dirtyProducer` sites lose their trigger outright, and
`prepareClaimedRerun` (`facade.ts:2178-2180`) has nothing to prepare.
**CP1 as a class dissolves**: it is defined by "an action the server was
going to do, then didn't", and the whole point of blanket ownership is that
there is no "then didn't".

§5h.4's own measurement already anticipated this: "**Measured in the
flagship fixture: `settlementsUnserved` = 0 and `claimsRevoked` = 2 in
every arm** — so the rerun path fires via revocation, and rarely." CP1 was
never load-bearing; it was the escape hatch for a regime that is ending.

**The residual CP1 leaves behind, and it is not client authority.** A
server run can still fail after being admitted: the firewall can reject a
specific write (`runtime-exceeds-static-scope`, `broad-lane-value-write`,
`unobserved-write`), a read basis can be invalidated
(`source-basis-rejected`), or the Worker can die. Today all four resolve
to "the client reruns and commits, and that IS canonical." Under blanket
ownership none of them may resolve that way — **nothing else runs them**
(the owner's words). So the residual is:

> **A rejected or lost server run must be RETRIED SERVER-SIDE, and the
> value must be allowed to be absent in the meantime.**

That is a different obligation from CP1 and needs naming. Two concrete
consequences:

1. `dropClaimedOverlays`' `dirtyProducer: true` path — "re-queue the
   producing computation on the CLIENT" — inverts into "re-queue it on the
   executor." The mechanism has a home already: the executor's own
   `markInvalid` / `invalidateActionForHostWake` seam
   (`facade.ts:2186-2192`), running inside the Worker. The six sites'
   *body* survives; the *side of the wire it fires on* flips.
2. **D5 (never show a wrong value) becomes the binding constraint where
   CP1 used to be.** The client's speculative local run still produces a
   render value; what it may not do is commit. So the client's overlay
   becomes render-only and is dropped, not committed, when the server's
   value arrives — which is `dropClaimedOverlays`' `dirtyProducer: false`
   arm (`storage/v2.ts:6405`), the one that survives. If the server never
   produces a value, the client shows its speculation and the value is
   **stale, not wrong** — acceptable per D10/D5, but it needs a counter,
   because it is the failure mode that used to be loud (a fail-open commit)
   and becomes quiet.

**CP1's sentence "suppression demotes client machinery, it never deletes
it" survives with its subject changed.** The client machinery that must
stay executable is *speculation for rendering*, not *rerun for
canonicity*. §6b's own end-state list already says this — the client keeps
"an initial pull for the rendered vdom" and "lazy pattern instantiation on
the first handler call". CP1's demand that the rerun stay executable was a
demand that the client keep a *complete, committable* closure; the
residual only demands a *renderable* one. That is a strictly weaker
requirement and it is what makes §6b's lazy instantiation legal at all.

---

# 5. The migration

## 5a. The terminal condition is a PAIRED flip, not a single one

The top box names one line. There are two, and they are mirror images:

```
// client: extended-storage-transaction.ts:378-379
this.tx.executionEffectAuthority = "client";
return "allow";

// executor: executor-worker.ts:1564-1567
externalSinkDisposition: (sourceAction) =>
  sourceAction !== undefined && hasAnyLiveClaim(sourceAction)
    ? "allow"
    : "suppress",
```

Default is `"allow"` on the client (`runtime.ts:1052`,
`extended-storage-transaction.ts:359`) and claim-conditional-`"allow"` on
the executor. **Flipping only the client makes every unclaimed effect
vanish** — the exact "silent missing side effects" the box forbids.
Flipping only the executor doubles every effect. The flip is atomic:
client → `suppress`, executor → `allow`, together, behind one flag.

The single universal chokepoint is **`cfc/sink-request.ts:99`**:
`if (tx.externalSinkDisposition?.() === "suppress") return;` inside
`enqueueSinkRequestPostCommitEffect`. Every egress builtin funnels through
it: `llm.ts:561`, `fetch.ts:480`, `fetch-program.ts:303`,
`stream-data.ts:145`, `sqlite-builtins.ts:801`, `llm-dialog.ts:3299`.
(`sqlite-builtins.ts:798` and `llm-dialog.ts:3272` also consult it
directly, earlier, to avoid stranding a dedup marker.)

## 5b. What must be true first — three concrete prerequisites

**(1) Every egress builtin must have a server-side route.** The full
egress set is pinned by `packages/runner/test/builtin-effect-registry.test.ts`:
`EGRESS_EFFECT_IDS` (`:32-41`) = fetchBinary, fetchText, fetchJson,
fetchJsonUnchecked, fetchProgram, **streamData**; `OTHER_EFFECT_IDS`
(`:44-49`) = llm, generateObject, generateText, **sqliteQuery**; plus
`llmDialog` (factory-declared) and `navigateTo`.

Set-difference against `SERVER_EXECUTABLE_BUILTIN_IDS`
(`server-execution.ts:19-66`): **`streamData` and `sqliteQuery` are
missing.**

- `sqliteQuery` is fine in the can-run sense: its egress is
  `provider.sqliteQuery(db, sql, params)` (`sqlite-builtins.ts:825`), and
  the Worker has a provider. It only lacks the allowlist membership that
  would let it be *claimed* — which is exactly the scaffolding Q3
  identifies. Under the paired flip it needs no allowlist at all.
- **`streamData` is a genuine blocker.** `stream-data.ts:160` calls raw
  `fetch(url, {…signal})` inside the flush; the Worker installs
  `fetch: denyExternalBuiltinFetch` (`executor-worker.ts:206-209`,
  `:1563`). Client suppressed + executor denied = the effect never
  happens. It also has no `:server-v1` route to add it to. Its polling
  loop and `AbortController` shape make it the least broker-friendly of
  the family.
- `compileAndRun` (`compile-and-run.ts:270-278`) uses
  `tx.enqueuePostCommitEffect` directly and **deliberately has no
  `externalSinkDisposition()` gate** (`:253-258`, with the reason: asking
  would pin effect authority and prejudge its kind review). So the flip
  does not reach it either way — but that means it is unaffected rather
  than safe, and its kind review is a real open item.

**(2) The acting context must stop coming from the claim.** §2b's table.
Until it does, deleting claims removes the engine's entire write firewall
(§2a). This is the prerequisite for everything else.

**(3) CP17's effect-attempt journal moves from improvement to
requirement.** Today the client's fail-open rerun is the recovery path for
a fenced writeback (`wave-d` §6.1: `fetchProgram`'s `reopenClaimedWork`
"deliberately re-egresses"). Under the paired flip there is no client
fallback, so a Worker death between egress and writeback silently loses
the effect. The journal (`wave-d` §6.2) is the named design. Alternatively
accept the gap and count it — but decide, do not discover.

## 5c. Ordering — smallest first slice that REDUCES arbitration

**Slice 1 (the first slice): source the served commit's acting context
from the RESOLVED effective context, not from the claim's `contextKey`.**

Concretely: `admitExecutionCommitLanes` (`engine.ts:8612-8676`) already
accepts `actingContext` as a parameter; today `server.ts:8392` derives it
from `executionClaimsActingContext(claims)` and `:8622-8627` throws if the
two disagree. Change the derivation to the wire's `message.actingContext`
validated against the live lane grant — the code for that validation
already exists for reads (`#actingReadScopeContext`, `server.ts:4489-4536`).

Why this is the right first slice:

- It is the mechanical content of "a rank changing is not a reason to
  decline". `claim-context-mismatch` (`engine.ts:9051-9061`, `:10176-10191`)
  exists only because two functions compute the context and can disagree.
  Give the commit ONE source of context and the fence has nothing to
  compare. **This is the only correct way to delete that fence** — the
  fence is a real cross-principal leak guard in disguise (a space-rank
  claim whose run resolved `user` would write a per-user result to the
  shared instance), so it may not simply be removed.
- It deletes, in one step and without designing any negotiation:
  `#assertExecutionClaimContextFloorAdmits` + `schedulerClaimContextFloor`
  (R7 has no claim to decline), `claim-context-mismatch`, `contextRank` on
  the classification result, `candidateLaneKeys`, `laneKeyRank`, and the
  CA9 rank filter.
- It dissolves `non-space-read-scope` / `non-space-write-scope` /
  `non-space-piece-scope` — 33 events and 19 offenders in the space arm
  (§5h.3), the arc's largest residual — because the lane rank is now
  whatever the run resolved to, so there is no wrong lane to be in.
- It is a strict improvement **in the current regime**, measurable with the
  existing instrument: `candidateUnservedByCode` +
  `actionFirewallRejects` + `commit-rejected:*` should all fall and
  `settlementsCommitted` should rise (§5h.5's corrected gate).
- It survives the deletion because it IS the deletion's mechanism. It is
  also the implementation of §5h.4's "scope is discovered by running":
  `resolveSchedulerExecutionContext` (`engine.ts:7266-7388`) already
  returns the discovered scope AND the broader contexts it invalidates
  (`invalidatedSchedulerExecutionContexts`, `:7190-7215`) — the "a broader
  result is shared" case is already implemented as cache invalidation.

**Slice 2: re-anchor the write firewall on the certificate, not on
provenance.** Change `assertExecutionActionTransaction`'s guard from
`acceptedObservation.provenance !== undefined` (`engine.ts:8874`, `:10091`)
to "the observation carries a trusted complete summary AND a validated
acting context". Rename its `claimContextKey` parameter to
`actingContextKey` — it is already reduced to a `laneScopeKey` at `:6507`.
Provenance becomes an output of admission rather than its precondition.
No behaviour change while claims still exist (every claimed commit has
both); it just stops the firewall from depending on the thing being
deleted. **This is the slice that makes the rest safe.**

**Slice 3: promote the lease.** Keep `lease-stale`, `leaseOwnerMatches`,
`leaseGeneration`, `lane-generation-stale`, `lane-write-authority`,
`sponsor-authority`, `lane-principal-mismatch`, `foreign-authorization-stale`;
delete `requireExactClaim`, `claim-arity`, `claim-expired`,
`claim-lease-generation`, `claim-not-live`, `claim-observation-mismatch`,
and hoist the acting-principal WRITE re-check out of the
`for (const claim of options.claims)` loop (`engine.ts:4103-4128`) so it
runs once per commit against the acting context. Retarget
`noteClaimAuthorityLoss` (`shared-execution-pool.ts:737-790`) at lease-level
authority loss.

**Slice 4: the paired egress flip, behind a flag, per space.** Requires
5b(1) and 5b(3). Land `streamData`'s server route (or explicitly except it
and count the exception) first. The acceptance test is the box's: flip both
defaults and nothing breaks.

**Slice 5: delete the client mirror.** `client-execution/action-transaction-router.ts`
(whole file), `#executionClaims` + the feed's claim events in
`storage/v2.ts`, the six `dirtyProducer` sites,
`prepareClaimedRerun`, `disposition:"unserved"`. Re-key the surviving
overlay drop (`storage/v2.ts:6405`) off `executionClaimIncarnationKey`.

**Slice 6: delete the candidate pipeline and the allowlists.**
`emitCandidates`, `#handleCandidate`, `trySetExecutionClaim`,
`CandidateClaim`, `SERVER_EXECUTABLE_BUILTIN_IDS` /
`SERVER_COMPUTATION_BUILTIN_IDS` as gates, the `:server-v1` fingerprint
fork (`runner.ts:5197-5216`). Delete
`recordExecutionCandidate*` LAST — they are the instrument that proves
slices 1-5 worked.

Slices 1, 2 and 3 are all safe to land while both executors still run;
none of them changes who commits. Only slice 4 is a behaviour flip, and it
is the one that needs the flag.

---

# 6. What could make this a bad idea

Four candidates. Two are weaker than they look, two are real.

## 6a. "The closure is too large or too expensive for the server to own
## wholesale" — WEAKER THAN IT LOOKS

The server already owns it. `activateDemand` (`executor-worker.ts:988-1037`)
does `runtime.start(cell)` plus a permanent `cell.sink`, per demanded root,
and D2's roll-up exists precisely because the server instantiates the
descendants itself (`demand-closure.ts:5-14`). Servability never gated a
run. So blanket ownership adds **zero server compute** — it changes only
which peer's commit is authoritative.

What it genuinely adds is **durable write volume for closure members no
client currently pulls**: today the server runs them and shadows the write,
and no client runs them at all, so nothing lands. Afterwards they commit.
That is the intended behaviour (server-materialized state), but it is a
real new cost and it belongs in the P0b keep-warm accounting row rather
than being discovered in production.

Note also that the pool's hard caps are **target state, not
implemented** — README §6.6 ("Target state — pool sizing: workers ≈ active
spaces, bounded LRU") and G18 in the register (`README.md:1493`). So the
starve-the-pool hazard is real. It just is not *created* by this change.

## 6b. "A latency property only per-action claiming provides" — REAL, but
## it indicts P5, not this

Today, for every action in the never-claimed set, the client computes the
value locally and commits it — so the value is available at **local
latency**, zero round trips. That set is large (§5h.3: 33+2+2 events per
arm depending on rank dial). Under blanket ownership those values arrive
from the server: one round trip, minimum.

Per-action claiming does not itself provide the low latency — the client's
*local run* does. The design's answer is to keep the local run as pure
speculation and drop only its authority, which is exactly D10 and the
`dropClaimedOverlays` `dirtyProducer: false` path. **So the latency is
preserved as long as the client still holds a computable closure.**

The problem is that §6b's end state removes that: "lazy pattern
instantiation on the first handler call" means a freshly-booted client has
no closure to speculate with, so every derived value is canonical-first.
The arc's goal statement ("no e2e latency increase … within noise") is
claimed only for "the warm-path/speculation-hit case" (§1, CP3/CP15) and
the tails are explicitly unratified. **Blanket ownership does not create
this, but it removes the escape hatch that currently hides it** — today
the never-claimed set is silently served at local latency, and after the
flip it is not. That should be measured before slice 4, not after.

## 6c. Per-session closures make the server's cost O(sessions) — THE
## STRONGEST COUNTER-CASE

The owner's inversion says: run as one principal, and if the result comes
back broader, it is shared. The code says how often that happens. A
computation that READS scoped state has its effective floor narrowed to
that scope by `schedulerRuntimeContextFloor` (`engine.ts:6909-6997`), and
the floor is **durable and monotonic** (`upsertSchedulerContextFloor`,
`:7132-7136` — it only ever narrows). The §4 pair plus
`assertLaneBroadScopeNamingWrite` then force the value write to the acting
instance, and `laneAdmitsWriteScope` (`servability.ts:903-909`) keeps
writes exact-lane. So for anything reading PerUser or PerSession state the
result is **structurally not shareable** — that is the leak guard working
as designed, and it is exactly the C1-ruled survivor.

Consequence: for a space with S live sessions and session-scoped
derivations, the server must run those derivations S times. Today the
executor runs the closure once (as a shadow) and each of the S clients runs
its own copy — total 1+S, of which S is paid by the clients, on their
hardware, isolated from each other. Afterwards the server runs S and the
clients run S speculatively — the same total, but the S server-side runs
land on one Worker per space, with no per-principal isolation boundary and
no implemented per-Worker budget (G18).

**This is the case to take to the owner**, because it is not a bug to fix:
it is the cost model changing owner. `map` is precisely this shape, which
is why it was the last residual. And the one-run-many-principals hope only
pays off for derivations that read no scoped state — which are already the
easy space-rank case that works today.

Two mitigations exist in the design and neither is built: multi-machine
sharding by space DID (README §6.6: "single-writer-per-space makes it
embarrassingly shardable"), and per-Worker budgets (G18). Neither is a
reason not to proceed; both are reasons to size the flag rollout per space.

## 6d. Exactly-once for effects gets strictly worse before it gets better
## — REAL, and it is a sequencing constraint

Today two things protect an effect: `externalSinkDisposition`'s
claim-conditional split, and the client's fail-open rerun when the claim
dies. The paired flip removes the second. Between slice 4 and the CP17
journal, an effect can be lost to a Worker death with no counter naming it.
`fetchProgram`'s `reopenClaimedWork` (`fetch-program.ts:279-290`)
deliberately re-egresses on a claim-incarnation change — correct today,
double-egress once two executors exist, and dead once claims go, leaving
no recovery at all. So 5b(3) is not optional decoration: **slice 4 must not
land before the journal or before an explicit, counted acceptance of the
gap.**

## 6e. What is NOT a good argument against it

- "The server cannot run child sub-patterns." It already does —
  `startWithTx` instantiation inside the Worker is what D2's roll-up
  exists to cover (`demand-closure.ts:5-14`).
- "Coverage is not closed yet." Coverage in the run sense is closed except
  for `streamData` and raw-`fetch` patterns. Coverage in the *commit-
  admission* sense is what is open, and that is the thing being deleted.
- "The claim mechanism gives us fail-open safety." Measured:
  `settlementsUnserved` = 0, `claimsRevoked` = 2 per arm (§5h.4). It is
  not carrying load.

---

# Appendix — three stale/dead things noticed in passing

1. **Orchestration §2.8's `llm` hole is CLOSED.** `llm.ts:812` passes
   `serverBuiltinId: "llm"`; `"llm"` is in `LLMServerBuiltinId`
   (`llm-client-options.ts:8-12`) and `SERVER_EXECUTABLE_BUILTIN_IDS`
   (`server-execution.ts:28`). §2.8 still reads as an open hole.
2. **§5h.4's six `dirtyProducer` line numbers have all rotted** by
   ~50 lines (see §1f's table).
3. **`ignoredSchedulingWrites` has no production producer at HEAD.** It is
   declared (`scheduler/types.ts:26`), reset per run
   (`runner.ts:4335`), and read by six consumers
   (`registration.ts:228`, `run.ts:852-855,916`,
   `persistent-observation.ts:157-164`, `servability.ts:696`,
   `action-transaction-router.ts:764,808`, `engine.ts:6031-6037`), but the
   only writer is `packages/runner/test/scheduler-effects.test.ts:456`.
   Either a producer was removed or it was never wired.
