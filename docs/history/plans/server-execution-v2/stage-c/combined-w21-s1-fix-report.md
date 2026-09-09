---
status: historical
created: 2026-08-20
archived: 2026-08-20
reason: "Stage-C combined W2.1+S1 review FIX ROUND: every finding dispositioned — F1 MAJOR fixed (seal-time jobless checks walk the cascade thread) and F2 MAJOR fixed (latch consume gated on bookkeeping-only advance waves) with red-first pins; F3 pin push-half-honest; F4 register-noted; F5/F6/F7 fixed; the 8 notes acknowledged; lunch gate 3/3 at 1 ms swatch walls with {1:16}; chat n=20 median 375 ms; one NEW pre-existing effect-channel flake attributed to the base by the ritual."
---

# Stage C — combined W2.1+S1 review fix round (server-execution v2)

Fixer: on the train tip branch `claude/server-exec-v2-w3-alpha`
(PR #6043; F1 touches W2.1's client file that lives lower in the stack
— the fix rides the TRAIN TIP, stated in PR #6039's ledger; no lower
branch rebased). Base: `7e1d5a8ff` (= the reviewed `4bf914a70` plus one
docs-only owner-rulings commit — `git diff` over `packages/` empty).
Commits: `2879ed734` (F1 + F6 + pins), `ff67134cc` (F2 + F7 + F3 + F5 +
pins), plus the docs commit carrying this report, the review report
verbatim, the register/plan updates, and the INDEX line. Worktree
`/Users/berni/labs-worktrees/fix-combined` (detached; local branch
`fix-combined-local`; pushed fast-forward only). Durable copy:
`/Users/berni/labs-worktrees/combined-w21-s1-fix-report.md`. Every deno
invocation `--no-lock`; every suite FOREGROUND. Input: the review
report (`stage-c/combined-w21-s1-review-report.md`, verbatim
on-branch): **LANDABLE-WITH-FIXES — 2 MAJOR / 5 MINOR / 8 notes**.

## 0. Verdict

Every finding dispositioned; nothing upgraded, nothing silent. Both
MAJORs are FIXED with red-first pins that reproduce the reviewer's
probes; the two dispose-by-record findings (F4's instrument bias, the
notes) are in the register, on the row the owner will read. The full
battery is green at the fixed tip; the lunch gate is 3/3 with every
swatch wall at 1 ms and `{1:16}` store multiplicity; the chat n=20
smoke holds the quiet band (median 375 ms — below W3.1's 544 ms) with
`settleAdvances` quiescence-only (55 over 169 waves). One NEW flake
surfaced during the battery and was attributed by the CI-attribution
ritual to the PRE-EXISTING base before any blame (§2).

## 1. Findings → dispositions (red/green evidence per row)

| finding | disposition | SHA | red-first evidence |
|---|---|---|---|
| **F1 (MAJOR, W2.1)** — a LATE grandchild of a SILENT (write-less) cascade child seals after P's mark and escapes both one-level seal-time jobless checks: registers, strands forever (reviewer probe P1: `entryCount=1, dropped=false, retired=false`) | **FIXED** — both checks (pre-seal `overlay-destination.ts` and the post-`sealInto` re-check) walk the `parentEventId` chain through `#cascadeParents` (`#joblessByAncestry`, the `#cascadeReaches` walk on ids, same 64-hop cap; P is in `#terminalIntents` via `#settleIntentConsequence`, so the walk finds it) — the reviewer's validated fix shape | `2879ed734` | Pins written FIRST and run against the tip's `overlay-destination.ts` (restored from HEAD): **W2.1-3 extended** (the late-silent-grandchild seal) RED — `lateEchoDropCount` 2 ≠ 3, the entry REGISTERED (the reviewer's P1 stranding); **W2.1-6** (P's mark landing while the silent child's grandchild is MID-seal — the post-`sealInto` re-check's seat, which a pre-seal-only fix cannot green) RED — `entryCount` 1 ≠ 0, no drop. Both green at the fix; the whole intent-listener suite 3 passed (19 steps) |
| **F2 (MAJOR, S1)** — the once-per-transition latch is consumed even when the advance-only wave picked up CONTENT mid-seal (a tx sealing between the gate snapshot and the wave detach joins the still-open closing wave); the folded seq — above the pre-fold `advanceTo` — stays uncovered until the next authored input: the swatch-stall shape in a microtask-wide race, unflagged | **FIXED** — the consume gated on `closing.contentContributionCount === 0` (`space-server.ts`): a fold leaves the latch ARMED (the arm above already re-set it) and the NEXT quiescence covers the folded tail; the stats block rides the consume deliberately (a fold-carrying wave is not advance-ONLY, so W4's subtraction arithmetic must not subtract it) — exactly the reviewer's probe-validated shape (S1-P3, 28/28) | `ff67134cc` | **Pin 6** makes the reviewer's structural interleaving DETERMINISTIC — the seam the review said was missing: a serving-runtime `edit()` wrapper injects a derivation-kind commit when the quiescence advance's watermark `["seq"]` write commits (discriminated by value > max authored seq — pin 1's own discriminator; `commit()` resolves at SEAL acceptance so awaiting inside the window cannot deadlock), then the pin asserts the fold landed in the SAME wave commit (loud abort otherwise — never a vacuous green). RED on the unfixed tip's code at exactly the predicted assert: `timed out waiting for the next quiescence advance to cover the folded tail (folded content at seq 8; W frozen below it …)`. Green at the fix: the next quiescence covers the folded seq, no authored commit involved, the client heals via the ordinary push. `executor-settle-advance` + `executor-serving-loop`: 2 passed (29 steps — the reviewer's 28 + pin 6); settle-advance green ≥ 6 consecutive runs |
| **F3 (MINOR, S1 pins)** — the pins' client-visibility clauses are transport-blind to the production push half (reviewer probe S1-P1: `noteExecutorCommit` skipped for advance waves → all four pins stay green via the emulated transport's initial-pull self-satisfaction) | **FIXED (pin)** — pin 1 installs a watermark-doc sink BEFORE any advance exists and requires a DELIVERED value above the final authored coverage: the initial sync pull at subscribe time can only see the pre-input watermark, and later values arrive ONLY through `noteExecutorCommit` → dirty-key → refresh (the watermark doc has no session writer), so the clause is push-half evidence by construction | `ff67134cc` | The reviewer's S1-P1 mutation re-applied (`noteExecutorCommit` guarded off for `settleAdvanceFrom !== undefined` waves): pin 1 now RED in 10 s — and at the FIRST client clause, because the pre-installed sink keeps the doc subscribed, so `waitForSettled`'s fresh-subscription initial-pull escape hatch is gone too (`waitForSettled(...) timed out … watermark W < 4`). Mutation reverted; pin green |
| **F4 (MINOR, W2.1)** — the flicker counter systematically UNDER-counts the coalesced-purged shape (a foreign write in the mark's own frame reads "arrived" — the root-cause report's common green-run shape s6/s13), and it is the shape-(b) DECISION INSTRUMENT the owner reads at W4 | **NOT CHANGED (code) — register note landed** on the flicker-trigger row (the (b) FUTURE row): the bias directions stated (under-counts coalesced-purged; over-counts equality-cutoff and the same-frame sidecar append), with the reading instruction — a NONZERO count is real flicker evidence, a LOW/ZERO count is NOT proof of little flicker. Why not the fix: a seq-level witness cannot attribute a same-frame doc move to a specific writer; counting the shape exactly needs value-level or writer-attributed evidence — not small, and it would change the decision instrument right before the owner reads it. The biases are also now stated on the churn surface's docstring (F5's edit) | docs commit | n/a (record disposition; the code's getter already disclosed the misreading abstractly — the register note names the shape, the commonness, and the direction) |
| **F5 (MINOR, W2.1)** — `overlayCascadeEchoFlickers`' docstring in `cfc-browser-helpers.ts` still described the witness as basis-keyed ("moved past its basis") — stale since the third W2.1 commit re-keyed it on the MARK frame | **FIXED (text)** — rewritten to the mark-frame semantics with both heuristic biases and their directions stated (the F4 disclosure at the decision surface) | `ff67134cc` | n/a (comment fix; no behavior) |
| **F6 (MINOR, W2.1)** — prune-eviction of a live chain link (reviewer probe P2: flooding 4096 seals evicts `C→P`, the grandchild strands: `entryCount=1, retired=0, drops=0`) and the depth-64 cap strand SILENTLY — indistinguishable from "no ancestor", zero telemetry | **FIXED (counter — the review's preferred shape)** — `cascadeThreadEvictionCount` (counted at the eviction, the one place truncation is knowable) and `cascadeWalkDepthCapCount` (counted when a walk stops at the cap with chain remaining, in both `#cascadeReaches` and `#joblessByAncestry`), logger keys `cascade-thread-evicted` / `cascade-walk-depth-capped`. The strand itself remains the stated bounded-design posture | `2879ed734` | **W2.1-7** RED on the tip (`Expected undefined to be greater than or equal 1` — the getters did not exist; the truncations were invisible), green at the fix: a 66-hop silent chain's capped walks counted at seal AND at the mark's retirement walk (the deep entry stands — the stated posture — but counted), and 4100 one-hop fillers push `#cascadeParents` past the 4096 bound with evictions counted |
| **F7 (S1, nit)** — `#ownWaveSeqs` unbounded on a space whose W is persistently clamped (pruned only as W advances) | **FIXED** — bounded at 4096, oldest evicted at insert; eviction can only open a hole at the walk's base, degrading the advance to fail-closed for the evicted tail (the pre-S1 posture), never to unsoundness; on a healthy space the prune-at-advance keeps the set near-empty and the bound is never reached | `ff67134cc` | No dedicated pin (the review: "No action required for landing"; the bound's failure mode is conservative by the same construction argument as the walk's hole rule) — the full settle-advance/serving-loop population green over it, and the lunch/chat gates exercise the live path |

## 2. The NEW pre-existing flake (attributed by the ritual before any blame)

The suite battery's first `runner half A` run failed ONE step. Per the
CI-attribution ritual: the exact failing assertion was extracted, the
reachability checked, and the base reproduced BEFORE naming a culprit.

- **Exact assert**: `executor-effect-channel.test.ts`, step "the
  served intent (T2 hops 1–4): fire → wave computes navigateTo → the
  §5 entry lands in the FIRING session's instance …" — `timed out
  waiting for the intent to land in alice's session instance` (20 s).
- **NOT the receipt-race pin** `78959c26c` fixed (different step,
  different wait — that one polled the live intent ENTRY against the
  designed enact→ack→retire pipeline).
- **Reproduced at the UNFIXED tip** `7e1d5a8ff` in a separate baseline
  worktree with the byte-identical step name and assert: 1 red / 7
  runs there vs 2 red / 9 runs on the fixed tip (loads ~2–4 both) —
  comparable rates, same failure. **Not a fix-round regression.**
- Disposition: left un-fixed (out of this round's scope — it needs its
  own red-first pass), recorded in the register's combined-review
  delta and here. Logs: session scratchpad `ec-r*.log` /
  `base-r*.log`.

## 3. Suites (all local, FOREGROUND, `--no-lock`; runner via its
package task's exact flags + preload, two halves under the call cap;
at the code tip `ff67134cc`)

- runner half A (`test/[a-l]*.test.ts test/scheduler/*.test.ts`):
  **523 passed (4052 steps) / 0 failed** (twice; the first attempt's
  single failed step is §2's pre-existing flake) + half B
  (`test/[m-z]*.test.ts`): **693 passed (2704 steps) / 0 failed** =
  **1216 passed (6756 steps) / 0 failed** (the reviewed tip: 1216 /
  6753 — +3 steps = pin 6, W2.1-6, W2.1-7; W2.1-3's extension rides
  its existing step).
- memory **522 (229)**; toolshed **142 (428)**; runtime-client **61
  (212)**; piece **37 (451)**; spec-model **23**; skip-list
  (`tasks/server-execution-on-skips.test.ts`) **17** — the post-lift
  one-entry state pinned, untouched.
- `SCHEDULER_LIVENESS_EQUIVALENCE=1` executor family (15 files): **17
  passed (192 steps)** (+1 = pin 6).
- Stability: `executor-settle-advance` green ≥ 6 consecutive;
  `speculation-intent-listener` green 3 consecutive (3 tests / 19
  steps each).
- Mutations, applied and REVERTED (tree clean after each): the tip's
  one-level jobless checks (HEAD-restored file) → W2.1-3-ext, W2.1-6,
  W2.1-7 all RED as tabled in §1; S1-P1 (`noteExecutorCommit` skipped
  for advance waves) → pin 1 RED at 10 s.
- `deno fmt --check` on all 5 touched TS files: clean. `deno lint` on
  the two touched src files: clean. `deno check --no-lock` on the two
  src + two test files: clean. `deno task --no-lock check-docs` +
  history index: green (run after the docs commit; counts in the PR
  ledgers).
- Tree state: `git status` clean after every suite; no `deno.lock`
  churn; no `git stash`; no branch checkouts (worktree detached →
  local branch only).

## 4. The review's 8 notes — each read; dispositions

1. **S1 quiescence-gate vs the amended sentence** (deferred-rescan
   window approximation; the walk is the soundness belt) —
   ACKNOWLEDGED, no action (the reviewer: harmless, gate ⊇ spec).
2. **Push-reorder soundness** (per-doc arrival gate protects) —
   ACKNOWLEDGED, no action (verified safe by the reviewer).
3. **The advance's own commit / never-chased bound consistency** —
   ACKNOWLEDGED, no action.
4. **`#recordSettleCoverage(advanceTo)` a no-op on the advance path**
   — ACKNOWLEDGED, no action (the "split from the settle series"
   claim verified).
5. **Shared descendant id impossible by minting** (UUID-per-tx) —
   ACKNOWLEDGED, no action.
6. **Depth-64 cap silent strand** — ACTED via F6's
   `cascadeWalkDepthCapCount` (the note's telemetry ask).
7. **Jobless set × MAJ-1 / re-entrancy** — ACKNOWLEDGED; the real
   finding there was F1's depth-one gap, fixed.
8. **No-terminal-parent posture** (stated pre-existing) and **the
   lunch-gate step rewrite honest** — ACKNOWLEDGED, no action.

Nothing else in the notes named a cheap, real improvement beyond
F6's counter, which landed.

## 5. Gates at the fixed tip (ON binary from `ff67134cc`, sha256
`16de5fc042d7e361…`; `COMMIT_SHA` + `EXPERIMENTAL_SERVER_EXECUTION=true
deno task --no-lock build-binaries toolshed`; per run: fresh cwd =
fresh store, `/api/meta` posture + `gitSha` read back =
`ff67134cc…`, `shellServerExecutionDefine: "true"`, `servingLoop`
present, `No default model available`, 0 `CFTS_AI_LLM_*` keys, no
`.env`; `gtimeout --kill-after=30 520`; loads recorded; driver
`run-arm.sh`, ports 8991–8994)

The lunch gate ON, 3×, because F1/F2 touched both the retirement and
the latch:

| run | total | join (confirmed) | merge | **swatch step** | option B | advances | events a/p (purged) | multiplicity | flickers h/g | load |
|---|---|---|---|---|---|---|---|---|---|---|
| fixc1 | 4733 | 255 | 773 | **1** | 63 | 10 | 11/12 (1) | {1:16} | 0/0 | 3.2→2.6 |
| fixc2 | 4483 | 255 | 298 | **1** | 229 | 9 | 11/11 (0) | {1:16} | 0/0 | 3.9 |
| fixc3 | 3943 | 255 | 402 | **1** | 164 | 11 | 11/12 (1) | {1:16} | 1/0 | 2.6→4.4 |

**3/3 GREEN; every swatch wall 1 ms** (no recoveries, no timeouts);
consequence multiplicity **{1:16} in all three stores** (verified with
`inspect-store.py` per run — both the purge shape, 2 runs, and the
coalesced shape, 1 run); joins honest at 255 ms; `settleAdvances`
9–11, quiescence-only. The chat n=20 smoke (port 8994, load ~3):
series complete, **median 375 ms** (q1 305 / q3 454 / min 286 / max
679) — holds the quiet band (W3.1's provisional run: 544 ms); events
28/28, purge/refusal/orphan 0/0/0; `settleAdvances` 55 over 169 waves
— quiescence-only, never per-wave (the F2 gate costs the busy path
nothing). Run dirs: session scratchpad
`w21bench/runs/fixc{1,2,3}-lunch-on`, `fixc-chat-chat-on`; binary
`w21bench/toolshed-fixcombined`; build log `build-fixcombined.log`.

## 6. Files

`packages/runner/src/speculation/overlay-destination.ts` (the
`#joblessByAncestry` walk at both seal-time checks; the F6 counters +
getters + logger keys; the sweep comment's F2 pointer);
`packages/runner/src/executor/space-server.ts` (the F2 consume gate;
the F7 bound); `packages/runner/test/speculation-intent-listener.test.ts`
(W2.1-3 extended, W2.1-6, W2.1-7; `echoOf` gained `holdSeal`);
`packages/runner/test/executor-settle-advance.test.ts` (pin 6; pin 1's
push-half sink clause); `packages/patterns/integration/cfc-browser-helpers.ts`
(the F5/F4 docstring); docs: `verification-coverage.md` (the W2.1
row's UPDATE, the (b) row's instrument-bias note, the S1 residual
(iv), the combined-review delta block), the plan's coordination block,
`docs/history/INDEX.md`, the review report (verbatim + header), this
report.
