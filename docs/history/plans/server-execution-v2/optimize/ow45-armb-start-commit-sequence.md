---
status: historical
created: 2026-08-23
archived: 2026-08-23
reason: "Measurement answering the owner's OW45 arm-B question: is the refused 50-op deferred-start commit the piece's initial MATERIALIZATION, or a FOLLOW-UP first wave the client runs after a smaller materialization already landed? VERDICT — MATERIALIZATION, specifically the node-INSTANTIATION half of it, and it is the 5th and last of five client start commits (9, 23, 28, 46, 50 ops) of which the first four land successfully. So the owner is right that a smaller commit already lands first, but wrong that the 50-op commit is a derivation wave: no first-run output is in it (every `computed:` op it writes holds a wiring LINK, not a derived value; the scheduler's first run is a later macrotask in its own transactions). The decisive new fact is redundancy, not ordering: the SERVING side's own derived wave commit writes EVERY ONE of the same 50 operations — tuple for tuple in run s01, as a strict superset in run s02 — so client-only operations are 0 of 50 in all five measured refusals, and whichever side arrives second is refused as stale. CRUCIAL QUALIFIER: run s07 is GREEN — the step ran and PASSED — and its commit 5 was refused all the same by a wave covering 50/50. Across 5 informative runs the refusal is 5/5 while the verdict is 4 red / 1 green, so this duplicated materialization is the NORMAL steady state of a flag-ON client start, not the arm-B defect; removing it would remove the refusal but does NOT follow to arm B going green. Measured both directions in ONE run: session A's client lost to wave localSeq 7 and was REFUSED; session B's client won and a commit of the same shape was ACCEPTED, after which the server did smaller follow-up waves over the client's writes instead. On the shrink question the answer has a measured size: 4 of the 50 ops are piece ROOTS carrying the full setup state (patternIdentity, patternSetupIdentity, argument, internal, schema) — that is 'the pattern + the result cell'; the other 46 are structure, wiring and content-addressed schema the server writes anyway. Those 4 are in the START commit rather than the originating one because `instantiatePatternNode` runs `setupInternal` for CHILD pattern nodes inside the start tx — which also refines 'the server never writes setup': true of the top-level piece (the loop calls `start()`, never `run()`), false of children, and the wave wrote all four of these roots first."
---

# The OW45 arm-B start commit sequence — materialization, or follow-up wave?

**VERDICT: MATERIALIZATION — the node-INSTANTIATION half of it — and it is the
LAST of five client start commits, four of which land successfully first.**

The owner's hypothesis is right about ordering and wrong about kind. A smaller
commit does land first (four of them, in fact: 9, 23, 28 and 46 operations, all
accepted). But the refused 50-op commit is not "the follow-up first wave the
client runs" — it contains no derivation output at all. Every one of its 16
`computed:` operations writes a *wiring link*, not a computed value, and the
scheduler's first run of the instantiated actions happens later, in its own
separate transactions.

The fact that actually decides the disposition is neither of the two the
question offered. It is **redundancy**: the serving side's own derived wave
commit writes **every one of the same 50 operations** — exactly, tuple for
tuple, in run s01; as a strict superset in run s02 — and whichever side arrives
second is refused as stale. **Client-only operations: 0 of 50, in all five measured
refusals — four reds and one green.** That the two sides are doing the same work was measured in both
directions inside a single run: where the wave got there first the client's copy
was REFUSED; where the client got there first a commit of the same shape was
ACCEPTED and the server then did smaller follow-up waves over the client's
writes instead.

**And the shrink the owner proposes has a measured size: 4 operations out of
50.** Four of the commit's `of:` documents are piece ROOTS carrying the whole
setup state — `patternIdentity`, `patternSetupIdentity`, the `argument`
write-redirect, the `internal` manifest and the result cell's `schema`. That is
exactly "the pattern + the result cell". The remaining 46 are wiring, structure
and content-addressed schema. The catch is that on this evidence even those 4
are not unique to the client: the serving side wrote all four roots first, in
the same wave.

## Why this was asked

The arm-B fork memo (`optimize/ow45-armb-client-start-fork.md`) root-caused the
remaining arm-B defect to the flag-ON client's navigate-deferred piece start
dying terminally on a stale-confirmed-read `ConflictError` with no retry arm.
The commit census (`optimize/ow45-armb-commit-census.md`) then measured that
refused commit as MIXED — 50 semantic operations, 16 `computed:` / 15 `of:` /
19 `cid:`, 143 confirmed reads, 95 stale across 40 documents — which rules out
computed-cell-identity.md's phase-2 ack-and-drop. The owner asked whether the
commit could instead be *shrunk*:

> "materialization might actually be on the client, but could be shrunk to just
> writing the pattern + the result cell but none of the rest. maybe that's
> already another commit and what you see is the follow-up first wave the
> client runs."

## Bench

- Head `c105fa3c8` (origin/main), worktree
  `claude/server-exec-v2-start-commit-sequence`.
- ON toolshed binary built from this worktree with
  `EXPERIMENTAL_SERVER_EXECUTION=true`; posture probed per run
  (`shellServerExecutionDefine=true servingLoop=present`), fresh store per run,
  port 9663.
- Gate: `packages/patterns/integration/default-app.test.ts`. The step's ON skip
  entry in `tasks/server-execution-on-skips.ts` was neutralized for the
  measurement so the step actually runs.
- **Ambient load only — no synthetic burners.**
- Run s01 reproduced the arm-B RED on the first attempt (test exit 1, the step
  failing on the 300 s `waitForCondition`, load 5.32 before / 3.52 after).

### Run ledger

Each run drives two browser sessions (the step creates notes, then reloads), so
each contributes two captures of the start sequence.

| run | step | exit | wall | load before | 5-commit sequence | commit 5, session 1 | wave covers its 50 ops |
|---|---|---|---|---|---|---|---|
| s01 | ran | 1 (RED) | 329 s | 5.32 | 9/23/28/46/50 | REFUSED | 50/50 (wave localSeq 7, exact) |
| s02 | ran | 1 (RED) | 330 s | 3.70 | 9/23/28/46/50 | REFUSED | 50/50 (wave localSeq 30, superset of 63) |
| s03 | `ignored` | 0 | 9 s | 2.33 | — | — | — |
| s04 | `ignored` | 0 | 14 s | 3.21 | — | — | — |
| s05 | ran | 1 (RED) | 327 s | 3.48 | 9/23/28/46/50 | REFUSED | 50/50 (wave localSeq 6) |
| s06 | ran | 1 (RED) | 324 s | 4.26 | 9/23/28/46/50 | REFUSED | 50/50 (wave localSeq 7) |
| **s07** | **ran** | **0 (GREEN)** | **28 s** | **4.79** | **9/23/28/46/50** | **REFUSED** | **50/50 (wave localSeq 7)** |

s03 and s04 are not informative — reverting the scratch edit between run batches
re-enabled the step's ON skip. In every informative run the reload session ran
the same five-commit sequence and its commit 5 was **ACCEPTED**, no 50-op wave
having preceded it.

**s07 is the load-bearing row.** It is GREEN — the step ran and PASSED in 17 s —
and its first session's commit 5 was refused all the same, by a wave covering
50/50 of its operations, exactly like the four reds. So the duplicated
materialization and the refusal that follows it are the **normal steady state**
of a flag-ON client start, not the arm-B defect. This independently reproduces
on this bench what the census found from the other direction (15 of its 18
captured refusals came from runs that passed), and it bounds every inference
below: see §6.

### The instrument

The census reconstructed one commit from the client's own error payload. This
question needs *every* commit in arrival order, so the tap moved to the
**server**, which sees them all: a scratch wrapper around `applyCommit` and
`applyWaveCommit` in `packages/memory/v2/engine.ts` logging, per commit, the
commit class, session, `localSeq`, operation count, scheme split
(`computed:`/`of:`/`cid:`), verb split, read counts, the verdict, and the full
`(verb, id)` list.

This is strictly better than a client-side tap for this question: it captures
the serving loop's `derived`-class wave commits on the same timeline as the
client's `authored` ones, which is what made the redundancy visible. Run s01
captured **181 commit events** — 47 client commits (42 accepted, 5 refused) and
87 wave commits. The instrument is scratch and is not part of this commit; only
this report is.

## 1. The commit sequence of a client-side piece start

**Five commits, and the refused one is the fifth.** Measured on the red run's
first browser session (`7a87fd6795`), and reproduced with identical composition
in the reload session (`c7258f85c1`) in the same run:

| # | localSeq | ops | `computed:` | `of:` | `cid:` | verbs | confirmed reads | verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 9 | 0 | 8 | 1 | set=9 | 16 | ACCEPT |
| 2 | 2 | 23 | 0 | 22 | 1 | set=23 | 46 | ACCEPT |
| 3 | 3 | 28 | 0 | 28 | 0 | set=28 | 66 | ACCEPT |
| 4 | 4 | 46 | 12 | 15 | 19 | set=46 | 46 | ACCEPT |
| **5** | **5** | **50** | **16** | **15** | **19** | **patch=4, set=46** | **143** | **REFUSED** |

Commit 5's composition matches the census's captured refusal exactly — 50 ops,
16/15/19, 143 confirmed reads, `patch=4`/`set=46`, zero pending reads. It is the
same commit.

The five commits write **near-disjoint document sets**. Pairwise overlap is
**zero** for every pair except 4→5, which shares exactly **4** documents — the
four `computed:` docs that commit 4 `set`s and commit 5 `patch`es. So this is
not one materialization re-issued; it is a descent through a piece graph, each
commit materializing a different part, with commit 5 wiring itself into the
cells commit 4 created.

### The code path

`runWithStartOwnership` (`packages/runner/src/runner.ts:3651`) is where the
split happens. It first calls `setupInternal(tx, …)` — the setup writes are
staged in the **originating** transaction — and then branches:

- `deferRunnerStartUntilCommit === true` (set by `editWithRetry`,
  `runtime.ts:2316`) → `startAfterSuccessfulCommit(tx, …)` (`runner.ts:3694`),
  which hangs a commit callback on the originating tx, and only after that tx
  **succeeds** mints a *fresh* `this.runtime.edit()` and commits the node
  instantiation as a separate transaction (`runner.ts:3399`, `3453`).
- otherwise → `startWithTx(tx, …)` (`runner.ts:3702`), which puts the start
  writes in the *same* transaction.

The deferred arm is the ON client's navigate path, and its failure logs exactly
the `tx-commit-error … Error committing deferred start transaction` line the
census captured (`runner.ts:3456`).

One asymmetry is worth naming because it is the whole difference between
"recoverable" and "terminal": the **originating** tx is an `editWithRetry`, so a
stale-basis rejection retries. The **deferred start tx** is a plain
`runtime.edit()` minted inside a commit callback — no retry arm. That is why
commits 1–4 survive contention and commit 5 does not.

## 2. The ordering fact — and the one that actually matters

The interleaved timeline, red run s01, first session. `#` is the engine-arrival
counter; `derived` is the serving loop, `authored` is the client:

| # | class | localSeq | ops | shape | verdict |
|---|---|---|---|---|---|
| 16–17 | authored | 4 | 46 | 12/15/19, set=46 | ACCEPT (server seq 9) |
| 18 | derived | 6 | 1 | — | — |
| **19** | **derived** | **7** | **50** | **16/15/19, patch=4 set=46** | **applied (server seq 11)** |
| 20 | derived | 8 | 13 | 7/6/0, patch=11 | — |
| **21–22** | **authored** | **5** | **50** | **16/15/19, patch=4 set=46** | **REFUSED** |

`ConflictError: stale confirmed read: computed:fid1:7BycCyHc… at seq 9
conflicted with seq 12`.

**Wave commit #19 and client commit #21 are the same 50 documents.** Set
comparison: `shared = 50, wave-only = 0, client-only = 0`, and the `(verb, id)`
tuples match too. The store confirms the direction — every one of the refused
commit's 50 documents has its **first** revision at **seq 11**, the wave's seq;
the client's own earlier commit 4 landed at seq 9. The client built its commit
from the seq-9 world, the wave moved those documents to seq 11/12 underneath it,
and the client's identical copy arrived stale.

Run s02 reproduced the same defeat with the wave as a **superset** rather than
an exact match — the immediately preceding wave (localSeq 30) carried 63
operations over 61 documents, and **all 50** of the client's `(verb, id)` tuples
were among them, with **zero** client-only operations:

| # | class | localSeq | ops | shape | verdict |
|---|---|---|---|---|---|
| 65–66 | authored | 4 | 46 | 12/15/19, set=46 | ACCEPT |
| 67 | derived | 29 | 1 | — | — |
| **68** | **derived** | **30** | **63** | **23/21/19** | **applied** |
| **69–70** | **authored** | **5** | **50** | **16/15/19, patch=4 set=46** | **REFUSED** |

s02's refusal message reads `stale confirmed read: computed:fid1:2Oq8htwz… at
seq 0 conflicted with seq 11` — the fork memo's literal signature, which the
census had already explained as an array-order artifact.

So the invariant is not "the wave writes exactly the same commit" but the
weaker, sufficient one: **the client's deferred-start operations are a subset of
what the serving side writes anyway.** Client-only operations: 0 of 50, in both
measured refusals.

### The same commit is ACCEPTED when the client wins the race

The reload session in the *same run* ran the same five-commit sequence, with the
same composition at every step (9, 23, 28, 46, 50 ops; commit 5 again
16/15/19, `patch=4 set=46`, 143 confirmed reads):

| # | class | localSeq | ops | verdict |
|---|---|---|---|---|
| 68–69 | authored | 4 | 46 | ACCEPT |
| 70 | derived | 32 | 1 | — |
| **71–72** | **authored** | **5** | **50** | **ACCEPT** |
| 73–74 | derived | 33, 34 | 13, 27 | — |

Here no 50-op wave preceded it, the client's commit landed, and the serving side
then did smaller follow-up waves *over the client's writes* instead of
materializing the piece itself.

**And it never re-materialized them.** Checking every one of the 100+ wave
commits that followed, the largest overlap any of them has with the client's
50-document set is **16 of 50** (wave localSeq 34, a 23-document derivation
pass); every other later wave touches 1–5 of them. There is no second
50-document write. So the work is genuinely **either/or** — exactly one side
materializes the piece, and the other's identical attempt is either refused or
never issued. This is a duplicated-effort race, not a double-write.

(The two sessions' commit-5 document sets overlap in 23 of 50 — same shape, and
the same four piece roots' worth of work, but the notebook has acquired content
between them, so they are not the same bytes. What repeats exactly is the
*sequence and composition*, not the payload.)

This is the cleanest available statement of the defect: **the accept/refuse
outcome is decided entirely by which of two sides doing the same work arrives
first.** It also fits the census's finding that the refusal carries no signal
about whether the run will red — losing this race is the normal case, not the
failure, and the census measured refusals on 15 captures from runs that passed.

## 3. The 50 operations, classified

Read from the stored document values (the accepted copies of the same
documents, pulled from the run's sqlite store). Every one of the 50 written
documents falls into exactly one of four key-shapes:

| ops | scheme | top-level keys of the document | class |
|---|---|---|---|
| **4** | `of:` | `argument`, `internal`, `patternIdentity`, `patternSetupIdentity`, `schema`, `value` | **(i) irreducible materialization** |
| 11 | `of:` | `result` (7 of them also `value`) | (ii) authoritative structure |
| 16 | `computed:` | `result` | (iii) "computed" cells — but see below |
| 19 | `cid:` | `value` | (iv) content-addressed schema docs |

### (i) Irreducible materialization — **4 of the 50**

**This is the answer to "the pattern + the result cell".** Four of the fifteen
`of:` documents are piece ROOTS carrying the complete setup state: the pattern
pointer (`patternIdentity`), the setup-completion marker
(`patternSetupIdentity`), the argument write-redirect link, the `internal`
manifest, and the result cell's `schema` meta. If the commit were shrunk to "the
pattern and the result cell and none of the rest", these four documents are what
would remain — 4 operations instead of 50.

They are here, rather than in the originating transaction, because of nesting.
`setupInternal` writes into the *originating* tx for the piece being run, but
`instantiatePatternNode` (`runner.ts:7300`) calls
`runWithStartOwnership(tx, patternImpl, inputs, childResultCell, …)`
(`runner.ts:7483`) with the **start** transaction — so every CHILD pattern node
a start instantiates has its full setup written into that start's own commit.

The refused commit materializes four such child pieces, and they decode as
sub-pieces rather than the navigated target — read from their `$NAME` and
`patternIdentity`:

| `$NAME` | `patternIdentity.identity` |
|---|---|
| `BacklinksIndex` | `WnirWvtk7wCsoPNsu4IIKpp09TQeS7Ge…` |
| `SummaryIndex` | `Kn-c_cnguU8O9EnpN43JHx-9ieIv9u3E…` |
| `Grid View` | `eP2OivSIIN-HxgIDk_lS6XFoGREr7ZRZ…` |
| `Grid View` | `eP2OivSIIN-HxgIDk_lS6XFoGREr7ZRZ…` (same pattern, second instance) |

So even the irreducible 4 are children of the piece being started — which is
why the serving side, whose `start()` instantiates the same children, wrote all
four of them first.

The same count across the chain, measured: commits 1, 2 and 3 carry **0**
piece-root documents each (pure structure/wiring), commit 4 carries **1**, and
commit 5 carries **4**.

### (ii) Authoritative structure the server also writes — **11 `of:`**

The piece graph's result wiring, of the form
`{"result":{"/quote":{"/":{"link@1":{"id":"of:fid1:…","overwrite":"redirect",…}}}}}`
— node-instantiation products (`instantiateNode` → `instantiatePatternNode`'s
identity/value binds and `sendValueToBinding`), derivable from the pattern plus
the four roots above.

### (iii) "Computed" output cells — **16 `computed:`**, but they hold wiring, not values

12 `set` + 4 `patch`. Every one carries a **link**, not a derived value:

- the 12 `set` bodies are `{"result":{"/quote":{"/":{"link@1":{"id":"of:fid1:…"}}}}}`
- the 4 `patch` bodies are `[{"op":"add","path":"/value","value":{"/quote":{"/":{"link@1":{"id":"of:fid1:XfQeLs…"}}}}}]`
  — an `add /value` whose value is itself a link to an `of:` structure document.

The revision history of one such document over the whole run is two rows: `set`
at seq 9, `patch` at seq 11. Nothing else ever writes it. **These are
instantiation-time derived-internal cells, not first-run output.**

The same holds for every `value` payload in the commit's `of:` documents,
checked one by one: they are either static result projections carrying links
(`{"$NAME":"BacklinksIndex","$UI":{…}}`, `{"pieces":{…link@1…}}`) or bare
argument-schema **defaults** seeded create-only — `""`, `[]`, `{}`. Not one
derived value appears anywhere in the 50 operations.

That is corroborated by the code: after `instantiatePattern` wires the nodes,
each action is only *registered* with the scheduler
(`scheduler/facade.ts:620` → `registration.ts:113`), and every wake path calls
`queueExecution()`, which is `setTimeout(fn, 0)` (`facade.ts:1261`,
`diagnostics.ts:299`). Each run then mints its **own** transaction
(`scheduler/run.ts:508`) and commits it itself. **The first run's output cannot
be in this commit**, and measurably is not.

### (iv) `cid:` schema documents — **19**, and the client is not what requires them

Bodies are JSON Schema fragments (`{"value":{"type":"number"}}`,
`{"value":{"items":{"$ref":"cid:fid1:1RS1Hg…"},"type":"array"}}`, …), matching
the census. Three facts, together, answer the "does anything require the CLIENT
to write them" question with a plain **no**:

1. **Zero `cid:` reads.** The census measured no `cid:` confirmed read and no
   `cid:` document in the stale set; they are write-only in this commit.
2. **The client does not decide to write them.** They ride along automatically:
   `#stageSchemaDocsForValue` fires from *every* `write()`/`writeOrThrow()` on
   the extended transaction (`extended-storage-transaction.ts:2054`, `2146`,
   `2215`), with a full-scan backstop at `prepareCfc()`/`commit()`
   (`:1758`, `:2342`). Their only gate is the separate `contentAddressedSchemas`
   flag, not `serverExecution`.
3. **The server writes the same ones.** All 19 appear in wave commit #19, and
   in the store all 19 have their first revision at the wave's seq 11.

They are also content-addressed and idempotent (`cid:` re-sets of identical
content apply as no-ops, `extended-storage-transaction.ts:1677`), so the copy
that arrives second is semantically vacuous — which is exactly why exempting
them was tempting, and exactly why exempting them does not help: the census
already showed 15 non-computed `of:` ops remain.

## 4. Who else writes each class — the redundancy answer

**All four classes: the serving side writes them, through the same code, and in
the measured run it wrote all 50 first.**

| class | ops | serving side writes it? | evidence |
|---|---|---|---|
| (i) child-piece setup (piece roots) | 4 | **YES** | all 4 in the preceding wave; first revision at the wave's seq |
| (ii) `of:` structure/wiring | 11 | **YES** | all 11 in the preceding wave, every informative run |
| (iii) `computed:` wiring cells | 16 | **YES** | all 16 in the preceding wave, same verbs |
| (iv) `cid:` schema docs | 19 | **YES** | all 19 in the preceding wave; first revision at the wave's seq |

Stated as one number: **0 of the refused commit's 50 operations are absent from
the wave the serving side issued immediately before it** — in every informative
run measured (5/5; see the run ledger) — including the GREEN run s07.

Note that class (i) is a genuine refinement of "the server never writes setup".
That statement is true of the **top-level** piece: the serving loop's only
piece-start path is `space-server.ts:3279/3291` → `ensurePieceRunningVerdict` →
`ensure-piece-running.ts:198` `await runtime.start(resultCell)`, and
`ensure-piece-running.ts:196` says in as many words that it starts the existing
piece "without re-running setup and potentially allocating different metadata
cells" (there are no `runner.run` / `runtime.run(` calls anywhere in
`packages/toolshed/` or `packages/runner/src/executor/`). But `start()` on a
parent transitively performs `setupInternal` for every child *pattern node* it
instantiates, so the server does write child-piece setup — and measurably wrote
all four of these roots first.

The mechanism, traced: the serving loop's only piece-start path is
`space-server.ts:3279/3291` → `ensurePieceRunningVerdict` →
`ensure-piece-running.ts:198` `await runtime.start(resultCell)` →
`runtime.ts:2942` → `Runner.start` → `startCore` → `instantiateNode`. That is
**the same shared runner code the client runs** — there is no client/server
branch on any of the three write paths, and the client has no flag-gated skip
(the only `serverExecution` reference in the client packages is
`packages/shell/src/lib/env.ts:77`, which just reads the build define).

The one thing the server never does is **top-level piece creation** — the
`run()` entry point, which is what mints a piece that did not exist. Everything
downstream of an existing piece's `start()`, child-piece setup included, is
shared code that both sides execute.

**So the shrink the owner is reaching for has a measured size: 4 operations out
of 50.** The other 46 are structure, wiring and schema that the serving side
writes anyway, and in all five measured refusals had already written. Whether the
client should issue even those 4 is a different question — the piece they set up
is a *child* the server also instantiates, so on this evidence the durable
content unique to the client's deferred start is **zero**.

## 5. On the §3b read-and-render posture — and what N62 was deleted on

Worth recording against the owner's framing, since it bears on whether the
client should be issuing this commit at all: **"read-and-render" exists only as
spec prose, not as code.** `serving-loop.md:558` ("committed, so client reload
is read-and-render") and `runtime-mapping.md:523` ("clients no longer run
committed derivations at all") describe a posture nothing implements; the fork
memo's option (b), "adopt-not-start under ON", is explicitly future work, and it
calls the current client-side deferred start "a remnant still running against
it".

**The sharp form of this is N62.** Observation adoption was DELETED in Phase 1
stage C.2, and `runtime-mapping.md:520-524` states the premise plainly:

> "Adoption existed so N client runtimes didn't all re-run what one already ran
> — the multi-client symptom v2 removes at the root. Under the flag clients no
> longer run committed derivations at all (reload is read-and-render, §3b), so
> adoption has nothing to adopt."

The measurement here says that premise is **not yet true in code**. The client
and the serving loop each independently produced the same 50 operations for the
same four child pieces, in the same run — precisely "two runtimes re-running
what one already ran," the symptom adoption existed to prevent. N62's deletion
was justified by a posture (§3b read-and-render) that the client does not yet
adopt, so the deletion is currently running ahead of the code rather than behind
it. That is a spec-vs-implementation gap for the owner to weigh, not a defect in
the deletion decision: nothing here says adoption should come back, only that
the condition cited for removing it has not landed.

The measurement is what that remnant costs: one duplicated 50-op
materialization per piece start, which is refused whenever the server's copy of
the same work wins the race.

## 6. What this does NOT establish

Stated as gaps rather than inferred:

- **The TRIGGER of commits 1–4, and which piece each belongs to.** This is the
  half of the brief's question 1 that is not settled. Commit 5's trigger is
  established — it is the deferred start tx minted in
  `startAfterSuccessfulCommit`'s commit callback, identified by composition
  match with the census and by the `tx-commit-error … Error committing deferred
  start transaction` signature. Commits 1–4 are characterized only by *what they
  contain* (composition, document sets, disjointness, piece-root counts), not by
  which code path issued them. Each could be another deferred start, an
  `editWithRetry` originating tx, or one of `startCore`'s self-minted
  fire-and-forget `piece-instantiate/…` transactions
  (`runner.ts:2507-2582`); the server-side tap cannot tell these apart, and I
  did not add the client-side instrumentation that could. Relatedly I did **not**
  establish that commit 4 is the setup half of the *same* piece commit 5
  instantiates — their `cid:` sets are disjoint, which points at different
  patterns. The chain is a descent through a piece graph; its exact parentage
  was not resolved.
- ~~Whether the four piece roots are the navigated piece or its children.~~
  **Resolved** — they are children (`BacklinksIndex`, `SummaryIndex`, and two
  `Grid View` instances of one pattern). What is still *not* established is
  which piece the navigate itself targeted, and therefore where in the chain of
  five commits that piece's own root was written.
- **Invariance across runs — measured 5/5, which is fewer than the census's
  18/18.** See the run ledger in the Bench section. Five informative runs
  (s01, s02, s05, s06 RED; s07 GREEN), all showing the same five-commit
  sequence, the same refusal at commit 5, and 50/50 client operations covered
  by a preceding wave. A first pair of confirmation runs (s03, s04) turned out **not** to be
  informative: reverting the scratch edit re-enabled the step's ON skip, so the
  step was `ignored` — a reminder that the skip file is read by the test
  process from source, not baked into the binary. No GREEN run was sampled
  with the step enabled, so "the first session always loses the race" is
  measured on reds only.
- **Whether shrinking the commit would fix arm B — and there is now direct
  evidence AGAINST assuming it would.** This is a measurement of what is in the
  commit and who else writes it, not a validation of any disposition. Run s07
  passed *with the same refusal*, by the same 50/50 wave, in its first session.
  Across 5 informative runs the refusal is 5/5 and the verdict is 4 red / 1
  green, so the refusal does not discriminate. Removing the client's redundant
  materialization would remove this refusal; on this evidence it would **not**
  follow that arm B goes green, because the refusal is present on a green too.
  Whatever separates red from green lives downstream of it — which is exactly
  what the census concluded from its own 18 captures.
- **Whether the wave path imposes any scheme restriction on derived-class
  commits.** The wave commits observed here carry all three schemes, but the
  admission side was not audited.
- **The complete set of builtins that may write at instantiation time.**
  `instantiateRawNode` calls `module.implementation(...)` synchronously with the
  start tx, so a builtin factory could stage writes there; not all builtins were
  audited.
