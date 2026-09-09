---
status: historical
created: 2026-08-19
archived: 2026-08-19
reason: "Stage-C evidence: the swatch-stall root cause (W2.1+α) — a diverged speculation layer with no reachable retirement on a quiet space; 5/5 reds one class (delivered-but-masked); F1 orthogonal; fix seats S1–S4 for the owner."
---

# Root cause — the swatch stall on W2.1 + (α) (server-execution v2, stage C)

Investigator: read-only on all branches — nothing pushed, nothing commented; scratch worktrees + local commits only.
Date: 2026-08-19. Status: **COMPLETE** (mechanism named, reproduced ≥3× instrumented, heal-probe-confirmed; F1 tested).
Materials: `/Users/berni/labs-worktrees/w2-1-scratch` (the builder's failing configuration = W2+W2.1 on W3 `4f2bda2d7`, + my LOCAL instrumentation commits `cc132f3b7`/`036b22f08`-equiv/`44f381612`), `/Users/berni/labs-worktrees/w2-1-f1scratch` (the same W2 series cherry-picked onto the F1-fixed W3 tip `9e5e5b76a`, + the same instrumentation + test-only heal probes, tip `a25a0b064`), the builder's 13-run evidence and my runs under `…/scratchpad/w21bench/runs/` (`i1–i15`, `f1–f10`), binaries `toolshed-instr{,2,3}`, `toolshed-f1`.

## 0. The mechanism in three sentences

Under (α) the lagging voter's castVote LT1 child is purged at the flush deadline, so that voter's click is marked consequenced in a **mark-only commit** one commit before the drained child's votes commit; W2.1 retires the voter's castVote cascade echo at that mark, and because nothing confirmed covers the echo's docs yet, the retirement flip **visibly regresses the client's effective state** (the own vote disappears), which triggers a local re-derivation of the swatch VDOM from the regressed base that seals a **diverged speculation layer — a literal tombstone patch `{"op":"splice","path":"…/children","index":1,"remove":1,"add":[]}` deleting the voter's own span** — over the swatch VDOM doc. The server's healed derivation then ARRIVES under that layer (delivery is fine — the doc's confirmedSeq advances past the healed write), but the client never converges, because BOTH designed convergence paths are unreachable: the swatch computed is never re-run (it is an **undemanded pull computation** — `liveRefs 0`, `hasRunnablePullWork false`, a LEGAL scheduler idle; under server execution the client does not autonomously re-derive served nodes, and even an explicit page settle does not run it — probe-verified), and the tombstone layer is never retired (the sweep needs `W ≥ floor`, and the space-server's **watermark freezes below the tombstone's floor the moment the space goes quiet** — W covers inputs, never the tail derivations' own seqs). The stale splice keeps deleting the own span out of every healed confirmed value beneath it until the **next authored commit anywhere in the space** advances W and the sweep lifts the whole stack — probe-verified: a single keystroke into an unrelated input healed the stalled browser within one 500 ms poll, while two explicit settles did nothing.

Three necessary conditions (each individually designed/accepted; the deadlock is their conjunction):
1. **(α) purge + mark-only ordering** (server): the lagging voter's mark arrives in a commit carrying no confirmed write to the echo's docs. In green runs the two clicks coalesce into one wave commit (the mark rides with the other voter's confirmed add — no exploitable window), or the flip's re-derivation lands after the arrival and converges.
2. **W2.1's cascade-echo retirement at the parent's mark** (client): the designed flicker. It is what turns the mark-only commit into a client-visible regression; the fatal artifact is the re-derivation-from-the-regressed-base sealing a REMOVE patch diffed against the pre-flip rendering.
3. **No reachable convergence on a then-quiet space** (client+server): no re-run (undemanded computed, by design under server execution — and a settle does NOT pull it) and no retirement (W frozen below floor; secondarily, unacked-origin chaining among the stacked layers). The sweep's own comment accepts lingering entries under the premise "values converge, rendering stays correct" — the W2.1 flip manufactures a lingering layer whose value DIVERGES, which is exactly the unhandled case.

## 1. Per-red-run classification (the builder's 5 reds)

**All five are ONE class:** delivered-but-masked — "confirmed vote and healed swatch VDOM delivered to the stalled browser; a diverged local speculation layer (tombstone) masks the own span; no re-derivation, no retirement." None is (i) doc-never-delivered (instrumented reds show the swatch doc's confirmedSeq advancing past the healed server write UNDER the live tombstone). None is (iii) B1 lost delivery (every red store holds both votes durable, `users` spliced exactly twice, every event in exactly one derived commit; B1 loses the handler's writes entirely — a missing vote add — which no red shows; the castVote path also has no same-eventId sibling tx, B1's trigger).

Store archaeology (sN = `…/w21bench/runs/sN-lunch-on`, the builder's preserved stores):

| run | click marks | purged voter = flickering browser | drained child commit | swatch VDOM += own span | shape |
|---|---|---|---|---|---|
| s5 | Bob's click+child ride c67; **Alice marked ALONE c69** | Alice (host; flickers 1) | c70 | c71 | mark-only → RED |
| s8 | Alice rides c70; **Bob marked ALONE c72** | Bob (guest; flickers 1) | c73 | c73 | mark-only → RED |
| s10 | Bob rides c65; **Alice marked ALONE c66** | Alice (flickers 1) | c67 | c67 | mark-only → RED |
| s11 | Bob rides c59; **Alice marked ALONE c60** | Alice (flickers 1) | c61 | c61 | mark-only → RED |
| s12 | Alice rides c64; **Bob marked ALONE c65** | Bob (flickers 1) | c66 | c66 | mark-only → RED |

Green runs with the SAME purge+drain (s6, s13): both clicks marked in ONE commit that also carries the other voter's confirmed add → the flip has confirmed cover at the mark frame → no exploitable regression. s9's red is load (join step, peak 25; both joins durable) — not this class.

**Flicker-counter correlation:** in the builder's 13 runs, `overlayCascadeEchoFlickers=1` on exactly one browser ⟺ RED (5/5), all-zero ⟺ GREEN. My 25 runs refine it: the flicker marks the WINDOW (retirement processed with nothing confirmed at/after the mark covering the echo's docs) — **necessary but not sufficient**: f3 (F1 arm) had host flicker=1 yet healed green (the flip's re-derivation raced late enough to read the already-arrived confirmed base and sealed a CONVERGED layer). The kill condition is the regressed re-derivation **sealing before the drained child's arrival**.

Also corrected: the builder's "'2 love it' rendered 300–700 ms post-click, so the tally arrived" is not sound as delivery evidence — `waitForSettledText` passes on one settled snapshot, and on the flickering browser that snapshot can be the pre-retirement echo + the other's confirmed vote. Delivery was instead proven by the instrumented confirmedSeq under the tombstone.

## 2. Reproduction ledger

Local instrumentation (all LOCAL commits, never pushed): count-only probes at storage-v2's sync-arrival/notify and superseded-flip seams; overlay `debugSnapshot()` (live entries: floors, origins, written docs with confirmedSeq + pending-layer OPS) and scheduler `debugInvalidNodes()` (per-invalid-node liveRefs / demanded / throttled / debounce / pending + loop state), both exposed through `getLoggerCounts`; scheduler trigger-trace always-on; the lunch swatch step rewritten to poll per-page swatch names, dump diagnostics at 15 s/timeout, and (iteration 4, F1 arm only) fire heal probes.

Arm A — the builder's exact configuration (`w2-1-scratch`, W3 tip `4f2bda2d7`):

| run | load(1m) | result | note |
|---|---|---|---|
| i1,i2 | ~9 | GREEN | purge 0 |
| i3,i4 | ~9 | GREEN | purge 1, heal won before the first poll |
| i5,i8,i9,i11–i14 | 9–104 | GREEN | (i8 336 s wall — box starved) |
| **i6** | 12.7 | **RED 60 s** | poll: `+2ms host=Alice+Bob guest=Bob` → `+505ms host=Bob guest=Alice+Bob` → frozen |
| **i7** | 14.9 | **RED 60 s** | identical |
| **i10** | 27 | **RED 60 s** | tombstone ops + trigger trace captured |
| **i15** | 104 | **RED 60 s** | invalid-node predicates captured |

Arm B — the same W2 series on the **F1-fixed** W3 tip (`w2-1-f1scratch`, base `9e5e5b76a` which contains `499c9dd7b` = F1+M1 fixes; verified `contribution.context.lt1 === true` present in wave.ts):

| run | result | note |
|---|---|---|
| f2,f4,f5,f6,f8 | GREEN | |
| **f1** | **RED 60 s** | same poll shape; tombstone verbatim: `splice remove@1` on the swatch doc, confirmedSeq 71 healed under it, W 67 < floor 68, scheduler legally idle |
| f3 | GREEN | host flicker=1 that healed (the necessary-not-sufficient case) |
| **f7** | **RED 60 s** | guest side |
| **f9** | stall ≥35 s, then probe-healed | **settle@20 s: NO heal; one keystroke@35.3 s: healed at the NEXT poll (+35.8 s)** |
| **f10** | stall ≥35 s, then probe-healed | identical probe outcome |

Stall rate: builder 5/13; my Arm A 4/15 (loads 9–104, greens cluster at low load and at extreme starvation); Arm B 4/10. **F1 does not move the rate and does not touch the mechanism** (§5). Reds require moderate load — it jitters the wave boundary so the two clicks land in separate waves (the mark-only ordering) and the client-side flip beats the drained child's push.

## 3. Mechanism narrative with anchors

(File:line at `4f2bda2d7` + W2 series, i.e. `w2-1-scratch` without the instrumentation commits; all confirmed present on the F1 tip too.)

Server — the window:
- `packages/runner/src/executor/space-server.ts` `#purgeLt1Leftovers` (both `exhausted` arms of `#waveCycle`): the lagging voter's castVote LT1 child is purged at the flush deadline (`lt1LeftoversPurged 1` in every red) → its click's wave commits the MARK without the child's writes; the drain delivers the child one wave later. Whether the two clicks coalesce into one wave (green) or split (the red precondition) is scheduler/load timing.

Client — the poison:
- `packages/runner/src/speculation/overlay-destination.ts` `retireIntent` cascade arm (W2.1, `5319ed3a5`-equiv): the mark retires the click echo AND its castVote cascade echo (`#cascadeReaches`).
- `packages/runner/src/storage/v2.ts` `finalizeSupersededSpeculation` (~:4599): dropping the echo's pending layers diffs effective values and emits the flip `integrate` (source = the echo's tx). Mark-only ordering ⇒ the votes array and vote entity visibly regress (`probe-flip-changed`); coalesced ordering ⇒ empty diff (`probe-flip-noop`), no exposure.
- `packages/runner/src/scheduler/invalidation.ts:120–226`: the flip triggers the derivation chain; the swatch computed re-runs against the regressed base; its output is DIFFED against the current effective value, so it seals a speculation layer whose content is a **REMOVE patch**. Captured verbatim (i10 host, swatch VDOM doc `computed:fid1:cQ96eS7…`): pending layer 76 = `{"op":"splice","path":"/value/0/children/1/children","index":1,"remove":1,"add":[]}` — the voter's own span deleted; the SAME doc's `confirmedSeq = 75` already held the server's healed VDOM (both spans) UNDER it. Effective = healed ⊕ tombstone = other-voter-only; that is what the DOM renders for 60 s (f1 reproduces the identical layer on the F1 tip: confirmedSeq 71 under `remove@1`, floor 68, W 67).

Client — why no re-run (heal path 1 dead):
- Trigger trace (i10 host): the drained child's votes commit DOES arrive and notify (`integrate …/value/votes` at t=8149 after the flip at 7501); the chain re-runs todaysVotes → counts → ranked (the ranked doc's layers HEAL — both voters) — and **dies one level short**: at t=8214/8218 the ranked-doc changes mark the swatch computed (and topChoice computed) `mark-invalid`, and no action ever runs again (the 15 s and 60 s dumps are byte-identical).
- `invalidation.ts:395 planPullTriggeredAction` → `operation:"invalidate"` (mark-invalid, never schedule). `work-oracle.ts:246 hasRunnablePullWork` runs an invalid computation only if demanded (`facade.ts:2550 isDemandedPullComputation` → `dependency-graph.ts:68 isLive`: demand-root or `liveRefs > 0`).
- **i15 predicate dump (the answer):** all 41 invalid computations on the stalled browser have `liveRefs 0, demanded false, throttled false, debounceWaiting false, pending false`; loop state `running false, scheduled false, wakeShaperPending false, eventQueue 0, hasRunnablePullWork false` — a LEGAL idle. The healed guest sits in the SAME state (43 invalid, not runnable) — the idling is normal under server execution: the server derives; a client computation whose output doc is rendered only through a storage SINK is undemanded for the autonomous drain. **Probe-verified consequence: an explicit `viewSettled()` on the stalled page does NOT heal it** (f9/f10 at +20 s) — idle() resolves without running undemanded computeds. So the intended convergence path for a stale local derivation is not re-running it; it is retirement.
- (Why the flip-time re-derivation DID run minutes... ms earlier: the merge step's `waitForSettledText` settles were still driving the page/demand context through ~t=7800; the arrival at 8149 landed after the last settle. The swatch test step deliberately polls the DOM without settling — but per the above, settling would not have saved it either.)

Client+server — why no retirement (heal path 2 dead):
- `overlay-destination.ts` `#sweep` (~:1697): retire iff no unacked pending layer below AND `watermark ≥ floor` AND every written doc's `confirmedSeq ≥ floor`. The tombstone's floor (68–72 across reds) includes seqs of PUSHED DERIVED values its run read, and the space-server's watermark **stops below the tail derivations** when the space quiets (i10: W 71 vs floor 72; f1: W 67 vs floor 68; the sweep's own comment: "the server's own derived write bumps it ABOVE any reachable W on a quiet space… the entry lingers on a then-quiet space (values converge, rendering stays correct; each new input lifts the previous generation)"). The lingering-is-fine premise — CONVERGED values — is exactly what the flip-regressed re-derivation violates.
- Second, independent blocker: the stacked generations' `originLocalSeqs` reference other live speculation layers (unacked → `blocked`), 30–40 entries deep on the stalled browser.
- **Probe-verified exit:** one authored commit anywhere in the space (a keystroke into the option-draft input, on the OTHER browser) → new wave → watermark write past the floors → sweep fixpoint lifts the stack bottom-up → the served swatch shows through **within one 500 ms poll** (f9: stalled from +0.5 s, settles at +20 s useless, keystroke at +35.3 s, healed at +35.8 s; f10 identical). In production terms: the stall lasts exactly until the next event in the space — potentially forever for a passively watching user.

## 4. Fix-seat verdict

The deadlock is a conjunction of three parties, each defensible alone; the DEFECT, named precisely, is: **a client speculation layer whose value diverges from the store (derived from a flip-regressed base) has no reachable retirement on a quiet space.** W2.1+(α) is the (currently only known) producer of diverged layers; the retirement hole is general and pre-exists W2.1 (any regressed-base re-derivation racing an arrival could mint one — e.g. a rejection-revert racing pushes).

Candidate seats, with costs and what each does NOT fix:

- **(S1) The quiet-space watermark tail** (server, serving loop / space-server): after the drain settles a tail wave, advance/emit a watermark that covers the tail derivations (make "each new input lifts the previous generation" hold without requiring a NEXT input). Fixes: this stall for every producer, and drains the 30–40-entry lingering stacks (a memory/liveness win). Does not fix: the visible flicker itself (own vote blinks for a wave); the diverged layer still exists for ~a wave. Cost: W's meaning is RULED text ("W covers inputs"); advancing it to the derived tail on quiescence is a semantics amendment — **owner-visible, but small and server-local**. This is the seat the heal probe demonstrates: the keystroke's only relevant effect was a watermark advance. Cheapest credible fix.
- **(S2) Shape (b) — deterministic cascade ids** (owner-level, already flagged by the builder §7): the echo carries the server child's id, retires on the child's OWN mark/arrival — no premature retirement, no regression window, no flicker, no tombstone. Fixes the producer entirely (conditions 1+2 vanish). Does not fix: the general diverged-layer/frozen-W hole (S1's class) — a future regressed-base re-derivation from another cause would still strand. Cost: spec-level identity change (events.md §4 per-attempt freshness), two code paths agreeing byte-for-byte, retry story — the owner is already weighing it.
- **(S3) W2.1 retirement timing** (hold the cascade echo until the child's delivery is covered): re-verified NOT buildable today — the client cascade id appears in no durable entry, no mark, no watermark, no arrival can name it (`OverlayEntry.parentEventId` doc); "cover" would have to be inferred (e.g. retire the cascade echo only when the parent's mark commit or a later confirmed write covers the echo's written docs — an arrival-gated variant of the cascade arm). That narrower version IS buildable client-side (the flicker witness already computes exactly this predicate at the mark!) and would close the lunch stall (the echo would stand the extra wave until the drained child lands, then retire on arrival with an empty flip — no regression, no tombstone, no flicker either). It weakens W2.1's guarantee to "retire at mark OR on subsequent arrival, whichever is later" and re-opens a sliver of the stranding it fixed if the child never lands (needs the W backstop as today). Does not fix: S1's general hole.
- **(S4) Client scheduler: run invalid computations whose output doc a live sink renders** (demand the writer through the sink). Fixes the re-run leg generally. Cost: reverses a deliberate server-execution narrowing (the server derives; client re-runs are speculative extras) — could reintroduce the OW32 re-derive-forever loop class the arrival gate exists for. NOT recommended as the seat.

**Verdict:** two seats each independently kill the lunch stall: **S1** (make retirement reachable on quiet spaces) and **S2/S3** (stop minting the diverged layer). **S1 is the cheapest and is the RIGHT fix for the actual defect** (diverged layer with unreachable retirement — it also repairs the class for unknown future producers and drains the lingering stacks); **S2 is the RIGHT identity-level fix for the producer** and the owner already has it flagged; S3's arrival-gated cascade retirement is a competent W2.1-local mitigation if S1/S2 are deferred, using the flicker witness's existing predicate as the gate. **Flag: both S1 (watermark semantics amendment) and S2 (event identity) are owner-level rulings; S3 is buildable inside W2.1's existing seam without a ruling but changes stated W2.1 semantics — flagged, not chosen unilaterally.** If the lift decision cannot wait for a ruling: S3 + the register row for S1's hole is the minimal honest package.

Also for the register regardless of seat: (d′)-adjacent finding — the sweep's accepted-lingering premise ("values converge, rendering stays correct") is false under any mechanism that can regress the effective read base between derivation generations; and the flicker witness (`cascade-echo-retired-unarrived`) is a live, cheap predictor of the poisonous window (it was 5/5 on the builder's reds and marks the stalled browser in every instrumented red).

## 5. Does F1 change anything? — NO (tested, not just reasoned)

F1 (`499c9dd7b` on `claude/server-exec-v2-w3-alpha`, now re-stacked into train tip `b2ecd93b0`) gates `survivedEventIds` marking on `contribution.context.lt1 === true` — it prevents a same-eventId SIBLING tx from marking an LT1 entry consequenced (the B1 lost delivery). The lunch castVote has no sibling tx; the red-shape ordering (purge → mark-only commit → drained child next commit) is byte-identical on the F1 tip, and the reds reproduce there with the SAME tombstone (f1: `splice remove@1`, healed confirmedSeq 71 under it, W 67 < floor 68, legal idle; f7, f9, f10 same class). Rate: 4/10 on the F1 arm vs 5/13 (builder) / 4/15 (my Arm A) — no movement beyond noise. Corroboration from the re-stacker's own ledger (`ef69c1a39` docs commit): one of their three train-tip lunch runs "carried the stall shape recovering inside the timeout (swatch step 28.3 s, the only run with commit reverts)" — a revert-cascade is another accidental layer-lifting path (rejection cascades drop speculation layers), consistent with §3's endgame.

## 6. What was NOT done

- No fix built anywhere (per brief); no pushes, no PR comments, no branch checkouts mutated — all work is local commits on the two scratch worktrees (`w2-1-scratch` tip `44f381612`, `w2-1-f1scratch` tip `a25a0b064`), both trees clean.
- The B1 check on the 5 builder reds was by store shape (votes durable, one consequence commit per event, no sibling tx on the castVote path), not by re-running review probe P1.
- The green-run coalescing claim (both clicks in one wave) was verified on s6/s13 only; other greens inferred from counters.
- WHY the swatch computed's `liveRefs` is 0 while its output doc is sink-rendered (the exact demand-accounting wiring for VDOM sinks vs actions) was characterized behaviorally (undemanded; settle does not run it; both browsers identical), not traced to its own root — irrelevant to the verdict because retirement, not re-running, is the designed convergence path, but S4 evaluation would need it.
- The heal probes ran on the F1 arm only (2 occurrences, both confirming); not re-run on Arm A (same client code at those seams).
- Load sensitivity was not isolated from the concurrent re-stacker's suites (loads recorded per run, 9–104).
- The re-stacked train tip `b2ecd93b0` itself was not re-benched by me (my Arm B is the same composition built independently; the re-stacker's 3-run ledger is quoted in §5).

## Appendix: where a successor picks up

- Reproduce: `REPO_OVERRIDE=/Users/berni/labs-worktrees/w2-1-f1scratch BIN_OVERRIDE=…/w21bench/toolshed-f1 zsh …/w21bench/run-arm.sh on lunch <id> 8961` under load ~12–30 (add CPU spinners); a red shows `[swatch-poll]` freezing with one browser missing its OWN voter name, `[swatch-diag …]` JSON carries the tombstone (`pending` ops with `"remove":1` on the swatch VDOM doc), the frozen `watermark`, and the all-undemanded `invalidNodes`.
- The instrumentation commits are cleanly droppable (`git log --oneline 9e5e5b76a..a25a0b064` — the last 4 commits are mine, marked "SWATCH-STALL INVESTIGATION").
- If S3 is chosen: the gate predicate already exists as the flicker witness's arrived-check in `retireIntent` (`overlay-destination.ts` ~:1457) — invert it from "count" to "defer this descendant's retirement to the arrival observer / W backstop".
- If S1 is chosen: the seat is the space-server's watermark advancement at drain-settle (where `of:server-execution-watermark` is written); the ruled sentence about W covering inputs is the text to amend.
