# Pattern Review: main.tsx (Critic Pass 2)

**Pattern**: Parking Coordinator
**File**: workspace/2026-02-24-parking-coordinator-k21l/pattern/main.tsx
**Test file**: workspace/2026-02-24-parking-coordinator-k21l/pattern/main.test.tsx
**Spec**: workspace/2026-02-24-parking-coordinator-k21l/spec.md
**Prior review**: workspace/2026-02-24-parking-coordinator-k21l/reviews/critic-001.md

---

## Focus of This Pass

This is a targeted re-review after a fix pass. The three changes made were:

1. **MAJOR fix**: Added full `edit-person` view with default spot selector and preference list editor (interactions 10 and 11 from spec).
2. **MINOR fix**: Extracted `hasActiveRequest` to module-scope helper (lines 128-139).
3. **Deferred**: Inline arrow functions in `.map()` loops were not converted (prior deferred decision).

Primary questions for this pass:
- Is the MAJOR fix correct and complete?
- Did the fix pass introduce any new issues?
- What is the updated overall state?

---

## Results by Category

### 1. Module Scope

- [PASS] No `handler()` defined inside the pattern body — all named handlers remain `action()`.
- [PASS] No `lift()` anywhere in the file.
- [PASS] All helper functions at module scope: `getTodayDate`, `getDateOffset`, `formatShortDate`, `genId`, `hasActiveRequest`, `allocateSpot` (lines 17-187).
- [PASS] **NEW**: `hasActiveRequest` is now at module scope (lines 128-139). The duplicate predicate from critic-001 Priority 3 is resolved.
- [PASS] **NEW**: All four new edit-person actions (`openEditPerson`, `saveEditPerson`, `addPrefSpot`, `removePrefSpot`, `movePrefUp`, `movePrefDown`) are defined inside the pattern body as `action()` — correct, they all close over pattern-scope Writables.

### 2. Reactivity

- [PASS] All `Writable.of()` calls use static literal values — including the four new edit-person Writables at lines 222-225 (`editPersonId`, `editPersonDefaultSpot`, `editPersonPrefs`, `editPersonAddPrefSpotId`).
- [PASS] All new computeds have proper reactive dependencies: `editPersonName` reads `editPersonId.get()` and `persons.get()` (line 815); `availablePrefSpots` reads `editPersonPrefs.get()` and `spots.get()` (line 823); `editPersonPrefDetails` reads `editPersonPrefs.get()` and `spots.get()` (line 838).
- [PASS] No `.filter()` or `.sort()` inline in JSX in the new view — `editPersonPrefDetails` is a `computed()` (lines 838-847).
- [PASS] `weekDays` accessed directly (without `.get()`) inside `weekGrid` computed body at line 556 — correct CT idiom for computed access.
- [NOTE] **Unchanged from critic-001**: `const TODAY = getTodayDate()` (line 193) is a static string captured at pattern instantiation. The today panel and week-ahead grid will drift after midnight. Not introduced by this fix pass.

### 3. Conditional Rendering

- [PASS] No `onClick` inside a `computed()` body anywhere including the new view.
- [PASS] `{isEditPerson ? (...) : null}` at line 1427 uses a JSX ternary — correctly auto-converted to `ifElse()`.
- [PASS] All other conditional rendering in the new view uses JSX ternaries.

### 4. Type System

- [PASS] No changes to entity types. All `Default<T, default>` annotations unchanged.
- [PASS] `editPersonPrefs` is `Writable.of<string[]>([])` (line 224) — correct typing, no `Default<>` needed since this is a local Writable, not a serialized input.
- [PASS] `editPersonPrefDetails` computed filters with a type guard `(s): s is {id, number, label} => !!s` (line 846) — typed correctly.
- [PASS] No `Map` or `Set` in cell data.

### 5. Binding

- [PASS] **NEW**: `<ct-select $value={editPersonDefaultSpot} items={spotOptions} />` at line 1437-1440 — correct `$value` binding on `Writable<string>`.
- [PASS] **NEW**: `<ct-select $value={editPersonAddPrefSpotId} items={availablePrefSpots} />` at line 1492-1496 — correct `$value` binding.
- [PASS] All pre-existing bindings from critic-001 remain correct.
- [PASS] No missing `$` prefixes; no wrong event names.

### 6. Style Syntax

- [PASS] All HTML elements in the new `edit-person` view use object syntax: `style={{ ... }}` (lines 1441, 1449, 1457).
- [PASS] All `ct-*` elements in the new view use string syntax (lines 1429, 1435, 1447, 1461, 1491, 1507).
- [PASS] `style="color: #dc2626;"` on `<ct-button>` at line 1480 — string on custom element, correct.
- [PASS] No style regressions introduced.

### 7. Handler Binding

- [FAIL] **10 total inline arrow functions inside `.map()` loops** — the fix pass added 4 new ones (1 in `priorityList.map()`, 3 in `editPersonPrefDetails.map()`), on top of the 6 from critic-001 that were deferred. All create new function instances per render per item.

  **Pre-existing (deferred from critic-001):**
  - Line 1208: `onClick={() => movePriorityUp.send({ personId: person.id })}` inside `priorityList.map()`
  - Line 1215: `onClick={() => movePriorityDown.send({ personId: person.id })}` inside `priorityList.map()`
  - Line 1222: `onClick={() => removePerson.send({ personId: person.id })}` inside `priorityList.map()`
  - Line 1289: `onClick={() => openEditSpot.send({ spotId: spot.id })}` inside `spots.map()`
  - Line 1296: `onClick={() => removeSpot.send({ spotId: spot.id })}` inside `spots.map()`
  - Line 1162: `onClick={() => cancelRequest.send({ requestId: r.id })}` inside `myRequests.map()`

  **NEW in this fix pass:**
  - Line 1223: `onClick={() => openEditPerson.send({ personId: person.id })}` inside `priorityList.map()`
  - Line 1464: `onClick={() => movePrefUp.send({ spotId: pref.id })}` inside `editPersonPrefDetails.map()`
  - Line 1471: `onClick={() => movePrefDown.send({ spotId: pref.id })}` inside `editPersonPrefDetails.map()`
  - Line 1478: `onClick={() => removePrefSpot.send({ spotId: pref.id })}` inside `editPersonPrefDetails.map()`

  The fix pass added 4 new violations of the same type that was deferred. Since the deferral decision is consistent, these new violations carry the same MINOR severity. However, the count has grown from 6 to 10 — the pattern is now more consistently using this anti-pattern rather than less. Fix: apply the `handler()` conversion to all 10 sites, or continue the consistent deferral.

### 8. Stream/Async

- [PASS] No `Stream.of()`, `.subscribe()`, or `async/await` — unchanged.
- [N/A] No LLM usage.

### 9. LLM Integration

- [PASS] `/// <cts-enable />` present at line 1.
- [N/A] No LLM integration.

### 10. Performance

- [FAIL] 10 per-item inline arrow functions in `.map()` loops (see Category 7). The fix pass added 4 new ones, growing the performance concern.
- [PASS] No new expensive computations inside loops. `editPersonPrefDetails` is computed once, not re-derived inline in JSX.
- [PASS] `availablePrefSpots` and `editPersonPrefDetails` are properly computed.

### 11. Action vs Handler Choice

- [PASS] `removePrefSpot`, `movePrefUp`, `movePrefDown` (lines 777, 782, 792) are correctly defined as `action()`. They close over `editPersonPrefs` (pattern-scope Writable) and the event parameter carries per-item spot IDs. The question "do different instantiations need different bound data?" — technically the spotId differs per item, but these actions are not bound; they receive the spotId via `.send()` in the event parameter. This is the correct approach for actions that operate on a single shared state (editPersonPrefs) with per-call parameters.
- [PASS] `openEditPerson` (line 742) is correctly `action()` — it closes over `persons`, `editPersonId`, `editPersonDefaultSpot`, `editPersonPrefs`, `editPersonAddPrefSpotId`. The event parameter carries only the personId lookup key.
- [PASS] `saveEditPerson` (line 754), `addPrefSpot` (line 768) — correctly `action()`.
- [FAIL] The four new inline arrow functions in `.map()` loops (lines 1223, 1464, 1471, 1478) are per-item handlers that should use `handler()` at module scope — same issue as the 6 deferred ones. See Category 7.

### 12. Design Review

- [PASS] The new `edit-person` view is well-scoped: it handles exactly one concern (editing a person's parking preferences).
- [PASS] The workflow is clear: admin clicks "Edit" on a person, fills in default spot and preferences, saves. The form pre-populates from the person's current values (lines 747-750).
- [PASS] `availablePrefSpots` excludes already-added spots from the add-spot dropdown (line 829) — prevents duplicate preferences. Good defensive design.
- [PASS] `addPrefSpot` guards against duplicates explicitly (line 772: `if (current.includes(spotId)) return`).
- [PASS] The "None" option (value `""`) in `spotOptions` (line 621) allows the admin to clear a person's default spot — correctly handles the spec requirement "The admin can also clear the default."
- [NOTE] `openEditPerson` loads the person's current default and preferences into local edit state (lines 747-750) but does NOT update if the underlying person data changes while the edit-person view is open (e.g., if a spot is removed in another session). In a single-user pattern this is acceptable — but if `removeSpot` fires while editing, `editPersonPrefs` will still contain the removed spot ID until the form is reopened. Low risk for a single-user internal tool; worth noting.
- [PASS] Pattern granularity remains appropriate.

### 13. Regression Check

- [PASS] The `hasActiveRequest` extraction is a pure refactor — the logic is identical to what was inlined. Both call sites (lines 422, 659) now use the module-scope helper. No behavior change.
- [PASS] The new edit-person form state Writables do not interfere with any pre-existing Writables.
- [PASS] `openEditPerson` is added to the persons list (line 1222) — does not affect any pre-existing button in that view.
- [PASS] No changes to the output interface — all pre-existing exported actions and state remain intact (lines 1540-1561).
- [PASS] Test file unchanged — all prior tests continue to cover the core business logic. The new UI actions (`openEditPerson`, `saveEditPerson`, etc.) are navigation helpers that delegate to `setDefaultSpot` and `setSpotPreferences`, which are already tested.

---

## Extended Checks

### Static vs. Reactive Correctness

- [NOTE] **Line 193** — `const TODAY = getTodayDate()` unchanged. Same stale-after-midnight concern from critic-001. Not introduced by this pass.
- [PASS] `editPersonPrefs` is correctly reactive — `editPersonPrefDetails` and `availablePrefSpots` both read `editPersonPrefs.get()` inside `computed()` bodies, so UI updates immediately when preferences change.
- [PASS] `spotOptions` (line 619) is referenced in the edit-person view (`items={spotOptions}`). Since it's a computed, it correctly reflects any spots added or removed while the edit-person view is open. PASS.
- [NOTE] **Line 823** — `availablePrefSpots` reads `spots.get()` reactively, so if a spot is added or removed, the add-preference dropdown updates. However, `editPersonPrefs` is loaded from the person's stored data only when `openEditPerson` fires. If a spot referenced in `editPersonPrefs` is removed while the edit form is open, `editPersonPrefDetails` will silently filter it out (the `.filter(s => !!s)` at line 846), which is defensive and correct.

### Computed Logic Duplication

- [PASS] **`hasActiveRequest` duplication is resolved** (Priority 3 from critic-001). Now a single module-scope helper at lines 128-139, called at lines 422 and 659. No remaining logic duplication.
- [PASS] No new duplication introduced in the fix pass.

### Spec Compliance

| Criterion | Status | Note |
|-----------|--------|------|
| Today panel shows all 3 initial spots as available on first load | PASS | Unchanged — `INITIAL_SPOTS` + `todayAllocations` computed |
| Week-ahead grid shows 7 days from today | PASS | Unchanged |
| Request parking allocates spot immediately if free | PASS | Unchanged |
| Allocated spot shows as occupied in today panel | PASS | Unchanged |
| Denied request shows clear message | PASS | Unchanged |
| Duplicate active request prevented with error message | PASS | Unchanged |
| Cancelling a request frees spot immediately | PASS | Unchanged |
| Auto-allocation: default spot → preferences → any free spot | PASS | Unchanged |
| No default/no preferences: assigns any available spot | PASS | Unchanged |
| Week-ahead grid shows future allocations | PASS | Unchanged |
| Admin mode reveals add/remove/edit controls | PASS | Unchanged |
| Adding a person makes them available in request form | PASS | Unchanged |
| Removing a person cancels upcoming allocated requests | PASS | Unchanged |
| Priority list shows all persons in ranked order | PASS | Unchanged |
| Moving a person up/down updates position immediately | PASS | Unchanged |
| Adding a spot makes it appear everywhere | PASS | Unchanged |
| Removing a spot cancels upcoming allocations (status → denied) | PASS | Unchanged |
| Spot label/notes can be edited | PASS | Unchanged |
| Commute mode is informational only | PASS | Unchanged |
| "My Requests" view shows requests filtered by selected name | PASS | Unchanged |
| **Admin can assign a default spot to a person (Interaction 10)** | **PASS** | **FIXED: Edit-person view with ct-select for default spot at line 1437** |
| **Admin can set/edit spot preferences for a person (Interaction 11)** | **PASS** | **FIXED: Preference list editor with add/remove/reorder at lines 1447-1503** |
| Past dates cannot be selected in request form | PARTIAL | Validated on submit (line 653); date input lacks min/max constraint — unchanged from critic-001 |
| Admin can clear a person's default spot | PASS | "None" option (value "") in spotOptions (line 621) |
| Multiple people may share same default spot | PASS | No uniqueness constraint enforced — correct per spec assumption 7 |

### Defensive Coding

- [PASS] `openEditPerson` guards against missing person: `if (!person) return` (line 746) — defensive.
- [PASS] `saveEditPerson` guards against empty `editPersonId`: `if (!personId) return` (line 756).
- [PASS] `addPrefSpot` guards against empty spotId (`if (!spotId) return`, line 770) and duplicates (`if (current.includes(spotId)) return`, line 772).
- [PASS] `editPersonPrefDetails` filters null entries (line 846) — handles case where a referenced spot no longer exists.
- [PASS] `availablePrefSpots` excludes already-added spots — prevents adding duplicates to the selector.
- [NOTE] **Line 844** — `(spot.label as string) ?? ""` — same idiomatic `Default<>` cast pattern throughout. Low risk, consistent with prior analysis.
- [NOTE] If the user clicks "Edit" on a person, then another action removes that person (theoretically impossible in this single-view UI, but possible via external `.send()`), `saveEditPerson` would call `setDefaultSpot.send({ personId, ... })` with a now-deleted personId. The `setDefaultSpot` action's `currentPersons.map()` would simply not find the ID and produce no change. Graceful no-op — PASS.

### Handler Architecture Consistency

- [PASS] The new `edit-person` view is internally consistent with the rest of the pattern: per-item buttons use inline arrow functions, matching the deferred pattern throughout.
- [FAIL] The fix pass extended the same inline-arrow-function pattern to the new preference list (lines 1464, 1471, 1478) and the new "Edit" button in persons list (line 1223). This is internally consistent (all `.map()` handlers follow the same convention throughout the file) but consistently violates the platform convention. The total count is now 10 inline arrow functions across 4 `.map()` loops. The consistent application is noted — this is a single decision that should be made once and applied uniformly rather than a random pattern.

---

## Test Review (Regression Check)

The test file was not changed in the fix pass. Reviewing relevant coverage for the fixed interactions:

- **`setDefaultSpot` and `setSpotPreferences` tested**: Lines 196-220 define test actions for these. Lines 635-649 invoke them and verify. Lines 475-488 assert the state is correct. The preference-based allocation test at lines 492-515 verifies that the stored preferences actually influence allocation results. **Coverage for the fixed actions is thorough.**

- **New UI actions not directly tested** (`openEditPerson`, `saveEditPerson`, `addPrefSpot`, `movePrefUp`, `movePrefDown`, `removePrefSpot`): These are view-navigation helpers that delegate to `setDefaultSpot` and `setSpotPreferences`. The underlying business logic is tested. The UI navigation itself (view transitions, form state management) is not tested, which is typical and acceptable for this test style — the test suite focuses on business logic, not UI state.

- **No regressions introduced**: The `hasActiveRequest` extraction is a pure refactor with identical logic. Tests that exercise `requestParking` and `submitRequest` continue to validate this path.

---

## Summary

| Category | Count |
|----------|-------|
| Passed | 51 |
| Failed | 3 |
| Warnings | 0 |
| Notes | 6 |
| N/A | 3 |

**Change from critic-001**: MAJOR Priority 1 (missing edit-person UI) is RESOLVED. MINOR Priority 3 (duplicate predicate) is RESOLVED. The inline arrow count grew from 6 to 10 due to the fix pass adding the new view without converting to `handler()`.

---

## Priority Fixes

**Priority 1 — MINOR:** **Lines 1208, 1215, 1222, 1223, 1289, 1296, 1162, 1464, 1471, 1478** — 10 inline arrow functions in `.map()` loops across 4 list renders. This violation count grew from 6 to 10 in the fix pass. Since this was already deferred citing exemplar precedent, the severity remains MINOR. However, the growing count makes this more worth addressing in a future pass. Fix: Extract module-scope `handler()` instances for each operation:

```typescript
// At module scope:
const handleMovePriorityUp = handler<void, { personId: string }>(
  (_, { personId }) => {
    // move logic duplicated here from action body, OR
    // refactor action to accept event and expose as handler
  }
);
// In .map():
onClick={handleMovePriorityUp({ personId: person.id })}
```

**Priority 2 — NOTE:** **Line 193** — `const TODAY = getTodayDate()` static snapshot. Unchanged from critic-001. If the tool stays open past midnight, the today panel and week-ahead grid will drift. Fix: `const TODAY = computed(() => getTodayDate())` with `.get()` at usage sites.

**Priority 3 — NOTE:** **Line 1079** — Date input (`<ct-input $value={reqDate} />`) has no `min`/`max` constraints. The spec says "only today and future dates (up to 30 days ahead) are selectable." Submit-time validation exists (line 653) but the input does not prevent past dates at the form level. Fix: Add `min={TODAY}` and `max={getDateOffset(30)}` attributes to the date input.

---

## Verdict on the MAJOR Fix

**The MAJOR issue from critic-001 is fully and correctly resolved.**

The edit-person view (lines 1426-1524) provides:
1. A default spot selector (`<ct-select $value={editPersonDefaultSpot} items={spotOptions} />`) pre-populated with the person's current default and including a "None" option to clear it.
2. A full preference list editor showing the ordered list of preferred spots with Up/Down/Remove controls per item, plus an add-spot dropdown that excludes already-added spots.
3. A Save button that calls both `setDefaultSpot.send()` and `setSpotPreferences.send()` with the edited values.
4. The view is navigated to from the admin-persons list via a per-person "Edit" button.

Both spec interactions 10 and 11 are now fully implemented in the UI.

No new CRITICAL or MAJOR issues were introduced by the fix pass.
