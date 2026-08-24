---
status: historical
created: 2026-08-23
archived: 2026-08-23
reason: "Client-side capture answering the owner's OW45 arm-B question: WHICH call site arms the deferred start whose commit the server refuses. VERDICT — `PiecesController.ensureDefaultPattern`, `packages/piece/src/ops/pieces-controller.ts:1759` (the `editWithRetry` inside the `ensureDefaultPattern.editWithRetry` timing phase), whose `fn` calls `this.runtime.run(tx, pattern, {}, pieceCell, DEFAULT_ROOT_RUN_OPTIONS)` at `:1783`. The leading hypothesis is CONFIRMED and the sequence memo's child-node evidence does NOT contradict it: the four child roots (BacklinksIndex, SummaryIndex, two Grid Views) are in the deferred commit because `instantiatePatternNode` runs `setupInternal` for CHILD pattern nodes inside the start tx, exactly as that memo's own §3(i) explains — a space-ROOT start whose children materialize in its deferred tx. Reached from `RuntimeProcessor.handleGetSpaceRootPattern`, i.e. session boot, NOT navigation. Two further facts the owner's sizing needs. (1) The five start commits do NOT share one arming entry: commits 1-3 (9, 23, 28 ops) are `PatternManager.writeBackCompileCache` compile-cache write-backs (`pattern-manager.ts:2183`) and have nothing to do with the piece start; only commits 4 (46 ops, the originating editWithRetry tx) and 5 (50 ops, the refused deferred start) are the ensureDefaultPattern pair. (2) `startAfterSuccessfulCommit` has a SECOND caller the brief's premise does not cover — `setupDeferredHandlerResultPattern` (`runner.ts:5820`), ungated by immediate/defer, armed by any handler result pattern carrying a `navigateTo`. It fires in every session measured, commits 83 ops, and was ACCEPTED 8/8 — so it is NOT the refusal, but it means 'the deferred start' is two mechanisms, and a fix aimed at one leaves the other. So moving `ensureDefaultPattern` server-side WOULD remove this refusal. Measured 4 informative runs, refusal 4/4, all GREEN — no red was sampled, so the arming attribution is established on greens only (the census's 15-of-18 greens-carry-refusals finding makes that the normal case, not a gap in kind)."
---

# OW45 arm B — which call site arms the refused deferred start?

**ANSWER: `packages/piece/src/ops/pieces-controller.ts:1759` — the
`editWithRetry` inside `PiecesController.ensureDefaultPattern` (the
`"ensureDefaultPattern.editWithRetry"` timing phase), whose `fn` calls
`this.runtime.run(tx, pattern, {}, pieceCell, DEFAULT_ROOT_RUN_OPTIONS)` at
`pieces-controller.ts:1783`.**

The leading hypothesis is **confirmed**. Captured client-side, on the arming
transaction itself, in 4 of 4 informative runs.

**Consequence for the owner's sizing, stated and not acted on: moving
`ensureDefaultPattern` server-side WOULD remove this refusal.** It is the
arming entry, not a bystander.

## Why the sequence memo's child-node evidence does not contradict this

The brief flagged that the refused commit's four irreducible piece roots are
CHILD pattern nodes (`BacklinksIndex`, `SummaryIndex`, two `Grid View`s), which
"does not obviously match a space-ROOT default-pattern start." Measured, it
matches exactly — and the sequence memo already contains the reason in its own
§3(i):

> `instantiatePatternNode` calls `runWithStartOwnership(tx, patternImpl, inputs,
> childResultCell, …)` with the **start** transaction — so every CHILD pattern
> node a start instantiates has its full setup written into that start's own
> commit.

A space-root start's deferred transaction is *expected* to contain its
children's roots and no root of its own: the root's own setup was staged in the
**originating** tx (commit 4), which is why commit 4 carries exactly 1 piece
root and commit 5 carries 4. Child roots in the deferred commit are therefore
consistent with a root start, not evidence against one.

## The arming entry, as captured

The full synchronous chain, read off the arming stack (run a02, session 1,
paths shortened):

```
Runner.startAfterSuccessfulCommit
  < Runner.runWithStartOwnership
  < Runner.run
  < Runtime.run
  < <editWithRetry fn>
  < Runtime.editWithRetry
  < timePiecePhase
  < PiecesController.ensureDefaultPattern
  < async RuntimeProcessor.handleGetSpaceRootPattern
  < async RuntimeProcessor.handleRequest
```

and the arming record itself:

```
[ARMB_ARM] id=arm1 tag=ARM-A:runWithStartOwnership
  originImmediate=true originDefer=true
  originSite=pieces-controller.ts:1759(ensureDefaultPattern)
[ARMB_DEFERRED_START] verdict=REFUSED id=arm1 tag=ARM-A:runWithStartOwnership
```

Two independent identifications agree: an explicit tag written onto the
transaction inside the `ensureDefaultPattern` callback, and a stack captured at
the arming point. Both name the same call site.

**The entry above it is `handleGetSpaceRootPattern` — session boot, not
navigation.** The fork memo and the ON skip entry both call this "the flag-ON
client's navigate-deferred piece start". On this evidence the refused start is
the **space root default-pattern** start; it is armed while the shell is
resolving the space root, before any navigation. The phrase appears to be
shorthand for "the deferred start seen during the test's navigate phase" rather
than a claim about the arming path, but it is worth correcting because it is
what made `ensureDefaultPattern` look like the wrong suspect.

## There are TWO arming arms, not one

The brief's premise — armed when `Runner.run` sees both `tx.tx.immediate` and
`deferRunnerStartUntilCommit` (`runner.ts:3686-3691`) — covers only one of two
callers of `startAfterSuccessfulCommit`, the function whose failure emits the
`"Error committing deferred start transaction"` line the census captured:

| arm | call site | gate | seen in these runs |
|---|---|---|---|
| **ARM-A** | `runner.ts:3694`, in `runWithStartOwnership` | `immediate && deferRunnerStartUntilCommit` — i.e. requires an `editWithRetry` tx | armed 2×/run; **the refused one** |
| **ARM-B** | `runner.ts:5820`, in `setupDeferredHandlerResultPattern` (`runner.ts:5791`) | **none** — fires whenever a handler's result pattern contains a `navigateTo` node (`handlerResultPatternHasNavigateTo`, `runner.ts:5783`) | armed 2×/run; **ACCEPTED 8/8** |

ARM-B needs no `editWithRetry` at all — its arming transactions log
`originDefer=undefined`. It is the arm whose name actually is "navigate", it
commits 83 operations (18 `computed:` / 31 `of:` / 34 `cid:`), and it was
accepted in every session measured.

This matters beyond bookkeeping: **"the client's deferred start" is two
mechanisms sharing one error string.** A change that removes ARM-A leaves ARM-B
arming and committing on every session.

One nearby path is **eliminated**: the navigate path at `runner.ts:5629` goes
through `runPatternAfterSuccessfulCommit`, which logs `"Error committing
deferred cross-space pattern transaction"` — a different string from the one the
census captured, so it is not the refusal's source.

## The five-commit sequence, attributed

The sequence memo established the composition of the five client start commits
but explicitly could not establish the triggers of commits 1–4. All five,
attributed (run a02, session 1; composition reproduces the memo's table
exactly):

| # | localSeq | ops | `computed:` | `of:` | `cid:` | attributed to | verdict |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 9 | 0 | 8 | 1 | `PatternManager.writeBackCompileCache` (`pattern-manager.ts:2183`) | ACCEPT |
| 2 | 2 | 23 | 0 | 22 | 1 | `PatternManager.writeBackCompileCache` | ACCEPT |
| 3 | 3 | 28 | 0 | 28 | 0 | `PatternManager.writeBackCompileCache` | ACCEPT |
| 4 | 4 | 46 | 12 | 15 | 19 | **`ensureDefaultPattern` `editWithRetry` (`pieces-controller.ts:1759`)** — the originating tx | ACCEPT |
| **5** | **5** | **50** | **16** | **15** | **19** | **the deferred start tx armed by that same call site** | **REFUSED** |

**They do NOT share one arming entry.** Commits 1–3 are compile-cache
write-backs and are not piece-start work at all — they are `editWithRetry`
transactions, but their `fn` never calls `runtime.run`, so they arm nothing.
Only commits 4 and 5 are the `ensureDefaultPattern` pair: the originating
transaction and the deferred start hung off its commit callback.

Commit 5's origin stack independently confirms the mechanism — it is minted
inside a commit callback, not by a caller:

```
Runtime.edit < <startAfterSuccessfulCommit callback>
  < ExtendedStorageTransaction.runCommitCallbacks
```

The `arm=arm1` tag carried onto that transaction ties it to the arming record
above, so the join from "refused commit" to "arming call site" is by
transaction identity, not by inference from composition.

## Bench

- Worktree `/Users/berni/labs-worktrees/armb-arming-entry`, branch
  `claude/server-exec-v2-armb-arming-entry`, head **`e55785eff`** (origin/main).
- ON toolshed binary built from this worktree with
  `EXPERIMENTAL_SERVER_EXECUTION=true`; posture probed per run
  (`shellServerExecutionDefine=true servingLoop=present`), **fresh store per
  run**, ports 9671–9676 (never 8000).
- Gate: `packages/patterns/integration/default-app.test.ts`. The step's ON skip
  entry in `tasks/server-execution-on-skips.ts` was neutralized so the step
  actually runs.
- Client console reached the test output via `FORWARD_WORKER_CONSOLE=1
  PIPE_CONSOLE=1`.
- **Ambient load only — no synthetic burners.**

### The instrument

Three scratch taps, all reverted before this report:

1. **`startAfterSuccessfulCommit`** (`runner.ts`) — an explicit arm tag passed
   from each of its two call sites, plus a stack captured at entry, plus the
   commit verdict. The tag is what makes the arm identification independent of
   stack quality.
2. **`Runtime.edit`** (`runtime.ts`) — stamps the minting stack on every
   transaction; the `editWithRetry` callbacks of the three enumerated
   `runtime.run` call sites additionally stamp an explicit site string.
3. **`sealOperations` / `commitOperations`** (`storage/v2.ts`) — logs every
   client commit's `localSeq`, operation count, scheme split, arm id and site.
   `localSeq` is what joins these records to the sequence memo's table.

**One product-behaviour change was required to get stacks at all, and it is
worth recording.** Under SES lockdown the worker's `errorTaming: "safe"`
(`packages/runner/src/sandbox/ses-runtime.ts:247`) blanks `error.stack`, so the
first instrumented run (a01) returned `stack=` empty for every capture. The
diagnostic build sets `errorTaming: "unsafe"`. Runs a02–a06 therefore carry one
deviation from stock beyond logging. The explicit site tags are *not* affected
by it, and they agree with the stacks — a01, built with stock taming, already
identified the refused arm as ARM-A by tag alone.

### Run ledger

| run | port | exit | wall | step | load before/after | arms | refusals | refused arm |
|---|---|---|---|---|---|---|---|---|
| a01 | 9671 | 0 (GREEN) | 24 s | ok (14 s) | 6.31 / 4.87 | 4 | 1 | ARM-A (tag only; stacks blank) |
| a02 | 9672 | 0 (GREEN) | 21 s | ok (11 s) | 3.65 / 3.56 | 4 | 1 | **ARM-A `ensureDefaultPattern`** |
| a03 | 9673 | 0 (GREEN) | 27 s | ok | 2.38 / 3.56 | 4 | 1 | ARM-A `ensureDefaultPattern` |

Each run drives two browser sessions, so each contributes two captures of the
arming sequence; in every one the first session's ARM-A start is refused and the
second session's is accepted, matching the sequence memo's 5-of-6 pattern.

A run that finishes in under ~20 s with the step `ignored` means the skip
neutralization was reverted — the failure that made the sequence memo's s03/s04
uninformative. Every run above ran the step.

## What this does NOT establish

- **No RED run was sampled.** All informative runs here are GREEN. The refusal
  reproduced 4/4 regardless, which is the census's finding from the other
  direction (15 of its 18 captured refusals came from runs that PASSED), and
  the census further measured the red's refused commit as doc-for-doc identical
  to the greens'. So there is good reason to expect the arming entry is the same
  on a red — but it is an expectation, not a measurement, and it is stated here
  as a gap rather than folded into the answer.
- **Whether ARM-B ever loses its race.** It was accepted in every session
  measured. Nothing here bounds its behaviour under contention, and it is the
  arm that would remain after any ARM-A change.
- **Whether the enumerated `editWithRetry` → `runtime.run` sites are the
  complete set.** Three were tagged explicitly (`pieces-controller.ts:1618`,
  `:1759`, `llm-dialog.ts:3032`); the stack capture is the backstop that would
  have named an unenumerated one, and in these runs it never did. Sites reached
  only under LLM or multi-space flows were not exercised by this gate.
- **Whether removing this refusal makes arm B go green.** Explicitly out of
  scope, and the sequence memo already argues against assuming it: its run s07
  was GREEN carrying the same refusal. This report identifies the arming entry
  only.
