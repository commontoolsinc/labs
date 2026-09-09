---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Stage-C evidence: the independent adversarial review of the tuning trio (#5991) at 2e9d86478 — LANDABLE-WITH-FIXES; MINOR-1/2/3 addressed at b54bf5215."
---

*Recovery note — recovered verbatim on 2026-08-18 from the coordinator's
session transcript (the review agent's final message; its worktree
`/Users/berni/labs-worktrees/review-tuning` at `2e9d86478`). This is the
tuning trio's SECOND review round: an independent adversarial review of the
tip `2e9d86478`, after the on-branch
[`stage-c-tuning-review-report.md`](stage-c-tuning-review-report.md)
(findings 1–9, fixed at `7997a6971` / `2e9d86478`); its report was never
written to a file. The text below is the reviewer's, unedited — the
preamble line and the trailing `result:` line included. The review's
dispositions are `b54bf5215`'s commit message (MINOR-1 the register
reconciled to the final binaries; MINOR-2 the seal→outcome-window pin;
MINOR-3 the T2 row's "pending owner ratification" — the late-echo rule was
RATIFIED later that day, OW36; the pre-existing effect-channel flake
recorded, not fixed) and the register's "Stage C tuning delta (2026-08-18)"
in `verification-coverage.md` §3.*

I have everything needed. All work is complete: five mutation probes (all reverted, tree clean), the full suite matrix, deep code analysis of all four mechanisms, and the self-review re-derivation. Here is my assessment.

---

# Independent Adversarial Review — PR #5991 "stage C tuning trio"

## 1. Verdict: **LANDABLE-WITH-FIXES**

No code-correctness blocker. The three mechanisms (T1/T2/T3) + the drain guard do what the register says, the OFF arm is neutral, and every new pin is non-vacuous (verified by five mutation probes). The "fixes" are **documentation reconciliation** — the canonical register (`verification-coverage.md`) carries **stale interim measurements** that contradict both the PR body and the shipped test. Since that register is kept-true canon, it should be corrected before merge. A reviewer who treats the register lag as a follow-up could reasonably call this LANDABLE; I flag it as a fix because canon shouldn't land contradicting the code it documents.

## 2. Findings by severity

**MINOR-1 (doc, canon) — the register's stage-C measurements are the INTERIM binary's, mislabeled "final."** `docs/specs/server-side-execution/verification-coverage.md:3302` says T2 "**GREEN 10/10** — 7/7 on the final binary (`a9534d18…`, G3–G9)"; `:3339` says T3 "`lease.lost` 0 in all **13** re-measured runs"; `:3335`-ish describes test "(ii) a wave outliving a **600-ms TTL**." The PR body §Verification says **16/16** (6/6 on final binary **F10–F15**, with `a9534d18` the *interim*), **22** runs, and the shipped test (`executor-cooperative-yield.test.ts:264`) uses a **900-ms** TTL / 45-step walk. The register was written at commit `5c296cefe`, *before* the final commit `2e9d86478` (which removed the fan-out yield) and before the F10–F15 final-binary runs — so it predates the shipping code and omits its verification. The shipping code IS verified (PR body's final-binary greens + the green pins I ran), but the durable canon disagrees. Reconcile the register to the final numbers, or mark them interim.

**MINOR-2 (informational) — the guard's release-point change (self-review Finding 1) is safe-by-construction but untested.** Probe C (below) shows the `executor-events-down` exactly-once pin passes with BOTH seal-release and outcome-release — the pin covers the β re-scan (which either release point closes) and cannot witness the specific seal→outcome re-drain window Finding 1 targets. The move to outcome-release is strictly safer (holding the id longer only strengthens dedup) and I verified it introduces no wedge (every `marked` id reaches `committedEventIds ∪ requeuedEventIds` or park-clear), so this is not a defect — just an unpinned improvement, honestly disclosed by the self-review.

**MINOR-3 (governance, PR already flags) — late-echo rule ratification.** `speculation.md §4 step 2` carries the late-echo sentence dated `2026-08-18` with **no RULED marker** (verified — it is *not* written as ruled, which is correct), while the code enforces it and the register presents T2(b) as "covered here." This is the owner call the PR raises in Flag 2. Correctly surfaced; not a code issue.

**NOT-THIS-PR — pre-existing effect-channel flake.** `executor-effect-channel.test.ts` "receipt-race divert pin (MINOR-3)" times out (~20 s) waiting for the served navigate intent to land. Rate: **base `fb2292a24` 2/20, PR tip 2/16 — identical failure signature**, so this is a base flake, not a regression. It sits in the ON danger set the PR claims green; worth knowing it flakes at ~10% on a loaded box (this box was at load ~5).

## 3. T2 soundness assessment (the highest-stakes change)

**Arrival keying — SOUND.** The arrival-observer *relevance* check keys coarsely on `${scope}\0${id}` (ignoring instance/`scopeKey`), so it can only **over**-trigger a sweep — never miss one. The actual retirement is the `#sweep` arrival gate, which calls `speculationRetirementView(id, scope)` → resolves the **client's own instance** (`#ownInstanceKey`) and requires `confirmedSeq ≥ floor` for **every** `writtenDoc`. So a frame for a sibling doc/instance, or a partial frame, triggers a sweep that then finds the gate unmet and leaves the entry standing — it cannot retire an entry whose own-target value hasn't landed. OW17-collapsed serving-replica rows don't apply: the overlay is constructed only on non-serving client runtimes (`#speculationDestination()` returns undefined under `servingPosture`), so its replica is always the client's own single-instance view. Probe A confirmed the watermark path is the intact fallback (nothing pre-existing depends on arrival alone).

**Late-echo rule under C8b/C8d requeue — SOUND.** `#terminalIntents` is populated only from **durable** terminal signals the client observed (`#scanIntentNotices` on the sidecar's `consequenced`/`dropped`, or `resolveIntent` `refused`). A requeued parent has **no durable consequence mark** (it rolls back with its wave), so it never enters `#terminalIntents` — the "stale mark" the task worried about cannot form.

**Under double-dispatch (#5969) — SOUND.** `#terminalIntents` keys by `eventId` (a per-fire mint, stable and unique across spaces). One fire → one authoritative consequence → one jobless mark; a re-fire mints a fresh id. "Consequenced" is unambiguous per fire. The β double-dispatch the guard now prevents doesn't change this — one entry consequences one eventId.

**Cascade fold — SOUND and correctly wired.** Client cascade children carry `parentEventId` (cell.ts `clientCascadeParent` → `queueEvent` → `stampServerRun` → `stampSpeculationRunContext`, verified routes to the speculation context on a non-serving client). The dropped late echo's own id joins `#terminalIntents`, so grandchildren fold; ordering holds (parent drop is synchronous at seal, child seals a later macrotask). Effects are owned-not-enacted (`deferSealedEffects` checks `#droppedLateEchoTxs`). Probe B confirmed the pin is non-vacuous.

**Ratification — verified NOT written as ruled** (dated, no RULED marker). Correct per the ratify-or-pending requirement.

## 4. T3 double-emission disposition: **YIELD-ONLY, not latent in base**

The double emission required an **added macrotask yield inside the per-demander fan-out loop** (run.ts) — which lets a run's own async seal refusal (the early-emit guard's fail-closed refusal) land mid-pass and dirty its instance, so the loop re-runs it in-pass while the refusal's queued retry re-runs it again. The **shipped code has no fan-out-loop yield** (run.ts:585-596 reverted to base's microtask shape, byte-identical modulo a comment). The **LT6 early-emit ARM3 pin** (`executor-space-server.test.ts:1372`, `expect(earlyEntries.length).toBe(1)`) asserts exactly-one-durable-entry and is **green on both base and PR** — proving the microtask shape does not reach the double emission. So it is not a finding against the base. The shipped **settle-loop** yield (between actions) is a coarser boundary; the wave's `basisSeq` is captured once at `#openWave` and `commitWave`'s per-doc CAS drops/requeues any doc whose head advanced past it, so a mid-yield authored commit is caught (T3a: basis-snapshot semantics survive the yield; an unconflicted early-derived value is re-confirmed next wave, W stays input-driven). The mid-wave-renew-at-TTL/3 vs 5-s interval is not a no-op: the timer *starves* under a long settle (the whole motivation), and `#renewIfDue` fires from the yield independent of the timer queue — probe D confirms pin (ii) reproduces lease-loss when renew-on-yield is removed.

## 5. Self-review audit (9 items re-derived — no hollow claims)

1. Guard release at seal → outcome: **verified present**; residual untested (MINOR-2). 2. Late-echo cascade+effects → **verified** (scripted pin). 3. Fan-out yield removal → **verified** (LT6 pin green + comment). 4. Wedge/tenure → **verified** (catch deletes; tenure checks on final callback + onFailure). 5. Post-await re-check → **verified present** (overlay-destination.ts:585-610). 6. Test (ii) hardened to 900-ms/45-step, firedAt<90 → **verified in the test** — but the register still describes the old 600-ms TTL (feeds MINOR-1). 7. Docs/comments → events.md "at-most-one-copy" reword **landed** (`events.md:252`); E2 re-attributed to inferred late echo — but the register measurement staleness (MINOR-1) is a lag the disposition left. 8. Observer-slot hygiene → **verified** (release-only-if-still-ours, both wakes). 9. Telemetry → unchanged (acknowledged). T1 also verified: memo invalidated by every journaled read/write/deref-trace/trigger-read; positive verdict never memoized; the internal-verifier reads carry `ignoreReadForScheduling` and probe-once-vs-twice yields the same deduplicated read set, so the OFF arm is byte-identical in state/verdicts (only two new diagnostic counters + halved probe frequency) — no recorded-acceptance row required; the register's "arm-independent by design" is accurate.

## 6. Suites + probes (all foreground)

| Suite | Result |
|---|---|
| Runner full (4 alphabetical chunks, preload) | **1211 passed / 6718 steps / 0 failed** |
| memory | 521/0 · spec-model 23/0 |
| T1 pins (cfc-flow-probe-memo, cfc-runtime-stats) + T3 (cooperative-yield) | green |
| T2 (speculation-arrival-gate) + guard (executor-events-down) | green |
| fmt --check / lint / `deno check` (runner + patterns/integration) | clean, exit 0 |
| check-docs | 548 blocks pass |
| serving-loop soak ×5 (24 steps, 12 s) | 5/5 |
| effect-channel soak | **pre-existing flake** (base 2/20, PR 2/16, same step) |
| Danger sets (fan-out, run-supply, space-server, wave, speculation-overlay, instance-keyed-replica, cross-space, outbox) | ran & green within chunks |

**Probes (applied → verified → reverted, tree clean):**
- **A** disable arrival observer → E2 + trigger pins red, **OW32/watermark pin + late-echo pin green** (watermark fallback intact). 
- **B** neutralize late-echo drop → late-echo pin red (non-vacuous). 
- **C** release guard at seal → exactly-once pin **still green** (pin can't witness Finding-1 window → MINOR-2). 
- **D** remove settle-loop yield → cooperative-yield (i) **and** (ii) red. 
- **E** neutralize the T1 epoch bump → memo-invalidation pins red, **but cfc-flow-labels/integrity/pointwise stay green** (no real workload flips a verdict between the two probe sites → determinism holds).

## 7. Verified-deep vs skimmed

**Deep:** overlay-destination.ts (arrival wake, late-echo rule both arms, sweep gate, observer hygiene, close); v2.ts `applySessionSync` arrival collection + keying; cell.ts client-cascade `parentEventId` threading; events.ts/runtime.ts stamping to the speculation context; space-server.ts drain guard (all release paths, tenure checks, seal-accept mark, wave-outcome release, park clear) + `#renewIfDue`; wave.ts commitWave outcome reporting (committed/requeued, seal-failure seed, abort arms); scheduler settle.ts/run.ts/cooperative-yield.ts/facade.ts (yield placement, posture gate, basis snapshot); extended-storage-transaction.ts T1 memo + epoch; all new/changed tests; the four spec diffs + register.

**Skimmed / not independently reproduced:** the live two-browsers gate and note-create timing series (I verified the pins encoding the mechanisms, but the aggregate green counts and the "night-like / no-LLM-model" environment live in the builder's session ledger, not reproducible here — this is exactly where MINOR-1's 10/10-vs-16/16 discrepancy lives); `wave.ts` regions outside the requeue/outcome path; the memory/spec-model internals (ran green, not read).

Worktree left in place at `/Users/berni/labs-worktrees/review-tuning` (HEAD `2e9d86478`, clean).

result: PR #5991 is LANDABLE-WITH-FIXES — code sound (T2 arrival-keying + late-echo rule verified sound under requeue/double-dispatch; T3 double-emission is fan-out-yield-only, not latent-in-base; drain guard release-paths + T1 determinism verified; 5 mutation probes confirm every pin non-vacuous; runner 1211/0, memory 521/0, spec-model 23/0, docs 548 all green), but the canonical register carries stale INTERIM measurements (10/10 not 16/16, wrong "final binary", 13 not 22 runs, 600-ms not 900-ms TTL) that must be reconciled; the effect-channel "receipt-race divert" flake is pre-existing (base 2/20 ≈ PR 2/16), not this PR's regression.
