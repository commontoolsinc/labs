---
status: historical
created: 2026-08-23
archived: 2026-08-23
reason: "Measurement for the owner's OW45 arm-B arm choice: a live census of the flag-ON client's navigate-deferred piece-start commit at the moment the server refuses it. VERDICT — the commit is MIXED in 18 of 18 captures across 12 gate runs, with ONE distinct shape: 34 of its 50 semantic operations target non-computed entities (15 `of:` structure docs, 19 `cid:` schema docs), only 16 are computed. So computed-cell-identity.md's phase-2 ack-and-drop, specified for ALL-COMPUTED commits only and explicitly holding mixed commits to strict semantics, does NOT reach this failure; and exempting the content-addressed writes still leaves 15 non-computed ops, so that sub-arm fails too. The stale read set is 95 of 143 confirmed reads spanning 40 DISTINCT documents, so no single-doc repair converges either. BOTH arm-B shapes reproduced (single-chain c03, whole-piece c11 matching b04 down to storedUiNoteChips 98) and their refused commits are identical in every measured field — two downstream consequences of one refusal, not two mechanisms. Three further facts the arm choice needs: the error message's `at seq 0` is an artifact of array order (the engine reports `reads.confirmed[0]`), the refusal fires on GREEN runs too (15 of the 18 captures), and the red's commit is doc-for-doc identical to the greens' — so the server cannot distinguish the harmful refusal from the benign one at commit-apply time."
---

# The OW45 arm-B commit census — what is actually in the refused deferred-start commit?

**VERDICT: the refused navigate-deferred piece-start commit is MIXED, not
all-computed — in 18 of 18 captures, with one distinct shape and no
all-computed instance.** 34 of its 50 semantic operations target
non-computed entities (15 `of:`, 19 `cid:`); only 16 are `computed:`.
Under `docs/specs/computed-cell-identity.md` § "Server conflict policy" —
*"Mixed commits (computed and non-computed operations together): strict
semantics for the whole commit"* — phase 2's ack-and-drop **does not
reach this failure at all**.

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

## 4. BOTH arm-B shapes reproduced — and they are one thing at the commit

The fork memo's caution was not to assume the remainder is a single
defect. Measured, at the level of the refused commit, it is:

| shape | run | load | diagnostics | refused commit |
|---|---|---|---|---|
| **single-chain** (h01/h05) | c03 | 3.08 | `isNotebook: true, noteCount: 7, notesLength: 7, mentionableLength: 7, storedUiNoteChips: 12, renderedNoteChips: 6` | MIXED, 50 ops (16/15/19), 143 reads, 95 stale / 40 docs, head `0→11` |
| **whole-piece** (h04/b04) | c11 | 5.91 | `isNotebook: false, noteCount: -1, notesLength: 0, mentionableLength: 0, storedUiNoteChips: 98` | MIXED, 50 ops (16/15/19), 143 reads, 95 stale / 40 docs, head `0→11` |

c11 reproduces the fork memo's b04 whole-piece capture exactly, down to
`storedUiNoteChips: 98`. Both reds failed on the 300 s
`waitForCondition` timeout, both carried **one** deferred-start refusal,
and **their refused commits are identical in every measured field** —
op count and scheme split, read count, stale count, distinct stale docs
and their 23/17 kind split, conflict frontiers `[11, 12]`, zero pending
reads, no preconditions.

So the two surface shapes are two *downstream consequences* of the same
refusal, not two mechanisms. Whatever differs between them differs after
the commit is refused, not in what was refused.

Both reds failed on the 300 s `waitForCondition` timeout at
`packages/integration/utils.ts:569`, and both carry the fork memo's exact
signature, `computed:… at seq 0 conflicted with seq 11`.

**Answering the brief's question directly:** the single-chain shape does
**not** have a different conflicted entity, and it is **not** a case with
no start refusal. It has a start refusal, its conflicted entity is a
`computed:` document read at seq 0, and its commit is indistinguishable
from the whole-piece shape's and from every green's.

## 5. The refusal is NOT sufficient for the red — and does not even correlate

Every green run carried refusals too — 15 of the 18 captures come from
runs that PASSED:

- greens c02, c04, c05, c06, c07, c09: **2** refusals each.
- greens c08, c10, c12: **1** each.
- reds c03 and c11: **1** each.

So the client-start die-off is **not sufficient** for the arm-B red, and
refusal *count* does not track redness in the naive direction — the red
had fewer than the greens. Nor does the first-conflict seq track it: c04
is green with two `seq 0 → 11` heads, the same head the red carries. Any
fix validated only against the step's red/green verdict is therefore
measuring a coarser and noisier signal than the mechanism itself; the
refusal is directly observable on every run and is the better bench.

### The red's commit is indistinguishable from the greens'

Comparing the full stale sets doc-by-doc between the red (c03) and the
greens (c02, c04):

| run | verdict | head | stale docs | computed | `of:` | docs read at seq 0 | conflict frontiers |
|---|---|---|---|---|---|---|---|
| c02 | green | 9→12 | 40 | 23 | 17 | 27 | 11, 12 |
| c02 | green | 9→11 | 40 | 23 | 17 | 27 | 11 |
| **c03** | **RED** | 0→11 | 40 | 23 | 17 | 27 | 11, 12 |
| c04 | green | 0→11 | 40 | 23 | 17 | 27 | 11, 12 |
| c04 | green | 0→11 | 40 | 23 | 17 | 27 | 11 |

**The refused commit carries no signal about whether the run will red.**
This bounds what any server-side commit-classification rule can achieve
here: the server cannot tell the harmful refusal from the benign one,
because at commit-apply time they are the same commit. Whatever the
server does with this commit, it does uniformly to both. The red/green
difference lives downstream of the refusal, not in it.

### The rest of the commit envelope

Uniform across every capture, and worth recording because the spec's
phase-3 lineage question turns on it:

- `preconditions`: **none** (empty).
- `eventAppends`: **0**.
- `reads.pending`: **0** — the commit is based **entirely on confirmed
  state**, with no optimistic layer beneath it.
- `branch`: default.

So the "descendant built from a dropped optimistic value" hazard the spec
flags as PROVISIONAL does not arise *within* this commit — it has no
pending basis of its own. It says nothing about commits built on top of
*it*, which is where that hazard would live.

## 6. The composition is invariant across all 18 captures

| measured field | value | captures |
|---|---|---|
| verdict | **MIXED** | **18 / 18** |
| `(ops, computed, of:, cid:, reads)` | `(50, 16, 15, 19, 143)` | **18 / 18** — one distinct shape |
| `(stale reads, distinct stale docs)` | `(95, 40)` | 17 / 18 |
| | `(91, 36)` | 1 / 18 |
| pending reads / preconditions / eventAppends | `0` / none / `0` | 18 / 18 |

**Not one all-computed capture.** The commit's composition is a
structural property of the navigate-deferred piece start, not a
race-dependent shape — only *which* read sits at the array head varies,
and that is the artifact described in §3.

## Run ledger

12 runs, all at the true ON topology (posture probed per run:
`shellServerExecutionDefine=true servingLoop=present`), fresh store per
run, port 9661, **ambient load only — no synthetic burners**.

| run | exit | wall | load before/after | step | refusals | shape |
|---|---|---|---|---|---|---|
| c01 | 0 | 12s | 4.43 / 4.69 | `ignored` (skip still in place) | 1 | — |
| c02 | 0 | 24s | 3.88 / 4.41 | ok (16s) | 2 | — |
| **c03** | **1** | **324s** | **3.08 / 2.86** | **FAILED (5m15s)** | 1 | **single-chain** |
| c04 | 0 | 23s | 2.86 / 3.56 | ok (15s) | 2 | — |
| c05 | 0 | 37s | 3.52 / 3.89 | ok (25s) | 2 | — |
| c06 | 0 | 37s | 3.98 / 5.00 | ok (20s) | 2 | — |
| c07 | 0 | 27s | 5.00 / 4.93 | ok (15s) | 2 | — |
| c08 | 0 | 23s | 4.77 / 4.83 | ok (13s) | 1 | — |
| c09 | 0 | 27s | 4.60 / 6.63 | ok (17s) | 2 | — |
| c10 | 0 | 21s | 6.58 / 6.17 | ok (12s) | 1 | — |
| **c11** | **1** | **324s** | **5.91 / 2.06** | **FAILED (5m15s)** | 1 | **whole-piece** |
| c12 | 0 | 23s | 2.29 / 2.92 | ok (14s) | 1 | — |

- **2 reds in 11 informative runs** (c01's step was skipped), consistent
  with the historical 3/5 and 2/7 rates.
- Loads spanned **2.29 – 6.63**. Note c10 was **green at 6.58**, inside
  the band the historical reds came from — load does not determine the
  outcome within this range.
- **18 deferred-start refusals captured in total**, 15 of them from runs
  that passed.

### What did NOT reproduce, stated honestly

- **No all-computed deferred-start commit, in any run.** This is the
  measurement's central negative result rather than a gap.
- **No load above ~6.6 was sampled**, because adding synthetic load is
  ruled out for this bench (the 6-burner regime at ~11.7 induced a
  different defect and never reproduced arm B). The h04-class "load spike
  ~20" regime is therefore unsampled here — though its *shape* did
  reproduce at ambient 5.91 in c11, so the shape does not require the
  spike.
- The `ARMB_WIRE` client-side tag written for this census never fired;
  it was redundant, because the runner's own error payload already
  carries the whole transaction. Nothing depends on it.

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
