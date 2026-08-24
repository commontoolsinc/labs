---
status: historical
created: 2026-08-23
archived: 2026-08-23
reason: "Measurement answering the owner's OW45 arm-B question: is the refused 50-op deferred-start commit the piece's initial MATERIALIZATION, or a FOLLOW-UP first wave the client runs after a smaller materialization already landed? VERDICT — MATERIALIZATION, specifically the node-INSTANTIATION half of it, and it is the 5th and last of five client start commits (9, 23, 28, 46, 50 ops) of which the first four land successfully. So the owner is right that a smaller commit already lands first, but wrong that the 50-op commit is a derivation wave: no first-run output is in it (every `computed:` op it writes holds a wiring LINK, not a derived value; the scheduler's first run is a later macrotask in its own transactions). The decisive new fact is redundancy, not ordering: the SERVING side's own derived wave commit writes the identical 50 documents — the same 50 (verb, id) tuples, 16 `computed:` / 15 `of:` / 19 `cid:`, patch=4 + set=46 — and whichever side arrives second is refused as stale. Measured both directions in ONE run: session A's client lost to wave localSeq 7 and was REFUSED; session B's client won and the byte-identical commit was ACCEPTED. The client's whole deferred-start commit is therefore duplicated work under ON, and the only durable content the serving side structurally cannot supply (the setup half — pattern identity, argument, stored-setup marker) is NOT in the refused commit: it landed earlier, in the accepted commits."
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
commit writes **the identical 50 documents** — the same 50 `(verb, id)` tuples,
the same 16/15/19 scheme split, the same `patch=4, set=46` verb split — and
whichever side arrives second is refused as stale. This was measured in both
directions inside a single run.

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

### The same commit is ACCEPTED when the client wins the race

The reload session in the *same run* ran the identical five-commit sequence:

| # | class | localSeq | ops | verdict |
|---|---|---|---|---|
| 68–69 | authored | 4 | 46 | ACCEPT |
| 70 | derived | 32 | 1 | — |
| **71–72** | **authored** | **5** | **50** | **ACCEPT** |
| 73–74 | derived | 33, 34 | 13, 27 | — |

Here no 50-op wave preceded it, the client's commit landed, and the serving side
then did smaller follow-up waves *over the client's writes* instead of
materializing the piece itself.

This is the cleanest available statement of the defect: **the accept/refuse
outcome is decided entirely by which of two sides doing identical work arrives
first.** It also explains the census's otherwise puzzling result that the
refused commit is doc-for-doc identical on greens and reds — it is literally the
same commit; only the race outcome differs.

## 3. The 50 operations, classified

Read from the stored document values (the accepted copies of the same
documents, pulled from the run's sqlite store).

### (i) Irreducible materialization — **0 of the 50**

Nothing in this commit is the piece's identity or entry point. The pattern
pointer (`patternIdentity`), the argument document, the result cell's `schema`
meta and the stored-setup marker are all written by `setupInternal` /
`applySetupState` (`runner.ts:2098`, `1913`) into the **originating**
transaction — i.e. they are in commits 1–4, which landed. By the time the
refused commit is issued, the piece's identity is already durable.

### (ii) Authoritative structure the server also writes — **15 `of:`**

The piece graph's argument/result wiring. Measured shapes: **4** documents whose
body is an `argument` write-redirect link, **11** whose body is a `result` link,
each of the form
`{"result":{"/quote":{"/":{"link@1":{"id":"of:fid1:…","overwrite":"redirect",…}}}}}`.
These are node-instantiation products (`instantiateNode` →
`instantiatePatternNode`'s identity/value binds and `sendValueToBinding`), not
setup products.

### (iii) "Computed" output cells — **16 `computed:`**, but they hold wiring, not values

12 `set` + 4 `patch`. Every one carries a **link**, not a derived value:

- the 12 `set` bodies are `{"result":{"/quote":{"/":{"link@1":{"id":"of:fid1:…"}}}}}`
- the 4 `patch` bodies are `[{"op":"add","path":"/value","value":{"/quote":{"/":{"link@1":{"id":"of:fid1:XfQeLs…"}}}}}]`
  — an `add /value` whose value is itself a link to an `of:` structure document.

The revision history of one such document over the whole run is two rows: `set`
at seq 9, `patch` at seq 11. Nothing else ever writes it. **These are
instantiation-time derived-internal cells, not first-run output.**

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
| (i) irreducible materialization (setup) | 0 in this commit | **NO** | the loop calls `runtime.start()`, never `run()` |
| (ii) `of:` structure/wiring | 15 | **YES** | all 15 in wave #19; first revision at the wave's seq |
| (iii) `computed:` wiring cells | 16 | **YES** | all 16 in wave #19, same verbs |
| (iv) `cid:` schema docs | 19 | **YES** | all 19 in wave #19, first revision at the wave's seq |

The mechanism, traced: the serving loop's only piece-start path is
`space-server.ts:3279/3291` → `ensurePieceRunningVerdict` →
`ensure-piece-running.ts:198` `await runtime.start(resultCell)` →
`runtime.ts:2942` → `Runner.start` → `startCore` → `instantiateNode`. That is
**the same shared runner code the client runs** — there is no client/server
branch on any of the three write paths, and the client has no flag-gated skip
(the only `serverExecution` reference in the client packages is
`packages/shell/src/lib/env.ts:77`, which just reads the build define).

The one thing the server never does is **setup**. `ensure-piece-running.ts:196`
says so in as many words — it starts the existing piece "without re-running
setup and potentially allocating different metadata cells" — and there are no
`runner.run` / `runtime.run(` calls anywhere in `packages/toolshed/` or
`packages/runner/src/executor/`.

**So the split the owner is reaching for already exists in the code, one level
up from where he expected it.** Piece *creation* (setup) is client-only and
already lands in its own earlier, retrying, accepted commit. Piece
*instantiation* is shared, and the client's copy of it is fully redundant with a
wave the server issues anyway.

## 5. On the §3b read-and-render posture

Worth recording against the owner's framing, since it bears on whether the
client should be issuing this commit at all: **"read-and-render" exists only as
spec prose, not as code.** `serving-loop.md:558` ("committed, so client reload
is read-and-render") and `runtime-mapping.md:523` ("clients no longer run
committed derivations at all") describe a posture nothing implements; the fork
memo's option (b), "adopt-not-start under ON", is explicitly future work, and it
calls the current client-side deferred start "a remnant still running against
it". The measurement here is what that remnant costs: one duplicated 50-op
materialization per piece start, which is refused whenever the server's copy of
the same work wins the race.

## 6. What this does NOT establish

Stated as gaps rather than inferred:

- **Which piece each of commits 1–4 belongs to, by name.** Their compositions,
  their document sets and their disjointness are measured; the mapping from each
  commit to a named pattern/piece in the default app is not. In particular I did
  **not** establish that commit 4 is the setup half of the *same* piece commit 5
  instantiates — their `cid:` sets are disjoint, which suggests different
  patterns. What is established is that no setup-class write appears in commit 5.
- **Invariance across runs.** Everything above is from run s01 (one red run,
  two browser sessions, both showing the same five-commit sequence with
  compositions 9/23/28/46/50). Confirmation runs were still in flight when this
  report was written; the report should not be read as claiming an 18/18-style
  invariance the census earned for its own measurement.
- **Whether shrinking the commit would fix arm B.** This is a measurement of
  what is in the commit and who else writes it, not a validation of any
  disposition. Note in particular the census's finding that the refused commit
  carries no signal distinguishing a run that will red from one that will not.
- **Whether the wave path imposes any scheme restriction on derived-class
  commits.** The wave commits observed here carry all three schemes, but the
  admission side was not audited.
- **The complete set of builtins that may write at instantiation time.**
  `instantiateRawNode` calls `module.implementation(...)` synchronously with the
  start tx, so a builtin factory could stage writes there; not all builtins were
  audited.
