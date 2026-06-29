# Cellset last-write-wins for scalar `$value` writes — context & status

**PR:** [#4245](https://github.com/commontoolsinc/labs/pull/4245) (draft) ·
**branch:** `fix/cellset-blind-leaf-write` ·
**supersedes:** #4126 (closed), #4196 (closed)

This is a working-context document for picking the PR back up cold. It records
the bug, the fix, *why the fix is shaped the way it is*, how it's verified, how
it relates to the conflict-handling work that landed while it was parked, and
the open questions for the area owner (Robin / ubik2).

---

## TL;DR

A scalar `$value`/`$checked` UI write was committed as a **compare-and-set**, so
under concurrent same-user edits it lost an own-write race, was rejected and
rolled back, and the edit silently vanished — the `cfc-group-chat-demo`
"Name not set" flake. The fix makes a scalar `$value` write a **precondition-free
last-write-wins leaf overwrite**: `handleCellSet` marks its transaction so the
write records no concurrency precondition. Structured (array/object) values are
left alone (they're often read-modify-write). Verified by a headless
multi-runtime regression test (fails-without / passes-with) plus a real
two-browser run, and confirmed to **still add value** after rebasing onto the
new conflict-handling world (#4220/#4210/#4343/#4366/#4367).

---

## 1. The bug

The `cfc-group-chat-demo` two-browser CI flake — a user's profile name stays
**"Name not set"** under contention — had two independent mechanisms:

1. **Handler-delivery** (lost trusted click / cross-thread handler retirement) —
   fixed separately in **#4146**. Not this PR.
2. **Cell-write drop** — this PR.

**Mechanism #2, root cause.** Writing a scalar `$value` goes
`UI → CellHandle.set → CellSet IPC → RuntimeProcessor.handleCellSet → Cell.set →
diffAndUpdate → normalizeAndDiff`. To diff, `normalizeAndDiff` **reads the write
target** (`packages/runner/src/data-updating.ts`, the `tx.readValueOrThrow(link)`
on the value being written). That read is recorded as a **commit precondition**
two ways:

- engine side — it becomes a `reads.confirmed` entry (via `buildReads` in
  `packages/runner/src/storage/v2.ts`), checked by `validateConfirmedReads` →
  `findConflictSeq` in `packages/memory/v2/engine.ts`;
- client side — `V2StorageTransaction.read()` marks the doc `validated`, which
  `validate()` turns into a compare-and-swap `claim()`.

So a `$value` write is "only apply if the target is unchanged since I read it."
Under an **own-write race** — two sessions/tabs of one user sharing the PerUser
`profileDraft`, **or** the typed `$value` set racing the save handler's own
`nameDraft.set` ([`trusted.tsx:533`](../../../packages/patterns/cfc-group-chat-demo/trusted.tsx))
— the write-target read is baselined at a stale seq and loses:
`ConflictError: stale confirmed read: <id> at seq N conflicted with seq M`. The
write is **rejected and rolled back**, the draft reverts, and the save handler
(`commitTrustedProfileSave`, which reads
[`draftText(nameDraft)` at `trusted.tsx:530`](../../../packages/patterns/cfc-group-chat-demo/trusted.tsx))
reads the wrong/empty draft → the typed name is lost.

**The conflict is tier-2 (patch path-overlap) on the *same* leaf path**
`["value","profileDraft"]` — both writers patch the same leaf. (An early model
called it tier-1 path-blind; instrumentation on the multi-runtime probe corrected
that — it's same-leaf tier-2.)

---

## 2. The fix

`RuntimeProcessor.handleCellSet`
([`runtime-processor.ts:689`](../../../packages/runtime-client/backends/runtime-processor.ts))
marks its transaction as a **blind-leaf-write**, but only:

- **for scalar values** (`typeof === "string" | "number" | "boolean"`,
  line 703), and
- **around the `cell.set()` call only** — mark at line 705, **unmark at line 707**
  before `prepareTxForCommit`.

While the tx is marked, `V2StorageTransaction.read()`
([`v2-transaction.ts:1335`](../../../packages/runner/src/storage/v2-transaction.ts)):
tags every read with `ignoreReadForCommit` and **skips setting `doc.validated`**;
and `buildReads` ([`v2.ts:2170`](../../../packages/runner/src/storage/v2.ts))
**drops** `ignoreReadForCommit` reads from `reads.confirmed`. Net: the write
carries **no concurrency precondition** on either side → precondition-free
last-write-wins, which is correct for raw scalar UI input.

The marker registry lives in
[`reactivity-log.ts`](../../../packages/runner/src/storage/reactivity-log.ts):
`markUiInputBlindWriteTx` / `unmarkUiInputBlindWriteTx` / `isUiInputBlindWriteTx`
(lines 122/125/128) + the `ignoreReadForCommit` metadata marker (line 50). The
mark walks the tx wrapper chain so both the `ExtendedStorageTransaction` and the
inner `V2StorageTransaction` are marked.

### Why it's shaped this way (the load-bearing decisions)

These came out of a 3-agent audit that **blocked** the first (whole-transaction)
prototype:

- **Scalar-only, not all of `handleCellSet`.** `CellHandle.set` is the *sole*
  `CellSet` sender, but it is *also* the read-modify-write path —
  `CellHandle.push`, `cf-autocomplete` multi-select, `ArrayCellController`
  (add/remove/update). Blind LWW on those reintroduces **lost updates** on
  concurrent array appends. Scalars are full overwrites (LWW-safe); array/object
  values may be RMW, so they **keep compare-and-set**. The value type is the
  reliable partition — a flag at `cell-controller.defaultSetValue` does *not*
  work, because autocomplete's RMW routes through that same setter.
- **Around `set()` only, not the whole tx.** `prepareTxForCommit → prepareCfc →
  prepareBoundaryCommit` persists CFC label / `cid:` schema docs as
  **read-then-write in the same tx**. Marking the whole tx would strip *those*
  preconditions too, letting a concurrent label/classification change be
  clobbered. Unmarking before `prepareTxForCommit` keeps them.
- **Preserved invariants (verified):** CFC enforcement rides `attemptedWrites`
  (the `markReadAsAttemptedWrite` read, kept) — not `reads.confirmed`/`validated`
  — so it's intact. Reactivity/subscriptions ride `ignoreReadForScheduling`,
  which the fix never sets, so the self-subscription is intact.

### Things tried and dropped

- **No-op-suppression bypass / force-write** (making a same-value re-set still
  send). Dropped: precondition removal *alone* fixes the real data loss (a
  genuine concurrent edit has a delta and now commits); a same-value *echo* of
  the stale local value is not data loss, and forcing it is both a debatable
  policy and blocked by a third commit-assembly delta gate.
- **Whole-transaction blind write** — blocked by the audit (see above).

---

## 3. Coverage / verification

**Regression test:** `packages/patterns/integration/cellset-lww.test.ts`
(headless multi-runtime: Deno workers + in-process `StandaloneMemoryServer`,
~6s, no browser, CI-ready). Three steps:

1. concurrent same-user scalar sets → **0 conflicts**;
2. structured (array/object) writes → **still hit compare-and-set** (guards the
   narrowing — proves blind-write does *not* apply to non-scalars);
3. e2e — a typed name survives the own-write race **through `saveProfile`**
   (the actual symptom).

All three **fail with the fix disabled and pass with it on** (verified by
toggling the worker mark — fails-without/passes-with). The harness gained a
`set` command (`multi-runtime-{worker,harness}.ts`) mirroring `handleCellSet`;
it was previously missing a UI-input `$value` write path and is reusable infra.

**Production-fidelity:** the real two-browser integration
(`deno task integration patterns two-browsers`, real chromium) ran **13/13 PASS,
`commitRejected=0`** every run on the fix branch (contention happened —
`commitConflicts≈25/run` from handler/machinery writes that recover via retry —
but the `$value` writes were never rejected).

**Diff size:** ~100 lines of fix, ~165 test, ~55 harness infra (8 files).

---

## 4. The "new world" — landed conflict-handling PRs and how ours relates

The branch is rebased onto main as of late June 2026, which includes:

- **#4220** *(conflict-granularity)* — the closest neighbor. It built a
  conflict-read filtering system in `buildReads`: an `excludeReadFromConflict`
  marker (**nonRecursive-gated** — drops reference/topology reads like asCell
  shape resolution), a "mergeable op" concept, CFC-label-path dropping, and a
  **leaf-only conflict matcher**. **Complementary, not redundant:** the leaf-only
  matcher *preserves* same-leaf conflicts (our race is same-leaf), and
  `excludeReadFromConflict` is nonRecursive-only while our write-target read is
  **recursive (by-value)** — so #4220 never drops it. Our `ignoreReadForCommit`
  is the *first* filter in that same `buildReads` loop, sitting alongside theirs.
- **#4210** *(reactive computes don't re-queue on commit conflict)* and
  **#4343** *(re-queue reactive computes stranded by a commit conflict — Hixie's
  fix for the #4210 strand)*. Both live in `scheduler/action-run.ts` +
  `storage/rejection.ts` — the **reactive compute** recovery path, **orthogonal**
  to the `handleCellSet` `$value` write (which is a single un-retried commit, not
  a reactive compute). See the `reference_reactive_conflict_strand_repro` note
  (the #4210/#4343 strand only reproduces under real async load).
- **#4366** *(VDOM list child settling)* and **#4367** *(reload churn read
  resume)* — rendering/reload level, orthogonal to the cellset write path.

**Rebase mechanics:** one trivial conflict (an import block in `v2.ts`, both
#4220 and we import from `reactivity-log.ts`); everything else auto-merged,
including `v2-transaction.ts read()` and `reactivity-log.ts`. Post-rebase:
type-check clean, `cellset-lww` 3/3, 47 conflict/commit/storage/runtime-processor
regression tests green.

**Still adds value — confirmed empirically.** With the fix disabled on the *new*
base (which already includes all five PRs), the own-write race still fails
identically (`stale confirmed read … conflicted`), and the e2e still drops the
typed name. None of the landed work addresses the scalar `$value` own-write race.

---

## 5. Open questions for Robin (ubik2) — flagged in the PR body

1. **Patch-replay edge.** A nested scalar `$value` set emits a *patch* op.
   Precondition-free, a patch whose ancestor path was concurrently removed (a
   whole-doc delete racing a `$value` set — rare, and **not** the PerUser
   own-write race this fixes) would throw at **read-materialization** rather than
   be rejected at commit. Should we keep a structural (entity/parent-present)
   precondition even when dropping the value-equality one?
2. **Trigger choice.** Value-type heuristic (scalar → blind) vs an explicit
   signal — and whether the blind-leaf-write belongs expressed in #4220's newer
   "mergeable op / `excludeReadFromConflict`" vocabulary (conceptually adjacent;
   functionally distinct today). Possible unification opportunity.

This supersedes the **recovery**-based approaches (#4196 per-key commit queue,
#4126 reapply-latest) by removing the conflict at the source (**prevention**).

---

## 6. Repro & commands

```bash
# Worktree / branch
cd labs/.claude/worktrees/cellset-probe            # branch: fix/cellset-blind-leaf-write

# Regression test (fast, headless) — should be 3/3
deno test -A packages/patterns/integration/cellset-lww.test.ts

# See the flake: disable the fix and re-run → steps 1 & 3 fail with
# "stale confirmed read … conflicted". In multi-runtime-worker.ts set(),
# change `const blindLeafWrite = …` to `false && (…)`, run, then revert.

# Production-fidelity (real chromium; loop for a flake-rate)
deno task integration patterns two-browsers

# Conflict/commit regression (coexistence with #4220/#4210/#4343)
deno test -A \
  packages/runner/test/conflict-repro.test.ts \
  packages/runner/test/compute-conflict-recovery.test.ts \
  packages/runner/test/effect-conflict-recovery.test.ts \
  packages/runtime-client/backends/runtime-processor.test.ts
```

The original instrumented prototype (env-gated `CSPROBE` probes that confirmed
the mechanism) is preserved on `origin/scratch/cellset-conflict-probe`.

---

## 7. Key files (with the fix)

| File | Role |
|------|------|
| `packages/runtime-client/backends/runtime-processor.ts` | `handleCellSet` trigger: scalar check + mark/unmark around `set()` |
| `packages/runner/src/storage/reactivity-log.ts` | `markUiInputBlindWriteTx` / `unmark` / `is` + `ignoreReadForCommit` marker |
| `packages/runner/src/storage/v2-transaction.ts` | `read()` tags reads + skips `doc.validated` when blind |
| `packages/runner/src/storage/v2.ts` | `buildReads` drops `ignoreReadForCommit` reads from `reads.confirmed` |
| `packages/runner/src/index.ts` | exports the marker fns |
| `packages/patterns/integration/cellset-lww.test.ts` | regression test (3 steps) |
| `packages/patterns/integration/multi-runtime-{worker,harness}.ts` | `set` harness command (UI-input write path) |
