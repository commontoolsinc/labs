# Lunch-Poll / Resume / Runtime — Open-Threads Map

_Living index of this investigation's open threads. **Transient working notes** —
intentionally NOT on `main`; tracked in git on the `gideon/lunch-poll-perf-load`
branch so it survives branch cleanup. **Last updated: 2026-06-29.**_

This doc is the **map**. The deep-dives live next to it in `perf-seed/`:
- [`IDENTITY-DIVERGENCE-HANDOFF.md`](./IDENTITY-DIVERGENCE-HANDOFF.md) — the storm root cause (cell-identity divergence)
- [`MULTI-USER-CONTENTION-HANDOFF.md`](./MULTI-USER-CONTENTION-HANDOFF.md) — multi-user contention findings (premise superseded; instrumentation history)
- [`SLOW-LOAD-FINDINGS.md`](./SLOW-LOAD-FINDINGS.md) — single-client slow load (resolved)
- [`S16-FILTER-FLATMAP-OVERTAINT-HANDOFF.md`](./S16-FILTER-FLATMAP-OVERTAINT-HANDOFF.md) — **next-session focus**: the CFC over-taint in filter/flatMap (out of the #4367 review)

## TL;DR status
- ✅ Original write-storm / cell-identity divergence **fixed & merged** (#4360 + supporting).
- ✅ Resume / list-settling / flicker cluster **resolved & merged**: #4366 (VDOM settling) + **#4367 (read-mostly resume, MERGED 06-27)**.
- ✅ cf-fragment trust-boundary gap **fixed** (CT-1796, Done).
- 🔵 **S16 filter/flatMap over-taint (VERIFIED 06-29):** the input-list read over-taints the result `structure` label, but the "obvious" fix (mirror map) is a **security regression** — it's the sole carrier of the legitimate membership taint, and the precise carrier (predicate results) is elided by skip-if-unchanged timing. Reframed as a structure-stamp-discipline design question for seefeld (CT-1801). See the handoff doc.
- 🟡 Two architectural levers **held for seefeld**: the **scopes question** (CT-1799) and the **CFC structure-only-read rule** (CT-1801).

## Ticket / PR index (quick reference)
| Ref | What | Status |
| --- | --- | --- |
| #4360 / #4361 / #4366 / #4367 | storm fix / memwrite trace / VDOM settling / read-mostly resume | all **merged** |
| **#4391** | our S16 probe-scope follow-up (filter/flatMap container reads) | **OPEN, CI green, but label-neutral; drop the "over-taint fix" framing — see thread 3** |
| #4346 (Ben) / #4349 (Wilk) | localize vote writes / runtime convergence | OPEN (4349 likely close) |
| **CT-1799** | scopes architecture (every-client write-back) → seefeld | Triage, held |
| **CT-1801** | CFC structure-only-read rule (spec gap) → seefeld | Triage, held |
| **CT-1802** | resume during-batch self-heal test seam | Triage (resolved; deferred guard) |
| CT-1798 | #4366 static-prop churn | In Review (Gideon's PR) |
| CT-1803 | Cell<Props> primitive-prop guard (from CT-1798 review) | Triage |
| CT-1795 | lunch-poll empty-box Join needs two clicks | Triage |
| CT-1796 | cf-fragment nested authorship trust-boundary | **Done** |

---

## ✅ Resolved
- **Write-storm / fresh-vs-resume cell-identity divergence** — **#4360** (06-25):
  `awaitSync` lifted out-of-band + canonical schema interning. ~27.8k → ~2.1k writes.
  Supporting: #4292, #4220, #4353. Single-client slow-load earlier (#4326/#4325). See IDENTITY-DIVERGENCE-HANDOFF.md.
- **VDOM list-child settling** — **#4366** (06-26): our three review points all landed (beforeId → degrade-to-append; over-reset → derive-from-descendants; cubic-P1 → literal reuse requires `cell===undefined`).
- **Read-mostly resume** — **#4367** (Hixie, MERGED 06-27): pre-sync owned cells + the list-builtin preserve guard. We confirmed it kills the live `35→0→refill` flicker (baseline flickers, fix doesn't). Full re-review delivered; the during-batch self-heal question resolved (CT-1802).
- **cf-fragment trust-boundary gap** — **CT-1796** (Done): nested `cf-cfc-authorship` boundaries didn't compose; inner boundary laundered trust. Gideon took this in a separate context.
- **memwrite trace** — **#4361** (merged 06-26).

---

## 🔵 / 🟡 Open threads

### 1. Scopes question — conditional-result scope (user vs space) → **CT-1799**
**[ARCHITECTURAL · owner: seefeld · held for Gideon to route]**
`ifElse`/`when`/computed result cells inherit the **scope of their condition** (`if-else.ts:33`). A
condition over *shared* (PerSpace) state → a `space`-scoped (shared) result that *every* client
recomputes and writes back to the **one** shared slot. #4360 made it *safe* (ids converge → value-equal
→ terminate); the architectural question is untouched: **should a render-only conditional over shared
state produce a shared written-back cell at all** (vs computed-once / per-client-local)? The spec
(`docs/specs/scoped-cell-instances.md`) justifies write-back as **narrow→wide bridging**, which doesn't
apply to wide→wide pure-functional derivations. Full problem statement + design table in CT-1799.
Lowering data point: lunch-poll `main.tsx` = 25 `ifElse` + 27 `lift` static → ~196 `raw:if` runtime.

### 2. CFC structure-only-read rule (spec gap) → **CT-1801**
**[SPEC · owner: seefeld · held]**
The CFC spec implies (S16 D1/D2/D4) but never **states** the rule that a coordinator reading its own
result container journals shape + link-identities, NOT element contents. That's why map (which
implements it via `linkResolutionProbe`) and filter/flatMap (which didn't) drifted. CT-1801 proposes the
`08-09` spec edit. **Thread 3 is its implementation half.**

### 3. S16 filter/flatMap over-taint (implementation) → **[`S16-FILTER-FLATMAP-OVERTAINT-HANDOFF.md`](./S16-FILTER-FLATMAP-OVERTAINT-HANDOFF.md)**
**[VERIFIED 2026-06-29 — prior "port map's idiom" plan was WRONG]**
The input-list read DOES over-taint the result `structure` label (verified observable: an index-only
predicate still taints it with dropped elements' content). **BUT** porting map's identity-only
materialization is a **security regression** — that same read is the sole carrier of the legitimate
§8.5.6.1 membership taint, and removing it makes the team's own `cfc-flow-pointwise` filter tests go
red. Traced root cause: the correct carrier (predicate-result reads) is precise but arrives on reconcile
pass 2, when `skip-if-unchanged` elides the container write → its `structure` stamp never fires; the leak
was masking a **label-stamp-timing** bug. A precise fix needs map-style input read **plus** re-stamping
`structure` when J changes without a value change — structure-stamp discipline, **seefeld's domain**
(CT-1801 reframed). #4391's container change is separately label-neutral. Full trace + the
fails-without/passes-with shape (with the essential `isPositive` control) are in the handoff doc.

### 4. Resume during-batch self-heal → **CT-1802** (resolved; deferred guard)
The "write-after-sync" worry (republish reads a transient `undefined` → persists a shrink) is
**self-healed**: every per-element read is a commit precondition (`buildReads` in `storage/v2.ts`), so a
durable arrival's `confirmed.seq` bump conflicts the republish commit → `editWithRetry` re-runs against
settled state. Confirmed structurally AND empirically (the dangerous write can't be provoked in-process
— the convergence is value-equal). A faithful white-box guard needs a `sync()`-resolved-but-absent
storage seam → CT-1802.

### 5. Reactive-conflict "strand" (#4210/#4343 family)
**[PARTIALLY OPEN]**
Reactive computes stranded by commit-conflict retries under real async load. #4210 + #4343 + #4220
merged; the resume conflict-rollback (now resolved via #4367 + thread 4) was the same mechanism. The
general "conflict-revert under async load" question persists. **No deterministic in-process repro** —
needs a white-box storage seam (re-confirmed twice). See memory `reactive-conflict-strand-repro` and
CT-1802. CI data point (06-26): `cfc-group-chat-demo.test.ts:116` strand-signature timeout; flake-rate
check still never done.

### 6. lunch-poll empty-box Join needs two clicks → **CT-1795**
**[pattern bug · Gideon · Triage]**
Clicking **Join** with the name box empty does nothing on the first click. A handler-only-read
wish-backed computed (`profileName = computed(() => profileNameWish.result ?? "")`) isn't pulled before
the first handler invocation. Pattern-level lunch-poll bug; detail in CT-1795.

### 7. Open PRs / loose ends
- **#4391** (ours) — see thread 3; CI green, decision pending.
- **#4346** (Ben — per-user vote rows) — OPEN; pattern-level complement to the storm fix.
- **#4349** (Wilk — runtime convergence) — OPEN; superseded by #4360/#4366/#4367 → likely should close.

### 8. Tooling / smaller follow-ups (mostly untracked)
- **otel follow-up** — promote the gated memwrite console trace (now merged, #4361) to structured OTel
  metrics + sampled span events. Cardinality design is the bulk. Not started.
- **Flaky `notebook reload` CI test** — hypothesised same strand. Flake-rate check never done.
- **Deployed demo** — cf-pr-wt `:8100` tailnet demo of #4360, still live (kept).

### 9. Comms
- **Loop seefeld in** on CT-1799 (scopes) and CT-1801 (CFC read-rule) — both held for Gideon to route.

---

## Cross-team note
Wilk's, Hixie's, and our agents independently converged on **read-mostly resume / pull-before-compute**
as the principled fix for the resume-flicker family. The "not-loaded vs settled `undefined`" question is
**fractal** and **unclassifiable at read time**, so the fix is to **pull durable docs before computing**
rather than classify reads. That direction shipped in #4367.

## Parked artifacts / branches / worktrees
- `gideon/lunch-poll-perf-load` (this branch, worktree `labs-perfseed`) — the investigation's git home:
  handoff docs + perf-seed seeder + the two-browser repro harness + this map. **Push after editing.**
- `gideon/4367-followups` (worktree `labs-4367-fu`) — **#4391** (S16 follow-up). Base was the throwaway
  mirror `gideon/4367-base` (delete once #4391 retargets/lands).
- `labs-4367` / `labs-main` worktrees — the eyeball instances for the #4367 flicker test (`:8200`/`:8300`
  localhost). Tear down: `for f in /tmp/cf-4367.pids /tmp/cf-main.pids; do while read p; do kill "$p" 2>/dev/null; done < "$f"; done`.
- `gideon/list-resume-childsync` — parked offering (superseded by #4367; deletable).
- `gideon/memwrite-trace` (#4361) — merged; worktree `labs-4361` deletable.
- perf-seed seeder: `./seed.sh` (10 opts / 35 votes / 4 users) — local lunch-poll for repro/eyeball.
