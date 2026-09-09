---
status: historical
created: 2026-08-19
archived: 2026-08-19
reason: "Stage-C evidence: the fix pass for W2 (e), PR #6039 — every finding of the independent review (LANDABLE-WITH-FIXES, 0/1/7/6) dispositioned with red/green evidence; the branch rebased onto its stated base; OW42 minted (as OW41; renumbered at the re-stack onto W1); the suites re-run; one provisional note n=20 series for the one client-side cost change."
---

# Stage C — W2 (e) fix report: the intent listener after its independent review

Date: 2026-08-19. Branch `claude/server-exec-v2-w2-intent-listener`
(PR #6039, stacked on `claude/server-exec-v2-stage-c-design`; to be
re-stacked onto W1's tip, PR #6029, as a separate step after W1's fix
pass lands — the PR base was NOT changed here). Fixer worktree
`/Users/berni/labs-worktrees/fix-w2` (detached from the branch, local
branch `fix-w2-local`). Durable copy of this report:
`/Users/berni/labs-worktrees/w2-intent-fix-report.md`. Inputs: the
review report ([`w2-intent-review-report.md`](w2-intent-review-report.md),
landed on-branch verbatim; the reviewer's tip `2ce7cb8c7`), the build
report ([`w2-intent-build-report.md`](w2-intent-build-report.md),
corrected in place with dated notes), the design §3.3/§3.4/§3.5,
speculation.md §4, the register §3.

## 0. In one line

**All 14 findings addressed — 10 FIXED (MAJ-1, MIN-1, MIN-4, MIN-5,
MIN-6 in code/tests; MIN-7 the rebase; MIN-2, N-1, N-4, N-5 as text), 1
OWED as a numbered row (MIN-3 → OW42, minted as OW41), 1 HARDENED
(N-2), 2 NOT CHANGED
with the reason stated (N-3, N-6); the MIN-2 code alternative is
flagged, not built. No finding disputed. The MAJOR was real: reproduced RED on the build
tip exactly as the reviewer's scratch probe said
(`["dropped:Z","dropped:X","dropped:X"]`), one-line fix, pinned. Runner
1213 passed (6731 steps) / 0 failed after the fixes; every sibling suite
green; one PROVISIONAL note n=20 ON series on the fix tip — per-note
client `scheduler/run` FLAT (106–412 ms under a 9.8–11.3 load), the
sink effect 0 runs.**

## 1. The rebase (MIN-7), first

The branch's stated base was `461b01822` (the W0 (d′) docs landing);
its actual merge-base was `c3ec7fc7b`. Rebased onto `461b01822`
(`git rebase`, 8 commits replayed); ONE conflict, docs-only, in
`docs/plans/server-execution-v2.md`'s "Ordered next actions" paragraph
— both sides rewrote it (the base: W0 DONE / the train LAUNCHED; the
branch: W2's landing note). Resolved keeping BOTH: the base's W0/W1/W2
state text with the branch's "W2 (e) BUILT 2026-08-19 (PR #6039 …)"
note spliced into its W2 clause. `stage-c-design.md` auto-merged. The
code is byte-identical across the rebase (`git diff 2ce7cb8c7 HEAD --
packages/` empty before any fix). Pushed ONCE with
`--force-with-lease=claude/server-exec-v2-w2-intent-listener:2ce7cb8c7`
(the history rewrite of this branch's own commits: `2ce7cb8c7 →
20c442213`); every later push plain. SHA map for the pre-rebase
commits the build report and the PR body cite: (b) scratch
`e91194469` → `b6af5ff86`; the series tip `7a5481d14` → `44b5b361c`
(the run artifacts' `gitSha` keeps the pre-rebase value the binary was
built from); `75f02c1f7` → `162c221df`; the build tip `2ce7cb8c7` →
`20c442213`. The re-stack onto W1's tip will
meet the same paragraph again (W1's branch also rewrote the plan's
coordination block) and `docs/history/INDEX.md`'s
`plans/server-execution-v2/` directory-entry LINE, which both W1 and W2
amended — the INDEX is merged with git's `union` driver, so the
re-stack will keep both versions of that line and
`tasks/check-docs-history-index.ts` will flag the duplicate target:
merge the two texts into one line (W1's mentions its build report; W2's
mentions its three).

## 2. Dispositions, finding by finding

Severities exactly as the review report. SHAs are on the rebased
branch. "RED" means the pin was run against the build tip's code (or the
named mutation applied to the fixed code) and failed at the stated
assertion; "GREEN" means it passes on the fix tip.

| # | finding (severity) | disposition | SHA | red / green evidence |
|---|---|---|---|---|
| MAJ-1 | re-entrant `trackIntent` inside an outcome callback applies an already-retired id twice (MAJOR) | **FIXED** — `#checkIntents`'s `consider` now gates each located entry on the LIVE tracked set re-fetched from the map (`this.#trackedIntents.get(space)?.get(sidecarId)`), not only on the check's pre-loop `pending` snapshot; the old sink's scan gated on the live `ids.has(...)` per entry AND its `trackIntent` returned early while a sink existed, so it could not double-apply — this was a regression vs the old guard, LATENT today (no production `subscribeIntentOutcomes` caller; the hook is the ruled UI hook), now restored explicitly. The PR body's self-review claim "re-entrancy … is safe — `pending` is a copy" was wrong precisely because it is a copy; corrected in the PR body and the build report with a dated note | `9c7ecf80f` | pin "review MAJ-1" (the reviewer's scenario: seed [X, Z], track both, a subscriber that consumes the memo and re-fires ONCE on the first outcome, one notification marks both dropped with hints Z then X): RED on the build tip's code — `Actual ["dropped:Z","dropped:X","dropped:X"] / Expected ["dropped:Z","dropped:X"]`; GREEN after the fix; the pin also asserts `pendingIntentCount` 1 (the retry), each consequence settled once, and NO orphaned memo (a fresh waiter for X hangs). The pre-fix code IS the pin's named mutation |
| MIN-1 | pin-vacuity gap: one notification spanning two tracked sidecars uncovered (the MX1 `break` mutation survived every pin) (MINOR) | **FIXED** — pin "review MIN-1" added: `deliverMany` dispatches ONE notification with changes on two tracked sidecars; asserts one coalesced check per sidecar (`intentCheckCount` +2), both intents retired, the listener released, zero `runtime.edit`. The harness gained `deliverMany` (`deliver` delegates to it) | `9c7ecf80f` | GREEN on the tip code (behavior was correct, coverage was not); RED under MX1 (`break` after the first wanted change in `CoalescedDocListener#next`): the second sidecar's intent stays outstanding — `1 passed (10 steps) / 1 failed (1 step)`; mutation reverted, tree clean |
| MIN-2 | `speculation.md` §4 overclaims "O(outstanding), never O(history)" (MINOR) | **FIXED (text)** — the RULED content (carrier, guards, never a dependency on history) stands; the COST clause now says what the code does: a notified check is O(outstanding + hinted indices); a change with no usable index (an append, a moved hint) degrades to a backward tail scan over the entries appended after the tracked one — O(k) per notification on a busy shared stream; the immediate check at `trackIntent` walks the raw array once, O(E). Mirrored in the register block's "Not rows" (i) and the build report §3 (dated). The code alternative (memoize each located index into the hint set → O(1) thereafter) is NAMED as the fix shape and flagged, NOT built — describe, don't re-rule | `546ef4cb3` (spec), `793a10aab` (register/report) | n/a (text); pin 5 still pins the hinted arm's O(1) and the immediate walk's 1 000 visits |
| MIN-3 | the tracked-set drain gap deserves a NUMBERED row (MINOR) | **OWED — OW42 minted** (minted as OW41, the next free number at mint time: the register's last was OW40; W1's branch at `19c6448ab` and the design base had minted none. Renumbered OW42 at the 2026-08-19 re-stack onto W1: W1's fix pass had concurrently minted its own OW41 — the O(closure) demand-pass row — which keeps the number). Row text: an outstanding intent whose sidecar entry is GONE before this client saw its mark never resolves — `waitForIntentConsequence` hangs, and with it the caller's durable-ack `onCommit` (`cell.ts` routes the flag-ON send path's ack through it — the CLI verb dispatch / webhook forwarder would wait forever); the ECHO still retires by W. Verified UNREACHABLE today (`maintainStreamEventWatermarks` recomputes `eventWatermark` from the contiguous consequenced frontier, so `eventWatermark ≥ seq(e)` implies the mark is present; nothing but compaction removes an entry). Fix shape (~10 lines in `#checkIntents`: record the entry's `seq` at first sight; treat `eventWatermark ≥ seq` with the entry gone as consequenced) with its pin. Trigger: OW24 — the compaction PR cannot land without it | `793a10aab` | register §3, the W2 block; the build report's flag 1 annotated |
| MIN-4 | the one best-effort `sync` kick is load-bearing; a transient first failure leaves the stream unwatched (MINOR) | **FIXED** — `#watchIntentSidecar` now runs on EVERY `trackIntent`, not only when the sidecar state is created. Cost shown, not assumed: a covered re-kick takes the selector tracker's exact-match fast path and `pull`'s `#syncTasks`/`newEntries.length === 0` early return (no wire; `normalizeSyncSelector` returns the `REJECTING_SELECTOR` singleton for `schema: false`, so `Provider#syncRequests` does not grow); micro-measured on the real replica (EmulatedStorageManager over an in-process server, real clock): first sync 7.9 ms (the watch), covered re-kick **1.7–2.4 µs each** (×1 000 / ×10 000). Pin 1's "sync exactly once" assertion became "once per fire, same selector" | `546ef4cb3` | pin "review MIN-4" (`failNextSync` makes the first `sync` resolve `{error}` — loud `intent-watch-failed` asserted via `getLoggerCountsBreakdown`; the second `trackIntent` on the same sidecar must re-issue the sync): RED on the build tip at `expect(scripted.syncs.length).toBe(2)` (received 1); GREEN after. The provisional note series (§4 below) shows no per-note growth from the re-kick |
| MIN-5 | pin 10 weaker than the design's "by `synced()`/`idle()`" (MINOR) | **FIXED** — pin 10 now states the design's guarantee: a probe subscriber registered AFTER the listener (the relay runs subscribers in insertion order) arms `manager.synced()` and `runtime.idle()` AT the frame that carries the mark; both continuations must read `pendingIntentCount` 0 (and the probe reads 1 inside the dispatch — contract point 3). The macrotask-poll assertion is kept beside it | `546ef4cb3` | GREEN on the tip; RED under the mutation "defer the check to a macrotask" (`queueMicrotask` → `setTimeout(0)` in the listener): `synced` reads 1 (line 795) — a deferral the old macrotask-poll form could NOT see (the deferred check ran before the poll's next 20-ms tick; that assertion stayed green under the same mutation). Mutation reverted, tree clean |
| MIN-6 | the scripted harness's change addresses lack production's `scope: "space"` (MINOR) | **FIXED** — every harness change address now carries `scope: "space"` (as `differential.ts`'s `toAddress` sets via `normalizeCellScope`) | `9c7ecf80f` | the reviewer's MX4 mutation (`wants` accepts only `scope === undefined`) now reddens the SCRIPTED describe (0 passed / 1 failed, the first pin), not only e2e pins 6/10; reverted, tree clean |
| MIN-7 | not rebased onto the stated base; docs-only conflict (MINOR) | **FIXED** — §1 above | `20c442213` (the rebased tip before any fix) | merge-base now `461b01822`; code byte-identical; suites re-run on the rebased + fixed tip (§3) |
| N-1 | "pins 1–11, each with its mutation" overstates (3/4 folded into pin 1; 11 has no mutation) (NIT) | **FIXED (text)** — spec: "each with its mutation or OFF witness, plus the review pins"; register: "each pin red under its own mutation, or — pin 11 — the OFF witness"; the test-file header says which are folded | `546ef4cb3`, `793a10aab` | n/a |
| N-2 | no per-entry try/catch in `#checkIntents`; a throw would strand the check's other ids (NIT) | **HARDENED** — `try { this.#applyIntentEntry(...) } catch { logger.warn("intent-apply-failed", …) }` around the one call; the key added to the register's counter surface. No pin: nothing in the arms can throw today (the reviewer's own finding — subscribers are caught in `#notifyIntentOutcome`, the waiters are promise resolvers), and a red would need a throw injected into a private path; stated rather than pinned vacuously | `793a10aab` | n/a |
| N-3 | the tail-first scan reads the T25 duplicate's own mark where the old forward scan read the original's (NIT) | **NOT CHANGED** — the backward scan IS design contract point 4's; the duplicate's own `consequenced` (the skip path seals it without error) is THIS fire's consequence — arguably more correct, as the reviewer says. Recorded as a behavior delta in the build report §3 and the register's "Not rows" (ii) | `793a10aab` | verified against `space-server.ts` `#drainStreamEvents`' `duplicateOfConsequenced` arm (`#sealEventConsequenceNotice` on the duplicate) |
| N-4 | "loads 2.0–5.5" understates the in-run peaks; the baseline arm ran under the highest load (NIT) | **FIXED (text)** — from `load-samples.txt` (10-s cadence): in-run 1-min peaks b1 **6.29** (07:08:30Z; the reviewer quoted the 07:04:59Z sample 6.12), e1 5.01, a1 6.07, ca1 7.61; stated in the build report (§1, §6), the register block, the PR body; the ratio is indicative, the slope is the signal | `793a10aab` | the artifacts under the session scratchpad `w2bench/runs/*/load-samples.txt` |
| N-5 | `intent-echo-retired-by-backstop` counts echo entries swept by W, not missed marks (NIT) | **FIXED (text)** — one sentence in the register's counter bullet and the W4-witness bullet, and beside the chat witness in the build report §6: the arrival sweep runs synchronously inside `applySessionSync` and can retire the echo before the mark's microtask check runs — 2 backstops coexist with 25/25 resolved by mark | `793a10aab` | n/a |
| N-6 | the re-seamed `event-append-client` pin's first `feed` exercises only the tail-scan arm (NIT) | **NOT CHANGED** — stated in the register's "Not rows" (iii); the hinted arm is pinned in the new suite (pin 5, MIN-1) | `793a10aab` | n/a |

Dispositions: 10 FIXED (5 in code/tests — MAJ-1, MIN-1, MIN-4, MIN-5,
MIN-6; 1 the rebase — MIN-7; 4 text — MIN-2, N-1, N-4, N-5), 1 OWED
(MIN-3 → OW42, minted as OW41), 1 HARDENED (N-2), 2 NOT CHANGED
(N-3, N-6). Nothing
upgraded; nothing disputed.

Files touched by the fix pass (vs the rebased tip `20c442213`, +/−
lines): `overlay-destination.ts` 35/2 (the live-set gate, the per-fire
kick, the apply guard), `speculation-intent-listener.test.ts` 211/9 (+3
pins, pin 10 strengthened, header), `speculation-intent-test-utils.ts`
60/17 (`deliverMany`, `failNextSync`, production scope),
`speculation.md` 12/3 (§4's cost clause), `verification-coverage.md`
143/62 (the W2 block re-tensed, OW42 — minted as OW41), the build
report 93/6 (dated
notes), the review report 146/0 (new), `INDEX.md` 1/1.

## 3. Suites (FOREGROUND, every `deno test` with `--no-lock`; the runner through its package task's exact flags + preload)

On the fix tip `793a10aab` (the code tip; this report is the commit
after it):

- runner — `packages/runner` (`ENV=test deno test --no-lock --no-check
  --preload=test/clock-preload.ts --allow-ffi --allow-env --allow-read
  --allow-write=/tmp,/var/folders --allow-run=git,deno`), run as two
  halves of the package task's `test/**/*.test.ts` list under the
  10-minute call cap (`test/[a-l]*.test.ts test/scheduler/*.test.ts`
  and `test/[m-z]*.test.ts`): **521 passed (4 034 steps) + 692 passed
  (2 697 steps) = 1 213 passed (6 731 steps) / 0 failed** (5m06s +
  3m26s; the build's count was 1 213 / 6 728 — +3 steps = the three
  review pins). Logs: session scratchpad `fix-w2-runner-{A,B}.log`.
- memory `deno check` + tests: **521 passed (229 steps)**; toolshed
  **142 (428)**; runtime-client **61 (212)**; piece **37 (451)**;
  spec-model check + **23 passed**.
- Targeted family (`speculation-intent-listener` 2 tests / **12
  steps**, `event-append-client` 4/15, `speculation-arrival-gate` 1/6,
  `executor-effect-channel` 1/15, `executor-events-down` 1/13): **9
  passed (61 steps) / 0 failed** (38 s).
- `deno task --no-lock check-docs`: 548 blocks pass;
  `check-docs-history-index`: 120 entries / 165 documents (166 with this
  report); `deno fmt --check` on the 9 touched TS files: clean (`docs/`
  is fmt-excluded by config); `deno lint` on them: clean; `deno check
  --no-lock` on the three `src/speculation/*.ts` + the two test files:
  clean.
- Mutation re-runs (each against the fixed code, reverted after, tree
  clean): MX1 → MIN-1 pin RED; MX4 → the scripted describe RED; the
  macrotask deferral → pin 10 RED; the MAJ-1 and MIN-4 pins RED on the
  build tip's code before their fixes.
- Tree clean after every run (`git status --short` empty; no
  `deno.lock` churn; the foreign `stash@{0}` untouched — no `git
  stash` used).

## 4. The one provisional series (the MIN-4 re-kick is the only client-side cost change)

Same recipe as the build report §1/§6 (the scratchpad driver
`run-arm.sh` with `PROFILE=1`; ON binary built from the fix tip
`793a10aab` by `COMMIT_SHA=… EXPERIMENTAL_SERVER_EXECUTION=true deno task
--no-lock build-binaries toolshed`, sha `3a3a0f6d37f9eed1`;
`/api/meta.gitSha` read back `793a10aab…`,
`shellServerExecutionDefine: "true"`; toolshed log `No default model
available`; fresh store; port 8961; the note workload with the client
captures, `CF_NOTE_CREATE_TIMING_SERIES=20`). Run f1, 19:31–19:34 UTC.

- **Load: 1-min 9.82 → 10.90 (in-run peak 11.32)** — roughly TWICE the
  build's a1 run (3.06 → 5.99, peak 6.07) and 1.7× b1's peak; the
  loads are NOT equal across the arms — the per-arm SLOPE is the
  signal, the cross-arm ratios are not.
- Per-note client `scheduler/run` ms: `153 117 109 147 142 110 112 106
  111 157 153 362 205 250 255 242 205 412 210 130` — **FLAT** (no
  monotone growth; first-10 median 115 / last-10 226 under a load
  rising 9.8 → 11.3; the design tip the same workload: 0.84 → 14–20 s
  monotone; a1: 86 / 116 at half the load); `scheduler/run` COUNT per
  note 77–122 (same band as every arm); `run/commit` 16–66 ms; the
  sink effect: **0 runs / 0 ms** (no `sink:…/of:stream-events:`
  action in any note's trace).
- createToView: `1147 852 739 1152 891 904 1135 1085 2009 790 1802 1254
  2339 1658 1215 1128 2115 1035 1429 583` ms — p50 1 135 (test's
  summary), p95 2 115; first-10 median 995 / last-10 1 342 — a mild
  rise that tracks the load's rise (9.8 → 11.3), vs the design tip's
  1.7 → 15 s; a1's 778 p50 was at half the load.
- Server unchanged in class: waves 341, `events 94/95`, lease.lost 0.
- Test step 1 RED on the pre-existing `splitDefinitions` console gate
  (as in every prior arm); the n=20 series completed.

Reading: the re-kick adds no per-note term (as the µs micro-measurement
predicts); the client's (e) budget stays flat under a heavier load.
PROVISIONAL — W4 is the quiet acceptance run. Artifacts:
`…/scratchpad/w2bench/runs/f1-note-on/` (`driver.log`, `meta.json`,
`load-samples.txt`, `test.clean.log`, `per-note.txt`, `stats-*.json`,
`store/`), `sha-on-fix.txt`, `tip-fix.txt`, `build-on-fix.log`.

## 5. Not done, and why

- **The MIN-2 code alternative** (memoize located indices into the hint
  set so a busy-stream notification is O(1) after the first location)
  — not built; the spec now states the cost as built and names the
  shape; building it would change the per-check accounting pin 5
  asserts and is an owner/W4 call, not a fix-pass one.
- **No pin for N-2's guard** — nothing can throw there today; a pin
  would need an injected throw into a private path (vacuous otherwise).
- **No chat series, no OFF bracket, no benchmark re-run** — the
  reviewer confirmed the artifacts; only the one client-side cost change
  (MIN-4) warranted a series, and it was run.
- **The PR base was not changed** (the re-stack onto W1's tip is the
  coordinator's separate step; §1 names the two docs-merge hazards it
  will meet).
- The register's OW41 number was minted against W1's tip `19c6448ab`
  and the design base; if W1's fix pass mints OW41 concurrently the
  re-stack renumbers one of them (stated here so the collision is
  visible). **Resolved at the 2026-08-19 re-stack onto W1:** W1's fix
  pass HAD minted its own OW41 (the O(closure) demand-pass row); W1
  keeps OW41 and this report's row is **OW42** — every reference here,
  in the build report, and in the register renumbered.
