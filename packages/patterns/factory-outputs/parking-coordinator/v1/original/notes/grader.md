# Grader Working Notes: Parking Coordinator

## Run Info
- run_id: 2026-02-24-parking-coordinator-k21l
- Pattern: parking-coordinator
- Build iterations: 5 + 1 fix pass = 6 total
- Process efficiency modifier: 5 iterations used (max was 5) + 1 fix pass. Per pipeline.json the build used 5 iterations AND a fix pass. That counts as 5+1=6 total build/fix cycles. Per the grading instructions: 1 iteration = no modifier, 2 = -2, 3+ = -3 per additional iteration beyond 1. With 6 cycles: -3 * (6-1) = -15? Let me re-read the rules carefully.
  - "1 iteration (first-pass success): No modifier"
  - "2 iterations (one fix pass): -2 points"
  - "3+ iterations: -3 points per additional iteration beyond 1"
  - With 6 total: -3 * (6-1) = -15. That seems very steep. Let me interpret again. The instructions say "3+ iterations: -3 points per additional iteration beyond 1". So iteration 3 = -3, iteration 4 = another -3, iteration 5 = another -3, fix pass counts as iteration 6 = another -3. Total = -2 (for going to 2) + -3*4 (for going from 2 to 3, 3 to 4, 4 to 5, 5 to 6) = ... actually let me re-read: "2 iterations: -2 points", then "3+: -3 per additional beyond 1". With 6 total iterations beyond 1 = 5 additional. But the -2 is for the first additional, and -3 for each subsequent. So: -2 + (-3 * 4) = -14? Or is it: iterations 2 = -2, and for 3+ it's -3 per iteration beyond 1 (superseding the -2). I'll interpret as: the -3 rule replaces the -2 rule for 3+ iterations. So: 6 iterations beyond 1 = 5 additional iterations * -3 = -15.
  - Actually reading more carefully: "3+ iterations: -3 points per additional iteration beyond 1". This means the formula for 3+ is -3*(n-1) where n is total iterations. For n=6: -3*5 = -15. But the 2-iteration case explicitly says -2, so the formula only applies from 3+. For 3 iterations: -3*(3-1) = -6. For 6 iterations: -3*(6-1) = -15.
  - I'll apply -15 as the modifier for 6 build iterations.

## Evidence Summary

### Compilation
- PASS: deno task ct check --no-run runs clean (only deprecation warning from deno, not from pattern code)

### Test Results (from test-report.md)
- 60/64 pass (test-report says 60 passed, 4 failed)
- Note: pipeline.json says "59 passed, 5 failed" - there's a discrepancy. Context summary says "59/64 pass, 5 failures". The test-report.md (which is the formal artifact) says 60/64. I'll use the test-report as primary evidence. Either way, there ARE failing tests.
- Failures are test harness limitations (same-length array detection), NOT pattern logic bugs
- TST-2: Tests fail = dimension capped at 30. However, are these truly "failing tests" for our purposes? The harness limitations are explicitly documented and acknowledged as known constraints, not pattern bugs. The critic and test report both say this is a harness issue. But the rubric says "All tests pass when run with ct test" - and they don't all pass. I must apply the cap. TST-2 FAIL.

### Critic Pass 1 Findings
- MAJOR: Missing edit-person UI for interactions 10 and 11 (RESOLVED in fix pass)
- MINOR: 6 inline arrow functions in .map() loops (DEFERRED)
- MINOR: Duplicate predicate (RESOLVED in fix pass)
- NOTE: Static TODAY variable
- NOTE: weekDays no reactive deps

### Critic Pass 2 Findings
- MAJOR resolved, no new CRITICAL/MAJOR introduced
- MINOR: 10 total inline arrow functions in .map() loops (grew from 6 to 10)
- NOTE: static TODAY unchanged

### Manual Test Critical Issues

#### Issue 1 - CRITICAL: INITIAL_SPOTS not seeded
- Code evidence: INITIAL_SPOTS is defined at line 73-77 as a module-level const
- But the pattern input type at line 82: `spots?: Writable<Default<ParkingSpot[], []>>`
- The Default<ParkingSpot[], []> means if no external value is provided, defaults to []
- INITIAL_SPOTS is never used to initialize the spots Writable
- The spec explicitly states "The system starts with the three office parking spots pre-loaded"
- First acceptance criterion: "On first load, the today panel shows all three parking spots (#1, #5, #12) as available."
- This is a SPEC FIDELITY failure AND a CORRECTNESS failure (edge case - initial load state)
- Classification: COR-5 (initial load state unhandled) + SPF-1 (feature missing from spec)

#### Issue 2 - HIGH: "Denied" message always shown after request
- Code evidence at lines 646-680: submitRequest calls requestParking.send() at line 663, then immediately does requests.get() at line 665
- The problem: requestParking.send() triggers an action which calls requests.push(). However, in CT's reactive model, the push operation via .send() may complete synchronously within the action, but the outer submitRequest action reading requests.get() right after .send() may see stale state depending on CT's action execution model.
- The manual tester confirmed: successful allocations show "Denied" message
- The code logic: line 666 finds newReq, checks status === "allocated". If the push result isn't visible yet, newReq is undefined and the else branch (line 678) fires "Denied"
- This is a COR-3 failure: the submitRequest action does not correctly show allocation result. The UI feedback is wrong even when data state is correct.
- Also COR-5: edge case of message display after allocation is broken.

#### Issue 3 - HIGH: Runtime TypeErrors in computed values
- Manual tester found TypeErrors at lines 623, ~1730, ~1973, ~4461
- "Cannot read properties of undefined (reading 'number')" etc.
- These fire in computed value functions when accessing array elements that are temporarily undefined
- COR-2: runtime errors in computed bodies. Does this trigger the "cap at 20" rule? The errors don't prevent actions completing, but they ARE runtime errors in computed bodies (line 623 is in a computed). However, they're intermittent/temporary (during reactive update cycle), not persistent crashes.
- I'll classify this as COR-2 FAIL with the "cap at 20" modifier for correctness since the pattern does have runtime errors. Actually - reading COR-2 carefully: "no uncaught exceptions in handler/action/computed bodies". These ARE uncaught exceptions in computed bodies. The cap at 20 should apply.
- Wait - let me reconsider. The manual tester says "These errors do not prevent action completion". They fire during piece step calls, not persistently. The pattern doesn't crash to a blank screen. But the rubric says COR-2 = "evaluates without runtime errors". The TypeErrors ARE runtime errors in computed bodies, just intermittent ones.
- I'll apply COR-2 as a partial concern: the pattern doesn't fully crash (wouldn't score 0-20) but it does have runtime errors in computeds. I'll cap correctness at 20 per the rule, noting this is a hard cap from the rubric even for intermittent errors.
- Judgment call: these errors are specifically described as "do not prevent action completion" and are "intermittent" (more frequent as data accumulates). The pattern doesn't go blank. But the rule is clear: cap at 20. I'll apply it.

#### Issue 4 - MEDIUM: Layout overflow in admin mode
- UIQ-4: layout issue. -5 deduction.

#### Issue 5 - MEDIUM: Wrong tab highlighted (Spots always active)
- UIQ-6: interactive elements visual affordance. The tab indicator is misleading. -5 deduction.

#### Issue 6 - MEDIUM: Week-ahead grid incomplete rows
- This is a computed logic bug. When all 3 spots have allocations for today, only 1 row shows in the week grid. This suggests a reactivity issue in the weekGrid computed or the JSX rendering. COR-4 failure: state updates not fully propagating to UI in the week grid view. -15 deduction.

## Dimension-by-Dimension Analysis

### CORRECTNESS (weight: 0.25)

COR-1: PASS (compiles clean)
COR-2: FAIL - Runtime TypeErrors in computed bodies during data accumulation (lines 623, ~1730 etc per manual test). Cap at 20.

Since COR-2 fails, the entire correctness dimension is CAPPED at 20.

Within cap, noting:
- COR-3: FAIL - submitRequest always shows "Denied" even when allocation succeeds (line 663-678). The action fires correctly at state level but UI message is wrong.
- COR-4: FAIL - Week-ahead grid shows only 1 row when all spots allocated (visual state not propagating correctly to grid display)
- COR-5: FAIL - Initial spots not seeded (empty state on first load), INITIAL_SPOTS never used
- COR-6: PASS - No TS type errors reported in compilation

Score: Capped at 20 due to COR-2.
Final correctness score: 20

### IDIOMATICITY (weight: 0.20)

IDI-1: PASS - action() used throughout; no handler() at pattern scope
IDI-2: PASS - No handler()/lift() inside pattern body
IDI-3: PASS - All derived values in computed()
IDI-4: PASS - Default<T[], []> on all array inputs
IDI-5: PASS - Writable<> correctly typed
IDI-6: PASS - Stream<T> for all action outputs in output interface
IDI-7: PASS - [NAME] and [UI] both present in return
IDI-8: N/A - No LLM used (/// <cts-enable /> is present but no LLM functions used)
IDI-9: PASS - All $value/$checked bindings correct
IDI-10: PASS - Object style on HTML, string style on ct-*, camelCase props
IDI-11: PASS - Correct event names
IDI-12: PASS - Set used only in local variable inside allocateSpot helper, not in cell data
IDI-13: PASS - No Stream.of() or .subscribe()
IDI-14: PASS - No async/await in handlers

Minor issues flagged by critic:
- 10 inline arrow functions in .map() loops. These violate REA-9/IDI-1 per the critic. But wait - IDI-1 specifically says "handler() only used for multi-binding scenarios (e.g., .map() loops where each item needs its own binding)". The inline arrow functions are the opposite: they're NOT using handler(), which is the preferred approach for .map() per-item handlers. However, IDI-1 is about misusing handler() where action() suffices. The violation here is more about REA-9 (no handler/action created per-item inside .map()).
- Actually re-reading IDI-1: "action() used for pattern-scope handlers... handler() only used for multi-binding scenarios". The inline arrows in .map() are neither handler() nor action() - they're plain anonymous functions. The rubric maps this to REA-9 (-5 per handler created inside .map()). The IDI-1 check is PASS (no handler() at pattern scope without multi-binding).
- So the inline arrows hit REA-9 in the Reactivity dimension, not IDI-1.

No IDI failures.
Score: 100

Pass: 13, Fail: 0, N/A: 1 (IDI-8)

### REACTIVITY (weight: 0.15)

REA-1: PASS - No .get() on computed/lift results (only Writables use .get())
REA-2: PASS - All Writable.of() use static values
REA-3: PASS - No inline filter/sort/reduce in JSX (all wrapped in computed())
REA-4: PASS - No handler()/lift() inside pattern body
REA-5: PASS - [NAME] is a plain string "Parking Coordinator" (static, not reactive - no computed needed)
REA-6: PASS - JSX ternaries used for conditional rendering (auto-converted to ifElse())
REA-7: PASS - No nested computed with captured outer reactive vars identified by critic
REA-8: N/A - No lift() used anywhere
REA-9: FAIL - 10 inline arrow functions created per-item inside .map() loops (lines 1162, 1208, 1215, 1222, 1223, 1289, 1296, 1464, 1471, 1478). However, the rubric says "-5 per handler created inside .map()". The critic counted 10 violations. But these are 10 separate instances across 4 map loops - they're really 4 groups. I'll count per-instance as the rubric says "per handler": 10 violations * -5 = -50. But that would floor at 0 anyway. Let me consider whether to deduct per-instance or per-loop. The rubric says "per handler" so I'll group by logical operation: movePriorityUp, movePriorityDown, removePerson, openEditPerson in one map (4 handlers), cancelRequest in another (1 handler), openEditSpot, removeSpot in spots map (2 handlers), movePrefUp, movePrefDown, removePrefSpot in editPersonPrefDetails map (3 handlers). Total 10 distinct handlers. -5 * 10 = -50. Floor at 0? No, let me cap at 50 deduction from 100: 100 - 50 = 50.

Actually the rubric says "-5 per handler created inside .map()". The guidance is clear: -5 each. 10 instances = -50. But I should be reasonable: this is one consistent design decision applied throughout. The critic called it MINOR severity. Still, the rubric says -5 per instance and there are 10. I'll apply -50, which gives 50.

Actually: re-reading the rubric check REA-9: "No handler/action created per-item inside .map(). Handlers for list items use handler() at module scope with per-item binding." Severity: minor, -5 per handler created inside .map(). 10 inline arrow functions = -50. Score: 100 - 50 = 50.

Hmm, that seems harsh for a MINOR issue. But the rubric is clear. Let me also note this was an explicitly deferred fix with the critic noting it as a consistent pattern throughout.

Score: 50 (100 - 50 for REA-9 with 10 violations)

Pass: 7, Fail: 1 (REA-9), N/A: 1 (REA-8)

Wait - I need to reconsider. The pattern-critic calls this a performance issue too (Category 10). The rubric has both REA-9 and a related IDI-1 but REA-9 specifically covers this. Let me not double-count.

Score for reactivity: 50

### UI QUALITY (weight: 0.15)

UIQ-1: PASS - All form inputs use ct-* components
UIQ-2: PASS - $value/$checked bindings used throughout
UIQ-3: PASS - ct-screen with header/footer slots, ct-vstack/ct-hstack for layout
UIQ-4: FAIL - Layout overflow in admin mode (admin tabs clip title text, layout breaks). -5
UIQ-5: PASS - No <option> elements in ct-select (uses items attribute)
UIQ-6: FAIL - Spots tab permanently highlighted blue (wrong active state indicator). -5
UIQ-7: PASS - Empty states handled (admin People panel shows prompt when no people, Today panel handles no spots gracefully)

Score: 100 - 5 - 5 = 90

Pass: 5, Fail: 2 (UIQ-4, UIQ-6), N/A: 0

### TEST COVERAGE (weight: 0.10)

TST-1: PASS - main.test.tsx exists
TST-2: FAIL - Tests fail (4 failures: editSpot timeout, cascading assertions, manualOverride). Cap at 30.

Within the cap:
TST-3: PASS - Non-trivial state transitions well tested (allocation, cancellation, removal cascades, priority ordering, preferences)
TST-4: PASS - Pattern-as-test approach used correctly
TST-5: PASS - Edge cases covered (duplicate prevention, empty inputs via validation, preference allocation)

Coverage gaps (from critic/test report):
- Denial scenario not directly tested
- Past date validation not tested
- Clearing default spot not tested

These are minor coverage gaps on top of the TST-2 cap.

Score: Capped at 30 due to TST-2.

Pass: 4, Fail: 1 (TST-2), N/A: 0

### CODE QUALITY (weight: 0.10)

CQA-1: PASS - Clear domain type names (ParkingSpot, Person, SpotRequest, CommuteMode)
CQA-2: PASS - Single file for an intermediate-complexity pattern is appropriate; split to schemas.tsx would be optional here
CQA-3: PASS - Complexity is appropriate; no over-abstraction; helper at module scope is well-justified
CQA-4: PASS - Helpers at module scope: getTodayDate, getDateOffset, formatShortDate, genId, hasActiveRequest, allocateSpot all at module scope
CQA-5: PASS - camelCase variables, PascalCase types, action names match user intent
CQA-6: PASS - Normalized state: no duplicate data; SpotRequest references by ID; derived views computed reactively
CQA-7: PASS - Unidirectional data flow: pattern owns all state; no upward mutations

Minor notes: editSpotAction internal variable renamed to avoid collision (IDI-2 minor naming inconsistency noted by critic) - but this doesn't warrant a penalty.

Score: 100

Pass: 7, Fail: 0, N/A: 0

### SPEC FIDELITY (weight: 0.05)

SPF-1: FAIL - INITIAL_SPOTS never used: the first acceptance criterion explicitly states "On first load, the today panel shows all three parking spots (#1, #5, #12) as available." This is a missing feature. -15
SPF-2: PASS - Data model matches spec well (ParkingSpot with number/label/notes, Person with name/email/commuteMode/preferences/defaultSpot, SpotRequest with status/assignedSpot/autoAllocated)
SPF-3: PARTIAL - Most interactions present; past date constraint only enforced on submit not at form level (partial per both critics). The date input lacks min/max constraints. The spec says "form does not allow selecting past dates". -5 (SPF-3: missing form-level past date prevention)
SPF-4: FAIL - Pattern feels incomplete due to missing initial spots (empty state on first load) and the incorrect request result message. The core user journey "request parking and see if I got a spot" is visually broken. -10

Score: 100 - 15 - 5 - 10 = 70

Wait: SPF-1 is -15 per missing feature. SPF-4 is -10 "if pattern feels incomplete". The "Denied" message bug also contributes to incompleteness but I've already counted that in correctness. Let me be precise:
- SPF-1: FAIL (INITIAL_SPOTS not seeded = missing spec feature) -15
- SPF-3: FAIL (date input lacks form-level past-date prevention) -5
- SPF-4: FAIL (pattern feels incomplete due to empty initial state) -10

Score: 100 - 15 - 5 - 10 = 70

Hmm, should I apply both SPF-1 and SPF-4 for the same root cause? SPF-1 is specifically about the feature being missing. SPF-4 is about the overall "incomplete" feeling. They have different angles: SPF-1 is about checking acceptance criteria, SPF-4 is about the overall user experience quality. I'll apply both since they address different aspects.

Actually, the "Denied" message bug also contributes to SPF-4 incompleteness feeling (beyond just the initial spots). The week-ahead grid issue too. I think -10 for SPF-4 is warranted.

Score: 70

Pass: 1, Fail: 3 (SPF-1, SPF-3, SPF-4), N/A: 0

## Weighted Score Calculation (before efficiency modifier)

| Dimension | Weight | Score | Weighted |
|---|---|---|---|
| Correctness | 0.25 | 20 | 5.0 |
| Idiomaticity | 0.20 | 100 | 20.0 |
| Reactivity | 0.15 | 50 | 7.5 |
| UI Quality | 0.15 | 90 | 13.5 |
| Test Coverage | 0.10 | 30 | 3.0 |
| Code Quality | 0.10 | 100 | 10.0 |
| Spec Fidelity | 0.05 | 70 | 3.5 |
| **TOTAL** | | | **62.5** |

Raw overall = 63 (rounded from 62.5)

## Process Efficiency Modifier

Pipeline.json shows: build.iterations = 5, fix_pass = true
Total iterations = 5 build iterations + 1 fix pass = 6 total build cycles
Modifier: -3 * (6-1) = -15 points

Adjusted overall: 63 - 15 = 48

Classification: < 60 = FAILED
Recommendation: REJECT

Wait - 48 is quite low. Let me double-check the efficiency modifier interpretation. The grader instructions say:
- "1 iteration (first-pass success): No modifier."
- "2 iterations (one fix pass): -2 points from overall score."
- "3+ iterations: -3 points per additional iteration beyond 1."

Pipeline.json: build.iterations = 5, fix_pass = true.

How to count "iterations"? The build phase used 5 iterations (the max), then a separate fix pass. That's a total of 6 distinct build cycles. Applying the 3+ rule: iterations beyond 1 = 5. -3 * 5 = -15.

But wait - is each "iteration" in the build phase a separate iteration for this purpose, or is the entire build phase one iteration and the fix pass another? The grader instructions mention "build iterations" in the context of the pipeline: "BUILD -- pattern-maker produces code AND tests as a single unit, iterating until both compile and pass." A "build iteration" here is one complete cycle of (write code → compile → test → check). The pipeline ran 5 of these plus 1 critic-triggered fix pass.

I think each build iteration + the fix pass = 6 total iterations for efficiency purposes. The modifier: -15.

However, looking at this from a fairness perspective: the -15 modifier on a raw score of 63 brings it to 48. This seems appropriate - a pattern that took 6 iterations to produce and still has critical runtime errors and spec failures should be scored lower than one that came out clean on the first pass.

Final overall: 63 - 15 = 48. FAIL. Recommend: REJECT.

## Confidence

- Correctness: High confidence. COR-2 cap is clear (runtime TypeErrors in computeds confirmed by manual tester). COR-3 and COR-4 bugs confirmed with code evidence (submitRequest reactive read-after-write issue, week grid rendering issue).
- Idiomaticity: High confidence. All checks pass per two rounds of critic review.
- Reactivity: Medium confidence. REA-9 with 10 violations is mechanically applied per rubric. The -50 deduction seems harsh for one consistent design decision, but the rubric is clear.
- UI Quality: High confidence. Two specific layout issues confirmed by manual test with screenshots.
- Test Coverage: High confidence. TST-2 cap applies per test-report.
- Code Quality: High confidence. Excellent code structure throughout.
- Spec Fidelity: High confidence. INITIAL_SPOTS bug is unambiguous spec violation.
- Efficiency modifier: Confident. 6 iterations confirmed by pipeline.json.
