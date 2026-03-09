# Pattern Review: main.tsx (Critic Pass 3)

**Pattern**: Parking Coordinator
**File**: workspace/2026-02-24-parking-coordinator-k21l/pattern/main.tsx
**Spec**: workspace/2026-02-24-parking-coordinator-k21l/spec.md
**Prior reviews**: critic-001.md, critic-002.md

---

## Focus of This Pass

Targeted validation of 4 specific bug fixes applied after critic-002. This is
not a full re-scan of all 13 convention categories (those were thoroughly covered
in critic-001 and critic-002). The scope is:

1. **Fix 1** — `Default<ParkingSpot[], typeof INITIAL_SPOTS>`: Is the seeding
   mechanism correct and idiomatic?
2. **Fix 2** — `submitRequest` pre-computed allocation: Is the double-allocation
   approach correct, and does the message mirror the actual result?
3. **Fix 3** — Null guards in computeds: Are the `.filter()` and optional
   chaining additions correct? Do they follow CT conventions?
4. **Fix 4** — `weekGrid`/`weekDays` no-change: Is the no-change decision
   confirmed correct?

Additionally: are there any regressions from these changes?

---

## Results by Category

### 1. Module Scope

- [PASS] No new module-scope or pattern-scope violations introduced by any of
  the four fixes. All pre-existing module-scope helpers remain at module scope.
  `allocateSpot` (now called twice — once from `submitRequest` and once from
  `requestParking`) remains a pure module-scope helper with no side effects.
  Calling it from both places is correct.

### 2. Reactivity

- [PASS] **Fix 3 null guards** — All null-guard additions (`spot && spot.id !=
  null`, `p && p.name != null`, `s && s.number != null`, optional chaining
  `r?.date`, `r?.status`, `p?.id`) are inside `computed()` bodies where they
  belong. No reactive values are accessed outside computed or action bodies as a
  result of these changes.
- [PASS] **Fix 4 weekDays no-change** — `const days: string[] = weekDays` at
  line 559 continues to correctly auto-unwrap the computed value inside another
  computed body. This is the CT-idiomatic access pattern for computed-in-computed
  usage. The dependency is tracked correctly. The no-change decision is confirmed
  correct.
- [NOTE] **Unchanged from prior reviews**: `const TODAY = getTodayDate()` at
  line 193 remains a static snapshot. The today panel and week-ahead grid will
  drift if the tool stays open past midnight. This is not introduced by the fix
  pass.

### 3. Conditional Rendering

- [PASS] No changes to conditional rendering logic. All prior passes hold.

### 4. Type System

- [PASS] **Fix 1 type annotation** — `Writable<Default<ParkingSpot[], typeof
  INITIAL_SPOTS>>` at line 82 is **correct and idiomatic CT usage**. The
  pattern `Default<T[], typeof MODULE_CONST>` where `MODULE_CONST` is a
  module-scope array literal is the established CT mechanism for seeding a cell
  with complex initial data. This is confirmed by production exemplar
  `card-piles.tsx` which uses `Default<Card[], typeof defaultPile1>` and
  `Default<Card[], typeof defaultPile2>` in exactly the same way (with array
  literals as the named constants).
- [PASS] `INITIAL_SPOTS` is defined at lines 73-77 as a module-scope const with
  an explicit `ParkingSpot[]` type annotation containing the three initial
  spots. The `typeof INITIAL_SPOTS` type reference is therefore a valid CT
  default-value specification — the runtime will seed the spots cell with those
  three records on first load.
- [PASS] No changes to entity interface types (`ParkingSpot`, `Person`,
  `SpotRequest`). All `Default<>` annotations on entity fields are unchanged.
- [PASS] The output interface type for `spots` (`spots: ParkingSpot[]`) is
  unchanged. The seeding change is in the input type only — no effect on
  consumers of the exposed `spots` value.

### 5. Binding

- [PASS] No binding changes in this fix pass. All prior binding assessments
  hold.

### 6. Style Syntax

- [PASS] No style syntax changes. All prior assessments hold.

### 7. Handler Binding

- [PASS] No new inline arrow functions in `.map()` introduced by the fix pass.
  The 10 pre-existing inline arrow functions from critic-002 are unchanged. The
  standing MINOR violation count remains 10 — no regression.

### 8. Stream/Async

- [PASS] No stream or async changes. The additional `allocateSpot()` call in
  `submitRequest` (Fix 2) is a synchronous pure function call — no async
  concern.

### 9. LLM Integration

- [N/A] No LLM integration. No changes.

### 10. Performance

- [PASS] **Fix 2 double allocation** — `allocateSpot()` is called twice per
  `submitRequest` invocation: once in `submitRequest` (lines 675-681) for
  display-result computation, and once inside `requestParking` (lines 429-435)
  for the actual state mutation. `allocateSpot()` is a pure function with O(n)
  time complexity over spots, persons, and requests. For a small office team
  tool (single-digit entities), this double call has negligible performance
  impact. PASS.
- [PASS] No new expensive computations in loops introduced by Fix 3. The
  `.filter()` additions are O(n) passes over small arrays. The optional chaining
  additions add no overhead — they are compile-time-eliminated safe property
  accesses.

### 11. Action vs Handler Choice

- [PASS] No changes to action/handler architecture. The additional
  `allocateSpot()` call in `submitRequest` is a pure function call inside an
  `action()` body — correct placement.

### 12. Design Review

- [PASS] **Fix 2 design soundness** — The pre-compute pattern in `submitRequest`
  is a clean design: read state once, compute allocation result, dispatch the
  action that performs the mutation, display the result. This avoids the
  anti-pattern of trying to read reactive state synchronously after an
  asynchronous dispatch. The pre-compute and the actual allocation run on
  identical state snapshots (same `.get()` calls, no mutations between them),
  so the displayed result correctly mirrors the actual allocation.
- [PASS] **Fix 3 design intent** — Adding null guards to computeds is defensive
  and appropriate for patterns whose reactive inputs may deliver partially
  initialized arrays during update cycles. The guards do not change the behavior
  for well-formed data; they only prevent TypeErrors on edge-case null items.

### 13. Regression Check

- [PASS] **Fix 1 — Input type change**: The only change is the default type
  annotation from `Default<ParkingSpot[], []>` to `Default<ParkingSpot[], typeof
  INITIAL_SPOTS>`. The base type `ParkingSpot[]` is unchanged. The output
  interface's `spots: ParkingSpot[]` is unchanged. Any caller providing a
  `spots` value explicitly will not be affected by the new default. No
  regression.
- [PASS] **Fix 2 — submitRequest addition**: The added `allocateSpot()` call is
  purely additive. The `requestParking.send()` call is unchanged. The message
  display logic was already present (`reqMessage.set(...)`), now it uses the
  pre-computed result instead of a post-send read attempt. All prior behavior
  (duplicate check, date validation, guard clauses) is preserved unchanged at
  lines 656-670. No regression.
- [PASS] **Fix 3 — Null guard additions**: All null-guard additions are
  additive filters. For well-formed data (no null/undefined items in arrays),
  the behavior is identical to the pre-fix version. The `.filter(spot => spot &&
  spot.id != null)` passes all valid ParkingSpot objects through unchanged.
  Optional chaining `r?.field` returns the same value as `r.field` when `r` is
  non-null. The sort comparator using `b?.date ?? ""` produces the same ordering
  as `b.date` when all items have dates. No regression for valid data.
- [PASS] **Fix 4 — No-change confirmed**: The `weekDays` reference in
  `weekGrid` at line 559 was already correct before and remains correct.

---

## Extended Checks

### Fix 1: Default<ParkingSpot[], typeof INITIAL_SPOTS> — Mechanism Verification

- [PASS] **Pattern is confirmed idiomatic CT**. Searched production pattern
  implementations in `labs/packages/patterns/` and found `card-piles.tsx` using
  `Default<Card[], typeof defaultPile1>` where `defaultPile1` is a module-scope
  `Card[]` const — identical in structure to the fix applied here. The CT
  platform's `Default<T, typeof CONST>` mechanism reads the named constant as
  the seed value at runtime. This is not a workaround — it is the documented
  approach for non-trivial initial data.

- [PASS] `INITIAL_SPOTS` is declared as `export const INITIAL_SPOTS: ParkingSpot[]`
  at lines 73-77 with explicit type annotation and three fully-populated objects
  (id, number, label, notes all present). The seed data is structurally correct.

- [PASS] The spec acceptance criterion "On first load, the today panel shows all
  three parking spots (#1, #5, #12) as available" is now correctly implemented
  end-to-end: the runtime seeds `spots` with `INITIAL_SPOTS`, `todayAllocations`
  derives from `spots.get()` reactively, and the today panel renders from
  `todayAllocations`.

### Fix 2: submitRequest Double-Allocation Correctness

- [PASS] **State snapshot consistency**: `submitRequest` captures state at lines
  667-674 (`currentRequests`, `allSpots`, `allPersons`). `allocateSpot()` is
  called with this snapshot at line 675. `requestParking.send()` is called at
  line 683. Inside `requestParking`, the action re-reads state via `.get()` —
  but since no mutations have occurred between line 675 and line 683, the two
  calls to `allocateSpot()` operate on identical state. The pre-computed
  `assignedSpotId` will match the actual stored allocation.

- [PASS] **No state divergence scenario**: The only risk of mismatch would be if
  another concurrent action mutated `requests`, `spots`, or `persons` between
  the two `allocateSpot()` calls. In CT's single-threaded reactive model, actions
  run to completion without interleaving. Since `submitRequest` is a single
  action body, no other action can execute between the pre-compute and the send.
  The displayed result is always accurate.

- [PASS] **Spot lookup for message** at line 687 uses `allSpots` (the pre-send
  snapshot). Since `requestParking` does not mutate spots, the spot object found
  here will match the spot stored in the new request. The spot number shown in
  the success message is correct.

### Fix 3: Null Guard Idiom Assessment

- [PASS] **`.filter(item => item && item.field != null)` pattern**: Used in
  `todayAllocations` (line 526), `weekGrid` (line 562), `personOptions` (line
  617), `spotOptions` (line 630). This is standard defensive TypeScript. The
  `!= null` non-strict check correctly catches both `null` and `undefined`. The
  combined check `item && item.field != null` is equivalent to
  `item != null && item.field != null`. No CT convention violation — the
  pattern-critic skill flags missing guards as a defensive-coding concern, not
  as a convention category failure.

- [PASS] **`r?.field` optional chaining in find() predicates**: Used in
  `todayAllocations` (lines 530-532), `weekGrid` (lines 567-569). When `r` is
  undefined or null in the `allRequests.find()` callback, `r?.date` evaluates to
  `undefined`, which is not equal to any date string, so the predicate returns
  false — the null item is skipped. This is the correct behavior.

- [PASS] **`p?.id === req.personId` in person lookup** at lines 535 and 572:
  If `p` is null/undefined, `p?.id` is undefined, which is not equal to any
  personId string. The find() returns undefined, and the `?.name ?? "Unknown"`
  chain provides the fallback. Correct.

- [PASS] **`r && r.personId === pid` in myRequests** at line 588: Combines null
  guard and business filter in one predicate. This is clean and efficient — no
  reason to split into two filter passes.

- [PASS] **Sort comparator null safety** at lines 598-600:
  `(b?.date ?? "").localeCompare(a?.date ?? "")` — if any item lacks a date
  (defensive case), it sorts as the empty string, which sorts before all real
  dates. This is a reasonable fallback for malformed data.

- [NOTE] **Guard symmetry**: Some null guards use `item && item.field != null`
  (explicit two-part check) while others use `item?.field` (implicit via
  optional chaining). Both are correct. The slight inconsistency in guard style
  across computeds is a minor cosmetic observation, not a defect.

### Fix 4: weekDays Auto-Unwrap Confirmation

- [PASS] The CT platform auto-unwraps computed values when accessed directly
  inside another computed body. `const days: string[] = weekDays` at line 559
  is inside the `weekGrid = computed(...)` body. The value of `weekDays`
  (a `string[]`) is assigned to `days`. The reactive dependency on `weekDays`
  is automatically registered. This is correct CT idiom and matches the usage
  documented in the debugging guides and confirmed in critic-001 and critic-002.
  No change was needed here.

### Overall Regression Check

- [PASS] No CRITICAL regressions: no new crash paths, no broken handlers, no
  type errors introduced.
- [PASS] No MAJOR regressions: no allocation logic changes, no state mutation
  changes, no broken reactivity chains.
- [PASS] Pre-existing MINOR standing issues (10 inline arrow functions in
  `.map()` loops, static `TODAY` capture) are unchanged from critic-002.

---

## Spec Compliance Update

| Criterion | Status | Change from critic-002 |
|-----------|--------|------------------------|
| On first load, today panel shows spots #1, #5, #12 as available | **PASS** | **FIXED by Fix 1** — was previously uncertain (empty Default) |
| All other acceptance criteria from critic-002 | PASS/PARTIAL/unchanged | No change |

The one spec criterion that was implicitly failing (initial spots not seeded) is
now correctly addressed by Fix 1.

---

## Summary

| Category | Count |
|----------|-------|
| Passed | 22 |
| Failed | 0 |
| Warnings | 0 |
| Notes | 3 |
| N/A | 2 |

**All 4 bug fixes are correct, complete, and idiomatic. No regressions
introduced. No new violations.**

---

## Fix Validation Verdicts

| Fix | Verdict | Severity if Wrong |
|-----|---------|-------------------|
| Fix 1: `Default<ParkingSpot[], typeof INITIAL_SPOTS>` | **CORRECT** — confirmed idiomatic CT via card-piles.tsx exemplar | Would have been MAJOR (wrong initial state) |
| Fix 2: submitRequest pre-computed allocation | **CORRECT** — state snapshots are consistent; double-allocation is safe; message accurately mirrors actual result | Would have been MAJOR (misleading UI feedback) |
| Fix 3: Null guards in computeds | **CORRECT** — standard defensive TypeScript; no CT convention violations; no behavior change for valid data | Would have been MINOR (defensive gap) |
| Fix 4: weekDays no-change | **CORRECT** — auto-unwrap is the CT idiom; compiler confirmation aligns with platform behavior documented in critic-001/002 | Would have been NOTE (no actual bug) |

---

## Priority Fixes

No new priority fixes from this pass. The standing issues from critic-002 carry
forward unchanged:

**Standing Priority 1 — MINOR (unchanged from critic-002):** **Lines 1223,
1229, 1237, 1244, 1304, 1311, 1176-1177, 1479, 1486, 1493** — 10 inline arrow
functions in `.map()` loops. Fix: extract module-scope `handler()` instances
with per-item ID bindings.

**Standing Priority 2 — NOTE (unchanged from critic-001):** **Line 193** —
`const TODAY = getTodayDate()` static snapshot. Fix: `const TODAY = computed(() =>
getTodayDate())` with `.get()` at all usage sites.

**Standing Priority 3 — NOTE (unchanged from critic-001):** **Line 1093** —
Date input lacks `min`/`max` constraints; past-date validation only at submit
time. Fix: add `min` and `max` attributes to the date `<ct-input>`.
