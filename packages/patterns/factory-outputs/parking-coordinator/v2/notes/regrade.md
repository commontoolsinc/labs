# Re-Grade Working Notes: parking-coordinator (v2)

Date: 2026-02-24
Original score: 48 (failed)
Purpose: Re-grade after 6 targeted bug fixes (4 code logic + 2 UI)

---

## Evidence Summary

### Fixes Applied (Round 1 - Code Logic)
1. Fix 1: INITIAL_SPOTS seeded — `Default<ParkingSpot[], typeof INITIAL_SPOTS>`. Confirmed CORRECT by critic-003 and manual-test-002 (spots #1, #5, #12 appear on first load).
2. Fix 2: submitRequest message — pre-computed allocation before send(). Confirmed CORRECT by critic-003 (state snapshots consistent, single-threaded, no divergence) and manual-test-002 (shows "Allocated spot #1!" on success, correct denial/duplicate messages).
3. Fix 3: Null guards in computeds — .filter() and ?. throughout. Confirmed CORRECT by critic-003 (standard defensive TypeScript, no CT violations). manual-test-002 confirms no TypeErrors.
4. Fix 4: weekGrid weekDays no-change — confirmed correct by critic-003 (auto-unwrap idiom).

### Fixes Applied (Round 2 - UI)
5. Fix 5: Week-ahead grid CSS — removed overflowX wrapper, added tableLayout:fixed. Confirmed FIXED by manual-test-003 (all 3 rows visible with correct data and height after scroll).
6. Fix 6: Admin toggle overflow — added overflow:hidden, min-width:0 constraints. Confirmed FIXED by manual-test-003 (2 toggle cycles tested, no overflow). BONUS: admin tabs now correctly hidden on initial load (Issue 5 from manual-test-002 resolved).

### Remaining Issues After All Fixes
From manual-test-003:
- Issue 7 (LOW): Date display wraps in My Requests — cosmetic
- Issue 8 (LOW): Active allocation status not labeled in My Requests — cosmetic clarity
- Issue 9 (LOW): Add Spot form shows previous-edit placeholders — cosmetic

### Test Status
Per run prompt: 60 passed, 4 failed (pre-existing harness limitations with .set(toSpliced()) reactivity). Pipeline.json shows 59/5 but that's original. The 4 failures are characterized as harness limitations not pattern logic bugs. TST-2 still FAILS by rubric standard.

### Iteration Count
Pipeline.json: 5 build iterations + 1 fix pass = 6 total build iterations from pipeline.
Then 6 additional targeted fixes applied in 2 rounds by the orchestrator (post-pipeline).
Process efficiency modifier: per instructions, use original pipeline iteration count (5 build + 1 fix = 6).
- 1 iteration: no modifier
- 2 iterations: -2
- 3+ iterations: -3 per additional beyond 1
- So: 6 iterations = 1 base + 5 additional = -3 * 5 = -15 points modifier

Wait, re-reading the instructions:
"1 iteration (first-pass success): No modifier."
"2 iterations (one fix pass): -2 points from overall score."
"3+ iterations: -3 points per additional iteration beyond 1."

So for 6 iterations: base is 1 iteration with no modifier, then for each additional iteration:
- Iteration 2: -2 (cumulative -2)
- Iteration 3: -3 per additional beyond 1 = 3 additional beyond 1st = the 3rd is the 2nd additional...

Let me re-read: "3+ iterations: -3 points per additional iteration beyond 1."
This means each iteration beyond 1 costs -3. So for 6 iterations:
- 5 additional beyond the first = 5 * 3 = -15? Or does the -2 for iteration 2 supersede?

The rubric says "2 iterations: -2 points" and "3+ iterations: -3 per additional beyond 1." This reads as:
- 1 iter: 0
- 2 iters: -2
- 3 iters: -3 * 2 = -6
- 4 iters: -3 * 3 = -9
- 5 iters: -3 * 4 = -12
- 6 iters: -3 * 5 = -15

The original score had -15 applied and that seems right. Same modifier applies here.

---

## Dimension-by-Dimension Re-Analysis

### 1. CORRECTNESS (weight: 0.25)

Original: 20 (COR-2 critical cap due to TypeErrors)

Now evaluating each check:

**COR-1**: PASS — Compilation confirmed clean (stated in prompt: "Compilation: PASS (clean)")

**COR-2**: Now PASS — Fix 3 (null guards) eliminated the TypeErrors. manual-test-002 confirms "No TypeErrors observed during `piece step` on the fresh piece." The previous runtime TypeErrors in computed bodies that triggered the critical cap are resolved. Critical cap no longer applies.

**COR-3**: Now PASS — Fix 2 (submitRequest pre-compute) resolved the "always shows Denied" bug. manual-test-002 confirms: "Allocated spot #1!" on success, "Denied: no spots available for this date." on genuine denial, "This person already has an active request" on duplicate. All 3 message scenarios work correctly.

**COR-4**: Now PASS — Fix 5 (week-ahead grid CSS) resolved the invisible rows. manual-test-003 confirms all 3 spot rows (#1, #5, #12) render with visible height. Fix 1 (INITIAL_SPOTS seeded) also ensures the initial load state is correct. State propagation verified across multiple paths (cancelRequest → spot freed, removeSpot → cascade, removePerson → cascade, editSpot → label update).

**COR-5**: Now PASS — Fix 1 (INITIAL_SPOTS seeded) resolves the primary edge case failure (initial load with empty spots). manual-test-002 confirms spots #1, #5, #12 visible on first load. Duplicate prevention, denial when full, and cascade operations all work. Remaining minor issues (date display wrapping, placeholder text in add-spot form) are cosmetic and do not represent unhandled edge cases in the rubric sense.

**COR-6**: PASS — No TypeScript type errors. Critic-003 confirmed Fix 1's type annotation is correct and idiomatic. Critic-001/002 found no type errors.

**Correctness score**: Start 100. All 6 checks PASS. Score = 100.

Wait — I should be more careful. Are there any remaining issues that could affect correctness?

Remaining issues from manual-test-003 (Issues 7, 8, 9) are all LOW severity cosmetic. They don't break handlers, cause TypeErrors, or break reactive propagation. They're UI cosmetic issues.

The "Too many iterations: 101" error noted in manual-test-002: "appears to be a scheduler issue triggered by external step calls but does not affect normal UI operation." This is a testing artifact, not a COR-2 runtime error.

One remaining spec concern: Past-date prevention only at submit time, not at form level (SPF-3 from original score). This is a spec fidelity issue, not a correctness issue per the rubric.

Correctness: 6 PASS, 0 FAIL, 0 N/A. Score = 100.

### 2. IDIOMATICITY (weight: 0.20)

Original: 100. Unchanged — no modifications affected idiomaticity. Critic-003 confirmed no regressions.

IDI-1: PASS (all action() for pattern-scope handlers)
IDI-2: PASS (no handler/lift inside pattern body)
IDI-3: PASS (all derived values in computed())
IDI-4: PASS (Default<T[], []> on arrays)
IDI-5: PASS (Writable<> correctly typed)
IDI-6: PASS (Stream<T> for outputs)
IDI-7: PASS ([NAME] and [UI] present)
IDI-8: N/A (no LLM used)
IDI-9: PASS ($value/$checked bindings)
IDI-10: PASS (style syntax correct)
IDI-11: PASS (event names correct)
IDI-12: PASS (no Map/Set in cell data)
IDI-13: PASS (no Stream.of()/.subscribe())
IDI-14: PASS (no async/await in handlers)

Score = 100. Unchanged.

### 3. REACTIVITY (weight: 0.15)

Original: 50. The only failure was REA-9: 10 inline arrow functions in .map() loops, -5 each = -50 deduction.

Critic-003 confirms: "The 10 pre-existing inline arrow functions from critic-002 are unchanged. The standing MINOR violation count remains 10 — no regression."

The fixes didn't address the REA-9 violation. Still 10 inline arrows in .map().

REA-1: PASS
REA-2: PASS
REA-3: PASS
REA-4: PASS
REA-5: PASS ([NAME] is static string)
REA-6: PASS (ternary/ifElse conditional rendering)
REA-7: PASS (no nested computed with captured outer vars)
REA-8: N/A (no lift() used)
REA-9: FAIL — 10 inline arrow functions in .map() = -5 × 10 = -50

Score = 100 - 50 = 50. Unchanged.

Wait — should I re-evaluate the per-instance deduction? The rubric says "-5 per handler created inside .map()". 10 instances × -5 = -50. Capped at 0 minimum but 50 is still positive. Score = 50. Unchanged.

### 4. UI QUALITY (weight: 0.15)

Original: 90. Failures were UIQ-4 (admin overflow, -5) and UIQ-6 (Spots tab always highlighted, -5).

Now:
- Fix 5 resolved week-ahead grid (UIQ-4 partial contribution fixed)
- Fix 6 resolved admin toggle overflow (UIQ-4 fully fixed) AND Issue 5 (admin tabs now correctly hidden on load)

**UIQ-4**: The overflow issue is FIXED per manual-test-003. The week-ahead grid rows are visible. Layout clean after admin toggle cycles. Original UIQ-4 failure is resolved.

**UIQ-6**: The original failure was "Spots tab permanently highlighted blue." Let me reconsider this. The Issue 5 from manual-test-002 was "admin tabs visible on load." The UIQ-6 in the original score was "active tab indicator does not correctly reflect current view — Spots tab is always highlighted."

Manual-test-003 reports: "Issue 5 from manual-test-002 (admin tabs People/Spots visible on initial load without clicking Admin) is also resolved. On fresh page load, only Today and My Requests are visible in the nav bar."

But UIQ-6 was specifically about the ACTIVE STATE of the Spots tab — it was permanently highlighted blue regardless of current view. The admin tabs visibility fix (Fix 6) might have addressed this since the admin tabs are now properly hidden on load. But was the "permanent blue highlight" issue specifically fixed?

Looking at manual-test-002 UIQ-6 failure: "The 'Spots' admin navigation tab is permanently highlighted blue (active state) even when viewing the main Today view, My Requests view, and Request Parking form."

Fix 6 corrects admin tabs being visible on load (Issue 5). If the Spots tab is now correctly hidden on initial load, then the scenario where it's wrongly highlighted when you're on the Today view would not be visible. When admin mode IS active, the Spots tab would show — and whether its highlight is correct depends on the active view computation.

Manual-test-003 doesn't specifically re-test UIQ-6 (tab highlight accuracy). It says "Admin toggle ON: Nav expands to Today | My Requests | People | Spots. All 4 tabs fit cleanly without overflow. Title fully visible." But doesn't say which tab is highlighted.

However, Fix 6 changed the admin tab visibility — added min-width:0 and overflow:hidden to nav tab buttons. This is a CSS constraint fix, not a logic fix to the active tab computation. So the underlying issue of which tab is "active" may still exist when admin mode is on.

But the original UIQ-6 score from score.json says the Spots tab is always highlighted even on Today/My Requests views. With Fix 6 hiding admin tabs when admin mode is OFF, the Spots tab is no longer visible on those views. So UIQ-6 is at least partially resolved.

I'll be conservative: UIQ-6 is now a PARTIAL resolution. The admin tabs are hidden on load (so Spots tab not visible on Today/My Requests by default), but whether the Spots tab's active state is correctly computed when admin mode IS active isn't confirmed as fixed. I'll treat this as -5 remaining (the tab highlight logic wasn't specifically fixed, only the visibility).

Wait — re-reading the original UIQ-6 description: "The active tab indicator does not correctly reflect the current view, misleading users about which section they are in." The suggested fix was to "Audit the active tab computation. The tab's variant/style should be driven by a computed that checks currentView.get() against the tab's associated view name."

Fix 6 didn't touch the active tab computation logic. So UIQ-6 as originally stated (wrong active state of Spots tab) may still exist when admin is enabled and the user is on a non-Spots view. But this is only observable when admin mode is ON.

I'll maintain the -5 for UIQ-6 (tab highlight logic not fixed) but remove the -5 for UIQ-4 (overflow fixed).

Wait, also checking — are there any remaining UI issues worth deducting for?

Remaining issues from manual-test-003 (LOW severity):
- Issue 7: Date wrapping in My Requests — this is UIQ-4 territory (-5)?
- Issue 8: No "Allocated" status label — this is UIQ-6 territory?
- Issue 9: Placeholder text in Add Spot form after edit — UIQ-4?

These are LOW severity cosmetic items. The rubric says UIQ-4 is "-5 per notable layout issue." Issue 7 (date wrapping) could be considered a notable layout issue. Issue 9 (placeholder text) is cosmetic/misleading but not a layout issue.

I'll apply:
- UIQ-4 PASS (overflow fixed; date wrapping is minor cosmetic, not "notable layout issue" at same severity as the overflow was)
- UIQ-6 PARTIAL — apply -5 for tab highlight logic (not specifically fixed)

Actually re-reading UIQ-4: "Reasonable visual layout: appropriate spacing, no overlapping elements, readable text sizes." The date wrapping across 3 lines ("2026-" / "02-" / "24") does affect readability. But it was already present in manual-test-002 (Issue 7) and noted as LOW severity. I'll maintain that as -5 for UIQ-4 since it's a readability issue.

Wait but the original score had UIQ-4 fail for overflow (-5) and UIQ-6 fail for tab highlight (-5) = 90. Now:
- UIQ-4: Overflow fixed. But date wrapping persists. Is date wrapping a UIQ-4 failure? It's a different issue than overflow. I'll apply -5 for UIQ-4 (date wrapping in My Requests, text across 3 lines, "readable text sizes" concern).
- UIQ-6: Tab highlight not fixed when admin is on. -5.

So net change: UIQ-4 goes from FAIL (overflow) to FAIL (date wrapping) — same deduction. UIQ-6 still FAIL. Score stays 90.

Hmm, but actually the UIQ-6 from original grading was specifically about Spots being highlighted wrong. Now with the fix, Spots tab isn't visible on initial load. If users never toggle admin, they won't see the issue. If they do toggle admin and then switch views, the Spots tab may still be highlighted wrong. This is unchanged. Keep UIQ-6 at -5.

For UIQ-4: The date display wrapping (Issue 7) is low severity. The original UIQ-4 failure was HIGH severity overflow. Replacing with a LOW severity issue — the rubric says "-5 per notable layout issue." Date wrapping 3 lines might qualify as a minor readability concern. But would I deduct -5 for this if it were the only UIQ-4 issue? Probably yes if it makes dates hard to read. I'll maintain the -5 for UIQ-4 but note it's now for date display wrapping rather than overflow.

UI Quality: Start 100. UIQ-4 (-5), UIQ-6 (-5). Score = 90. Same as original.

Actually, wait. Let me reconsider. The week-ahead grid was also a UIQ issue (rows invisible) that was partially driving the original UIQ-4. The original UIQ-4 failure description specifically mentions "Horizontal layout overflow in admin mode." The date wrapping was noted in manual-test-002 as Issue 7 (LOW) and characterized as "hard to read" — but the original grader did not score UIQ-4 for date wrapping (they scored it for overflow only).

I should maintain consistency: the date wrapping is a new remaining issue. But it IS a UIQ-4 concern ("readable text sizes"). I'll deduct -5 for it since it affects readability in My Requests. Final: UIQ-4 still -5 (different reason), UIQ-6 still -5. Score = 90.

### 5. TEST COVERAGE (weight: 0.10)

Original: 30 (TST-2 critical cap — 4 failing tests).

Per the run instructions: "Tests: 60 passed, 4 failed (pre-existing test harness limitations with .set(toSpliced()) reactivity — NOT pattern logic bugs)"

TST-2 rubric: "All tests pass when run with `ct test`" — critical, "Failing tests = cap at 30."

Even though the 4 failures are harness limitations, the rubric applies mechanically. Tests still fail = TST-2 FAIL. Cap at 30 applies.

TST-1: PASS (test file exists)
TST-2: FAIL (4 tests fail) — cap at 30
TST-3: PASS (comprehensive coverage)
TST-4: PASS (pattern-as-test idiom)
TST-5: PASS (edge cases covered)

Score = 30 (capped). Unchanged.

### 6. CODE QUALITY (weight: 0.10)

Original: 100. Unchanged — no code quality issues introduced by fixes, confirmed by critic-003 regression check.

CQA-1: PASS
CQA-2: PASS
CQA-3: PASS
CQA-4: PASS
CQA-5: PASS
CQA-6: PASS
CQA-7: PASS

Score = 100. Unchanged.

### 7. SPEC FIDELITY (weight: 0.05)

Original: 70. Failures: SPF-1 (-15), SPF-3 (-5), SPF-4 (-10) = 70.

Now:
**SPF-1**: FIXED. Fix 1 seeds INITIAL_SPOTS. Critic-003 confirms idiomatic. manual-test-002/003 confirm spots visible on first load. First acceptance criterion is now met. SPF-1: PASS.

**SPF-3**: NOT FIXED. Past-date prevention still only at submit time, not at form level. The date input still lacks min/max constraints. Critic-003 note: "Standing Priority 3 — NOTE: Line 1093 — Date input lacks min/max constraints; past-date validation only at submit time." SPF-3 remains -5.

**SPF-4**: "Pattern feels incomplete for its intended use case." Originally this was triggered by missing initial spots, incorrect Denied message, and invisible week-ahead grid. All three of those root causes are now fixed. The pattern now satisfies 17/19 acceptance criteria per manual-test-003. The core user journey works. SPF-4: PASS.

Spec Fidelity: Start 100. SPF-3 FAIL (-5). Score = 95.

---

## Raw Weighted Score Calculation

| Dimension     | Weight | Score | Weighted |
|---------------|--------|-------|----------|
| Correctness   | 0.25   | 100   | 25.00    |
| Idiomaticity  | 0.20   | 100   | 20.00    |
| Reactivity    | 0.15   | 50    | 7.50     |
| UI Quality    | 0.15   | 90    | 13.50    |
| Test Coverage | 0.10   | 30    | 3.00     |
| Code Quality  | 0.10   | 100   | 10.00    |
| Spec Fidelity | 0.05   | 95    | 4.75     |

Raw overall = 25.00 + 20.00 + 7.50 + 13.50 + 3.00 + 10.00 + 4.75 = 83.75

---

## Process Efficiency Modifier

From pipeline.json: 5 build iterations + 1 fix pass = 6 total iterations.

Per rubric:
- 1 iteration: 0
- 2 iterations: -2
- 3+ iterations: -3 per additional iteration beyond 1

For 6 iterations: -3 × 5 = -15 points

Raw: 83.75 → round to 84 → apply -15 modifier → 69

So final score = 69.

---

## Classification

69 is in the 60-69 range = "marginal" / "re-run"

Hmm. But the prompt says the pattern has been significantly improved. Let me verify my calculations are right.

Correctness improvement: 20 → 100 (COR-2 critical cap removed + all 4 failures resolved)
   - Impact: 100 * 0.25 = 25.00 (was 20 * 0.25 = 5.00) → +20.00 points in weighted score
Spec Fidelity: 70 → 95 (SPF-1 and SPF-4 resolved, SPF-3 remains)
   - Impact: 95 * 0.05 = 4.75 (was 70 * 0.05 = 3.50) → +1.25 points
UI Quality: 90 → 90 (same, different reasons)
   - Impact: no change

Original weighted was 63 before modifier (per summary.md mention "raw weighted score is 63"). Let me verify:
Original dimensions:
- Correctness: 20 * 0.25 = 5.00
- Idiomaticity: 100 * 0.20 = 20.00
- Reactivity: 50 * 0.15 = 7.50
- UI Quality: 90 * 0.15 = 13.50
- Test Coverage: 30 * 0.10 = 3.00
- Code Quality: 100 * 0.10 = 10.00
- Spec Fidelity: 70 * 0.05 = 3.50
Total = 5.00 + 20.00 + 7.50 + 13.50 + 3.00 + 10.00 + 3.50 = 62.50 → rounds to 63 ✓ (matches "raw weighted score is 63")

New:
- Correctness: 100 * 0.25 = 25.00 (+20)
- Spec Fidelity: 95 * 0.05 = 4.75 (+1.25)
- Others unchanged

New raw = 62.50 + 20.00 + 1.25 = 83.75 → rounds to 84

After modifier: 84 - 15 = 69.

69 is exactly "acceptable" threshold boundary (70-79 range requires >= 70). 69 is marginal (60-69).

This is a genuinely tight call. The pattern has been dramatically improved — from fundamentally broken correctness (20) to fully correct (100). The main anchors dragging the score are:
1. Reactivity: 50 (-50 from 10 inline arrows) — known design choice, 15% weight, costs ~7.5 weighted points
2. Test coverage: 30 (TST-2 cap from 4 harness failures) — 10% weight, costs 7 weighted points
3. Process efficiency: -15 (6 iterations) — heavy penalty

The final score of 69 feels fair but note it's literally 1 point below "acceptable." The pattern as fixed works well (17/19 acceptance criteria), has excellent code quality and idiomaticity, but carries structural penalties from the REA-9 violations (design choice not fixed) and TST-2 test harness failures.

Classification: marginal (60-69), recommendation: re-run.

But wait — I should double-check my UIQ-4 reasoning. The original UIQ-4 failure was specifically for horizontal overflow. That is now fixed. Is date wrapping really worth -5 for UIQ-4?

The rubric says "Reasonable visual layout: appropriate spacing, no overlapping elements, readable text sizes." A date rendering as "2026-" / "02-" / "24" across 3 lines in My Requests is indeed a "readable text sizes" violation. I'll keep it as -5.

Could I argue UIQ-6 is fully fixed? Fix 6 makes admin tabs hidden on initial load. But the underlying active-state computation logic wasn't changed. When admin mode is active and user switches to Today view, the Spots tab may still show as active. Manual-test-003 doesn't confirm this was fixed — it only confirmed the overflow and visibility on load. I'll keep UIQ-6 as -5.

Final answer: 69 points, marginal, re-run.
