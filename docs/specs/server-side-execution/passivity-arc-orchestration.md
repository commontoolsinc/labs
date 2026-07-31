# Server-primary passivity arc — build & orchestration plan

> ## READ THIS FIRST — owner, 2026-07-29
>
> **The claim thing needs to go. The server always needs to do the work.**
>
> **We run all scopes on the server.** A rank changing is not a reason to
> decline — "the rank changed" is an observation, never a refusal. If you find
> yourself making two rank computations agree so a claim key matches, stop:
> you are preserving the mechanism that is supposed to disappear.
>
> **Child sub-patterns must run on the server too. Punting to the client is
> NOT an option** — nothing else runs them.
>
> Every claim-arbitration failure class (`claim-key-mismatch`,
> `claim-authority-lost`, `claim-context-mismatch`, the R7 floor decline) is
> scaffolding for the mixed-ownership era. Do not build machinery that makes
> those declines *more correct*. Build toward not needing them.
>
> **Scope is DISCOVERED by running, not declared before it** (owner's
> inversion, and it is the design direction for `map`): rather than determine
> the required scope up front and run per principal/session, **run it as ONE
> principal/session and see what scope the result comes back at.** If it comes
> back at a broader scope, that is a win — the result is shared and the others
> need no run of their own. Only a genuinely narrow result requires per-
> principal runs. This is the same principle `scoped-cell-instances.md` already
> applies to write surfaces (output scope is discovered per transaction, not
> declared statically), carried over to scheduling.
>
> ### THE SURVIVAL TEST — apply it before starting ANY item
>
> Owner, 2026-07-29: *"we keep falling back playing whack-a-mole with the
> claim mechanism when we know we'll eventually delete that entire
> mechanism."* That is an accurate description of most of 2026-07-29's work,
> and the top box alone did not prevent it. So:
>
> **Before taking an item, ask: does this fix survive the deletion of claim
> arbitration?** If no, do not do it unless it unblocks something that does —
> and say which.
>
> Two kinds of machinery are tangled together here, and only one is going:
>
> | | goes with the claim mechanism | survives it |
> | --- | --- | --- |
> | what it is | deciding WHETHER to claim, and arbitrating between two executors | bounding what a run may WRITE, and who may read it |
> | examples | claim keys, claim-key-mismatch, claim-authority-lost, claim-context-mismatch, lease fences, the durable context floor as a claim GATE, candidate/claim-ready/settle | the §4 widening pair, lane scope admission, write envelopes, cross-principal leak prevention, `broad-lane-value-write` |
> | why | there is nothing to arbitrate once the server owns the space's closure | a cross-principal leak is wrong no matter WHO runs the action — C1 established the §4 pair is a base-runtime rule that predates lanes entirely |
>
> **HOW THE TEST GETS MISAPPLIED — one measured example.** Being *in* the
> claim/candidate pipeline is not evidence of being arbitration. The
> orchestrator read `candidateLaneKeys`' rank filter as arbitration polish
> and specified its deletion as slice 2; measurement refuted it (scope doc,
> Correction 3). The filter decides **which lane may own a write**, so it is
> write bounding and it survives — deleting it merely moved the rejection
> from a cheap pre-commit decline to the engine's exact-lane fence, turning
> 5 unserved / 28 committed into 75 unserved + 14 firewall rejects / 15
> committed.
>
> **Ask what the thing DECIDES, not where it lives.** Deciding *whether to
> claim* goes; deciding *what a run may write* stays.
>
> Scored against this test, 2026-07-29 was mixed: the sqlite acting-context
> seam, the provenance envelope rule, the ×12 §4 acceptance, the
> `pieceCreatedCallback` deletion, the `compileAndRun` outbox move and the
> `navigateTo` seam all **survive**. The `map` chase — R7's floor consult, the
> durable-floor sentinel, the CA9 question, the router `commitLane` residual —
> is **arbitration polish**. Its lasting value is the lessons (do not record
> per-run state as static; a counter that cannot NAME its offender is a dead
> end), not the fixes.
>
> **Corollary, and it is uncomfortable:** part of what wave G built may be
> scaffolding too. A descriptor serves two purposes — deciding claimability
> (goes) and bounding writes (stays). Do not assume a descriptor is durable
> just because it was hard to get right.
>
> ### THE TERMINAL CONDITION — how you know the gap is actually closed
>
> `externalSinkDisposition` (`storage/extended-storage-transaction.ts:369-379`)
> suppresses a CLIENT's egress **only when a server effect claim exists**;
> absent one it pins `executionEffectAuthority = "client"` and returns
> `"allow"`. So today, for every action in the never-claimed set, **the client
> performs the egress** — which makes D9's "control authority and quota on the
> server" claim-conditional rather than actual.
>
> The end state is **categorical**: a client never runs an egress effect, full
> stop. `allow` becomes the exception a server-side executor earns.
>
> That flip is also the **acceptance test for coverage**: it fails open today
> because an unclaimed effect must still happen. If you can flip the default to
> `suppress` and nothing breaks, the serving gap is closed by definition. Do
> not flip it before then — silent missing side effects are worse than
> duplicated ones.
>
> **THE OPERATIONAL TARGET, owner 2026-07-29: refusals to commit must reach
> ZERO.** *"What we'll see are refusals to commit and we need to get those to
> 0."* This follows from the deletion scope's load-bearing fact — the executor
> already RUNS the whole demanded closure, so the gap was never in producing
> results, only in **admitting** them. Every refusal is therefore work the
> server already did and then threw away.
>
> Concretely, drive to zero across all arms:
> `candidateUnservedByCode` + `actionFirewallRejects` + `commit-rejected:*`
> (the corrected gate, [client-passivity §5h.5](client-passivity.md)).
>
> **MEASURED 2026-07-29 — the two are DISJOINT, and I had claimed otherwise.**
> I wrote that "zero refusals is what makes the flip safe — the flip is the
> acceptance test, this is the thing being tested." A throwaway trial of the
> flip refutes it: **the gate did not move by a single digit** under the flip
> (flipped = control = baseline in every arm, identical composition), because
> the probes that produce the gate **contain no pattern effects at all.** The
> gate measures COMPUTATION ADMISSION; the flip acts on EFFECT DISPATCH. They
> are different surfaces, and driving one to zero says nothing about the other.
>
> So the terminal condition needs **its own instrument**: a gate probe that
> actually contains a pattern effect. Until that exists, "refusals → 0" is a
> real target but it is not evidence about egress.
>
> **AND THE FLIP IS NOT A ONE-LINER.** `externalSinkDisposition`
> (`storage/extended-storage-transaction.ts:366-372`) short-circuits only on
> `configured === "suppress"`; a configured `"allow"` falls through to the same
> default the flip changes. **The SERVER's permission to egress rides on that
> default** — so flipping it kills the executor's egress too (measured: 1 → 0
> releases at `executor-shadow-sink.test.ts:95`). Making "the server earned
> `allow`" expressible is a prerequisite, not a detail.
>
> Trial results, for scale: runner 1346 passed / **29 failed (123 steps)**,
> memory 840/0, integration probes green in both arms. **Zero executor, claim,
> pool, lease, routing or servability failures — and zero rendering effects
> broke.** Every failure is one shape: a post-commit effect never ran, so the
> result cell stayed `pending`. **The claim/executor machinery is not what
> stands between here and the terminal condition.**
>
> What does: making "the server earned allow" expressible; two R5 rows
> (`streamData` and `sqliteQuery` are absent from
> `SERVER_EXECUTABLE_BUILTIN_IDS` — only `sqliteDatabase` joined, and to the
> COMPUTATION list); `wish`'s egress, which bypasses the gate entirely
> (`wish.ts:1266`) so the flip cannot make the categorical statement true; and
> a gate probe containing a pattern effect.
>
> Full rationale: decision **D11** in
> [`client-passivity.md`](client-passivity.md) §6b, §5h.4.

**Live plan.** The orchestration companion to this directory's design docs
([`README.md`](README.md) — the original spec), the phase plan
([`implementation-plan.md`](implementation-plan.md)), the lattice register
([`context-lattice-execution.md`](context-lattice-execution.md)) and the
current arc's plan+evidence log
([`client-passivity.md`](client-passivity.md), whose §0 is START-HERE).
Those say WHAT and WHY; this says WHO BUILDS IT AND IN WHAT ORDER. Keep §1
accurate as work lands; archive to `docs/history/` per
[`docs/README.md`](../../README.md) when the arc completes.

**Goal of the arc (owner, 2026-07-28):** everything reactive runs on the
server. Client-side execution of reactive functions becomes *purely
speculative* — the client may compute for its own rendering but never commits
anything except handler/event-driven writes. Design rationale, including the
three motivations that make this worth its cost, is
[README §1 / §4 Q3](README.md) and decisions
D8–D10 in [client-passivity §7](client-passivity.md).

**Why this file exists.** The arc is months of work across many context
windows. This file is the orchestration script: it carries the state, the
hard-won knowledge that is expensive to rediscover, and a pre-written
delegation prompt per work item so a fresh context can drive the whole thing
without re-deriving any of it.

---

## 0. If you are resuming — do exactly this

1. Read **§1 State** (short). It names the next wave.
2. Read **§2 Standing knowledge** (short). It is the stuff that costs hours to
   rediscover and minutes to read.
3. Read **§3 Rules of engagement** — specifically which items must NOT be
   delegated.
4. For the next wave's items: dispatch each item's **verbatim prompt** from §4
   as a subagent, in parallel where the item says `parallel: yes`.
5. As each returns: run the item's **Verify** line YOURSELF. Do not accept a
   subagent's claim of success — run the command. (Agents in this repo have
   reported green while leaving a gate red.)
6. Commit per item (not per wave), update §1, push.
7. When a wave's gate in §5 is met, move to the next wave.

**Do not** start a wave whose §5 gate is unmet, and do not batch several items
into one commit — per-item commits are what make a partially-complete wave
resumable.

---

## 1. State

**Branch:** `codex/server-execution-w1-2-shared-pool` (LABS repo).
**Last landed:** `e32a46e26` — three claim-shaped lease fences DELETED
(`claim-arity`, `claim-expired`, `claim-lease-generation`); `claim-not-live`
kept for a measured cross-principal reason.

Earlier, most recent first: `ab948050b` the terminal-condition trial;
`8de47f7e3` all of §2b, so every survivor has a claim-free carrier;
`2663771ec` navigateTo's seam + rank-containment invariant; `3a48d6731`
demand-closure roll-up makes child sub-patterns servable. **Keep this line
current — it is the resume pointer, and it has rotted three times. Edit it by
hand; a `sed` on this line broke the file once.**

**ALL OF §2b IS LANDED (2026-07-29).** Every survivor of the survival test now
has a claim-free carrier, and the lease holds the single-executor guarantee in
its own right. **The fence deletions are unblocked.**

| §2b row | landed as |
| --- | --- |
| write firewall off `provenance` | `5aa63e6d3` (+ batch-path hole closed in `1ac795d52`) |
| acting lane for scope resolution | `768aab2dc` (slice 1) |
| write re-resolution + lane liveness | `1ac795d52` — a UNION query, not the swap §2b described |
| §4 pair emission | `7b932b6f3` — `actingRank ?? contextRank`, a strict superset |
| overlay drop | `2d5eac421` — family-keyed; fixed a live flicker at HEAD |
| pool sponsor re-anchor | `8de47f7e3` — lease-level authority loss |
| single-executor guarantee | `63a5a32ca` — lease promoted, `lease-unbounded-commit` added |

**THE LESSON FROM §2b, and apply it to whatever the scope doc says next:
FOUR of its seven rows carried a FAIL-OPEN in the paper design**, plus §1d
misclassified `lease-stale` as deletable when the promotion depends on it.
§2b was an excellent map of WHAT to move and an unreliable guide to HOW,
failing consistently toward silence. Every one was caught the same way — by
measuring **what the change stops rejecting**, not what it starts doing.
Treat every remaining row as guilty until measured.

Also: §2a shipped a superset proof over CALL SITES that missed a path which
never populated the new required input, silently unguarding batched commits.
**A superset argument over call sites is not enough when the new precondition
has its own population path.**

**Next up:** (1) delete the claim-shaped fences now that the lease carries
them — `claim-arity` (subsumed by the new `lease-unbounded-commit`),
`claim-expired`, `claim-lease-generation`, `claim-not-live`; **do NOT delete
`lease-stale`, `leaseOwnerMatches` or `leaseGeneration`** — they are carriers,
not arbitration. Then (2) the TERMINAL CONDITION in the box above: flip
`externalSinkDisposition`'s client default to `suppress` and see whether
anything breaks.

**Deliberately stopped, not finished:** the `map` chase is closed as
arbitration polish — one router residual from served, and that residual does
not survive the deletion.

The work is now the deletion itself: **replace per-action claim arbitration
with blanket server ownership of a space's demanded closure.** Under that model
there is nothing to arbitrate, so the whole
candidate→claim-ready→claim→settle→fence pipeline has no referent, and
`map`'s four events disappear rather than being fixed.

Sequence: (1) scope what blanket ownership means concretely and what it deletes;
(2) close whatever coverage it genuinely needs — noting that "coverage" changes
meaning, since classification exists to decide *whether to claim*; (3) the
categorical egress flip as the acceptance test.

Measure throughout with the CORRECTED gate in
[client-passivity §5h.5](client-passivity.md) — `candidateUnservedByCode`
**plus** `actionFirewallRejects` **plus** `commit-rejected:*`, quoted beside
`settlementsCommitted`. The old gate counted only unattempted work and scored a
tightening as a regression.

> **REORDERED 2026-07-29 by owner ruling D11** (client-passivity §6b).
> The claim mechanism is **transitional scaffolding**, not the end state.
> The server should end up running every derived computation, at which
> point there is nothing to arbitrate. **Closing the serving gap is now
> the highest priority**, and suppression machinery is machinery we will
> delete — so build as little of it as possible.

| Wave | What | Status |
| --- | --- | --- |
| A | R5/R13 effect rows — brokers, descriptors, `wish` | **DONE** |
| A5 | sqlite lane-scoped read seam (D2 narrowed to reads) | **DONE** — writes stay client-primary |
| B | measurement | **DONE ×2** — zero after A; **×12 cleared** after the scope fix |
| C | C1 ruled SURVIVES; C2 negotiates end to end | **DONE** |
| P2x | the ×12 — diagnosed AND fixed | **DONE** — first never-claimed reduction |
| **G** | **CLOSE THE SERVING GAP** — every derived computation runs server-side | **IN PROGRESS, HIGHEST PRIORITY** — see the table below |
| D | P3 passivity mechanism | **DEFERRED** — designed ([`wave-d-passivity-mechanism.md`](wave-d-passivity-mechanism.md)) but premised on claims persisting; D11 supersedes its Q1/Q2/Q3. Revisit only if G stalls |
| E/F | P5 passive delivery + warm spaces; P6 acceptance | after G |

**Already landed this arc (for context, do not redo):**

- `565a06916` CA4 audit + two rank-dial probes + §5g memo.
- `3d659cb14` group-chat SERVED in the gate topology; three-arm ladder;
  `non-space-read-scope` 33 events / 19 offenders → 1 → 0.
- `9caf341e2` R7 diagnosis.
- `dbb5fc86c` R7 fix — issuance-side context-floor consult; fences 2 → 0 → 0.
- `91434cc6d` spec motivations + R5 worklist.
- `b058731e1` this orchestration plan.

**Wave G — the serving gap, as measured today.** This is the worklist.
Everything here is a reason some derived computation cannot run on the
server; closing them all is what makes the claim mechanism unnecessary.

| Blocker | Status | Note |
| --- | --- | --- |
| `wish` | **DONE** `b3304e771` | Owner accepted the egress (idempotent GET of our own API). W2.15a descriptor; classifies claim-ready. A4's pins updated, not deleted |
| `llmDialog` | **DONE** `b3304e771` | Effect route. Turn starts from DOCUMENT state, so a client handler's append is an ordinary doc change. Four-doc surface (A3 said three — verify, don't trust) |
| `sqliteDatabase` | **DONE** `adf1e3dfe` + `5fea987a5` | Owner from the acting lane via the read-only `actingExecutionLane`; then its descriptor, once a minted-document declaration was made to implicitly cover the provenance meta paths `["result"]`/`["pattern"]` (`provenanceMetaWriteEnvelopes` in `scheduler/run.ts`). That rule generalizes to every computation-shaped minter. Materializer route declined — it changes scheduling, not just the write surface |
| `navigateTo` | **RATIFIED, BLOCKED** | [`navigate-to-server-side.md`](navigate-to-server-side.md). Owner gates 1 and 2 ruled: interim scope is "all sessions of the issuing principal", and the design splits at a seam — decision server-side, actuation a client rendering effect, the message IS the seam. **§8: gate 4 FIRED.** `addExecutionDemand` has one call site (in `start()`), and the commit-gated deferred navigate root reaches `startWithTx` instead, so its piece is never demanded and cannot be claimed at session rank. Blocking question: does demand closure-growth cover a deferred root? |
| `compileAndRun` | **UNBLOCKED** `5f5d3ffe0`; servability in flight | Owner ruled the `manager.add([piece])` coupling out entirely and `pieceCreatedCallback` was deleted (12 sites). The ruling was sharper than it looked: `PieceManager.add` never pushed to `allPieces` — it pulls the default pattern's `addPiece` STREAM and sends, so the callback was already on the sanctioned route and only the CALLER was wrong. One accepted behavior delta: `fetchAndRunPattern` outputs no longer auto-register, so they leave the backlinks index and `getPieces()`; that capability moves to the pattern author's `addPiece` send. **Three earlier readings of this row were wrong** — "unbounded async writes" (`llm` is async and serves; `sqliteQuery` writes post-commit through a gate), then "same problem as navigateTo" (the callbacks differ in kind — owner caught it), then "move the registration server-side" (owner: delete it). Open: whether it needs a descriptor, and whether `runSynced`'s spawned-pattern writes are attributed to it or to the spawned actions |
| `map` — `claim-key-mismatch` ×2, `claim-authority-lost` ×2 | **NOT SERVED. One question away** | Two independent causes were found and one is fixed. FIXED (`3a48d6731`): child sub-pattern actions could never be scoped candidates because scoped candidacy was piece-filtered against demand ROOTS — now rolled up to the root's closure, which nearly doubled committed settlements (session arm 15 → 28). REMAINING: `map`'s durable floor is `session` while the executor classifies it `user`, and **CA9's rank filter forbids a user-rank action from candidating at a session lane**, so no session proposal is possible. **The single open question: is CA9's thrash finding still real, given CA3 admits a user-rank action's READS on a session lane?** Do NOT answer it by reconciling the two rank computations so a claim key matches — see the box at the top of this file. The rank oscillates because the "static" summary folds each run's observed read log (`scheduler/run.ts:1428-1436`); per §5h.4 that is an observation, and scope is discovered by running |
| `malformed-output-surface` ×1, `non-space-read-scope` ×1 | **CLOSED** `cf09a186b` | **NOT cross-space** — my C3.6 attribution here was wrong, inferred from the sibling code name `foreign-read-access-denied` without checking. Both observations measure `foreignSpaceReads: 0` in a single-space fixture. They survived a wave undiagnosed because `recordExecutionCandidateUnserved` dedupes offenders by implementation fingerprint and cannot NAME them; the probe now records derivation keys. `non-space-read-scope` ×1 is correct behavior (a session-scoped read is admissible only at session lane rank). `malformed-output-surface` ×1 was the `c2cc3891e` relabel left half-applied — a rescue branch gated `laneRank === "space"`, so a SESSION twin outside a user lane's chain fell through to a shape complaint for a rank-admission fact. Label-only fix; user arm goes `{malformed:1, non-space-read:1}` → `{non-space-read:2}`, same total |
| `dynamic-sqlite-operation` | **NOT A BLOCKER** | Handler-only, so inside the goal per D2-as-amended |
| `event-handler` | **NOT A BLOCKER** | Client-inherent; P5 sends the EVENT instead of the commit |

**Known-open — CURRENT as of `e32a46e26` (2026-07-29). Closed items are
removed, not archived here; §6's Log is the history. This list has rotted
three times — prune it, do not append to it.**

**The measured distance to the TERMINAL CONDITION** (from the throwaway flip
trial; details in the top box). Under a categorical client-egress flip:
runner 1346 passed / 29 failed (123 steps), memory 840/0, integration probes
green — with **zero executor, claim, pool, lease, routing or servability
failures, and zero rendering effects broken.** Every failure is one shape: a
post-commit effect never ran, so the result cell stayed `pending`. **The
arbitration machinery is NOT what stands between here and the end.** Four
things do:

1. **Make "the server earned `allow`" expressible.** `externalSinkDisposition`
   (`storage/extended-storage-transaction.ts:366-372`) short-circuits only on
   `configured === "suppress"`, so a configured `"allow"` falls through to the
   same default the flip changes — flipping it kills the EXECUTOR's egress too
   (measured: 1 → 0 releases at `executor-shadow-sink.test.ts:95`).
   Prerequisite for the flip, not a detail.
2. **Two R5 rows.** `streamData` and `sqliteQuery` are absent from
   `SERVER_EXECUTABLE_BUILTIN_IDS`. Note `sqliteDatabase` joined the
   COMPUTATION list, which is a different thing.
3. **`wish`'s egress bypasses the gate entirely** (`wish.ts:1266`), so the flip
   cannot make the categorical statement true even once it works. Owner ruled
   the system-pattern load a special case needing no quota; the eventual fix is
   to load from disk server-side.
4. **A gate probe containing a pattern effect.** The corrected gate and the
   flip are DISJOINT surfaces — today's probes contain no pattern effects, so
   the gate cannot see egress at all.

**`claim-not-live` is the last claim-shaped fence, and it is LOAD-BEARING.**
Kept in `e32a46e26` after measurement: deleting it lets an unprivileged client
forging an `executionClaimAssertion` that names ANOTHER PRINCIPAL'S user lane
commit into that principal's instance. Its `unservedAttempt` leg has no carrier
at all. Deleting it needs one built first — authorising a LANE ASSERTION as
such, independently of any claim. **Its own slice; do not fold it in.**

**Other open items:**

- **Cross-space reads must be supported** (owner). Not yet exercised by any
  fixture; the user-arm residual that looked like this turned out to be the
  §4 relabel left half-applied (`cf09a186b`), so this is genuinely untested
  rather than partly done.
- **CP6's refutation is re-opened.** `llmDialog`'s KIND is now known to be
  effect and it runs server-side (`b3304e771`); whether it performs *double*
  egress was never re-measured after the kind changed. Needs a measurement.
- **Two-hop redirect, space → session via a user scope** (owner follow-up).
  The intermediate user-scoped doc may stay user-scoped for some principals
  and narrow for others, so a single redirect is not obviously convergent; the
  safe form is space → user → session, needed only when the path went through
  a user scope. See `claim-deletion-scope.md` header, Correction 1b.
- **`map` is one router residual from served** — deliberately NOT finished,
  because that residual is arbitration polish that does not survive the
  deletion. Do not resume it as a target.
- **Two instrument defects**, both found by downstream surprise rather than by
  the instruments failing: the C1.9 client-side `session.transact` commit tap
  read ZERO derived wire writes on a run where the server attributed those
  exact revisions to those sessions (C1.9 criterion (b) and C2.9 §7(b) both
  rest on it); and `recordExecutionCandidateUnserved` counts offenders by
  fingerprint and cannot NAME them, which hid the `map` residual for a full
  wave. **A counter that can read zero when the thing happened is worse than
  no counter.**
- **`data-model`'s `FabricError` codec test fails at MAIN** (`aac9bd3dc`) and
  is the only battery failure. Not this branch — `data-model` is clean and
  imports neither `runner` nor `memory` — and it passed here earlier the same
  day, so it is environmental. Do not attribute it to arc work.

---

## 2. Standing knowledge — do not rediscover

Everything here was paid for once. Subagent prompts in §4 tell the agent to
read this section; keep it accurate.

### 2.1 Getting the executor to actually serve

The `SharedExecutionPool` **does not wake an executor that is already live** —
`#acceptAcceptedCommit` in `packages/runner/src/executor/shared-execution-pool.ts`
returns early on `slot.executor !== null`. Its wake path exists to start or
unpark a Worker, never to drive one. And `set-demand` only *enqueues* the
structural swap; activation completion is observable **only** through
`settle()`.

A fixture that starts a pool and then drives clients gets a live Worker
holding its lanes and running nothing (`schedulerRuns: 0`). Drive the Worker's
`settle()` / `wake()` / `settle()` fixpoint explicitly. Worked examples:
`packages/runner/test/server-execution-rollout-products.test.ts` and
`packages/patterns/integration/server-execution-group-chat-user-rank-probe.test.ts`.

### 2.2 CFC patterns in loopback fixtures

- Loopback gate clients need a `trustSnapshotProvider` on the Runtime, or the
  first commit fails `cfc-relevant-transaction-not-prepared`. The harness's
  `openGateClient` does **not** supply one — see `openProbeClient` in the
  group-chat probe for the shape.
- Trusted handlers (group-chat `saveProfile`, `sendTrustedMessage`,
  `addTrustedRoom`) require a DOM-provenance event marked with
  `markRendererTrustedEvent` from `@commonfabric/runner/cfc`. Without it the
  writes are **silently dropped** with a warning and the fixture measures an
  unused piece. Copy `trustedEvent(surface, action)` from the group-chat probe.
- A session bound to the executor lease (`bindExecutionSession`) may not emit
  unclaimed observations. Use a second, unbound client for anything that must
  look like an ordinary client run.

### 2.3 Test topology

- `deno task test` (root) iterates workspace packages. It **does not** run
  `packages/patterns/integration` — that is
  `deno task integration` → `./integration/*.test.ts` with `--trace-leaks`.
- `packages/runner`'s `test` task runs `test/*.test.ts`, so runner probes DO
  ride the root battery.
- Every Worker-spawning test must run inside `withExecutorTeardownBarrier`
  (FW7) or `--trace-leaks` sanitizers flake at teardown.
- `docs/` is excluded from `deno fmt` (see root `deno.jsonc` `fmt.exclude`) —
  hand-wrap markdown at ~72 chars to match.

### 2.4 Known flaky gate — do not chase

`packages/patterns/integration/server-execution-cross-space-gate.test.ts`
fails its 60s `waitForCondition` barrier intermittently under load.
**Measured 3/6 failures at clean HEAD with zero local changes.** If it fails,
re-run it before believing it; it deserves its own barrier fix, which is not
part of this arc.

### 2.4c Second known flaky gate: `iframe-sandbox` — and a trap in diagnosing it

`packages/iframe-sandbox` runs its tests in a real browser
(`deno-web-test` → `vendor-astral` → Chrome). Under load it fails with
`RetryError: Retrying exceeded the maxAttempts (5)` caused by
`TimeoutError` inside `Page.evaluate`. Measured 2026-07-29: **failed
twice at load 26 and 60, passed at load 86**, then passed in BOTH arms of
an adjacent A/B at load 32-48. It is load-sensitive, not change-sensitive.

**The trap, which the orchestrator fell into and should not be repeated.**
`iframe-sandbox` DOES import from `runner`
(`src/ipc.ts:1`, `type JSONSchema`), so when a runner-only change set is
in the tree it is entirely plausible that a runner edit broke it. Two
dirty failures and one clean pass — at a HIGHER load than the failures —
looked like proof of causation, and it was not. The clean-pass-at-higher-
load reasoning felt rigorous and was still wrong, because the runs were
not adjacent.

**§2.5's "compare arms only in adjacent pairs" is the rule that catches
this.** Run dirty and clean back to back in one load window before
attributing anything. Doing that here refuted the causation claim
outright.

### 2.4f Third timeout-barrier gate: `executor-scoped-egress-e2e` — and what is NOT yet excluded

`packages/runner/test/executor-scoped-egress-e2e.test.ts` races a pending
promise against a **30 s timeout** (`timeoutMs = 30_000`,
`Promise.race([pending, timeout])` at `:137-152`). Same family as §2.4's
cross-space gate and §2.4c's `iframe-sandbox`: it can breach the barrier
under the battery's 37-package concurrency while passing alone.

Measured 2026-07-29: its two C2.8 e2e cases **failed inside a battery run**
(in which `iframe-sandbox` also failed) and then **passed 4/4 in isolation at
loads 188-225** — far above the load at which the battery failed. Failure
mode is `AssertionError: no broker egress`, with the event log showing the
claim set and the settlement committed, i.e. the wait expired rather than the
mechanism breaking.

**What is NOT established, and must not be glossed:** nobody has run the
battery at a BASELINE commit under comparable contention. So "my changes did
not slow this path enough to breach a 30 s barrier" is untested. The
provenance-envelope expansion (`5fea987a5`) adds two envelope entries per
minted document to every computation descriptor — if that lands on a hot
path, a timing regression is a live hypothesis, not a dismissed one.

**Do not conclude non-causation from isolation passes alone.** That is the
inverse of the §2.4c error and equally unsound: isolation removes the very
contention that produces the failure. The discriminating experiment is a
battery at baseline versus a battery at HEAD, **adjacent**, on a quiet box.

### 2.4d `deno task test` can exit 0 on a RED battery

Measured 2026-07-29: the root battery printed `One or more tests failed.`
/ `Failed packages: - iframe-sandbox` and the harness still reported exit
code 0. **Never trust the exit code alone.** Grep the captured output for
`All tests passing!` and for `One or more tests failed`, and count
`(ok)` lines against the expected package count (37 at the time of
writing). A red battery reporting success is exactly how a broken change
reaches a push.

### 2.4e The pre-commit hook also validates the wrong worktree — and MUTATES it

Same root cause as §2.5c's stop hook, but this one **blocks commits**.
`.claude/scripts/pre-commit.ts` runs fmt/lint/check against
`$CLAUDE_PROJECT_DIR` — the session's cwd checkout — not the worktree being
committed to. Measured 2026-07-29: it blocked a commit to this branch over
the `require-await` error at `executor/executor-worker.ts:1072` **on branch
`claude/fervent-bhabha-c8678b`**, which `a34c15fd2` fixed here long ago.

Worse: it runs `deno fmt`, not `deno fmt --check`, so it has been **silently
reformatting that other checkout** — 11 files of pure line-rewrapping churn
accumulated there this session, which subagents had earlier reported clean.

**Workaround, owner-authorised 2026-07-29:** commit with `--no-verify` and
say so in the commit message. Verify fmt/lint/check yourself in the correct
worktree first — `--no-verify` skips a real gate, so replace it, do not
merely bypass it.

**The real fix is to scope the hook to the worktree being committed to**,
which also stops it writing to a checkout nobody is working in. Not this
arc's work, but worth doing: any CI relying on it inherits both defects.

### 2.4b The fmt/lint gate — measured on BOTH sides, attribution settled

Measured by the orchestrator in detached worktrees with empty `git status`:

| | `deno fmt --check` | `deno lint` |
| --- | --- | --- |
| main `aac9bd3dc` | 26 unformatted / 2128 files | **clean** |
| branch `b058731e1` | 22 unformatted / 3735 files | **1 problem** |

**The lint error was ARC DEBT, and is now FIXED** (`a34c15fd2`). main is
lint-clean; `require-await` at
`packages/runner/src/executor/executor-worker.ts:1071` arrived on this branch
with `d28092a64`. The `async` keyword is load-bearing — `enqueue<T>` requires
`() => Promise<T>` — so the fix was a `// deno-lint-ignore require-await`
carrying a reason, NOT deleting the keyword. Note the directive must sit on
the line IMMEDIATELY before the code: a multi-line explanation above it breaks
the suppression and adds an unused-directive error, taking the count 1 → 2.

Both gates are green on this branch as of `57e625424`. **A new fmt/lint
failure is now yours** — but re-check your own files individually before
believing the stop hook, which runs repo-wide and can transiently catch
another agent's in-flight write.

**The fmt drift is on both sides and they are different sets.** All 22 on the
branch are in branch-modified files, so the arc introduced those; main
separately carries 26 of its own. Two distinct cleanups; do not conflate them,
and do not let "main is dirty too" excuse the branch's 22.

**Do not run repo-wide `deno fmt` mid-wave** — it rewrites files other agents
have open, which is the whole-file-clobber hazard §3 warns about. Take the
branch's fmt cleanup as its own commit on a quiet tree (all agents reported),
and keep it separate from any behavioral commit so the mechanical reformat
stays reviewable.

**Beware the dirty-tree reading.** Mid-wave, two of the 22
(`packages/runner/src/runner.ts`,
`packages/runner/test/executor-action-router.test.ts`) sit in the working set,
so it looks like the agents caused it. They did not — every subagent in this
wave independently checked and reported this correctly.

### 2.5 Measurement discipline (mandatory — see client-passivity §0)

Fresh store per run (`rm -rf packages/toolshed/cache` after stopping the
offset-750 servers); kill leftover `ms-playwright` browsers; record load
average; full-capture harness output (never `tail`); curl
`/api/health/stats` in the same command right after the harness exits;
compare arms only in **adjacent pairs**; real-Worker e2e one file per `deno`
invocation; engagement counters on every number or it reads "not engaged".

**Load matters.** This box has run at load 18–34 during this arc. Counts and
set relations are load-insensitive; latencies are not. Do not quote a latency
taken above load ~5.

### 2.5b Two traps that silently return the wrong answer

- **`grep` treats `packages/memory/v2/engine.ts` as BINARY** and prints
  nothing rather than erroring. Plain `grep -c sqlite engine.ts` returns
  empty; `grep -ac` returns 18. Use `grep -a` on that file or you will
  conclude, wrongly, that the biggest file in the memory layer has no
  handling for whatever you searched. (Found by A5, reproduced by the
  orchestrator.)
- **`git add docs/` is too broad while agents are running.** It sweeps
  concurrent agents' doc edits into an unrelated commit — this happened to
  `0ad293c2b`, which silently carries C2's `EXPERIMENTAL_OPTIONS.md` work
  under a commit message about something else. Stage explicit paths.

### 2.5c The stop hook validates the WRONG worktree — warn every subagent

Measured across all six subagents in this arc: **every one of them** burned
significant effort investigating a stop-hook failure it did not cause.

`.claude/scripts/subagent-stop.ts` runs `deno fmt --check` / `deno lint` /
`deno task check` against **the session's cwd checkout**, not the worktree the
subagent was assigned. In this arc that is
`/Users/berni/labs/.claude/worktrees/fervent-bhabha-c8678b` (branch
`claude/fervent-bhabha-c8678b`, HEAD `81662f0b5`, clean tree) rather than
`/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`. Its
type errors — `actionId` missing on `watchReactiveActionCommit` in
`scheduler-cfc-trigger-reads.test.ts` and `scheduler-retries.test.ts` — were
fixed on the arc branch long ago and persist on that one.

It also runs repo-wide, so mid-wave it additionally catches sibling agents'
in-flight writes.

**Put this in every subagent prompt:** the stop hook's verdict is not a gate
for work in `.agents/worktrees/`; check your own changed files individually
(`deno fmt --check <files>`, `deno lint <files>`, `deno check <files>`) and
believe that instead. Without the warning each agent spends tokens
re-deriving it, and one of them may "fix" a file it does not own.

### 2.6 Comparing action ids across arms

Action ids read `cf:module/<hash>:<lift>:<instance>`; the trailing instance
segment is minted per Runtime, so raw ids are **not** comparable between two
arms that each build a Runtime. Normalize to the derivation key
(first three colon-segments). See `derivationKey` in
`packages/runner/test/server-execution-group-chat-rank-probe.test.ts`. Getting
this wrong makes every cross-arm set relation vacuously zero.

### 2.7 The R5 mechanism (how a builtin becomes server-executable)

1. `packages/runner/src/builtins/server-execution.ts` —
   `SERVER_EXECUTABLE_BUILTIN_IDS` is the exact allowlist of effect builtins
   the server may execute. Membership is what earns the `:server-v1`
   implementation fingerprint (`serverBuiltinImplementationHash`).
2. `packages/runner/src/runner.ts:~5134` stamps that fingerprint; a canonical
   builtin outside the set instead gets `builtinImplementationHash` (`:v1`)
   and then rejects until a descriptor exists. **Which rejection depends on
   the KIND, and this doc named only one arm until 2026-07-29:** a
   *computation* rejects `incomplete-static-surface`; an *effect* with no
   assembled summary rejects **`unknown-effect-surface`**
   (`scheduler/servability.ts:382-388`). Grepping for the computation code
   while chasing an effect row finds nothing and reads as "not classified at
   all". (Caught by the navigateTo design.)
3. `packages/runner/src/runner.ts:~5244` mints the
   `ServerBuiltinActionDescriptor` **generically** from `serverBuiltinId` —
   so adding an id to the allowlist gives it a descriptor automatically from
   `inputCells` / `schedulingWrites` / `serverBuiltinRuntimeWrites`.
4. Computation builtins use the parallel
   `SERVER_COMPUTATION_BUILTIN_IDS` / `ServerBuiltinComputationDescriptor`
   (currently `ifElse`, `when`, `unless`) and the
   `serverBuiltinComputation` branch at the same site.
5. Kind pins live in `packages/runner/test/builtin-effect-registry.test.ts`
   (static, no Runtime): a builtin performing egress must register
   `isEffect: true` and appear in its id list.
6. **A builtin's registration is not its kind.** `runner.ts:5304` resolves
   `module.isEffect ?? builtinIsEffect` — the FACTORY's return wins over
   `index.ts`. `llmDialog` (`llm-dialog.ts:3219`) and `navigateTo`
   (`navigate-to.ts:121`) both `return { ..., isEffect: true }`, so they are
   **effect** nodes at runtime no matter what `addModuleByRef` says.
   Consequence for W2.15: never give them a computation descriptor —
   `serverBuiltinComputationScopeSummary` returns undefined unless
   `observation.actionKind === "computation"`, so the descriptor would mint
   and then never assemble. Pinned by "builtins whose factory declares
   isEffect are effect nodes regardless of the registration source" in the
   same file.

**CORRECTION (2026-07-28, A3).** An earlier revision of this plan asserted
"`llmDialog` is CONFIRMED a computation — CP6's egress claim was REFUTED."
**That was wrong**, and it came from a test comment that was itself wrong: the
"llmDialog stays a computation" assertion only regex-parses `index.ts`
registrations, so it is green while the effective kind is the opposite. This
is the exact failure mode §0 step 5 warns about — a green test asserting a
false thing — so it is worth remembering that it occurred inside this arc's
own standing knowledge. **CP6's refutation is re-opened and is owner-gated:**
the claim was that `llmDialog` performs no direct egress. Its *kind* is now
known to be effect; whether it performs *double* egress is a separate
question that nobody has re-measured.

### 2.8 The `llm` hole — CLOSED by wave A1; this section is history

**Superseded 2026-07-29.** At HEAD `llm.ts:812` passes
`serverBuiltinId: "llm"`, `"llm"` is in `LLMServerBuiltinId`
(`builtins/llm-client-options.ts:8-12`) and in
`SERVER_EXECUTABLE_BUILTIN_IDS`. Wave A1 (`cfa827f82`) closed it. The text
below described the hole as OPEN for a day after it was fixed — the eleventh
stale self-assertion this arc has caught, and the second inside its own
planning docs. Kept for the mechanism it explains, not as a live gap.

### 2.8 (historical) The `llm` hole as originally diagnosed

- `packages/runner/src/builtins/llm.ts:68` `llmClientOptions(runtime, space,
  serverBuiltinId?: "generateText" | "generateObject")`.
- Line ~79: when running server-side (`runtime.hasServerBuiltinFetch()`) and
  `serverBuiltinId === undefined`, it **throws**
  `"unsupported LLM builtin has no server broker route"`.
- The shared tool loop is `executeWithToolsLoop` (`llm.ts:377`), whose
  `serverBuiltinId` param is declared at `:391` with the same narrow union.
- `generateText` passes `serverBuiltinId: "generateText"` at `llm.ts:1183`.
- **The `llm` builtin's own call at `llm.ts:810` passes nothing** — that is the
  hole. `llm` is registered `isEffect: true`
  (`packages/runner/src/builtins/index.ts:73`) and already listed in the
  registry test's `OTHER_EFFECT_IDS`, but it is absent from
  `SERVER_EXECUTABLE_BUILTIN_IDS`.
- The broker route itself is `runtime.fetchBuiltin(serverBuiltinId, path, url,
  init)` (`packages/runner/src/runtime.ts:2074`), reached through
  `createInternalLLMBrokerRequestOptions`. Test scaffolding for it:
  `packages/runner/test/runtime-host-for-space.test.ts:123`
  (`describe("Runtime.fetchBuiltin")`).

### 2.9 R7 (landed — context for anyone touching claim issuance)

Claim rank and the engine's effective context are computed by two different
functions; only the engine's saw the durable, monotonic
`scheduler_context_floor`, which an ordinary **unclaimed client run** can pin
to `user`/`session`. The host now consults it at issuance
(`#assertExecutionClaimContextFloorAdmits`, `packages/memory/v2/server.ts`) and
declines a claim broader than the floor. The engine fence remains the backstop
for the issuance→commit race. Full write-up: client-passivity §5g.

**Relevance to the arc:** this class of bug is a *transition artifact*. It
exists only because two executors write the same durable state. Expect more of
them while both sides run, and expect them to disappear at P3 — that is an
argument for crossing rather than lingering.

---

## 3. Rules of engagement

### Delegate (subagent)

- Well-scoped builds with a named acceptance test.
- Investigations with one specific question and a written deliverable.
- Test authoring against an existing fixture family.

Use `general-purpose` unless the item says otherwise. Dispatch items marked
`parallel: yes` in a single message with multiple tool calls.

**Cap: at most THREE subagents in flight at once** (owner, 2026-07-28) — the
5-hour quota is a real budget and a wide fan-out burns it. `parallel: yes`
means "may run alongside others", not "dispatch all of them now". When a wave
has more than three parallel items, dispatch the highest crossing-weight three
(CP10) and hold the rest until a slot frees. A second reason to prefer three:
every parallel item shares one worktree, so each extra agent adds edit-collision
and test-interference risk on the shared registry files.

**When parallel items share a file** (wave A: `server-execution.ts`, and the
zero-verdict pin in `server-execution-product-fixtures.test.ts`), add to each
prompt: use anchored `Edit`s and never whole-file `Write`s on a shared file;
never `git checkout`/`stash`/`commit`; keep test runs narrow; and check
`git diff --stat` before chasing a failure that looks unrelated. Without that
clause the likeliest wave failure is not a bad build — it is one agent
debugging another's half-applied edit.

### Do NOT delegate — do these yourself

- **Measurement runs.** The protocol in §2.5 is easy to violate and a violated
  run produces confident wrong numbers. Every number that reaches a spec is
  taken by the orchestrator.
- **Owner-gated decisions** (anything the plan marks owner-gated; the D-series
  in client-passivity §7).
- **Commits, commit messages, pushes.** The narrative is the deliverable.
- **Accepting a result.** Always run the Verify line yourself.
- **Spec edits to `docs/specs/server-side-execution/*`.** Subagents may draft
  into a scratch file; the orchestrator lands the wording.

### Subagent prompt contract

Every prompt in §4 already contains this; keep it if you write new ones:

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2 (standing
> knowledge) — it will save you hours.
> Do NOT commit, do NOT push, do NOT edit anything under
> `docs/specs/server-side-execution/`. Report: files changed, the exact test
> command that proves it, and anything you found that contradicts §2.

---

## 4. Work items

### Wave A — R5/R13 effect rows

Priority is **crossing-weighted per CP10**: a mid-chain unservable strands
everything downstream, so it outranks a leaf with higher raw incidence.
Register row: `docs/specs/server-side-execution/context-lattice-execution.md`
§8 R5 / R13.

---

#### A1 — `llm` effect broker · parallel: yes

**Goal.** `llm` becomes server-executable, like `generateText` already is.

**Verify (run yourself):**
```bash
deno test -A packages/runner/test/builtin-effect-registry.test.ts packages/runner/test/builtin-implementation-hash.test.ts packages/runner/test/runtime-host-for-space.test.ts
```

**Prompt:**

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2 — especially §2.7
> (how a builtin becomes server-executable) and §2.8 (this exact hole, already
> diagnosed; the line numbers are current).
>
> TASK: give the `llm` builtin a server broker route, exactly as `generateText`
> has one. The diagnosis in §2.8 is complete — you should not need to
> rediscover it. Expected shape: add `"llm"` to `SERVER_EXECUTABLE_BUILTIN_IDS`;
> widen the `serverBuiltinId` unions in `llmClientOptions` and
> `executeWithToolsLoop`; pass `serverBuiltinId: "llm"` at the `llm` builtin's
> `executeWithToolsLoop` call (`llm.ts:~810`). VERIFY rather than assume that
> the generically-minted descriptor (§2.7 item 3) covers what `llm` mints at
> runtime — check `serverBuiltinRuntimeWrites` against the cells `llm` actually
> creates, and say so explicitly in your report either way.
>
> RED-FIRST: before changing behavior, add a test that fails for the right
> reason. Put the identity pin in
> `packages/runner/test/builtin-implementation-hash.test.ts` and the routing
> behavior in `packages/runner/test/runtime-host-for-space.test.ts` (there is a
> `describe("Runtime.fetchBuiltin")` block at :123 to model on). Show me the
> red output in your report, then the green.
>
> Do NOT commit, do NOT push, do NOT edit anything under
> `docs/specs/server-side-execution/`. Report: files changed, the exact test
> command that proves it, whether the descriptor genuinely covers `llm`'s
> runtime writes, and anything contradicting §2.

---

#### A2 — `sqliteQuery` effect broker · parallel: yes

**Goal.** `sqliteQuery` becomes server-executable. Unlike `llm` this is
**not** fetch-shaped, so §2.7's allowlist move alone will not be enough —
expect real broker work.

**Verify (run yourself):**
```bash
deno test -A packages/runner/test/builtin-effect-registry.test.ts && deno test -A --filter sqlite packages/runner/test/
```

**Prompt:**

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2 (especially §2.7),
> then decision **D2** in `docs/specs/server-side-execution/client-passivity.md`
> §7, then the R5 row in `context-lattice-execution.md` §8.
>
> TASK: design and implement the server-side broker path for the `sqliteQuery`
> effect builtin (`packages/runner/src/builtins/sqlite-builtins.ts`, registered
> at `builtins/index.ts:~94`). START BY REPORTING THE DESIGN before you build:
> `sqliteQuery` is not fetch-shaped, so the existing
> `ServerBuiltinFetchBroker` seam
> (`packages/runner/src/executor/server-builtin-transport.ts`) may not fit. Say
> plainly whether it fits, and if not, what the minimal new seam is. If the
> honest answer is "this needs the D2 served-commit path first" (item A5), say
> that and stop — a correct scoping answer is a good outcome for this task.
>
> If it does fit: implement red-first with tests, following §2.7.
>
> Do NOT commit, do NOT push, do NOT edit anything under
> `docs/specs/server-side-execution/`. Report: the design call and its
> rationale, files changed, the exact test command, and anything contradicting §2.

---

#### A3 — W2.15 descriptors for five computation builtins · parallel: yes

**Goal.** `llmDialog`, `compileAndRun`, `sqliteDatabase`, `navigateTo`,
`inspectConfLabel` get W2.15-shape computation descriptors so they stop
rejecting `incomplete-static-surface`.

**Note:** `llmDialog` is **confirmed a computation** — CP6's egress claim was
REFUTED; it orchestrates effect-classified `llm` nodes with no direct egress.
Do not "fix" it into an effect.

**Verify (run yourself):**
```bash
deno test -A packages/runner/test/server-execution-product-fixtures.test.ts packages/runner/test/builtin-effect-registry.test.ts
```

**Prompt:**

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2 (especially §2.7
> item 4 — the computation-descriptor seam), then the W2.15 material referenced
> from the R5 row in `docs/specs/server-side-execution/context-lattice-execution.md` §8.
>
> TASK: add W2.15-shape computation descriptors for `llmDialog`,
> `compileAndRun`, `sqliteDatabase`, `navigateTo`, `inspectConfLabel`. The
> existing exact registry is `SERVER_COMPUTATION_BUILTIN_IDS` in
> `packages/runner/src/builtins/server-execution.ts` (`ifElse`, `when`,
> `unless`) — read the docblock there; it is explicit that the registry is
> deliberately exact and that envelope-shaped builtins are a different design.
> For EACH of the five, verify against the builtin source what it actually
> reads and writes, and only add it if its surface genuinely is
> "reads its inputs, writes exactly its direct output(s)". If one of them is
> envelope-shaped or otherwise does not fit, LEAVE IT OUT and report why —
> a partial, correct result beats five wrong entries.
>
> `llmDialog` is CONFIRMED a computation (CP6's egress claim was refuted); do
> not reclassify it.
>
> Red-first with tests. Do NOT commit, do NOT push, do NOT edit anything under
> `docs/specs/server-side-execution/`. Report: which of the five you added,
> which you left out and why, files changed, the exact test command, and
> anything contradicting §2.

---

#### A4 — R13 `wish` descriptor · parallel: yes

**Goal.** `wish` gets a descriptor. Its shape is decided by the resolver
contract (plan W2.15b). Measured ×4 in the flagship fixture — a real hole.

**Verify (run yourself):**
```bash
deno test -A packages/runner/test/server-execution-product-fixtures.test.ts
```

**Prompt:**

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2 (especially §2.7),
> then the **R13** row in `docs/specs/server-side-execution/context-lattice-execution.md`
> §8, then `packages/runner/src/builtins/wish.ts`.
>
> TASK: `wish` has static builtin identity but no descriptor, so it classifies
> `incomplete-static-surface`. Determine its resolver contract from the source
> and give it a descriptor of the right shape. Note that
> `packages/runner/test/server-execution-product-fixtures.test.ts` currently
> carries an explicit exemption for `impl:cf:builtin/wish:v1` in its
> zero-verdict pin — when `wish` gets a real descriptor that exemption should
> narrow or go away, and that is the natural red-first signal for this task.
>
> If the resolver contract turns out NOT to have a bounded static surface, say
> so plainly with evidence rather than inventing one — "wish needs a different
> mechanism, here is why" is a good outcome.
>
> Do NOT commit, do NOT push, do NOT edit anything under
> `docs/specs/server-side-execution/`. Report: the contract you found, what you
> built (or why you did not), files changed, the exact test command, and
> anything contradicting §2.

---

#### A5 — served sqlite-op commit path (D2) · parallel: no (after A2)

**Goal.** Routing-layer lane-scope admission + row-label re-derivation, per
**D2**. D2 says BUILD it: the permanent-ruling alternative was rejected
because CP21 shows the required static detectability is structurally absent
(dynamic sqlite ops ride arbitrary callers' commits).

**Verify:** to be set from A2's design report.

**Prompt:** compose after A2 reports — its design call determines the shape.
Carry forward: the D2 rationale, `packages/runner/src/builtins/sqlite/`, and
whatever seam A2 identified.

---

### Wave B — measurement (orchestrator only, NOT delegated)

**B1.** Re-run the three-arm ladder probe and record the delta wave A bought.

```bash
deno test -A packages/patterns/integration/server-execution-group-chat-user-rank-probe.test.ts
```

Read `unservedByCode` / `offendersByCode` per arm. Expect the effect rows to
move `broker-required` classes; `dynamic-write-outside-static-surface` should
be unchanged (it is not an effect row). Record in client-passivity §5g.

Also re-run the classification probe:
```bash
deno test -A packages/runner/test/server-execution-group-chat-rank-probe.test.ts
```

**Gate:** numbers recorded in the spec before wave C proceeds past C1.

---

### Wave C — P3 preconditions

#### C1 — Does P3 delete the §4 widening artifact? · parallel: yes (can start now)

**Goal.** Decide whether `dynamic-write-outside-static-surface` (×12, 1
offender, survives both scoped ranks) is worth diagnosing, or whether a
passive client removes the requirement entirely. This is a **paper
investigation**, ~1 hour, and it reorders the plan if the answer is "deleted".

**Verify:** the deliverable is a written argument with code citations; the
orchestrator reads and rules.

**Prompt:**

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2, then
> `docs/specs/server-side-execution/client-passivity.md` §5g (the whole
> section), then the §4 output-widening pair contract — start at
> `laneBroadScopeNamingWriteViolation` in
> `packages/runner/src/scheduler/servability.ts:~727` and its engine twin
> `assertLaneBroadScopeNamingWrite` in `packages/memory/v2/`, plus
> `packages/memory/v2/scope-naming-link.ts`.
>
> QUESTION, and it is the only one: the §4 widening pair exists so that a
> CLIENT reading a scoped-lane write sees a correct self-scoping redirect. If
> the client becomes purely speculative — it still computes for rendering but
> NEVER commits reactive results — does that requirement still exist? Answer
> with code citations, not intuition. Specifically: enumerate who READS the
> broad instance today and why, and for each reader say whether a passive
> client still needs it.
>
> Deliverable: a written argument in
> `/private/tmp/claude-501/.../scratchpad/c1-widening-under-passivity.md`
> (create the directory if needed; do NOT write into docs/). State a verdict:
> DELETED / NARROWED / SURVIVES, with the reasoning that would let someone
> disagree with you.
>
> Do NOT commit, do NOT push, do NOT change any source. Report the verdict and
> the strongest counter-argument to it.

---

#### C2 — Client-side `context-lattice-claims-v1` negotiation · parallel: no (after C1)

**Goal.** The binding blocker from the CA4 audit: the browser client has no way
to negotiate the subcapability, and the principal-wide cohort gate therefore
makes user lanes un-openable in exactly the deployments worth measuring. This
is what unblocks the two-browser payoff surface.

**Precedent and template:**
`packages/patterns/integration/server-execution-f5-env-bridge-gate.test.ts` —
the F5 gate exists because the *identical* miswire already happened once (env
dials never reached the advertisement in realm-separated deployments). Build
this the same way: red-first, asserting the subcapability negotiates END TO
END from the dials alone.

**Prompt:** compose after C1; scope depends on whether the §4 artifact is being
carried forward.

---

### Waves D–F — sketch only (specify when C completes)

- **D · P3 passivity mechanism.** Per-session subcap, passive-mode demand
  producer, dynamic-reactivation contract, effect-attempt journal. THIS is
  where single-user boot shifts and multi-user actually gets faster. Design
  doc first (delegate the draft, orchestrator rules on it), then build.
  Watch: D5 hold-never-flicker is the user-visible risk surface.
- **E · P5 passive delivery + warm spaces.** Demote-never-retire, D3
  push-then-catch-up boot seed. Makes the persistent-page premise true for
  real returning users; kills the cold-start cliff jointly with the §5d
  serving-path work.
- **F · P6 acceptance.** Three-way at protocol n; fully-engaged ≤ flag-off on
  interaction AND boot; engagement by counters; cold row published alongside.
  Non-negotiable by this plan's own language (see D7).

**Standing constraint for D/E:** D10 sets the bar at *fast first paint with
gaps*, not zero-execution first paint. Speculation is for interaction latency
and nothing else; it is never load-bearing for convergence.

---

## 5. Phase gates

| Gate | Condition |
| --- | --- |
| A→B | All A items landed or explicitly scoped out with a recorded reason. Full battery green. |
| B→C | Post-A numbers recorded in client-passivity §5g. |
| C→D | C1 verdict ruled by the owner-facing memo; C2 negotiating end to end under a red-first gate. |
| D→E | Client stops running standing work for claimed actions, with counters proving it. |
| E→F | Cold-start cliff measured, not asserted. |
| F | P6 bar: fully-engaged ≤ flag-off on interaction AND boot, at protocol n, k∈{3,10}. If it fails → D7 says ESCALATE TO OQ5, do not ratify non-parity. |

---

## 6. Log

Append one line per landed item: date, item, commit, one-sentence outcome.

- 2026-07-28 — plan created (`docs/specs/server-side-execution/passivity-arc-orchestration.md`);
  wave A next, A1 pre-diagnosed in §2.8.
- 2026-07-28 — A1 `cfa827f82`: `llm` gets the server broker route; all three
  LLM builtins share it.
- 2026-07-28 — A2 `8cb00bbf8`: fetch broker refused as a misfit;
  `sqliteQuery`'s post-commit effect now routes through the sink-request
  suppression gate. Not blocked on D2; rest folds into A5.
- 2026-07-28 — A3 `f221411df`: `inspectConfLabel` added, 4 of 5 refused with
  evidence. Found a green test asserting a false thing; CP6 re-opened.
- 2026-07-28 — A4 `a69aec5f9`: `wish` refused a descriptor (its surface is
  misleadingly narrow) and the block is pinned. Found an egress-denial bypass.
- 2026-07-28 — arc debt `a34c15fd2` (lint pin) + `57e625424` (fmt 21 files);
  A→B gate's lint and format halves now met.
- 2026-07-28 — C1 ruled **SURVIVES**; the ×12 is unblocked as P2 work and the
  question's framing was wrong at the source. Full ruling: client-passivity §5h.
- 2026-07-28 — wave B measured: **zero movement**, every counter reproducing
  the pre-A baseline. The plan's own prediction ("expect the effect rows to
  move broker-required classes") was WRONG — group-chat exercises none of the
  four builtins wave A touched. Lesson for future waves: check that the
  measurement instrument can see the thing being built BEFORE promising a
  buy. Full numbers: client-passivity §5h.
- 2026-07-28 — A5 `57dd8da7f`: sqlite.query joins the acting-context seam. A
  lease-bound executor was opening the WRONG principal's cell-db (a cell-db is
  a file, so the scope context is the file selector and nothing downstream
  catches a bad resolution). Deliberately did NOT register the id — that one
  line alone would have served a user-scoped query reading the wrong file.
- 2026-07-28 — C2 `256e73799`: `context-lattice-claims-v1` negotiates end to
  end from the dials alone. The CA4 binding blocker is gone; a deployment can
  now flip the rank dials. Retired the harness hatch it stomped.
- 2026-07-28 — D2 narrowed to reads by owner ruling (`04836c65f`); sqlite
  writes stay client-primary and that is INSIDE the goal, since every
  `db.exec` site is in a handler and handlers are client-inherent by §1.
- 2026-07-28 — **`8e1cb7d99`: the ×12 cleared.** Owner ruled the fail-closed
  comment stale; scoped auxiliary result-instance LINKS are now accepted
  (values still rejected — the carve-out held under live measurement).
  `dynamic-write-outside-static-surface` 12 → absent,
  `malformed-scope-naming-link` 12 → 0, user candidates 17 → 29, session
  unserved inventory 16 events → 4. **The first measured reduction in the
  never-claimed set.** Lesson: a limitation recorded in a source comment as
  "accepted" had propagated into this plan as permanent, and was neither.

- 2026-07-29 — D11 reorders the arc: claims are scaffolding, close the
  serving gap first. Wave G opens.
- 2026-07-29 — navigateTo designed (`5fc2dd0f0`). A broadcast is
  structurally unreachable; the interim under-delivers. `compileAndRun` folded
  in — its real blocker was `pieceCreatedCallback`, not the async writes
  earlier recorded.
- 2026-07-29 — `adf1e3dfe` sqliteDatabase owner from the acting lane;
  `b3304e771` wish + llmDialog server-side. **A narrow verify line let a red
  gate through**: llmDialog's allowlist addition broke the "registry is exact"
  pin, the agent reported green, and only a sibling agent's broader run caught
  it. When an item touches a registry, verify the registry's OWN pin too.
- 2026-07-29 — `cf09a186b` the user arm's last residual closed. **NOT
  cross-space** — that attribution was the orchestrator's, inferred from a
  neighbouring code name without checking. The real cause was the `c2cc3891e`
  §4-pair relabel left half-applied at user rank. Lesson: two diagnostics
  sharing a neighbourhood in the source is not evidence they share a cause.
- 2026-07-29 — **counters that count but cannot NAME are a diagnosis dead
  end.** `recordExecutionCandidateUnserved` dedupes offenders by
  implementation fingerprint, which is why "1 offender" survived a full wave
  unidentified. The probe now records derivation keys. When adding a
  candidate-diagnostic counter, record something that identifies the offender.
- 2026-07-29 — navigateTo gate 4 FIRED before any build:
  `addExecutionDemand` has one call site (inside `start()`), and the
  commit-gated deferred navigate root reaches `startWithTx` instead — so its
  piece is never demanded and can never be claimed at session rank. Open
  question: does demand closure-growth cover a deferred root? See
  [`navigate-to-server-side.md`](navigate-to-server-side.md) §8.
