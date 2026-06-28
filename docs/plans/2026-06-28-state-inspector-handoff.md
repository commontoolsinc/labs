# State Inspector — Handoff & Merge Chain (compaction survival doc)

> Written 2026-06-28 before a context compaction. This is the resume-from-here
> doc: the stacked-PR chain and how to land it, where everything lives, and the
> next phase. Companion docs: the proposal
> `docs/plans/2026-06-26-runtime-trace-inspector.md` and the model design
> `docs/plans/2026-06-28-state-inspector-model-unification.md`.

## TL;DR

`@commonfabric/state-inspector` (`packages/state-inspector`) is an **offline
autopsy + comprehension tool** for memory v2 space SQLite stores, surfaced as
**`cf inspect`**. It's usable today (read-only, no live runtime). It ships as a
**6-branch stacked chain** of draft PRs, none merged. Next phase = **model
unification** (read the whole entity document, classify pieces/cells/streams by
path-set, resolve lineage). The merge of the chain should wait until that lands.

## Where everything lives

- **Worktree:** `/Users/ben/code/labs-state-inspector` (a `git worktree` off
  `origin/main`). All branches below live here. The current branch is
  `state-inspector-model-unification`.
- **Main checkout** `/Users/ben/code/labs` is on a different (merged) branch and
  contains **stale untracked M1-era copies** of `packages/state-inspector/*` plus
  the design docs — a `deno fmt` hook keeps re-touching them. Ignore/clean later;
  they are NOT the real work. Ben's floating `deno.json`/`deno.lock`/`las` edits
  there must stay untouched.
- **Real space DBs** for testing: `packages/toolshed/cache/memory/engine-v3/engine-v3/*.sqlite`
  (gitignored). The freshly-created notes space used for dogfooding:
  `did:key:z6Mkj75q…` (50 commits, 145 entities, modern regime).

## The stacked PR chain (bottom → top)

Each PR's base is the branch below it, so each diff shows only its own delta.

| Order | Branch | PR | Base | What | Mergeable (2026-06-28) |
| --- | --- | --- | --- | --- | --- |
| 1 | `state-inspector-autopsy-core` | [#4375](https://github.com/commontoolsinc/labs/pull/4375) | `main` | M1: db/decode/reconstruct/queries + proposal doc | **CONFLICTING** (main moved) |
| 2 | `state-inspector-convergence` | [#4376](https://github.com/commontoolsinc/labs/pull/4376) | #4375 | M2: server `applyPatch` reuse + cross-space convergence | MERGEABLE vs base |
| 3 | `state-inspector-replica-classification` | [#4377](https://github.com/commontoolsinc/labs/pull/4377) | #4376 | M2.5: replica-vs-instance classification | MERGEABLE vs base |
| 4 | `state-inspector-cf-inspect` | [#4386](https://github.com/commontoolsinc/labs/pull/4386) | #4377 | M3: `cf inspect` + local-DB discovery (usable) | MERGEABLE vs base |
| 5 | `state-inspector-dogfood` | [#4393](https://github.com/commontoolsinc/labs/pull/4393) | #4386 | dogfood fixes: fvj1 commit decode, `entities`, scheduler/session legibility | MERGEABLE vs base |
| 6 | `state-inspector-model-unification` | (no PR yet) | #4393 | design doc only so far; **next-phase code lands here** | — |

All draft. `mergeable` for 2–5 is relative to their *parent branch*; once the base
rebases onto live main, re-check.

## How to land the chain (repo-specific — read before merging)

This repo **squash-merges** and has **instant auto-merge** (no required status
checks → `gh pr merge --auto` merges immediately, even with CI pending). So:

1. **Don't use `--auto`.** Wait for `gh pr checks <pr>` green, then plain
   `gh pr merge <pr> --squash`.
2. **Rebase the chain onto current main first** (base #4375 is CONFLICTING):
   - In the worktree, `git fetch origin`, then rebase `state-inspector-autopsy-core`
     onto `origin/main`. **Expected conflicts: `deno.json` (workspace array) and
     `deno.lock`** from main's churn (e.g. charm→piece renames). Resolve by taking
     **main's** version and re-adding the one line `"./packages/state-inspector"`
     to the workspace array + the additive `deno.lock` state-inspector entry.
   - Cascade-rebase each upper branch onto its rebased parent:
     `git rebase --onto <new-parent-tip> <old-parent-tip> <branch>` for #4376→…→#4393.
     Force-push each (`--force-with-lease`). Nothing is stacked above the tip, so
     force-pushing is safe.
3. **Squash-merge bottom-up:** merge #4375 (→ main). Then for each next PR, GitHub
   may auto-retarget to main; if not, rebase it onto main (dropping the
   now-squash-merged commits — they're squashed, so `drop` in rebase) and merge.
   Verify each is green first.
4. **After all merged:** delete the worktree (`git worktree remove`), and clean the
   stale untracked `packages/state-inspector/*` copies + design-doc copies from the
   main checkout (they reference a `./packages/state-inspector` workspace member, so
   if you delete the dir there, also drop that line from that checkout's deno.json —
   but only after confirming it's not entangled with Ben's floating edits).

**Recommendation:** don't merge piecemeal yet. The dogfood `entities` classifier
**undercounts pieces** (uses a `$NAME`-string heuristic; finds 4 of 7). Model
unification (next phase) corrects this. Land the chain as one rebased unit *after*
model unification, so what merges is fluent, not guessing. Alternatively, if the
team wants `cf inspect` sooner, M1–M3 (#4375–#4386) are independently correct and
useful; #4393's `entities` is just incomplete, not wrong.

## Next phase: model unification (Phase 1) — start here post-compaction

Goal: make the tool fluent in the real entity model instead of reading only
`doc.value`. Per `2026-06-28-state-inspector-model-unification.md`:

- New `model.ts`: load an entity's **whole `is` document** (all top-level paths,
  not just `value`); classify by path-set into **piece / owned-cell / free-cell /
  stream / module / schema** (handle modern `patternIdentity` AND legacy
  `$TYPE`/`resultRef` regimes); resolve **lineage** — piece→input (`argument`),
  piece→pattern (`patternIdentity` → module `code`/`filename`), owned-cell→owner
  (`result`), piece→manifest (`internal`).
- Rewire `entities`/`value-at` onto it; add `cf inspect piece <id>` (shows a piece
  with input, result, owned cells, and pattern source).
- Then: space grouping → `graph` command → time travel (`diff`/`timeline`) →
  HTML visual surface. (Time-travel engine already exists via `atSeq`.)

## Resume gotchas

- Run from the **worktree**; real DBs live in the worktree's toolshed cache or the
  main checkout's — pass `--dir`/`MEMORY_DIR` or rely on cwd walk-up.
- `git commit --amend` is **blocked** by a repo hook → make a new commit.
- A stray **NUL byte** in a TS comment makes git treat the file as binary; `python3`
  byte-scan to find, replace with space. (Bit us once in `multispace.ts`.)
- `cf` launcher already grants `--allow-ffi`, so `cf inspect` + sqlite needs no perm
  change. Registering a Cliffy command in `commands/main.ts` needs
  `// @ts-ignore for the above type issue` (command-type quirk, like piece/fuse).
