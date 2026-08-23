---
status: historical
created: 2026-08-23
archived: 2026-08-23
reason: "Measurement for the owner's OW45 arm-B arm choice: a live census of the flag-ON client's navigate-deferred piece-start commit at the moment the server refuses it. The commit is MIXED — 34 of its 50 semantic operations target non-computed entities (15 `of:`, 19 `cid:`) — so computed-cell-identity.md's phase-2 ack-and-drop, which is specified for ALL-COMPUTED commits only and explicitly holds mixed commits to strict semantics, does NOT reach this failure. The stale read set is 95 of 143 confirmed reads spanning 40 DISTINCT documents, so no single-doc repair converges either. Also settles that the error message's `at seq 0` is an artifact of array order (the engine reports `reads.confirmed[0]`), not a property of the commit."
---

# The OW45 arm-B commit census — what is actually in the refused deferred-start commit?

**VERDICT: the refused navigate-deferred piece-start commit is MIXED, not
all-computed.** 34 of its 50 semantic operations target non-computed
entities (15 `of:`, 19 `cid:`); only 16 are `computed:`. Under
`docs/specs/computed-cell-identity.md` § "Server conflict policy" — *"Mixed
commits (computed and non-computed operations together): strict semantics
for the whole commit"* — phase 2's ack-and-drop **does not reach this
failure at all**.

## Why this was asked

The arm-B fork memo
(`optimize/ow45-armb-client-start-fork.md`) root-caused the remaining
arm-B defect to the flag-ON client's navigate-deferred piece start dying
terminally on
`ConflictError: stale confirmed read: computed:… at seq 0 conflicted with
seq N`, with no retry arm. One candidate disposition is to let the server
drop such commits (computed-cell-identity.md's phase 2). The spec grants
ack-and-drop **only** to all-computed commits, and notes that "pure
recompute transactions write only their computed output cells, so the
all-computed case is the common one" — but a deferred START is not a pure
recompute. This census resolves whether phase 2 would reach it.

## Bench

- Head `26be6c909` (origin/main), worktree
  `claude/server-exec-v2-armb-commit-census`.
- **Disposition (a) — the retry — is NOT on main.** It lives only on the
  unmerged `client-start-retry` branch. So this measures the true terminal
  behavior the fork memo describes.
- Gate: `packages/patterns/integration/default-app.test.ts`, the
  harness preserved at `/Users/berni/labs-worktrees/ow45sc-gatework/run.sh`,
  re-pointed at this worktree with the instrumented-client aid
  (`FORWARD_WORKER_CONSOLE=1 PIPE_CONSOLE=1`). ON-built toolshed binary
  from this worktree, **fresh store per run, posture probed per run**
  (`shellServerExecutionDefine=true servingLoop=present`), port 9661.
- **Ambient load only — no synthetic burners.** (The 6-burner regime at
  load ~11.7 induced a different defect and never reproduced arm B.)
- The step's ON skip entry (`tasks/server-execution-on-skips.ts`) was
  removed for the census so the step actually runs; run c01 confirms that
  with the skip in place the step is `ignored` and no deferred start
  occurs.

### Two instruments, and what each contributes

1. **The product's own error payload** (no patch needed). The runner's
   `tx-commit-error … Error committing deferred start transaction` log
   line already embeds the **entire transaction** — `localSeq`,
   `reads.confirmed`, `reads.pending`, and `operations` (57,192 chars in
   the captured line). This is the op-set/read-set source of record below,
   and it means the census was reconstructible from any instrumented run.
2. **A scratch engine patch** at `validateConfirmedReads`
   (`packages/memory/v2/engine.ts`), which computes `findConflictSeq` for
   **every** confirmed read rather than stopping at the first, then dumps
   the whole commit. This is the only way to get the COMPLETE stale set —
   the client payload carries the reads, but not which of them conflict.
   Correlation between the two is exact on the
   `(id, seq, conflictSeq)` triple.

Both instruments are scratch and are **not** part of this commit; only
this report is.

## 1. The operation (write) set — MIXED

Captured deferred-start refusal, `localSeq 5`:

| | count |
|---|---|
| operations, total | 50 |
| semantic (set/patch) | 50 |
| non-semantic (`sqlite`) | 0 |
| **`computed:`** | **16** |
| **`of:`** | **15** |
| **`cid:`** | **19** |

Verb split: 46 `set`, 4 `patch`. All 4 `patch` ops target `computed:`
docs; the 46 `set` ops interleave all three schemes.

The 34 non-computed ops are what force MIXED. Both non-computed schemes
parse as **no kind** under `entityKindOfIdString` (only `computed:` is a
kind; every other scheme, `of:` and `cid:` included, returns `undefined`
and "callers must treat as strict/authoritative, never relaxed"). A
representative sample of the ids:

```
set    none(of:)      of:fid1:heLjgID8NQZd8Y1fDLCoTZjdITYyznd1EmSIf1_bGHg
set    none(cid:)     cid:fid1:u6mY3JpPu0v6vdfhJSwG3hirREmwD0AIFMO-6cSesOI
set    none(of:)      of:fid1:T01cEZZ9LuDey1z0PNEzklTkorxVf8KjXXlgv9OOhfk
set    none(cid:)     cid:fid1:sHYonvNehSLXRvMQTmzDUsR_eHRrTKlOcqqj47-ziXI
set    none(of:)      of:fid1:wFfyJBbDw1XOiO0hyKbblKEKZ-yzb2ZjEIZzYiTz07g
…  (34 in total: 15 `of:`, 19 `cid:`)
```

This is a whole-piece structure write — the started piece's docs and its
content-addressed module/schema documents — not a recompute of computed
output cells. It is exactly the case the spec's own sentence carves OUT of
phase 2.

### What the three schemes actually are

Read from the operation payloads, this is a whole-piece instantiation:

- **19 `cid:` ops — content-addressed SCHEMA documents.** Bodies are JSON
  Schema fragments: `{"value":{"type":"number"}}`,
  `{"value":{"type":"string","default":""}}`,
  `{"value":{"type":"array","items":{"$ref":"cid:fid1:1RS1Hg…"}}}`.
- **15 `of:` ops — the piece's authoritative STRUCTURE docs**: the
  argument/result wiring, e.g.
  `{"result":{"/":{"link@1":{…,"id":"of:fid1:heLjgID8…","overwrite":"redirect"}}},"value":…}`,
  plus the piece's own `{"schema":{…}}` document.
- **16 `computed:` ops** — the piece's computed output cells. All 4
  `patch` ops are here, each an `add /value` pointing at an `of:`
  structure doc.

So the commit writes the piece's authoritative structure, its schema
registry, and its computed outputs in one atomic transaction. That is
categorically not the "pure recompute transaction" the spec expects to be
the common all-computed case.

### And the content-addressed exemption does not rescue it

A tempting sub-arm is that `cid:` writes are content-addressed — their
value is a function of their id, so a "conflict" on one is semantically
vacuous — and could be exempted from the classification. Measured, that
sub-arm still fails:

- The 19 `cid:` documents are **written but never read**: the commit has
  **zero** `cid:` confirmed reads, and no `cid:` document appears anywhere
  in the stale set.
- **Exempting all 19 still leaves 31 semantic ops of which 15 are
  non-computed `of:`** — genuine authoritative state. The commit is
  **still MIXED**.

The read/write shape overall: 50 written docs, of which 31 are also read
(read-modify-write) and 19 are write-only (all `cid:`). Of the 40 stale
documents, 31 are also written by this commit and 9 are read-only.

## 2. The confirmed-read set — 40 distinct stale documents, not one

The engine's message names only `reads.confirmed[0]`. The full set, from
the all-reads engine patch:

| | count |
|---|---|
| confirmed reads, total | 143 |
| **stale (conflicting)** | **95** |
| **distinct stale documents** | **40** |
| stale that are `computed:` | 35 reads |
| stale that are `of:` | 60 reads |
| stale read at seq 0 | 82 reads |
| stale read at seq 9 | 13 reads |
| pending reads | 0 |

Two distinct conflict frontiers appear in one commit: `conflictSeq` 11 and
12.

**Answer to "one doc or several": several — 40.** The staleness is not
localized to the entity the error names, and it spans both kinds (23
distinct computed docs and 17 distinct `of:` docs in the first capture).
No single-document repair could converge this commit.

## 3. The `at seq 0` in the error message is an array-order artifact

The fork memo records the signature as `computed:… at seq 0 conflicted
with seq 10`. The captures here read `computed:… at seq 9 conflicted with
seq 12` and `… at seq 11`. This is **not** a different defect:
`validateConfirmedReads` iterates `commit.reads.confirmed` in order and
throws on the first conflict, so the reported read is literally
`reads.confirmed[0]` whenever element 0 is stale — which it was in every
capture. The commit carries stale reads at **both** seq 0 and seq 9
simultaneously; which one the message names depends only on which sits at
the head of the array.

Consequence for the arm choice: **any rule keyed on the reported read's
seq or kind is keyed on an artifact.** The commit must be classified by
its whole composition, which is what the tables above give.

## 4. The single-chain shape shares the mechanism

Run **c03 reproduced the h01/h05 single-chain shape exactly** —
`isNotebook: true, noteCount: 7, notesLength: 7, mentionableLength: 7,
storedUiNoteChips: 12, renderedNoteChips: 6` — failing on the 300 s
`waitForCondition` timeout (`packages/integration/utils.ts:569`).

In that red the deferred-start refusal is present, and it is **the same
mechanism and the same commit**: `localSeq 5`, 50 operations
(16 `computed:` / 15 `of:` / 19 `cid:`), 143 confirmed reads, 95 stale
across 40 distinct documents, MIXED — and its first conflict carries the
fork memo's exact signature, `computed:… at seq 0 conflicted with seq 11`.

So the answer to "does the single-chain shape share this mechanism, or is
its conflicted entity different, or is there no start refusal at all" is:
**it shares it.** There is a start refusal, its conflicted entity is a
`computed:` document read at seq 0, and its commit composition is
indistinguishable from every other capture.

## 5. The refusal is NOT sufficient for the red — and does not even correlate

Every green run carried refusals too:

- c02 (green, step `ok`): **2** refusals.
- c04 (green): **2** refusals. c05 (green): **2**.
- c03 (**red**): **1** refusal.

So the client-start die-off is **not sufficient** for the arm-B red, and
refusal *count* does not track redness in the naive direction — the red
had fewer than the greens. Nor does the first-conflict seq track it: c04
is green with two `seq 0 → 11` heads, the same head the red carries. Any
fix validated only against the step's red/green verdict is therefore
measuring a coarser and noisier signal than the mechanism itself; the
refusal is directly observable on every run and is the better bench.

## 6. The composition is invariant

Across every capture the commit is bit-stable: 50 operations
(16 / 15 / 19 by scheme), 143 confirmed reads, 0 pending reads, and 95
stale reads over 40 distinct documents (one capture measured 91/36). This
is a structural property of the navigate-deferred piece start, not a
race-dependent shape — only *which* read sits at the array head varies,
and that is the artifact described in §3.

## What the preserved h-run stores can and cannot settle

The preserved artifacts at `/Users/berni/labs-worktrees/ow45sc-gatework/`
(h01–h10, mut1/mut2, off1–off3; ~1.3 GB, real sqlite stores plus server
logs) **cannot** settle this question, and this was checked before running
anything:

- `grep -rl "stale confirmed read"` over the whole gatework tree returns
  **nothing**. Those runs were un-instrumented: `tx-commit-error` count 0
  and forwarded `[worker]` line count 0 in `toolshed-h01/h04/h05.log`.
- The `ConflictError` occurrences that *are* in those logs are a different
  class — the server-side §3d drop (`pure derivation dropped: derived from
  a withdrawn contribution`), not a stale-confirmed-read refusal.
- Structurally, the refusal is a **client-side commit rejection that never
  reaches the store**, and the memos are emphatic that the server side of
  an arm-B red is indistinguishable from a green. The stores confirm the
  no-data-loss half and the seq ordering; they cannot carry the op set or
  the read set of a commit that was refused.

So a fresh instrumented run was required, and is what produced everything
above.
