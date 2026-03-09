# Pattern Review: main.tsx (Critic Pass 1)

**Pattern**: Parking Coordinator **File**:
workspace/2026-02-24-parking-coordinator-k21l/pattern/main.tsx **Test file**:
workspace/2026-02-24-parking-coordinator-k21l/pattern/main.test.tsx **Spec**:
workspace/2026-02-24-parking-coordinator-k21l/spec.md **Prior review**: none

---

## Results by Category

### 1. Module Scope

- [PASS] No `handler()` defined inside the pattern body — all named handlers are
  `action()` inside the pattern closure.
- [PASS] No `lift()` found anywhere in the file (not used).
- [PASS] All helper functions (`getTodayDate`, `getDateOffset`,
  `formatShortDate`, `genId`, `allocateSpot`) are at module scope.
- [PASS] `allocateSpot` is a pure module-scope helper, correctly separated from
  pattern logic (lines 128–172).

### 2. Reactivity

- [PASS] All `Writable.of()` calls use static literal values — no reactive
  values passed to `Writable.of()` (lines 181–204).
- [PASS] `persons.get()`, `spots.get()`, `requests.get()`, `priorityOrder.get()`
  are called correctly inside action bodies (not used as static snapshots
  outside actions).
- [PASS] `todayAllocations`, `weekGrid`, `myRequests`, `priorityList`,
  `personOptions`, `spotOptions` are all wrapped in `computed()` (lines
  505–601).
- [PASS] No `.filter()` or `.sort()` inline in JSX — `myRequests` sorts inside
  its `computed()` (line 578).
- [PASS] `weekGrid` reads `weekDays` (a computed) directly inside another
  `computed()` — correct CT idiom, reactive dependency is tracked (line 541).
- [PASS] `commuteOptions` is a static array of literals — no reactive
  dependency, correct to leave as a plain constant (line 614).
- [PASS] No `.get()` calls on computed values — only `Writable`s use `.get()`.
- [NOTE] `const TODAY = getTodayDate()` (line 178) is captured once at pattern
  instantiation as a plain string. All comparisons (`day === TODAY`,
  `r.date >= TODAY`) use this static snapshot. If the pattern stays open past
  midnight, TODAY will be stale and the "Today" panel will show the wrong day.
  Fix: `const TODAY = computed(() => getTodayDate())` and update usages to call
  `.get()` where needed — or accept this as a known limitation for a
  short-session tool.

### 3. Conditional Rendering

- [PASS] No `onClick` inside a `computed()` body.
- [PASS] All conditional rendering uses JSX ternaries
  (`{condition ? <Element /> : null}`) — correctly auto-converted to `ifElse()`
  by the transformer (lines 777, 787, 804, 829, 952, 957, 1011, 1071, 1137,
  1197, 1239, 1281).
- [PASS] `variant={isAdmin ? "primary" : "ghost"}` (line 754) — ternary in JSX
  attribute, correct.

### 4. Type System

- [PASS] All input array types are wrapped in `Default<T[], []>` — `spots`,
  `persons`, `requests`, `priorityOrder` all have `Default<ParkingSpot[], []>`
  etc. (lines 82–87).
- [PASS] All optional entity fields use `Default<string, "">`,
  `Default<string[], []>`, `Default<boolean, true>` (lines 42–68).
- [PASS] No `Map` or `Set` stored in cell data — the `Set` at line 136 is a
  local variable inside a pure helper function, not stored in any cell.
- [PASS] `Writable<>` is correctly typed on all inputs that call `.set()` /
  `.push()` (lines 82–87).
- [NOTE] `ParkingSpot`, `Person`, and `SpotRequest` all have an `id: string`
  field used as a foreign key reference between entities (lines 40, 49, 62).
  This is idiomatic for relational data models — these IDs are structural
  references (like foreign keys), not cell identity markers. `equals()` is for
  determining whether two cell references are the same cell; it does not apply
  here. No violation.

### 5. Binding

- [PASS] `<ct-select $value={reqPersonId} .../>` (line 967) — `$value` binding
  on Writable<string>.
- [PASS] `<ct-input $value={reqDate} .../>` (line 972) — `$value` binding.
- [PASS] `<ct-select $value={selectedPersonId} .../>` (line 1017–1020) —
  `$value` binding.
- [PASS] `<ct-input $value={newPersonName} .../>` (line 1203) — `$value`
  binding.
- [PASS] `<ct-input $value={newPersonEmail} .../>` (line 1208) — `$value`
  binding.
- [PASS] `<ct-select $value={newPersonCommute} .../>` (line 1214–1217) —
  `$value` binding.
- [PASS] `<ct-input $value={newSpotNumber} .../>` (line 1245) — `$value`
  binding.
- [PASS] `<ct-input $value={newSpotLabel} .../>` (line 1250) — `$value` binding.
- [PASS] `<ct-input $value={newSpotNotes} .../>` (line 1257) — `$value` binding.
- [PASS] `<ct-input $value={editSpotLabel} .../>` (line 1287) — `$value`
  binding.
- [PASS] `<ct-input $value={editSpotNotes} .../>` (line 1291) — `$value`
  binding.
- [PASS] No missing `$` prefixes; no wrong event names.

### 6. Style Syntax

- [PASS] All HTML elements (`div`, `table`, `tr`, `td`, `th`, `span`, `thead`,
  `tbody`, `label`) use object syntax: `style={{ ... }}` (lines 826, 831–833,
  837–843, 855, 857–862, 904–910, 919–935).
- [PASS] All `ct-*` elements use string syntax: `style="..."` (lines 762, 806,
  954, 995, 1013, 1073, 1117, 1140, 1184, 1199, 1241, 1283).
- [PASS] `ct-card` conditional style
  `style={alloc.occupied ? "border-left: ..." : "border-left: ..."}` (line
  820–822) — ternary resolves to a string on a custom element. Correct.
- [PASS] No kebab-case props on `ct-*` elements — all use camelCase (`justify`,
  `align`, `showScrollbar`, `fadeEdges`, etc.).

### 7. Handler Binding

- [FAIL] **6 inline arrow functions created per-item inside `.map()` loops** —
  these create new function instances on every render for every item (lines
  1101, 1108, 1114–1118, 1175, 1182, 1055–1056). Per the performance/handler
  convention, per-item event handlers in `.map()` should use `handler()` at
  module scope with explicit bindings.

  Specific violations:
  - Line 1101: `onClick={() => movePriorityUp.send({ personId: person.id })}`
    inside `priorityList.map()`
  - Line 1108: `onClick={() => movePriorityDown.send({ personId: person.id })}`
    inside `priorityList.map()`
  - Line 1115: `onClick={() => removePerson.send({ personId: person.id })}`
    inside `priorityList.map()`
  - Line 1175: `onClick={() => openEditSpot.send({ spotId: spot.id })}` inside
    `spots.map()`
  - Line 1182: `onClick={() => removeSpot.send({ spotId: spot.id })}` inside
    `spots.map()`
  - Line 1055: `onClick={() => cancelRequest.send({ requestId: r.id })}` inside
    `myRequests.map()`

  Fix: Extract module-scope `handler()` instances that accept item-specific data
  as binding:
  ```typescript
  // At module scope
  const handleMovePriorityUp = handler<void, { personId: string }>(
    (_, { personId }) => { /* move logic or delegate */ }
  );
  // In .map():
  onClick={handleMovePriorityUp({ personId: person.id })}
  ```
  For handlers that delegate to pattern-scope actions, the handler needs to
  contain the logic directly (since module-scope handlers cannot close over
  pattern-scope variables). Alternatively, the `movePriorityUp` action logic can
  be lifted to a module-scope handler that accepts all required data.

### 8. Stream/Async

- [PASS] No `Stream.of()` usage — `Stream` is imported but used only as a type
  annotation in the output interface.
- [PASS] No `.subscribe()` calls.
- [PASS] No `async/await` in any handler or action.
- [N/A] No `generateText` or `generateObject` usage.

### 9. LLM Integration

- [PASS] `/// <cts-enable />` directive is present at line 1.
- [N/A] No LLM integration — no `generateText`, `generateObject`, or LLM
  prompts.

### 10. Performance

- [FAIL] 6 per-item inline arrow functions in `.map()` loops (same locations as
  Category 7). See Category 7 for full list and fix.
- [PASS] No expensive computation inside loops — `allocateSpot` is called once
  per action invocation, not in any render loop.
- [PASS] `personOptions` and `spotOptions` are `computed()` — not recomputed
  inline in JSX.

### 11. Action vs Handler Choice

- [PASS] All pattern-specific named operations use `action()` inside the pattern
  body: `addPerson`, `removePerson`, `setDefaultSpot`, `setSpotPreferences`,
  `movePriorityUp`, `movePriorityDown`, `addSpot`, `removeSpot`,
  `editSpotAction`, `requestParking`, `cancelRequest`, `manualOverride` — all
  correctly close over pattern-scope Writables and do not need per-instantiation
  binding differences.
- [PASS] Navigation helpers (`openRequestForm`, `submitRequest`,
  `openAddPerson`, etc.) correctly use `action()` inside the pattern body.
- [FAIL] Per-item `.map()` event handlers use inline arrow functions where
  `handler()` at module scope is required (lines 1055, 1101, 1108, 1115, 1175,
  1182). The question "does this handler need different data bound to different
  instantiations?" is YES for all six — each needs the specific `personId`,
  `spotId`, or `requestId` for that row. Fix: see Category 7.

### 12. Design Review

- [PASS] Clear entity boundaries — `ParkingSpot`, `Person`, and `SpotRequest`
  are distinct, well-scoped types with explicit relationships via ID references.
- [PASS] Actions match user intent — `requestParking`, `cancelRequest`,
  `manualOverride`, `movePriorityUp`, `removePerson`, `addSpot` etc. are all
  named for the user-facing operation.
- [PASS] Unidirectional data flow — the pattern owns all state; no child
  patterns; derived views (`todayAllocations`, `weekGrid`, `myRequests`,
  `priorityList`) are computed from canonical state.
- [PASS] Normalized state — no duplication; `SpotRequest` references persons and
  spots by ID rather than embedding data.
- [PASS] Self-documenting types — all type names and field names are clear
  without needing comments.
- [PASS] `allocateSpot` (lines 128–172) is a pure, testable helper at module
  scope. Good separation of complex business logic.
- [NOTE] `editSpotAction` is the internal variable name but is exposed as
  `editSpot` in the output (line 1342). Minor naming inconsistency — the
  internal name was changed to avoid collision with the exposed key but this
  makes reading the code slightly harder. Not a violation.
- [PASS] Pattern granularity is appropriate for the Intermediate tier — all
  interactions belong to the same coordination tool.

### 13. Regression Check

- [N/A] This is a first-pass review, not an update to existing code.

---

## Extended Checks

### Static vs. Reactive Correctness

- [NOTE] **Line 178** — `const TODAY = getTodayDate()` captures today's date as
  a static string at pattern instantiation. All date comparisons in computed
  bodies and actions (`r.date >= TODAY`, `day === TODAY`, etc.) use this static
  value. The today panel, week-ahead grid, and "can cancel" logic will all be
  incorrect if the pattern instance lives past midnight. Fix:
  `const TODAY = computed(() => getTodayDate())` and update the few usages to
  access `.get()` inside action and computed bodies. (Lines using TODAY: 251,
  334, 337, 514, 638, 810, 881, 884, 928, 1051.)

- [NOTE] **Lines 529–535** — `weekDays` computed has no reactive dependencies
  (all calls are to `new Date()` with no cell reads). It will cache its initial
  computation and never re-derive unless the computed is invalidated by a
  dependency change. This means if the user keeps the tool open past midnight,
  the week-ahead grid will drift. This is the same root issue as the static
  TODAY. Fixing TODAY to be reactive and adding it as a signal that changes
  daily would fix both.

- [PASS] `commuteOptions` (line 614) is correctly static — it never changes.

- [PASS] `personOptions` and `spotOptions` correctly use `computed()` with
  reactive dependencies (`persons.get()` and `spots.get()`).

### Computed Logic Duplication

- [MINOR] **Lines 400–407 and 643–650** — The duplicate-active-request predicate
  is written identically in two places:

  In `requestParking` action (lines 400–407):
  ```typescript
  const hasActive = currentRequests.some(
    (r) =>
      r.personId === personId && r.date === date &&
      (r.status === "allocated" || r.status === "pending"),
  );
  ```

  In `submitRequest` action (lines 643–650):
  ```typescript
  const hasActive = currentRequests.some(
    (r) =>
      r.personId === personId && r.date === date &&
      (r.status === "allocated" || r.status === "pending"),
  );
  ```

  `submitRequest` calls `requestParking.send()` after doing its own check (so
  the check in `requestParking` acts as a safety guard). The predicate could be
  extracted as a module-scope helper:
  ```typescript
  const hasActiveRequest = (
    requests: readonly SpotRequest[],
    personId: string,
    date: string,
  ): boolean =>
    requests.some((r) =>
      r.personId === personId && r.date === date &&
      (r.status === "allocated" || r.status === "pending")
    );
  ```

### Spec Compliance

| Criterion                                                                     | Status   | Note                                                                                                |
| ----------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| Today panel shows all 3 initial spots as available on first load              | PASS     | `INITIAL_SPOTS` + `todayAllocations` computed                                                       |
| Week-ahead grid shows 7 days from today                                       | PASS     | `weekDays` computed, 7-iteration loop                                                               |
| Request parking allocates spot immediately if free                            | PASS     | `requestParking` action with `allocateSpot()` helper                                                |
| Allocated spot shows as occupied in today panel with person's name            | PASS     | `todayAllocations` maps to personName                                                               |
| Denied request shows clear message when all spots occupied                    | PASS     | `reqMessage` set to "Denied: no spots available..."                                                 |
| Duplicate active request for same person/date is prevented with error message | PASS     | `submitRequest` checks and shows message                                                            |
| Cancelling a request frees the spot immediately                               | PASS     | `cancelRequest` action + reactive `todayAllocations`                                                |
| Auto-allocation: default spot → preferences → any free spot                   | PASS     | `allocateSpot()` lines 156–171                                                                      |
| No default/no preferences: assigns any available spot                         | PASS     | `allocateSpot()` fallback at line 171                                                               |
| Week-ahead grid shows future allocations                                      | PASS     | `weekGrid` computed                                                                                 |
| Admin mode reveals add/remove/edit controls                                   | PASS     | `isAdmin` ternary shows People/Spots nav tabs                                                       |
| Adding a person makes them available in request form                          | PASS     | `personOptions` computed derives from `persons`                                                     |
| Removing a person cancels upcoming allocated requests                         | PASS     | `removePerson` action lines 245–261                                                                 |
| Priority list shows all persons in ranked order                               | PASS     | `priorityList` computed from `priorityOrder`                                                        |
| Moving a person up/down updates position immediately                          | PASS     | `movePriorityUp` / `movePriorityDown` actions                                                       |
| Adding a spot makes it appear in today panel, grid, preference lists          | PASS     | `addSpot` + reactive computeds                                                                      |
| Removing a spot cancels upcoming allocations (status → denied)                | PASS     | `removeSpot` action lines 330–373 (status set to "denied" per spec)                                 |
| Spot label/notes can be edited; updates appear immediately                    | PASS     | `editSpotAction` + reactive computeds                                                               |
| Commute mode is informational only, no restriction on requests                | PASS     | `requestParking` has no commute mode check                                                          |
| "My Requests" view shows requests filtered by selected name                   | PASS     | `myRequests` computed, `isMyRequests` view                                                          |
| **Admin can assign a default spot to a person**                               | **FAIL** | `setDefaultSpot` action exists but **no UI in admin panel to trigger it**                           |
| **Admin can set/edit spot preferences for a person**                          | **FAIL** | `setSpotPreferences` action exists but **no UI in admin panel to trigger it**                       |
| Past dates cannot be selected in request form                                 | PARTIAL  | Validated on submit (line 638–640), but `<ct-input>` does not restrict past dates at the form level |

### Defensive Coding

- [PASS] `allocateSpot` guards against missing person: `if (!person) return ""`
  (line 154).
- [PASS] Guards on `personId`, `date`, `spotId` at action entry points (lines
  397, 448).
- [PASS] Nullish coalescing used consistently for `Default<>` field access:
  `(person.defaultSpotId as string) ?? ""`,
  `(person.spotPreferences as string[]) ?? []` (lines 157, 163, 352–353).
- [PASS] `priorityList` computed filters out missing persons:
  `.filter((p): p is Person => !!p)` (line 589).
- [PASS] `todayAllocations` uses `?.name ?? "Unknown"` for null-safe person
  lookup (line 517).
- [PASS] `allocatedSpotIds` filter on line 141–143 correctly excludes requests
  without a spot ID (`(r.assignedSpotId ?? "") !== ""`).
- [MINOR] **Lines 144, 334, 352, 456, 501, 514, 549, 571** — `as string` casts
  on `Default<string, "">` typed fields are technically unsafe casts, used
  throughout as a workaround for the `Default<>` wrapper type. This is idiomatic
  CT usage, but a future type refinement allowing transparent access to
  `Default<>` fields would eliminate these. Low risk in practice since the cast
  is from the known underlying type. Consider a type helper
  `unwrap<T>(v: Default<T, any>): T` if this becomes widespread.

### Handler Architecture Consistency

- [PASS] All named mutable operations consistently use `action()` inside the
  pattern body. The choice of `action()` is uniform across the 12 named
  operations.
- [FAIL] The `.map()` event handlers are uniformly inline arrow functions across
  3 list views. This is internally consistent (same pattern applied everywhere)
  but consistently violates the convention that per-item handlers in `.map()`
  should use `handler()` at module scope. The three affected views are:
  `priorityList.map()` (lines 1085–1124), `spots.map()` (lines 1150–1191), and
  `myRequests.map()` (lines 1023–1065).

---

## Test Review

**Test coverage**: 60/64 passing. The 4 failures are `editSpot` reactive
detection limitations in the test harness — same-length array mutation is not
reliably detected. This is a known harness constraint, not a pattern bug; the
comment at lines 592–594 acknowledges it.

**Coverage strengths**:

- Initial state verification (7 assertions)
- Full CRUD lifecycle for persons and spots
- Request allocation and denial logic
- Cancellation and spot freeing
- Priority ordering (move up/down)
- Default spot and preference allocation
- Manual override
- Cascading cancellation on person/spot removal
- Duplicate request prevention

**Coverage gaps**:

- The "all spots occupied → denied" scenario is not directly tested (the test
  was restructured to add spot 7 before requests, giving 4 spots for 4 persons —
  all succeed). A direct denial test after all 4 spots are taken is absent.
- No test for blank-name rejection of addPerson (commented as a test intent at
  line 333 but the `assert_still_4_persons` assertion only checks count doesn't
  increase — no explicit send of a blank-name addPerson).
- No test for past-date validation in `submitRequest`.
- `setDefaultSpot` / `setSpotPreferences` are tested indirectly via allocation
  preference tests, but clearing a default (setting to "") is not tested.

**Test pattern observations**:

- The "warmup" assertions (repeated `assert_still_4_persons`) are used to give
  the reactive system propagation cycles for same-length array mutations
  (setDefaultSpot, setSpotPreferences). This is a test harness constraint,
  documented with comments (lines 638–648, 658–659, 665–666).
- The 10-iteration warmup for `manualOverride` (lines 684–693) is unusually long
  — the comment notes it's needed for `requests.push` propagation. This works
  correctly.
- Tests are well-organized with clear intent comments.
- The `/// <cts-enable />` directive is present in the test file (line 1). PASS.

---

## Summary

| Category | Count |
| -------- | ----- |
| Passed   | 44    |
| Failed   | 4     |
| Warnings | 0     |
| Notes    | 5     |
| N/A      | 4     |

---

## Priority Fixes

**Priority 1 — MAJOR:** **Lines 1070–1134 (admin-persons view) and no
corresponding view** — Admin interactions 10 and 11 from the spec are
unimplemented in the UI. The `setDefaultSpot` and `setSpotPreferences` actions
exist and are tested, but there is no UI element in the admin panel that allows
the admin to set a person's default spot or edit their preference list. Without
these controls, the allocation preference features (which 3 passing tests verify
work correctly) are inaccessible to real users. Fix: Add a "per-person edit"
view or inline controls in the admin-persons list that show the person's current
default spot (a select from `spotOptions`) and a preference list editor.

**Priority 2 — MINOR:** **Lines 1055, 1101, 1108, 1115, 1175, 1182** — Six
inline arrow functions created per-item inside `.map()` loops violate the
handler binding convention. Each creates a new function instance per render per
item. Fix: Extract module-scope `handler()` instances for `cancelRequest`,
`movePriorityUp`, `movePriorityDown`, `removePerson`, `openEditSpot`, and
`removeSpot` with per-item ID bindings. The action logic can either be inlined
into the handler or the pattern can be refactored so the handlers close over the
actions they need (which requires restructuring since module-scope handlers
cannot close over pattern-scope actions — the logic must be at module scope
too).

**Priority 3 — MINOR:** **Lines 400–407 and 643–650** — The
duplicate-active-request check predicate is written identically in both
`requestParking` and `submitRequest`. Fix: Extract to a module-scope helper
`hasActiveRequest(requests, personId, date): boolean`.

**Priority 4 — NOTE:** **Line 178** — `TODAY` is captured as a static string at
instantiation. The today panel, week-ahead grid, and cancellation eligibility
check will all be wrong if the tool stays open past midnight. Fix:
`const TODAY = computed(() => getTodayDate())` and update the ~10 usage sites to
access `.get()` inside action and computed bodies.

**Priority 5 — NOTE:** **Line 972** — The date input is a plain `<ct-input>`
with placeholder text rather than a date selector with `min`/`max` constraints.
The spec says "Only today and future dates (up to 30 days ahead) are
selectable." The implementation catches past dates on submit (line 638), but the
spec implies form-level prevention. Fix: Use a constrained date picker input
with `min={TODAY}` and `max={getDateOffset(30)}` attributes, or add visible
validation state on the input itself.
