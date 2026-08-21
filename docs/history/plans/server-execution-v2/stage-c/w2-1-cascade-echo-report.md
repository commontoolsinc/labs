---
status: historical
created: 2026-08-19
reason: "Stage-C build W2.1 — the CLIENT cascade-echo stranding (W0 l3's 'duplicate join', root-caused by W3 and handed to W2) fixed as shape (a): retireIntent(P) also retires P's client cascade descendants, the flicker case counted; pins red-first with their killing mutations; the lunch gate's spurious join step re-pointed at the CONFIRMED roster; the lunch gate on both configurations with loads; shape (b) — deterministic cascade ids — recorded as the owner-level alternative."
---

# Stage C — W2.1: the client cascade-echo stranding (server-execution v2)

Date: 2026-08-19. Branch `claude/server-exec-v2-w2-intent-listener`
(PR #6039), built ON the W2 tip `6bec4a4bb`; commits `1afe64c13` (the
fix + pins), `145cf8680` (the lunch step + churn counters), `8efff7925`
(the flicker witness keyed on the mark's frame), plus the docs commit
carrying this report. Worktree `/Users/berni/labs-worktrees/w2-1-echo`
(detached from the branch, local branch `w2-1-local`; pushed
fast-forward only). Durable copy of this report:
`/Users/berni/labs-worktrees/w2-1-cascade-echo-report.md`. Every deno
invocation `--no-lock`; every suite FOREGROUND. Inputs: W3's build
report §1 (`stage-c/w3-alpha-build-report.md` on
`claude/server-exec-v2-w3-alpha`; the diagnosis), the W0 l3 artifacts
(`…/scratchpad/w0bench/runs/l3-lunch-on/`), stage-c-design.md §3.3
(the seven-point contract) / §5 / §6 W2, speculation.md §4, events.md
§4–§5, the W2 build/review/fix reports.

## 0. Verdict

**Built as W3's shape (a).** `retireIntent(P)` — the one seam every
terminal arm of an intent reaches (the consequenced mark, the error
mark, the dropped notice, the admission refusal) — now ALSO retires
every live overlay entry whose cascade thread reaches P: the echoes of
the events P's speculative run itself sent, sealed under client-minted
cascade ids. Pins W2.1-1…4 (scripted, the mark path) + one e2e pin (the
lunch join shape through the real path) — every one RED on the W2 tip,
each with its killing mutation; the lunch gate's "both join lands" step
now asserts the CONFIRMED roster and is RED on a standing echo; the
gate is 6/6 green at the W2.1 tip (no (α)) with the join step at
3.3–5.1 s (honest — it was 7–16 ms on the echo) and the (α) class
visible in the store as W3 predicted; on the local W2.1 + (α) scratch it
is 4/4 green at loads ≤ 12 (join 253–255 ms, every event in exactly one
derived commit, `users` spliced exactly twice, 3 vote adds / 0 removes)
but RED at the swatch step in 5 of 12 runs there — and the bisect
(W3 alone 3/3 green under higher load; W2 on W3 without W2.1 2/2 green
under far higher load) attributes that stall to W2.1 in the (α)
configuration (§6b): the voter's own vote echo is retired at the
click's mark (the designed flicker) and the CONFIRMED own vote, durable
in the store, then fails to render its swatch within 60 s on that
browser — a BLOCKER-class finding for the LIFT configuration, flagged,
not root-caused. The flicker case itself is COUNTED and observed live
on both configurations; shape (b) — deterministic cascade ids on both
sides — is recorded as the owner-level alternative (§7) and would also
remove the exposure above (the echo would stand until the child's own
landing).

## 1. The mechanism, exactly (what (a) does)

Threaded state: `OverlayEntry.parentEventId` — the speculation run
context's `parentEventId` (cell.ts's plain `queueEvent` threads the
emitter's eventId for a send from within a speculation-stamped handler
run; the scheduler's dispatch stamp carries it into the context; the
late-echo rule already read it at seal) — now copied onto the sealed
entry; and `#cascadeParents`, a process-local, bounded (4 096, oldest
pruned — the jobless set's bound), insertion-ordered map child-id →
emitter-id recorded at the START of every event-handler seal that
carries a `parentEventId`, with or without writes, so a "router" child
that only forwards (no entry of its own) still links its grandchildren
to the root. Never persisted, never sent, never a dependency on
history; a link is needed only for the round trip between a cascade's
seal and its root's consequence.

`retireIntent(space, P, witness?)`: for every live entry in the space,
retire it if `entry.eventId === P` (as before) OR `#cascadeReaches(entry,
P)` — walk `entry.parentEventId`, then `#cascadeParents` links, up to a
depth cap of 64 (ids are fresh per attempt: no cycle), until P is
reached. A retired descendant: `#noteJoblessIntent(child)` (a LATE
grandchild sealing afterwards drops at seal through the existing
late-echo check on `context.parentEventId`), the verdict `withdrawn
{superseded: true}` with a cascade-specific message, the settled
re-sweep as before, `cascade-echo-retired` counted. Scope, precisely:
only entries whose thread reaches P — client-minted cascade children of
P's speculative run; a root fire's echo carries no `parentEventId` (it
is a tracked intent with its own mark); a derivation echo carries none;
another intent's cascade does not reach P; an untracked emitter's
cascade (a derivation-sent event's handler echo) has no terminal
ancestor and stands as before. The guards the design's seven-point
contract binds are kept: the parent still retires on the SANCTIONED
carrier (its own `consequenced` / `status` / `error` mark) or the `W ≥
seq(e)` backstop; the descendant rides the parent's signal. Stated, not
hidden: in the fail-soft posture where neither the listener nor the
watch installed, the descendant has no backstop of its own — exactly
as before W2.1 (the parent's echo, if any, still has the W sweep).

The four terminal arms, and what they mean for a cascade: consequenced
— the server's run of P produced the durable cascade under its own
ids, the client's copies are jobless; errored — the handler threw, no
cascade committed, the copies are false state; dropped / refused — the
handler never ran, the copies are false state. The retirement is
correct in all four; the FLICKER question (below) exists only for the
first.

## 2. The flicker case — counted, not hidden; the owner-level alternative

When the server's LT1 child of P did not complete in P's appending wave
— W3's (α1) purges it at the flush deadline and the drain delivers it a
wave later; before (α) the in-process leftover ran a wave late — the
cascade echo goes at P's consequence while the child's own consequence
is still a wave away: the echo's value disappears for that wave (ms to
a cut cycle). Counted: `cascade-echo-retired-unarrived` — armed ONLY
on the consequenced (non-error) arm (the one case where a server child
is on its way; a dropped / errored / refused parent produced no child,
the removal is final) — when NO doc the echo wrote holds a confirmed
value at or after the MARK frame's seq, read as the sidecar's confirmed
seq at the check (the mark and a same-wave child's writes commit
together, so a child that rode the parent's wave has moved every doc it
wrote to that seq; a purged child has moved none). Keyed on the mark's
frame, NOT the echo's read basis, on purpose: the first cut compared
against the basis and read 0 on the (α) scratch's s4 while the store
showed the flicker plainly (commit 60 = voter B's click ALONE, its
castVote child purged; 61 = the drained child's `add-unique`): voter A's
concurrent vote (59) had moved the votes doc past B's echo's basis
before B's mark — the lunch gate's own shape. A HEURISTIC still, two
misreadings stated on the getter: an unchanged authoritative value
(equality cutoff — no seq move) reads as unarrived; a foreign write
landing in the mark's own frame at or after the mark reads as arrived.
Surface: logger keys `speculation-overlay/cascade-echo-retired` /
`…-unarrived`, getters `cascadeEchoRetirementCount` /
`cascadeEchoRetirementUnarrivedCount`, the browser churn line's
`overlayCascadeEchoRetired` / `overlayCascadeEchoFlickers`.

Keeping the echo until the child's own delivery is covered by W was
NOT done — not cheap and not sound from the client: the durable child
entry carries no parent reference (`StreamEventEntry` has none), this
client does not watch the child's stream (it watches the sidecars IT
appended to), so there is nothing to match the echo against by parent
chain + stream + ordinal; and relaxing step 3's arrival gate for
orphaned cascades to "some written doc moved" would strand an echo
whose handler writes only entity docs (the stranding again) and is a
RULED-rule change. The flicker is the known cost of (a) and the reason
(b) exists (§7).

## 3. Pins, and the mutation that kills each (red-first; RED on the W2 tip `6bec4a4bb` means the pin was run against the tip's `overlay-destination.ts` — restored from `git show HEAD:` — and failed at the stated assert)

`packages/runner/test/speculation-intent-listener.test.ts` — a new
scripted describe (the mark path: entries register through a stub
replica's `sealNative`; marks arrive as notifications through the
scripted relay; the harness gained an optional replica seal seam,
ONE cached replica object per space) and one e2e pin.

| pin | asserts | RED on the tip | killing mutation (observed RED, code restored, tree clean) |
|---|---|---|---|
| **W2.1-1** | a cascade child's echo (client-minted id, `parentEventId` = P) writing the list + an entity doc is retired when P's consequenced MARK arrives; P's intent resolves; the child's verdict is `withdrawn.superseded`; `cascadeEchoRetirementCount` 1, unarrived 0 | `entryCount` 1 ≠ 0 (the entry stands forever) | M1: the cascade arm removed (`#cascadeReaches` → false) → RED (also pins 2–4) |
| **W2.1-2** | P's mark retires ONLY P's cascade: Q's root echo, Q's cascade child, and a cascade of an untracked emitter all stand; Q's mark then retires Q's own + Q's cascade; the orphan stands | `entryCount` 4 ≠ 3 | M2: the walk accepts any parented entry → Q's child and the orphan go with P → RED (also pin 4) |
| **W2.1-3** | a SILENT child (forwards only, no writes → no entry) threads its grandchild to P: both the grandchild and a direct child go at P's mark; a LATE child of P and a LATE grandchild of the retired child drop at seal (`lateEchoDropCount` +2); a fresh intent's cascade still registers | `entryCount` 2 ≠ 0 | M3a: the thread not recorded at seal → the grandchild stands → RED; M3b: a retired child's id not joining the jobless set → the late grandchild registers → RED |
| **W2.1-4** | the flicker witness: P1's mark at 45 with the list doc still at 40 → unarrived 1; P2's mark at 46 with its list at 46 → not counted; P3: a CONCURRENT writer moved the list to 44 before P3's mark at 47 and P3's child was purged → unarrived 2; P4 DROPS → its cascade retired, not counted | `entryCount` 2 ≠ 1 | M4a: the witness keyed on the echo's basis → P3 reads arrived → RED; M4b: the witness armed on the drop arm → P4 counts → RED |
| **W2.1 e2e** | the lunch join shape through the REAL path — a flag-ON client + a live ExecutorHost; a click handler that only forwards to a second stream whose handler cellifies a NEW object into a list (`users.set([...users, {name}])`): the cascade echo registers (the client renders one Alice), both sidecars consequence server-side, the click's intent resolves, the cascade echo RETIRES (`entryCount` 0), `cascadeEchoRetirementCount` 1 / unarrived 0 (flushDeadlineMs 5 s — the child rode the click's wave), the rendered list is exactly the server's one Alice and STAYS one through a settle beat | `timed out waiting for the cascade child's echo to retire on the click's consequence` (10 s) — the stranding reproduced end to end | M1 |
| **W2.1-5 (OFF)** | pin 11's shape stands: `runtime.speculationOverlay` undefined OFF, no subscribe, no node, the handler runs locally | n/a (witness) | n/a — every W2.1 line lives inside `SpeculationOverlayDestination`, which does not exist OFF |

Re-run after every mutation: the four scripted pins green, the e2e pin
green, `git status` clean (`overlay-destination.ts` byte-identical to
the committed copy — `diff -q`).

## 4. The lunch gate's spurious step, fixed

`packages/patterns/integration/lunch-poll-vote.test.ts`: "both join
lands (count reaches 2)" — `waitForSettledText(hostPage, "body", "2
joined")` + the guest's own name — passed on the HOST's stranded echo
(spec-Alice + confirmed Alice = "2 joined") in 7–16 ms, before the
guest's join had landed anywhere, and failed when the probe missed the
transient (W0 l3). Now "both join lands (confirmed roster: exactly
{Alice, Bob} on both)": a `participantChipNames(page)` helper reads the
participants strip (`data-participant-guest` / `-badge`, shadow roots
descended, DUPLICATES KEPT — a standing echo shows as the same name
twice), and the step waits until BOTH browsers show exactly two chips
naming {Alice, Bob} AND "2 joined" — a state only the guest's confirmed
join arriving at the host (and the host's at the guest) can satisfy.
RED on a standing echo (two Alices, or three chips), green only on the
real landing: its wall is now ≥ a server round trip on every ON run
(§6) and 25 ms OFF (the local-commit arm, one OFF run — the step change
is OFF-green). The ON skip entry is untouched (W3 owns the lift).

## 5. Suites (every green a LOCAL run; FOREGROUND; `--no-lock`; the runner through its package task's exact flags + preload, as two halves under the 10-minute call cap)

On `8efff7925` (the code tip; this report is the docs commit after it):

- runner — `packages/runner`: `test/[a-l]*.test.ts test/scheduler/*.test.ts`
  **521 passed (4 034 steps)** (4m48s) + `test/[m-z]*.test.ts` **693
  passed (2 702 steps)** (3m56s) = **1 214 passed (6 736 steps) / 0
  failed** (the W2 fix tip: 1 213 / 6 731 — +1 test +5 steps = the W2.1
  describe and the e2e pin). Logs: session scratchpad
  `w21-runner-{A,B}.log`.
- runtime-client **61 passed (212 steps)**; memory **521 (229)**;
  toolshed **142 (428)**; piece **37 (451)**; spec-model check + **23
  passed**.
- Targeted family after the witness refinement
  (`speculation-intent-listener` 3 tests / 17 steps, `speculation-
  arrival-gate` 1/6, `event-append-client` 4/15, `executor-events-down`
  1/13, `executor-effect-channel` 1/15): **10 passed (66 steps) / 0
  failed** (34 s).
- `deno task --no-lock check-docs` and `check-docs-history-index`: see
  the docs commit (run after this report landed; counts in the PR
  body). `deno fmt --check` / `deno lint` on every touched TS file:
  clean; `deno check --no-lock` on the overlay + the two test files:
  clean.
- Tree clean after every run; no `deno.lock` churn; the foreign
  `stash@{0}` untouched (no `git stash` used).

## 6. The lunch gate (binaries built with `COMMIT_SHA` + `EXPERIMENTAL_SERVER_EXECUTION=true deno task --no-lock build-binaries toolshed`; posture per run `/api/meta.shellServerExecutionDefine: "true"` + `servingLoop` present + `gitSha` read back; `No default model available` per run, 0 `CFTS_AI_LLM_*` keys, no `.env`; fresh cwd = fresh store; port 8961; `gtimeout --kill-after=30 520`; logs read with `/usr/bin/grep -a`; no orphaned browsers; loads recorded — the box carried OTHER agents' suites the whole session (a concurrent runner suite, a cli test at 148 % CPU, a long-running loom deno at 114 %), so loads are recorded, not excused)

### 6a. The W2.1 tip WITHOUT (α) — W2 + W2.1 only

Binaries: `536d144fb355a363` from `145cf8680` (l1–l3), `d3016826047aa056`
from `8efff7925` (l4–l6; the witness refinement changes counting only).

| run | start (UTC) | load 1/5/15 before → after (in-run 1-min peak) | wall | result / total | **both join lands** | merge / option B | events appended / processed; waves / exhausted | store: `users` splices; votes ops; consequence multiplicity | churn host / guest (`cascadeRetired` / `flickers`) |
|---|---|---|---|---|---|---|---|---|---|
| l1 | 20:35:02 | 6.02/6.59/7.00 → 8.07/7.04/7.13 (7.38) | 71 s | ✓ 30 477 ms | **3 551 ms** | 7 956 / 9 297 | 11 / 15; 60 / 193 | 46 (Alice idx 0), 49 (Bob idx 1); add 61, add 64, **remove 69**, add 72, add 83; {1: 14, 2: 1, 3: 1} | 2/1 ; 3/0 |
| l2 | 20:38:14 | 8.09/7.52/7.32 → 7.81/7.68/7.40 (9.36) | 62 s | ✓ 29 262 ms | **4 065 ms** | 7 727 / 8 082 | 11 / 15; 62 / 194 | 49, 52; add 66, add 69, **remove 74**, add 76, add 85; {1: 14, 2: 1, 3: 1} | 2/1 ; 3/0 |
| l3 | 20:39:32 | 7.52/7.63/7.38 → 8.96/8.17/7.61 (9.71) | 61 s | ✓ 30 847 ms | **5 079 ms** | 7 409 / 8 429 | 11 / 17; 66 / 195 | 51, 55; add 70, add 73, **remove 77**, add 79, add 89; {1: 14, 2: 1, 3: 1} | 2/1 ; 3/1 |
| l4 | 20:56:19 | 7.49/8.10/8.04 → 7.08/7.79/7.92 (7.18) | 61 s | ✓ 28 018 ms | **3 291 ms** | 8 805 / 8 461 | 11 / 19; 58 / 173 | 48, 52; add 63, add 66, **remove 70**, add 72, add 81; {1: 13, 2: 2, 3: 1} | 2/1 ; 3/2 |
| l5 | 20:57:32 | 7.08/7.79/7.92 → 8.42/8.07/8.02 (8.89) | 80 s | ✓ 34 832 ms | **4 071 ms** | 10 054 / 8 692 | 11 / 17; 66 / 241 | 49, 52; add 64, add 67, **remove 72, remove 74**, add 77, add 81, add 89; {1: 13, 2: 1, 3: 2} | 2/2 ; 3/1 |
| l6 | 20:59:14 | 7.86/7.97/7.98 → 8.66/8.22/8.07 (9.15) | 68 s | ✓ 34 506 ms | **4 564 ms** | 9 884 / 7 660 | 11 / 15; 62 / 209 | 49, 52; add 65, add 69, **remove 75**, add 78, add 86; {1: 14, 2: 1, 3: 1} | 2/1 ; 3/0 |

**6/6 GREEN; the join step is HONEST** (3.3–5.1 s — the guest's
confirmed join reaching the host under (α)-less serving, vs 7–16 ms on
the echo). The join itself is clean in every store: `users` spliced
exactly twice (Alice index 0, Bob index 1), one entity doc per user.
The (α) class W3 closes is visible exactly as the brief predicted: the
join LT1 child is consequenced in TWO derived commits (its in-process
leftover re-ran a wave later; `joinAs`'s own `existing.some(name)`
guard made the re-run a no-op, so no duplicate user), and the castVote
LT1 child in THREE (add → remove → add: the vote toggled OFF and back
ON — W0's l1 shape; the gate still greens because the final state is 2
votes). Not fixed here — W3's; reported. The flicker witness read 1–2
on a browser in every run: in l1 the click's mark is commit 45 and the
child's `users` splice commit 46 — spec-Alice went at 45, the confirmed
Alice arrived at 46, one wave later — the flicker, live.

### 6b. The LOCAL scratch combination — W2 + W2.1 rebased onto `origin/claude/server-exec-v2-w3-alpha` (W3 + W1 + the design base; `git cherry-pick 461b01822..145cf8680` onto `4f2bda2d7` in the detached worktree `/Users/berni/labs-worktrees/w2-1-scratch`, one docs-only conflict in the register — both blocks kept; scratch tip `13a23aa87`, then `36701427c` with `8efff7925` cherry-picked; NOT pushed)

Binaries: `7cfe0303d74a2086` from `13a23aa87` (s1–s4), `ba65956b650087c2`
from `36701427c` (s5–s10).

| run | start (UTC) | load before → after (peak) | wall | result / total | **both join lands** | merge / swatches / option B | events appended / processed (purged) ; waves / exhausted | store | churn host / guest |
|---|---|---|---|---|---|---|---|---|---|
| s1 | 20:42:40 | 12.51/10.36/8.58 → 7.20/8.95/8.27 (11.90) | 130 s | ✓ 110 264 ms | **255 ms** | **104 759** / 1 / 206 | 11 / 12 (1); 54 / 27 | users 43, 53; add 64, add 65, add 77 (0 removes); {1: 16} | 2/0 ; 3/0 |
| s2 | 20:45:34 | 5.81/8.41/8.10 → 10.57/9.26/8.41 (5.81) | 14 s | ✓ 3 822 ms | **253 ms** | 235 / 1 / 113 | 11 / 11 (0); 47 / 19 | 40, 49; add 60, add 60, add 71; {1: 16} | 2/0 ; 3/0 |
| s3 | 20:46:01 | 9.94/9.17/8.38 → 9.20/9.05/8.36 (9.55) | 15 s | ✓ 4 047 ms | **254 ms** | 172 / 1 / 185 | 11 / 11 (0); 50 / 19 | 43, 52; add 62, add 64, add 74; {1: 16} | 2/0 ; 2/0 |
| s4 | 20:50:48 | 6.08/7.26/7.72 → 6.54/7.29/7.72 (6.38) | 15 s | ✓ 4 595 ms | **254 ms** | 396 / 1 / 186 | 11 / 12 (1); 47 / 20 | 41, 49; add 59, add 61, add 70; {1: 16} | 2/0 ; 3/0 |
| s5 | 21:01:09 | 9.82/8.59/8.22 → 11.26/9.53/8.63 (11.89) | 96 s | ✗ at **swatches** (60 000 ms timeout) | 255 ms | 361 / ✗ / — | 9 / 10 (1); 52 / 32 | 44, 56; add 67, add 70; {1: 13} | 2/1 ; 2/0 |
| s6 | 21:03:00 | 11.08/9.52/8.63 → 10.95/9.68/8.72 (11.45) | 27 s | ✓ 6 377 ms | **255 ms** | 704 / 1 / 286 | 11 / 12 (1); 62 / 34 | 47, 58; add 70, add 72, add 85; {1: 16} | 2/0 ; 3/0 |
| s7 | 21:03:37 | 10.95/9.68/8.72 → 13.06/10.30/8.98 (12.21) | 28 s | ✓ 8 066 ms | **255 ms** | 1 091 / 1 / 408 | 11 / 12 (1); 63 / 39 | 45, 57; add 69, add 71, add 84; {1: 16} | 2/0 ; 3/0 |
| s8 | 21:05:17 | 13.43/11.01/9.35 (14.67) | 86 s | ✗ at **swatches** (60 s) | 281 ms | 348 / ✗ / — | 9 / 10 (1); 55 / 32 | add 70, add 73; {1: 13} | 2/0 ; 2/1 |
| s9 | 21:06:53 | 10.73/11.06/9.57 (**25.17**) | 82 s | ✗ at **both join lands** (60 s) | ✗ 60 142 | — | 6 / 6 (0); 42 / 23 | users 45, 57 (both joins DURABLE); {1: 8} | 1/0 ; 1/0 |
| s10 | 21:08:23 | 21.90/14.60/11.08 (20.79) | 83 s | ✗ at **swatches** (60 s) | 255 ms | 346 / ✗ / — | 9 / 10 (1); 47 / 25 | add 65, add 67; {1: 13} | 2/1 ; 2/0 |

Three later quiet-ish runs at the final scratch tip: s11 (21:23:12Z,
load 9.52 → peak 17.8) ✗ at **swatches** (join 254 ms, merge 271 ms;
store clean, 2 vote adds); s12 (21:24:39Z, 15.02 → 14.4) ✗ at
**swatches** (join 255, merge 472); s13 (21:26:07Z, 9.98 → 10.3) ✓
6 545 ms (join 255, merge 728, swatches 1 ms, `appended 11 / processed
12`, {1: 16}, 3 adds).

**The bisect (the honest part).** Because the swatch reds tracked load
only loosely (s5 red at 11.9 beside s7 green at 12.2; s11 red at 9.5 →
17.8), two baselines were built and run under the SAME or HIGHER load
— neither pushed: **(i) W3's own tip** `0b8156c09` (no W2, no W2.1;
binary `ee789d9fb563abc3`; its own test file, the old join step):
b1/b2/b3 at loads 20.1 / 21.7 / 20.1 → peaks 26.0 / 20.3 / 18.8 —
**3/3 GREEN**, swatches **505 / 1 010 / 1 009 ms**, merge 404 / 377 /
393 ms, `appended 11 / processed 12`, every event once, 3 adds; **(ii)
W2 on W3 WITHOUT W2.1** (`0f951a239` in the scratch's history — the
cherry-picked W2 tip on `4f2bda2d7`; binary `2d2272d2d0cd6f65`): c2/c3
at loads 116 / 70 → peaks 108 / 65 — **2/2 GREEN**, swatches 504 / 1
ms, merge 315 / 218 ms (c1 was killed by the box at load 350 before
voting — no result). Against that: **W2.1 on W3**: 7 GREEN (s1–s4, s6,
s7, s13; loads 6–12) / **5 RED at the swatch step** (s5, s8, s10, s11,
s12; loads 9.5–21) + 1 RED at the join step at peak 25 (s9, both joins
durable). **So the swatch-step stall is attributable to W2.1 in the
(α) configuration, not to load and not to W2.** Reading the mechanism
from the evidence (NOT root-caused — flagged): the voter's own castVote
is a cascade child of its click; under (α) its LT1 copy is purged at
the deadline in about one run in two (`lt1LeftoversPurged 1`) and the
drain delivers it a wave after the click's mark; W2.1 retires the
voter's own vote ECHO at the click's mark (the designed flicker), and
then the CONFIRMED own vote — durable in the store at the next commit,
and counted by "2 love it" on both browsers 300–700 ms after the clicks
— does not render its swatch on that browser within 60 s in those
runs. Before W2.1 the stranded echo carried the own swatch forever, so
every baseline is green by masking. Candidates a successor should look
at first: the confirmed own-vote ENTITY doc (a NEW doc id the client
never read — the echo's entity had the client-derived id) not reaching
the voter's replica after the echo's entity layer dropped (closure /
structural-growth push timing), or the swatch/`ranked` re-derivation
after the superseded flip racing the next frame; the OFF arm and the
(α)-less tip (6/6 green, merge 7–10 s) do not show it. This is a
BLOCKER-class finding for the LIFT configuration (W2.1 + (α)), not for
W2.1 alone, and not a store defect (every store clean). Until it is
understood, the skip lift should NOT proceed on W2.1 + (α) on the
strength of these runs; the worktrees `/Users/berni/labs-worktrees/
w2-1-scratch` (W2.1 on W3), `…/w2-1-w3base` (W3 alone), `…/w2-1-w2onw3`
(W2 on W3), the four binaries under `…/scratchpad/w21bench/`, the
driver, and the per-run stores are left in place for the successor.

Reading the rest, honestly. **At loads ≤ 12 with the join step: 7/7
green on the W2.1 + (α) scratch** — join **253–255 ms** on every run
(≥ a server round trip; the old step read 7–16 ms), `events appended 11
/ processed 11–12` (the 12th the purged LT1 leftover the drain
delivers — W3's shape), **every event in exactly ONE derived commit**,
`users` spliced exactly twice, 3 vote adds / 0 removes — the JOIN half
of the lift condition, green and honest; the swatch-step stall above is
the other half. s1's merge step (104.8 s at the session's first load
peak 11.9; the next runs 172–728 ms, W3's own 236–404 ms) is the same
stall surfacing in the merge step rather than the swatch step (both
browsers rendered after ~100 s); s9's join-step red at peak 25 (both
joins durable; the browsers starved) is load.

### 6c. OFF, once (the step change's OFF witness)

o1, 20:47:20 UTC, W0's OFF binary (`e91c7b3ff`, `shellServerExecutionDefine:
null`) with this worktree's test file, load 6.92/8.40/8.16 (peak 7.4):
✓ GREEN, total 4 961 ms, "both join lands (confirmed roster)" **25 ms**
(the local-commit arm: Bob's join propagates by sync), merge 13 ms,
option B 192 ms. The step is OFF-green.

## 7. The (b) flag — for the owner (not built; the coordinator is putting it to the owner)

**(b) deterministic cascade ids.** Derive a cascade child's event id on
BOTH sides from the parent event id + the send ordinal within the
parent's run, instead of `mintEventId`'s per-transaction random key.
Then the client's cascade echo carries the SAME id as the server's LT1
entry, so `retireIntent` matches it by its OWN mark (no thread walk),
and — because the handler frame's cause is `$event: tx.dispatchedEventId`
(runner.ts) — the cellified entity ids of the two runs AGREE, so step
3's arrival gate passes and the echo stands until the child's OWN
consequence lands: no flicker in the purged-leftover case, and a
tracked intent per cascade hop if wanted. What it touches:
`scheduler/event-identity.ts` `mintEventId` and events.md §4's "cascade
sends minted inside a handler attempt get fresh ids per attempt" (the
per-attempt freshness that keeps a retried attempt's cascades apart —
a deterministic id must carry the attempt or lean on the
committing-attempt-only escape), the C8d fold key and the served
dispatch's `parentEventId` carriage, the LT1 emission in `cell.ts`
(both arms mint), the client cascade's `queueEvent` id, and the (α)
seats that key on ids. Better: no flicker, one identity per cascade
hop, the child's own mark retires its own echo, no thread bookkeeping.
Worse: a spec-level identity change (events.md §4), two code paths
that must agree byte-for-byte, and a retry story to re-rule. Trigger
(my recommendation): if `overlayCascadeEchoFlickers` reads non-zero on
the W4 acceptance workloads at a rate the owner will not accept (it
reads 1–2 per browser per lunch run at the (α)-less tip, 0–1 on the
(α) scratch — where the purge makes the castVote child a wave late in
~1 run in 2 — see §6), or when per-hop intents are wanted.

## 8. Decisions (flag-don't-fill), and what was NOT done

1. **The thread is a bounded map, not a walk over live entries only** —
   a child that writes nothing has no entry to hang the walk on; the
   map (4 096, oldest pruned, same as the jobless set) costs one insert
   per cascade seal. Alternative not taken: thread a ROOT id through
   `ServerRunInfo` / `QueuedEvent` (shared server-side types — W1's
   files; out of scope here).
2. **The witness keys on the mark frame's seq** (decision after the
   scratch's s4 — §2); the parent's consequence seq is read as the
   sidecar's confirmed seq at the check — a later append to the same
   sidecar landing in the same frame would over-state it (rare; a
   false "unarrived"). The `retireIntent` signature gained an optional
   `witness` argument; public, no other callers.
3. **The sweep does NOT cascade.** When the W backstop retires a ROOT
   echo (`intent-echo-retired-by-backstop`), its descendants are not
   walked: in the normal posture the mark's microtask check runs in the
   same frame and does it; in the fail-soft posture (no listener, no
   watch) the descendant strands as before W2.1. Stated in the
   register; not built (one seam, the contract the review verified).
4. **NOT done — (b)** (§7); **NOT done — keeping the echo until the
   child lands** (§2); **NOT done — the lunch ON skip lift** (W3's);
   **NOT done — a quiet-box re-run of the scratch gate** (the box was
   at 12–25 for the last five runs; the successor's first step: the
   driver `…/scratchpad/w21bench/run-arm.sh on lunch <id> 8961` with
   `REPO_OVERRIDE=/Users/berni/labs-worktrees/w2-1-scratch
   BIN_OVERRIDE=…/w21bench/toolshed-on-scratch-b`, then
   `inspect-store.py` / `users-splices.py` on the run dir); **NOT
   done — the vote-toggle class** (W3's (α); visible in §6a's stores,
   reported); **NOT done — a chat / note series** (the change is
   retirement-only: zero new transactions, zero scheduler runs, an
   O(live entries × depth) walk at each intent's terminal — not a
   per-fire or per-change cost; W4's acceptance carries the numbers).
5. **The e2e pin lives in `speculation-intent-listener.test.ts`'s e2e
   describe** (its `standUp` gained a source/seed option; pin 10's host
   construction became the shared `newServingHost`) rather than
   `executor-events-down.test.ts` — the client-side retirement is the
   subject, the serving side is the fixture.

## 9. Files

`packages/runner/src/speculation/overlay-destination.ts` (the entry
field, the thread, `retireIntent`'s cascade arm + witness, counters,
getters, `close()`); `packages/runner/test/speculation-intent-listener.test.ts`
(W2.1-1…4, the e2e pin, the join pattern, the host helper);
`packages/runner/test/speculation-intent-test-utils.ts` (the optional
replica seal seam; one replica object per space);
`packages/patterns/integration/lunch-poll-vote.test.ts` (the confirmed-
roster step); `packages/patterns/integration/cfc-browser-helpers.ts`
(two churn counters); docs: speculation.md §4 step 2 (the dated
clarification), verification-coverage.md (the W2 block's W2.1 row + the
(b) FUTURE/owner row), stage-c-design.md §3.3 (the W2.1 landing note),
the W2 build report §9 (the dated addendum), `docs/history/INDEX.md`
(the directory entry names this report), this report.
